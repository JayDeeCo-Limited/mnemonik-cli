import { createHash, randomBytes } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

const LOCK_STALE_MS = 120_000;
const LOCK_RETRIES = 100;
const LOCK_RETRY_MS = 20;

interface NodeError extends Error {
  code?: string;
}

/** @internal Shared by settings I/O and runtime installation error handling. */
export function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as NodeError).code)
    : undefined;
}

function defaultRuntimeParent(
  env: Partial<Record<'HOME' | 'USERPROFILE', string | undefined>> = process.env
): string {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  if (!home) throw new Error('Could not determine home directory for Mnemonik settings locks');
  return join(home, '.mnemonik', 'hooks');
}

/** Non-invasive lock location shared by installers and settings editors. */
export function installerConfigLockPath(
  configPath: string,
  runtimeParent = defaultRuntimeParent()
): string {
  const key = createHash('sha256').update(resolve(configPath)).digest('hex').slice(0, 32);
  return join(runtimeParent, '.config-locks', `${key}.lock`);
}

async function canonicalMissingTarget(path: string): Promise<string> {
  let cursor = resolve(path);
  const missingSegments: string[] = [];
  while (true) {
    try {
      return resolve(await realpath(cursor), ...missingSegments);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) {
        throw new Error(`Refusing dangling configuration path symlink ${cursor}`);
      }
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error(`Could not canonicalize configuration path ${path}`);
    missingSegments.unshift(basename(cursor));
    cursor = parent;
  }
}

async function canonicalConfigTargetPath(path: string): Promise<string> {
  const absolutePath = resolve(path);
  try {
    return await realpath(absolutePath);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  return canonicalMissingTarget(absolutePath);
}

/** Resolve aliases before locking or updating configuration files. */
export async function canonicalizeConfigTargets(paths: string[]): Promise<string[]> {
  return Promise.all(paths.map((path) => canonicalConfigTargetPath(path)));
}

/** @internal Shared by atomic settings writes and durable runtime installation. */
export async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Some Node platforms cannot fsync directories. Files are synced first.
  }
}

function lockOwnerIsAlive(raw: string): boolean {
  const pid = Number.parseInt(raw.split(/\s+/, 1)[0] ?? '', 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

async function removeStaleLock(lockPath: string): Promise<boolean> {
  const info = await lstat(lockPath);
  if (!info.isDirectory()) {
    throw new Error(`Refusing unsafe non-directory installer lock ${lockPath}`);
  }
  if (Date.now() - info.mtimeMs <= LOCK_STALE_MS) return false;
  const entries = await readdir(lockPath);
  if (entries.length === 0) {
    try {
      await rmdir(lockPath);
      return true;
    } catch (error) {
      if (['ENOENT', 'ENOTEMPTY'].includes(errorCode(error) ?? '')) return false;
      throw error;
    }
  }
  if (entries.length !== 1 || !entries[0].startsWith('owner-')) return false;
  const tokenPath = join(lockPath, entries[0]);
  const owner = await readFile(tokenPath, 'utf8');
  if (lockOwnerIsAlive(owner)) return false;
  try {
    await unlink(tokenPath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
  try {
    await rmdir(lockPath);
    return true;
  } catch (error) {
    if (['ENOENT', 'ENOTEMPTY'].includes(errorCode(error) ?? '')) return false;
    throw error;
  }
}

async function acquireLock(lockPath: string): Promise<string> {
  await mkdir(dirname(lockPath), { recursive: true });
  const owner = `${process.pid} ${Date.now()} ${randomBytes(12).toString('hex')}\n`;
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      const tokenPath = join(lockPath, `owner-${process.pid}-${randomBytes(12).toString('hex')}`);
      const handle = await open(tokenPath, 'wx', 0o600);
      try {
        await handle.writeFile(owner, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(lockPath);
      await syncDirectory(dirname(lockPath));
      return tokenPath;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') {
        await rmdir(lockPath).catch(() => undefined);
        if (errorCode(error) === 'ENOENT') continue;
        throw error;
      }
      try {
        if (await removeStaleLock(lockPath)) continue;
      } catch (inspectError) {
        if (errorCode(inspectError) === 'ENOENT') continue;
        throw inspectError;
      }
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, LOCK_RETRY_MS));
    }
  }
  throw new Error(`Timed out waiting for installer lock ${lockPath}`);
}

export async function withFileLock<T>(lockPath: string, action: () => Promise<T>): Promise<T> {
  const tokenPath = await acquireLock(lockPath);
  try {
    return await action();
  } finally {
    try {
      await unlink(tokenPath);
      await rmdir(lockPath);
      await syncDirectory(dirname(lockPath));
    } catch {
      // A stale owner never removes a missing token or a successor lock.
    }
  }
}

export async function withFileLocks<T>(lockPaths: string[], action: () => Promise<T>): Promise<T> {
  const ordered = [...new Set(lockPaths)].sort();
  const acquire = (index: number): Promise<T> =>
    index >= ordered.length ? action() : withFileLock(ordered[index], () => acquire(index + 1));
  return acquire(0);
}

export async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

async function writableTarget(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        throw new Error(`Refusing to replace dangling configuration symlink ${path}`);
      }
    } catch (inspectError) {
      if (errorCode(inspectError) !== 'ENOENT') throw inspectError;
    }
    return path;
  }
}

