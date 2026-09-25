import { spawn as nodeSpawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { stat as nodeStat, utimes } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite, readBytes, stateDirectory, withLock } from './storage.js';

const DAY_MS = 86_400_000;
const statePath = (stateDir: string) => join(stateDir, 'automatic-update.json');

type UpdateState = { lastAttempt?: number };
type DetachedSpawn = (
  file: string,
  args: string[],
  options: {
    detached: true;
    stdio: 'ignore';
    windowsHide: true;
    windowsVerbatimArguments?: true;
  }
) => { once(event: 'error', listener: () => void): unknown; unref(): void };
type FileStat = { isFile(): boolean; mtimeMs: number };

export interface AutomaticUpdateOptions {
  stateDir?: string;
  home?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  spawn?: DetachedSpawn;
  stat?: (path: string) => Promise<FileStat>;
}

export function cliLauncherPath(options: AutomaticUpdateOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  return platform === 'win32'
    ? join(
        options.env?.LOCALAPPDATA || join(home, 'AppData', 'Local'),
        'Mnemonik',
        'bin',
        'mnemonik.cmd'
      )
    : join(home, '.local', 'bin', 'mnemonik');
}

async function readState(path: string): Promise<UpdateState> {
  const bytes = await readBytes(path);
  if (!bytes) return {};
  const value = JSON.parse(bytes.toString()) as UpdateState;
  if (
    !value ||
    typeof value !== 'object' ||
    (value.lastAttempt !== undefined &&
      (!Number.isFinite(value.lastAttempt) || value.lastAttempt < 0))
  )
    throw new Error('automatic_update_state_invalid');
  return value.lastAttempt === undefined ? {} : { lastAttempt: value.lastAttempt };
}

export async function maybeStartAutomaticUpdate(
  options: AutomaticUpdateOptions = {}
): Promise<boolean> {
  const stateDir = options.stateDir ?? stateDirectory(options.platform, options.env, options.home);
  const path = statePath(stateDir);
  try {
    const now = (options.now ?? Date.now)();
    const stat = options.stat ?? nodeStat;
    try {
      if (now - (await stat(path)).mtimeMs < DAY_MS) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!options.spawn && !(await stat(cliLauncherPath(options))).isFile()) return false;
    return await withLock(path, 0, async (assertOwned) => {
      const state = await readState(path);
      if (state.lastAttempt !== undefined && now - state.lastAttempt < DAY_MS) return false;
      await atomicWrite(
        path,
        Buffer.from(`${JSON.stringify({ lastAttempt: now })}\n`),
        undefined,
        assertOwned
      );
      await utimes(path, now / 1_000, now / 1_000);
      const platform = options.platform ?? process.platform;
      const launcher = cliLauncherPath(options);
      const command =
        platform === 'win32'
          ? {
              file: options.env?.ComSpec || 'cmd.exe',
              args: ['/d', '/s', '/c', `""${launcher}" update --automatic"`],
              windowsVerbatimArguments: true as const,
            }
          : platform === 'linux' && (options.env ?? process.env).INVOCATION_ID
            ? {
                // detached creates a process group, not a new systemd cgroup. An
                // updater spawned by the scanner must survive stopping that service.
                file: 'systemd-run',
                args: [
                  '--user',
                  '--collect',
                  '--quiet',
                  `--setenv=MNEMONIK_STATE_DIR=${stateDir}`,
                  '--',
                  launcher,
                  'update',
                  '--automatic',
                ],
              }
            : { file: launcher, args: ['update', '--automatic'] };
      const child = (options.spawn ?? (nodeSpawn as DetachedSpawn))(command.file, command.args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        ...('windowsVerbatimArguments' in command
          ? { windowsVerbatimArguments: command.windowsVerbatimArguments }
          : {}),
      });
      child.once('error', () => {});
      child.unref();
      return true;
    });
  } catch {
    return false;
  }
}

const HELPER_FLAG = '--mnemonik-automatic-update';
type HelperSpawn = (
  file: string,
  args: string[],
  options: { detached: true; stdio: 'ignore'; windowsHide: true }
) => { once(event: 'error', listener: () => void): unknown; unref(): void };

export interface SessionUpdateOptions extends Omit<AutomaticUpdateOptions, 'spawn'> {
  /** Starts the detached helper that claims the day and launches the updater. */
  spawnHelper?: HelperSpawn;
}

/**
 * Session start's share of the daily update is one stat. When a day has passed,
 * the claim and the updater launch go to a detached helper process: the claim
 * takes tens of milliseconds of locking and syncing, a hook that answers its
 * editor exits at once, and an exit in the middle of a claim used to spend the
 * day without starting an update. The hook never waits on update work.
 */
export async function startAutomaticUpdateForSession(
  options: SessionUpdateOptions = {}
): Promise<void> {
  try {
    const stateDir =
      options.stateDir ?? stateDirectory(options.platform, options.env, options.home);
    const now = (options.now ?? Date.now)();
    const stat = options.stat ?? nodeStat;
    try {
      if (now - (await stat(statePath(stateDir))).mtimeMs < DAY_MS) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
    }
    // No launcher, no update: never start a helper that can only give up.
    if (!(await stat(cliLauncherPath(options))).isFile()) return;
    const child = (options.spawnHelper ?? (nodeSpawn as HelperSpawn))(
      process.execPath,
      [fileURLToPath(import.meta.url), HELPER_FLAG, stateDir],
      { detached: true, stdio: 'ignore', windowsHide: true }
    );
    child.once('error', () => {});
    child.unref();
  } catch {
    // Session start is fail-open.
  }
}

function isHelperInvocation(): boolean {
  if (process.argv[2] !== HELPER_FLAG || !process.argv[3] || !process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isHelperInvocation()) void maybeStartAutomaticUpdate({ stateDir: process.argv[3] });
