import { spawn as nodeSpawn } from 'node:child_process';
import { stat as nodeStat, utimes } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
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

export async function startAutomaticUpdateForSession(
  start: () => Promise<unknown> = maybeStartAutomaticUpdate,
  timeoutMs = 50
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve()
        .then(start)
        .catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } catch {
    // Session start is fail-open.
  } finally {
    if (timer) clearTimeout(timer);
  }
}
