import { spawn as nodeSpawn } from 'node:child_process';
import { mkdir, open, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import {
  appendWindowsPath,
  atomicWrite,
  readWindowsUserPath,
  removeWindowsPathEntry,
  stateDirectory,
  windowsPathIncludes,
  withLock,
  writeWindowsUserPath,
  type WindowsPathOptions,
  type WindowsPathValue,
} from '@mnemonik/local-setup';
import { bytesAt } from './install/journal.js';

export interface LauncherOptions extends WindowsPathOptions {
  stateDir?: string;
  home?: string;
  platform?: NodeJS.Platform;
  spawn?: typeof nodeSpawn;
  instruction?: (text: string) => void;
}
export interface LauncherStatus {
  path: string;
  directory: string;
  ownership: 'ours' | 'not_ours' | 'missing';
  onPath: boolean;
  action: string;
}
interface LauncherRecord {
  path: string;
  entry: string;
  node?: string;
  phase: 'installing' | 'installed' | 'removing';
  windowsPath?: { before: WindowsPathValue; after: WindowsPathValue };
}
const fallback = 'npx -y @mnemonik/cli@latest';
const marker = '--mnemonik-owner=cli';
const missingNode =
  'The Node installation that Mnemonik was set up with has moved; run the install command again.';
const same = (a: WindowsPathValue, b: WindowsPathValue) =>
  a?.value === b?.value && a?.kind === b?.kind;
function locations(options: LauncherOptions) {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const state = resolve(options.stateDir ?? stateDirectory(platform, env, home));
  const directory =
    platform === 'win32'
      ? join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Mnemonik', 'bin')
      : join(home, '.local', 'bin');
  return {
    platform,
    home,
    env,
    directory,
    state,
    path: join(directory, platform === 'win32' ? 'mnemonik.cmd' : 'mnemonik'),
    entry: join(state, 'runtimes', 'bootstrap', 'dist', 'bin.js'),
    record: join(state, 'launcher.json'),
  };
}
const shellQuote = (value: string) => `"${value.replace(/[\\"$`]/g, '\\$&')}"`;
function contents(entry: string, node: string, platform: NodeJS.Platform): string {
  if (
    !isAbsolute(node) ||
    /[\r\n\0]/.test(entry + node) ||
    (platform === 'win32' && /"/.test(entry + node))
  )
    throw new Error('launcher_path_invalid');
  if (platform === 'win32') {
    const executable = node.replaceAll('%', '%%');
    return `@echo off\r\nrem ${marker}\r\nsetlocal DisableDelayedExpansion\r\nif not exist "${executable}" (\r\n  echo ${missingNode} 1>&2\r\n  exit /b 1\r\n)\r\nset "MNEMONIK_LAUNCHER=1"\r\n"${executable}" "${entry.replaceAll('%', '%%')}" %*\r\nexit /b %errorlevel%\r\n`;
  }
  return `#!/bin/sh\n# ${marker}\nif [ ! -x ${shellQuote(node)} ]; then\n  echo '${missingNode}' >&2\n  exit 1\nfi\nexec ${shellQuote(node)} ${shellQuote(entry)} "$@"\n`;
}
/** Marker plus the complete command shape, with no extra executable lines. */
function pinnedOwned(
  match: RegExpExecArray,
  entry: string,
  decode: (value: string) => string
): boolean {
  const checked = match[1];
  const executed = match[2];
  const target = match[3];
  return (
    checked !== undefined &&
    executed !== undefined &&
    target !== undefined &&
    decode(checked) === decode(executed) &&
    isAbsolute(decode(checked)) &&
    decode(target) === entry
  );
}
function owned(bytes: Buffer, entry: string, platform: NodeJS.Platform): boolean {
  const text = bytes.toString().replaceAll('\r\n', '\n');
  if (platform === 'win32') {
    const decode = (value: string) => value.replaceAll('%%', '%');
    const pinned =
      /^@echo off\nrem --mnemonik-owner=cli\nsetlocal DisableDelayedExpansion\nif not exist "([^"]+)" \(\n[ ]{2}echo The Node installation that Mnemonik was set up with has moved; run the install command again\. 1>&2\n[ ]{2}exit \/b 1\n\)\n(?:set "MNEMONIK_LAUNCHER=1"\n)?"([^"]+)" "([^"]+)" %\*(?: & exit \/b\n?|\nexit \/b %errorlevel%\n?)$/.exec(
        text
      );
    if (pinned) return pinnedOwned(pinned, entry, decode);
    const legacy =
      /^@echo off\nrem --mnemonik-owner=cli\nsetlocal DisableDelayedExpansion\nnode "([^"]+)" %\*\nexit \/b %errorlevel%\n?$/.exec(
        text
      );
    const legacyTarget = legacy?.[1];
    return legacyTarget !== undefined && decode(legacyTarget) === entry;
  }
  const decode = (value: string) => value.replace(/\\([\\"$`])/g, '$1');
  const quoted = '((?:[^"\\\\$`]|\\\\[\\\\"$`])*)';
  const pinned = new RegExp(
    `^#!/bin/sh\\n# --mnemonik-owner=cli\\nif \\[ ! -x "${quoted}" \\]; then\\n  echo '${missingNode.replace('.', '\\.')}' >&2\\n  exit 1\\nfi\\nexec "${quoted}" "${quoted}" "\\$@"\\n?$`
  ).exec(text);
  if (pinned) return pinnedOwned(pinned, entry, decode);
  const legacy = new RegExp(
    `^#!/bin/sh\\n# --mnemonik-owner=cli\\nexec node "${quoted}" "\\$@"\\n?$`
  ).exec(text);
  const legacyTarget = legacy?.[1];
  return legacyTarget !== undefined && decode(legacyTarget) === entry;
}
export function launcherPathAction(options: LauncherOptions = {}): string {
  const { platform, env } = locations(options);
  if (platform === 'win32') return 'Open a new terminal, then run mnemonik status.';
  const shell = basename(env.SHELL ?? '');
  if (shell === 'fish')
    return 'Run fish_add_path ~/.local/bin; mnemonik works in a new terminal after that.';
  const line = 'export PATH="$HOME/.local/bin:$PATH"';
  const profile =
    shell === 'zsh'
      ? '~/.zshrc'
      : shell === 'bash'
        ? platform === 'darwin'
          ? '~/.bashrc and ~/.bash_profile'
          : '~/.bashrc'
        : undefined;
  if (!profile)
    return `Add ${line} to the start-up file of the shell you use; your shell could not be detected. mnemonik works in a new terminal after that.`;
  return `Add ${line} to ${profile}; mnemonik works in a new terminal after that.`;
}
export async function launcherStatus(options: LauncherOptions = {}): Promise<LauncherStatus> {
  const loc = locations(options);
  let ownership: LauncherStatus['ownership'];
  try {
    const bytes = await bytesAt(loc.path);
    ownership =
      bytes === null ? 'missing' : owned(bytes, loc.entry, loc.platform) ? 'ours' : 'not_ours';
  } catch (error) {
    if (!/^target_(symlink|not_regular):/.test((error as Error).message)) throw error;
    ownership = 'not_ours';
  }
  const path = Object.entries(loc.env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  const onPath =
    loc.platform === 'win32'
      ? windowsPathIncludes(path, loc.directory, loc.env)
      : path.split(':').some((part) => part !== '' && resolve(part) === resolve(loc.directory));
  const action =
    ownership === 'not_ours'
      ? `Move the existing ${loc.path} aside yourself, then run ${fallback} install.`
      : ownership === 'missing'
        ? `Run ${fallback} repair.`
        : onPath
          ? 'mnemonik status'
          : launcherPathAction(options);
  return {
    path: loc.path,
    directory: loc.directory,
    ownership,
    onPath,
    action: !onPath && ownership !== 'ours' ? `${action} ${launcherPathAction(options)}` : action,
  };
}
export class LauncherError extends Error {
  readonly status = 'ACTION_REQUIRED';
  constructor(
    readonly launcher: LauncherStatus,
    reason = 'launcher_not_ours'
  ) {
    super(`${reason}: ${launcher.path}. ${launcher.action}`);
  }
}

/** A write-ahead record keeps PATH recovery independent of host/scanner journals. */
export async function ensureLauncher(options: LauncherOptions = {}): Promise<LauncherStatus> {
  const loc = locations(options);
  const node = await realpath(process.execPath);
  const desired = Buffer.from(contents(loc.entry, node, loc.platform));
  return withLock(loc.record, 1000, async (assertOwned) => {
    const status = await launcherStatus(options);
    if (status.ownership === 'not_ours') throw new LauncherError(status);
    const saved = await bytesAt(loc.record);
    const record: LauncherRecord = saved
      ? (JSON.parse(saved.toString()) as LauncherRecord)
      : { path: loc.path, entry: loc.entry, node, phase: 'installing' };
    if (record.path !== loc.path || record.entry !== loc.entry || record.phase === 'removing')
      throw new LauncherError(
        { ...status, action: `${fallback} uninstall` },
        'launcher_record_conflict'
      );
    const current = await bytesAt(loc.path);
    const needsWrite = current === null || !current.equals(desired);
    if (
      status.ownership === 'ours' &&
      record.phase === 'installed' &&
      record.node === node &&
      !needsWrite
    )
      return status;
    record.phase = 'installing';
    record.node = node;
    if (loc.platform === 'win32' && !record.windowsPath) {
      const before = await readWindowsUserPath(options);
      record.windowsPath = { before, after: appendWindowsPath(before, loc.directory, loc.env) };
    }
    const save = () =>
      atomicWrite(loc.record, Buffer.from(JSON.stringify(record)), undefined, assertOwned);
    await save();
    if (needsWrite) {
      await mkdir(loc.directory, { recursive: true });
      await assertOwned();
      if (current !== null) {
        if ((await launcherStatus(options)).ownership !== 'ours') throw new LauncherError(status);
        await rm(loc.path);
      }
      // Exclusive creation also refuses a competing file created after the ownership check.
      const file = await open(loc.path, 'wx', 0o755);
      try {
        await file.writeFile(desired);
        if (loc.platform !== 'win32') await file.chmod(0o755);
        await file.sync();
      } finally {
        await file.close();
      }
    }
    if (record.windowsPath) {
      const current = await readWindowsUserPath(options);
      if (!same(current, record.windowsPath.after)) {
        if (!same(current, record.windowsPath.before))
          throw new LauncherError(
            { ...status, action: `${fallback} uninstall` },
            'user_path_changed'
          );
        await assertOwned();
        await writeWindowsUserPath(current, record.windowsPath.after, options);
      }
    }
    record.phase = 'installed';
    await save();
    return launcherStatus(options);
  });
}

export async function removeLauncher(options: LauncherOptions = {}): Promise<boolean> {
  const loc = locations(options);
  return withLock(loc.record, 1000, async (assertOwned) => {
    const status = await launcherStatus(options);
    const bytes = await bytesAt(loc.record);
    if (!bytes && status.ownership === 'missing') return false;
    if (status.ownership === 'not_ours') throw new LauncherError(status);
    const record: LauncherRecord = bytes
      ? (JSON.parse(bytes.toString()) as LauncherRecord)
      : { path: loc.path, entry: loc.entry, phase: 'removing' };
    if (record.path !== loc.path || record.entry !== loc.entry)
      throw new LauncherError(status, 'launcher_record_conflict');
    record.phase = 'removing';
    await atomicWrite(loc.record, Buffer.from(JSON.stringify(record)), undefined, assertOwned);
    const change = record.windowsPath;
    if (change && !same(change.before, change.after)) {
      const current = await readWindowsUserPath(options);
      const preferredIndex = change.after?.value
        .split(';')
        .findIndex((part) => windowsPathIncludes(part, loc.directory, loc.env));
      const restored = same(current, change.after)
        ? change.before
        : current && {
            ...current,
            value: removeWindowsPathEntry(
              current.value,
              loc.directory,
              preferredIndex ?? -1,
              loc.env
            ),
          };
      if (!same(current, restored)) await writeWindowsUserPath(current, restored, options);
    }
    await assertOwned();
    // Recheck ownership before removing the file or scheduling its removal.
    if ((await launcherStatus(options)).ownership === 'not_ours') throw new LauncherError(status);
    if (loc.platform === 'win32' && loc.env.MNEMONIK_LAUNCHER === '1') {
      // cmd.exe is still reading this launcher, so the file is removed by a
      // separate PowerShell process that starts after Node has returned.
      // PowerShell exits without running when Node spawns it detached, so an
      // ordinary awaited PowerShell starts the helper through Start-Process,
      // which outlives this process; the helper's script travels encoded so no
      // quoting applies to the path.
      const helper = Buffer.from(
        `Start-Sleep -Seconds 2; Remove-Item -LiteralPath '${loc.path.replaceAll("'", "''")}' -Force`,
        'utf16le'
      ).toString('base64');
      await new Promise<void>((resolve, reject) => {
        const child = (options.spawn ?? nodeSpawn)(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `Start-Process -FilePath powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','${helper}')`,
          ],
          { stdio: 'ignore', windowsHide: true }
        );
        child.once('error', reject);
        child.once('exit', (code) =>
          code === 0 ? resolve() : reject(new Error(`launcher_removal_helper_${code ?? 'signal'}`))
        );
      });
      options.instruction?.('The command file is removed a moment after this command finishes.');
    } else await rm(loc.path, { force: true });
    await rm(loc.record, { force: true });
    return true;
  });
}
