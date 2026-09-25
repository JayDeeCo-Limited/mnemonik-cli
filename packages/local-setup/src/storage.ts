import {
  verifyWindowsAcl,
  windowsCurrentAccountSync,
  type Execute,
} from '@mnemonik/shared/hook-runtime';
import { createHash, randomUUID } from 'node:crypto';
import { execFile as nodeExecFile } from 'node:child_process';
import fs from 'node:fs';
import {
  open,
  rename,
  readFile,
  mkdir,
  lstat,
  chmod,
  writeFile,
  unlink,
  rmdir,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, win32, posix } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RuntimeError } from '@mnemonik/shared/hook-runtime';

const lockfileKey = Symbol.for('mnemonik.proper-lockfile');
type Lockfile = typeof import('proper-lockfile');
type SharedLockfile = typeof globalThis & { [key: symbol]: Promise<Lockfile> | undefined };
function sharedLockfile(): Promise<Lockfile> {
  const shared = globalThis as SharedLockfile;
  return (shared[lockfileKey] ??= import('proper-lockfile').then(
    (module) => (module as unknown as { default: Lockfile }).default
  ));
}

export const hash = (bytes: string | Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');
export const codeIs = (error: unknown, code: string): boolean =>
  (error as NodeJS.ErrnoException).code === code;
export function stateDirectory(
  platform = process.platform,
  env = process.env,
  home = homedir()
): string {
  if (env.MNEMONIK_STATE_DIR) return env.MNEMONIK_STATE_DIR;
  if (platform === 'win32')
    return win32.join(env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local'), 'Mnemonik');
  if (platform === 'darwin') return posix.join(home, 'Library', 'Application Support', 'Mnemonik');
  return posix.join(env.XDG_STATE_HOME || posix.join(home, '.local', 'state'), 'mnemonik');
}
export const recordPath = (root: string, state = stateDirectory()): string =>
  join(state, 'project-setup', `${hash(root)}.json`);
export async function readBytes(path: string): Promise<Buffer | null> {
  try {
    if (!(await lstat(path)).isFile()) throw new Error('setup_requires_regular_file');
    return await readFile(path);
  } catch (error) {
    if (codeIs(error, 'ENOENT')) return null;
    throw error;
  }
}
export async function syncDirectory(path: string): Promise<void> {
  // Windows does not expose directory fsync through Node. File fsync still runs.
  if (process.platform === 'win32') return;
  const fd = await open(path, 'r');
  try {
    await fd.sync();
  } finally {
    await fd.close();
  }
}
export type PermissionStatus = 'private' | 'acl_pending';
export type ExecFile = (
  file: string,
  args: readonly string[],
  callback: (error: Error | null, stdout: string, stderr: string) => void
) => unknown;
/** Resolve the process token: OpenSSH can advertise WORKGROUP as USERDOMAIN. */
export const windowsCurrentAccount = windowsCurrentAccountSync;
/** Only a path this process just created may have privileged grants stripped;
 *  a pre-existing one must be refused by validation rather than repaired. */
export async function windowsCurrentUserAcl(
  path: string,
  directory = false,
  options: { execFile?: ExecFile; username?: string } = {},
  created = false
): Promise<void> {
  const username = options.username ?? `*${windowsCurrentAccount().sid}`;
  const grant = `${username}:${directory ? '(OI)(CI)F' : 'F'}`;
  const execFile = options.execFile ?? (nodeExecFile as unknown as ExecFile);
  await new Promise<void>((resolve, reject) => {
    execFile(
      'icacls.exe',
      [
        path,
        '/inheritance:r',
        '/grant:r',
        grant,
        ...(created ? ['/remove:g', '*S-1-5-32-544', '*S-1-5-18'] : []),
      ],
      (error) => {
        if (error) reject(error);
        else resolve();
      }
    );
  });
}
/** Runs one native command for the Windows ACL reader; injected by tests. */
export type WindowsAclRun = Execute;
/**
 * The Windows counterpart of POSIX mode 0600/0700: every Allow ACE on `path`
 * names the current token's SID, so no other user or group (Users, Everyone)
 * can read it. Throws `acl_permissions` when one does. Reads the DACL through
 * the shared icacls export, whose temporary file lives under `state`.
 */
export async function verifyWindowsCurrentUserOnly(
  path: string,
  state: string,
  run?: WindowsAclRun
): Promise<void> {
  await verifyWindowsAcl(path, run, state);
}
export async function protectStateFile(
  path: string,
  platform = process.platform,
  aclOptions?: { execFile?: ExecFile; username?: string }
): Promise<PermissionStatus> {
  if (platform === 'win32') await windowsCurrentUserAcl(path, false, aclOptions);
  else await chmod(path, 0o600);
  return 'private';
}
export type Fault = (point: string) => void | Promise<void>;
export async function atomicWrite(
  path: string,
  bytes: Buffer,
  fault?: Fault,
  assertOwned?: () => Promise<void>
): Promise<PermissionStatus> {
  await assertOwned?.();
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = await open(temp, 'wx', 0o600);
  let permissionStatus: PermissionStatus;
  try {
    permissionStatus = await protectStateFile(temp);
    const split = Math.ceil(bytes.length / 2);
    await fd.writeFile(bytes.subarray(0, split));
    await fault?.('mid_write');
    await assertOwned?.();
    await fd.writeFile(bytes.subarray(split));
    await fd.sync();
  } finally {
    await fd.close();
  }
  await assertOwned?.();
  await rename(temp, path);
  await syncDirectory(dirname(path));
  return permissionStatus;
}
/** Cooperative mkdir lease: all consumers must use these same stale/update values. */
export async function withLock<T>(
  path: string,
  waitMs: number,
  work: (assertOwned: () => Promise<void>) => Promise<T>
): Promise<T> {
  const lockfile = await sharedLockfile();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const generation = randomUUID();
  const owner = join(`${path}.lock`, 'owner');
  let compromised = false;
  let acquired = false;
  const assertOwned = async () => {
    if (compromised || (await readBytes(owner).catch(() => null))?.toString() !== generation) {
      compromised = true;
      throw new Error('lock_lost');
    }
  };
  // Install the owner before proper-lockfile probes mtime; a later directory write
  // would otherwise invalidate its heartbeat. Reclamation removes the owner too.
  const leaseFs = {
    ...fs,
    mkdir: (dir: string, callback: (error?: NodeJS.ErrnoException | null) => void) => {
      void mkdir(dir)
        .then(() => writeFile(owner, generation, { mode: 0o600, flag: 'wx' }))
        .then(() => callback(), callback);
    },
    rmdir: (dir: string, callback: (error?: NodeJS.ErrnoException | null) => void) => {
      void unlink(join(dir, 'owner'))
        .catch((error) => {
          if (!codeIs(error, 'ENOENT')) throw error;
        })
        .then(() => rmdir(dir))
        .then(() => callback(), callback);
    },
    rmdirSync: (dir: string) => {
      try {
        fs.unlinkSync(join(dir, 'owner'));
      } catch (error) {
        if (!codeIs(error, 'ENOENT')) throw error;
      }
      fs.rmdirSync(dir);
    },
    stat: (
      file: string,
      callback: (error: NodeJS.ErrnoException | null, stats?: fs.Stats) => void
    ) => {
      // A superseded holder must also stop heartbeating the replacement lease.
      void (acquired ? assertOwned() : Promise.resolve()).then(
        () => fs.stat(file, callback),
        () => callback(Object.assign(new Error('lock_lost'), { code: 'ENOENT' }))
      );
    },
  };
  const deadline = performance.now() + waitMs;
  let release: (() => Promise<void>) | undefined;
  while (!release) {
    try {
      release = await lockfile.lock(path, {
        realpath: false,
        stale: 30_000,
        update: 5_000,
        retries: 0,
        fs: leaseFs,
        onCompromised: () => {
          compromised = true;
        },
      });
    } catch (error) {
      if (!codeIs(error, 'ELOCKED')) throw error;
      if (performance.now() >= deadline) throw new RuntimeError('lock_held');
      await delay(Math.min(100, Math.max(1, deadline - performance.now())));
    }
  }
  acquired = true;
  try {
    return await work(assertOwned);
  } finally {
    // Never release a successor's lease. A lost holder's heartbeat observes the
    // generation check above and stops through onCompromised.
    if (
      await assertOwned().then(
        () => true,
        () => false
      )
    )
      await release();
  }
}