export async function atomicWriteText(
  path: string,
  next: string,
  expectedCurrent: string | null,
  options: { mode?: number } = {}
): Promise<void> {
  const target = await writableTarget(path);
  await mkdir(dirname(target), { recursive: true });
  const current = await readTextIfExists(target);
  if (current !== expectedCurrent) {
    throw new Error(`Configuration changed concurrently while installing: ${path}`);
  }

  let mode = options.mode ?? 0o600;
  try {
    mode = (await stat(target)).mode & 0o777;
    if ((mode & 0o222) === 0) throw new Error(`Configuration is not writable: ${path}`);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }

  const tempPath = join(
    dirname(target),
    `.${join(target).split(/[\\/]/).pop()}.mnemonik-${process.pid}-${randomBytes(6).toString('hex')}`
  );
  let handle;
  try {
    handle = await open(tempPath, 'wx', mode);
    await handle.writeFile(next, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;

    // Node has no pathname compare-and-swap rename. Keeping this final check
    // next to rename narrows the race, but another writer can still change the
    // pathname after the read and before the rename.
    if ((await readTextIfExists(target)) !== expectedCurrent) {
      throw new Error(`Configuration changed concurrently while installing: ${path}`);
    }
    await rename(tempPath, target);
    await syncDirectory(dirname(target));
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

export async function atomicRestoreText(
  path: string,
  original: string | null,
  expectedCurrent: string
): Promise<void> {
  if (original !== null) {
    await atomicWriteText(path, original, expectedCurrent);
    return;
  }
  await atomicRemoveText(path, expectedCurrent);
}

async function restoreQuarantinedText(path: string, quarantine: string): Promise<void> {
  try {
    await link(quarantine, path);
    await unlink(quarantine);
    await syncDirectory(dirname(path));
  } catch (error) {
    throw new Error(
      `Could not restore concurrently changed configuration; preserved it at ${quarantine}`,
      { cause: error }
    );
  }
}

async function atomicRemoveText(path: string, expectedCurrent: string): Promise<void> {
  const quarantine = join(
    dirname(path),
    `.${join(path).split(/[\\/]/).pop()}.mnemonik-remove-${process.pid}-${randomBytes(6).toString('hex')}`
  );
  try {
    await rename(path, quarantine);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      throw new Error(`Configuration changed concurrently while removing: ${path}`);
    }
    throw error;
  }
  const info = await lstat(quarantine);
  const current = info.isFile() ? await readFile(quarantine, 'utf8') : null;
  if (!info.isFile() || current !== expectedCurrent) {
    await restoreQuarantinedText(path, quarantine);
    throw new Error(
      info.isSymbolicLink()
        ? `Refusing to remove configuration symlink ${path}`
        : `Configuration changed concurrently while removing: ${path}`
    );
  }
  await unlink(quarantine);
  await syncDirectory(dirname(path));
}

export interface AtomicTextChange {
  path: string;
  expected: string | null;
  next: string | null;
}

async function applyTextChange(change: AtomicTextChange): Promise<void> {
  if (change.next !== null) {
    await atomicWriteText(change.path, change.next, change.expected);
    return;
  }
  if (change.expected !== null) await atomicRemoveText(change.path, change.expected);
}

async function rollBackTextChange(change: AtomicTextChange): Promise<void> {
  if (change.expected === null) {
    if (change.next !== null) await atomicRemoveText(change.path, change.next);
    return;
  }
  await atomicWriteText(change.path, change.expected, change.next);
}

export async function atomicWriteTransaction(changes: AtomicTextChange[]): Promise<void> {
  const effective = changes.filter((change) => change.next !== change.expected);
  const canonicalPaths = await canonicalizeConfigTargets(effective.map((change) => change.path));
  if (new Set(canonicalPaths).size !== effective.length) {
    throw new Error('Atomic configuration transaction contains duplicate paths');
  }
  const applied: AtomicTextChange[] = [];
  try {
    for (const change of effective) {
      await applyTextChange(change);
      applied.push(change);
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const change of applied.reverse()) {
      try {
        await rollBackTextChange(change);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        'Configuration transaction failed and rollback was incomplete'
      );
    }
    throw error;
  }
}
