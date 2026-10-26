import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { dirname, join, parse, resolve, sep } from 'node:path';
import {
  verifySigner,
  verifyWindowsPermission,
  verifyWindowsAcl,
  prepareWindowsAclDirectory,
  auditWindowsPermissions,
  type WindowsPermission,
  type Execute,
  type Signer,
} from './runtimeSigners.js';

export type HostArtifact = 'claude-code' | 'codex' | 'cursor' | 'grok';
export type Artifact = 'cli' | 'scanner' | HostArtifact;
export type Reason =
  | 'digest_mismatch'
  | 'manifest_missing'
  | 'unsigned'
  | 'permission'
  | 'acl_unavailable'
  | 'lock_held'
  // The registry answered without the package (404, 429 or 5xx): a fresh release
  // still reaching its CDN, a busy registry, or a pin it does not have.
  | 'registry_unavailable'
  // The registry could not be reached at all: offline, DNS, refused, timed out.
  | 'registry_unreachable';
export class RuntimeError extends Error {
  constructor(public readonly reason: Reason) {
    super(reason);
    this.name = 'RuntimeError';
  }
}
export const hash = (bytes: Buffer | string): string =>
  createHash('sha256').update(bytes).digest('hex');
export function safePath(path: string): string {
  if (
    typeof path !== 'string' ||
    !/^[a-zA-Z0-9_@.+/-]+$/.test(path) ||
    path.split('/').some((p) => !p || p === '.' || p === '..') ||
    path.includes(':')
  )
    throw new RuntimeError('permission');
  return path;
}
export interface NpmReceipt {
  name: string;
  version: string;
  integrity: string;
  tarball: string;
  tarballSha256: string;
}
export interface Manifest {
  schemaVersion: 1;
  artifact: Artifact;
  version: string;
  entry: string;
  files: Record<string, { sha256: string; size: number; executable: boolean }>;
  totalSize: number;
  source:
    | { kind: 'npm'; packages: NpmReceipt[]; launchedFrom: string }
    | { kind: 'release'; url: string };
  signer?: Signer;
  signingStatus?: 'unsigned' | 'signed';
  disclosureVersion?: string;
}
export interface RuntimeSource {
  manifest: Manifest;
  files: Record<string, Buffer>;
}
export interface Reference {
  version: string;
  manifestSha256: string;
}
interface Pointer {
  current: Reference;
  previous?: Reference;
}
export interface Verified {
  directory: string;
  manifest: Manifest;
  entry: string;
  reference: Reference;
}
export const missing = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === 'ENOENT';
export const versionName = (v: string): string => {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(v)) throw new RuntimeError('permission');
  return v;
};

/**
 * Filesystem operations one runtime verification keeps in flight. Each file
 * costs a few round trips (lstat, open, read, close); awaited one at a time, a
 * 2,000-file hook runtime took 6.6 s to verify (26 Oct 2026). Every check is
 * still made, for every file.
 */
export const VERIFY_CONCURRENCY = 16;

/** Runs `work` with at most `limit` calls in flight; nested calls must not share a limiter. */
function limiter(limit: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((release) => waiting.push(release));
    active += 1;
    try {
      return await work();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

/**
 * A runtime file's bytes, read from the file that was opened: it must be a
 * regular file (not followed through a link), this user's, with exactly the
 * mode its manifest entry implies. POSIX only.
 */
async function ownedFileBytes(path: string, mode: number): Promise<Buffer> {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: unknown) => {
    // O_NOFOLLOW refuses a link with ELOOP: a link is not an owned file.
    throw (error as NodeJS.ErrnoException).code === 'ELOOP'
      ? new RuntimeError('permission')
      : error;
  });
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== mode)
      throw new RuntimeError('permission');
    return await fd.readFile();
  } finally {
    await fd.close();
  }
}

/**
 * Waits for every promise, then throws the first rejection in order: nothing a
 * failed verification started is still running when it reports.
 */
async function settleAll(work: Promise<unknown>[]): Promise<void> {
  const failed = (await Promise.allSettled(work)).find(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  );
  if (failed) throw failed.reason;
}

const statIdentity = (stat: Stats): string =>
  [stat.dev, stat.ino, stat.mode, stat.uid, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');

/** Only stdlib and the accepted bootstrap's signer adapter may load before verifyRuntime returns. */
export class RuntimeReader {
  readonly state: string;
  private static readonly windowsSignatures = new Map<string, Promise<void>>();
  // Omitted batch verdicts use the per-path fallback before entering the cache.
  private readonly windowsAudit = new Map<
    string,
    { verdict: WindowsPermission; checkedAt: number }
  >();
  private readonly windowsStats = new Map<string, string>();
  private readonly windowsDirectories = new Set<string>();
  private audits: Promise<void> = Promise.resolve();
  private readonly auditsInFlight = new Map<string, Promise<void>>();
  private activeOperation = false;
  private operations: Promise<unknown> = Promise.resolve();
  constructor(
    state: string,
    readonly run?: Execute,
    readonly options: { allowUnsigned?: boolean; cacheDirectories?: boolean } = {},
    private readonly now = () => performance.now()
  ) {
    this.state = resolve(state);
  }
  pointerPath(artifact: Artifact): string {
    if (!['cli', 'scanner', 'claude-code', 'codex', 'cursor', 'grok'].includes(artifact))
      throw new RuntimeError('permission');
    return join(this.state, 'runtimes', artifact, 'current');
  }
  private guardedPath(path: string): string {
    const absolute = resolve(path);
    if (
      (absolute !== this.state && !absolute.startsWith(this.state + sep)) ||
      (process.platform === 'win32' && /[\r\n\t]/.test(absolute))
    )
      throw new RuntimeError('permission');
    return absolute;
  }
  private auditRoot(path: string): string {
    const [area, artifact] = path.slice(this.state.length + 1).split(sep);
    return area === 'runtimes' ? join(this.state, area, ...(artifact ? [artifact] : [])) : path;
  }
  private traceAudit(event: Record<string, unknown>): void {
    const level = process.env.MNEMONIK_AUDIT_TRACE;
    if (level !== '1' && (level !== 'misses' || event.cache === 'hit')) return;
    process.stderr.write(
      JSON.stringify({
        type: 'runtime-audit',
        pid: process.pid,
        module: import.meta.url,
        activeOperation: this.activeOperation,
        ...event,
      }) + '\n'
    );
  }
  private invalidateAudit(path: string): void {
    const root = this.auditRoot(path);
    for (const key of this.windowsAudit.keys())
      if (
        key === root ||
        ((!this.options.cacheDirectories || root.startsWith(join(this.state, 'runtimes') + sep)) &&
          key.startsWith(root + sep))
      )
        this.windowsAudit.delete(key);
  }
  private audit(paths: string[]): Promise<void> {
    const root = this.auditRoot(paths.at(-1) ?? this.state);
    const pending = this.auditsInFlight.get(root);
    if (pending) return pending;
    const audit = this.audits
      .then(() => this.auditPending(paths))
      .finally(() => this.auditsInFlight.delete(root));
    this.auditsInFlight.set(root, audit);
    this.audits = audit.catch(() => {});
    return audit;
  }
  private async auditPending(paths: string[]): Promise<void> {
    if (process.platform !== 'win32') return;
    const pending = new Set<string>();
    for (const path of paths) {
      let part = this.guardedPath(path);
      while (true) {
        const cached = this.windowsAudit.get(part);
        const expired =
          !!cached &&
          !this.activeOperation &&
          !(this.options.cacheDirectories && this.windowsDirectories.has(part)) &&
          this.now() - cached.checkedAt >= 2_000;
        this.traceAudit({
          event: 'cache',
          requested: path,
          path: part,
          root: this.auditRoot(path),
          cache: !cached ? 'miss' : expired ? 'ttl-expired' : 'hit',
        });
        if (!cached || expired) pending.add(part);
        if (part === this.state) break;
        part = dirname(part);
      }
    }
    if (!pending.size) return;
    try {
      const root = this.auditRoot(paths.at(-1) ?? this.state);
      const ancestors = [...pending].filter(
        (path) => path !== root && !path.startsWith(root + sep)
      );
      const tree = [...pending].filter((path) => !ancestors.includes(path));
      for (const part of [...ancestors, ...(tree.length ? [root] : [])]) {
        const recursive = part === root && root.startsWith(join(this.state, 'runtimes') + sep);
        this.traceAudit({ event: 'audit', root: part, recursive });
        const requested = part === root ? tree : [part];
        if (
          this.options.cacheDirectories &&
          !this.windowsDirectories.has(part) &&
          this.windowsAudit.get(part)?.verdict === 'ok'
        ) {
          await verifyWindowsAcl(part, this.run, this.state);
          this.windowsAudit.set(part, { verdict: 'ok', checkedAt: this.now() });
          continue;
        }
        const verdicts = await auditWindowsPermissions(
          part,
          requested,
          this.run,
          recursive,
          this.state
        );
        const checkedAt = this.now();
        for (const path of new Set([...requested, ...verdicts.keys()])) {
          let verdict = verdicts.get(path);
          if (verdict === undefined) {
            await verifyWindowsPermission(path, this.run, this.state);
            verdict = 'ok';
          }
          this.windowsAudit.set(path, { verdict, checkedAt });
        }
      }
    } catch (error) {
      throw new RuntimeError(
        error instanceof Error && error.message === 'acl_permissions'
          ? 'permission'
          : 'acl_unavailable'
      );
    }
  }
  /**
   * `proven` (one verification's own set, POSIX only) holds directories this
   * verification has already inspected in full: their components are not
   * inspected again for every file beneath them, and directories proven here
   * are added to it.
   */
  async inspect(
    path: string,
    directory = false,
    allowMissing = false,
    replacing = false,
    proven?: Set<string>
  ): Promise<void> {
    const absolute = this.guardedPath(path);
    const windowsPaths: string[] = [];
    const remembered = process.platform === 'win32' ? undefined : proven;
    const checkedDirectories: string[] = [];
    // Directories proven by this verification are skipped; when the parent is
    // proven, so is every directory above it.
    const parent = dirname(absolute);
    let part = remembered?.has(parent) ? parent : parse(absolute).root;
    for (const name of absolute.slice(part.length).split(sep).filter(Boolean)) {
      part = join(part, name);
      if (part !== absolute && remembered?.has(part)) continue;
      const stat = await lstat(part).catch((e) => {
        if (allowMissing && missing(e)) return null;
        throw e;
      });
      if (!stat) break;
      if (
        stat.isSymbolicLink() ||
        (part === absolute
          ? directory
            ? !stat.isDirectory()
            : !stat.isFile()
          : !stat.isDirectory())
      )
        throw new RuntimeError('permission');
      if (part !== this.state && !part.startsWith(this.state + sep)) continue;
      if (process.platform === 'win32') {
        if (replacing && part === absolute) continue;
        if (part === this.state && !this.windowsStats.has(part)) {
          await prepareWindowsAclDirectory(this.state, this.run).catch((error: unknown) => {
            throw new RuntimeError(
              error instanceof Error && error.message === 'acl_permissions'
                ? 'permission'
                : 'acl_unavailable'
            );
          });
          // Initial creation is our own write, before this directory enters the cache.
          Object.assign(stat, await lstat(part));
        }
        if (stat.isDirectory()) this.windowsDirectories.add(part);
        const identity = statIdentity(stat);
        const previous = this.windowsStats.get(part);
        if (previous !== undefined && previous !== identity) {
          this.traceAudit({
            event: 'invalidate',
            requested: absolute,
            path: part,
            root: this.auditRoot(part),
            reason: 'stat-identity',
            previous,
            current: identity,
          });
          this.invalidateAudit(part);
        }
        this.windowsStats.set(part, identity);
        windowsPaths.push(part);
      } else if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
        throw new RuntimeError('permission');
      if (stat.isDirectory()) checkedDirectories.push(part);
    }
    if (remembered) for (const checked of checkedDirectories) remembered.add(checked);
    await this.audit(windowsPaths);
    for (const part of windowsPaths) {
      const verdict = this.windowsAudit.get(part)?.verdict;
      if (verdict !== 'ok')
        throw new RuntimeError(
          verdict === undefined || verdict === 'acl_unavailable' ? 'acl_unavailable' : 'permission'
        );
    }
  }
  /** Call only after an owned atomic replacement: its parent ctime is our own write. */
  async recordReplacement(path: string): Promise<void> {
    if (process.platform !== 'win32' || !this.options.cacheDirectories) return;
    const absolute = this.guardedPath(path);
    const parent = dirname(absolute);
    const stat = await lstat(parent);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      !this.windowsStats.get(parent)?.startsWith(`${stat.dev}:${stat.ino}:`)
    )
      throw new RuntimeError('permission');
    this.windowsStats.set(parent, statIdentity(stat));
    this.windowsAudit.delete(absolute);
    this.windowsStats.delete(absolute);
  }
  async bytes(path: string, proven?: Set<string>): Promise<Buffer> {
    await this.inspect(path, false, false, false, proven);
    const fd = await open(
      path,
      constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)
    );
    try {
      return await fd.readFile();
    } finally {
      await fd.close();
    }
  }
  /** An owned inheritable ACL update can change every cached descendant's ctime. */
  protected async recordAclWrite(path: string): Promise<void> {
    const root = this.guardedPath(path);
    for (const known of this.windowsStats.keys())
      if (known === root || known.startsWith(root + sep))
        this.windowsStats.set(known, statIdentity(await lstat(known)));
    this.invalidateAudit(root);
  }
  protected async pointer(artifact: Artifact): Promise<Pointer | undefined> {
    try {
      const p = JSON.parse((await this.bytes(this.pointerPath(artifact))).toString()) as Pointer;
      for (const ref of [p.current, ...(p.previous ? [p.previous] : [])]) {
        versionName(ref.version);
        if (!/^[a-f0-9]{64}$/.test(ref.manifestSha256)) throw new RuntimeError('digest_mismatch');
      }
      return p;
    } catch (e) {
      if (missing(e)) return undefined;
      throw e instanceof RuntimeError ? e : new RuntimeError('digest_mismatch');
    }
  }
  private async operation<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.operations.then(async () => {
      // Reuse this process's audit across inspect/install/verify; stat drift invalidates it.
      this.activeOperation = true;
      try {
        return await work();
      } finally {
        this.activeOperation = false;
      }
    });
    this.operations = operation.catch(() => undefined);
    return operation;
  }
  protected verifyAt(artifact: Artifact, ref: Reference, directory: string): Promise<Verified> {
    return this.operation(() => this.verifyOpen(artifact, ref, directory));
  }
  private async verifyOpen(
    artifact: Artifact,
    ref: Reference,
    directory: string
  ): Promise<Verified> {
    let bytes: Buffer;
    try {
      bytes = await this.bytes(join(directory, 'manifest.json'));
    } catch (e) {
      if (missing(e)) throw new RuntimeError('manifest_missing');
      throw e;
    }
    if (hash(bytes) !== ref.manifestSha256) throw new RuntimeError('digest_mismatch');
    let m: Manifest;
    try {
      m = JSON.parse(bytes.toString()) as Manifest;
    } catch {
      throw new RuntimeError('digest_mismatch');
    }
    if (
      !m ||
      m.schemaVersion !== 1 ||
      !m.source ||
      m.artifact !== artifact ||
      m.version !== ref.version ||
      !m.files ||
      !m.files[safePath(m.entry)]
    )
      throw new RuntimeError('digest_mismatch');
    if (
      artifact === 'scanner' &&
      (m.source.kind !== 'release' ||
        typeof m.source.url !== 'string' ||
        !m.source.url.startsWith('https://') ||
        ((!m.signer || m.signer.platform !== process.platform) &&
          !(this.options.allowUnsigned && !m.signer && m.signingStatus === 'unsigned')))
    )
      throw new RuntimeError('unsigned');
    if (
      artifact === 'cli' &&
      (m.source.kind !== 'npm' ||
        !Array.isArray(m.source.packages) ||
        !m.source.packages.some((p) => p.name === '@mnemonik/cli' && p.version === m.version))
    )
      throw new RuntimeError('unsigned');
    if (process.platform === 'win32')
      await this.audit(Object.keys(m.files).map((name) => join(directory, safePath(name))));
    // Every directory and file is inspected (type, owner, private mode) and
    // every file is read and hashed, as before; up to VERIFY_CONCURRENCY at a
    // time, and each directory's own components only once.
    const actual: string[] = [];
    const proven = new Set<string>();
    // Windows keeps one at a time: its ACL audit shares caches across calls.
    const limit = limiter(process.platform === 'win32' ? 1 : VERIFY_CONCURRENCY);
    const walk = async (dir: string, prefix = ''): Promise<void> => {
      const entries = await limit(async () => {
        await this.inspect(dir, true, false, false, proven);
        return readdir(dir, { withFileTypes: true });
      });
      await settleAll(
        entries.map(async (entry) => {
          const key = prefix + entry.name;
          if (!prefix && entry.name === 'manifest.json') return;
          const path = join(dir, entry.name);
          if (entry.isDirectory()) await walk(path, key + '/');
          else {
            // POSIX: a link or anything else that is not a regular file is
            // refused here, and every listed file's type, owner and exact mode
            // are checked on the file itself when it is read below. Windows
            // inspects each file for its ACL audit.
            if (process.platform === 'win32')
              await limit(() => this.inspect(path, false, false, false, proven));
            else if (!entry.isFile()) throw new RuntimeError('permission');
            actual.push(key);
          }
        })
      );
    };
    await walk(directory);
    if (actual.sort().join('\n') !== Object.keys(m.files).sort().join('\n'))
      throw new RuntimeError('digest_mismatch');
    for (const expected of Object.values(m.files))
      if (
        !expected ||
        !/^[a-f0-9]{64}$/.test(expected.sha256) ||
        !Number.isSafeInteger(expected.size) ||
        expected.size < 0 ||
        typeof expected.executable !== 'boolean'
      )
        throw new RuntimeError('digest_mismatch');
    let total = 0;
    await settleAll(
      Object.entries(m.files).map(([name, expected]) =>
        limit(async () => {
          const path = join(directory, safePath(name));
          const contents =
            process.platform === 'win32'
              ? await this.bytes(path, proven)
              : await ownedFileBytes(path, expected.executable ? 0o700 : 0o600);
          if (hash(contents) !== expected.sha256 || contents.length !== expected.size)
            throw new RuntimeError('digest_mismatch');
          total += contents.length;
        })
      )
    );
    if (total !== m.totalSize) throw new RuntimeError('digest_mismatch');
    if (m.signer) {
      const signer =
        m.signer.platform === 'linux'
          ? { ...m.signer, signature: join(directory, safePath(m.signer.signature)) }
          : m.signer;
      if (m.signer.platform === 'linux' && !m.files[m.signer.signature])
        throw new RuntimeError('unsigned');
      try {
        const entry = join(directory, m.entry);
        if (signer.platform === 'win32') {
          const key = JSON.stringify([entry, m.files[m.entry]?.sha256, signer.identity]);
          let verification = RuntimeReader.windowsSignatures.get(key);
          if (!verification) {
            verification = verifySigner(entry, signer, this.run).catch((error) => {
              RuntimeReader.windowsSignatures.delete(key);
              throw error;
            });
            RuntimeReader.windowsSignatures.set(key, verification);
          }
          await verification;
        } else await verifySigner(entry, signer, this.run);
      } catch {
        throw new RuntimeError('unsigned');
      }
    }
    return { directory, manifest: m, entry: join(directory, m.entry), reference: ref };
  }
  verifyRetainedRuntime(artifact: Artifact, reference: Reference): Promise<Verified> {
    versionName(reference.version);
    return this.verifyAt(
      artifact,
      reference,
      join(dirname(this.pointerPath(artifact)), reference.version)
    );
  }
  async verifyRuntime(artifact: Artifact): Promise<Verified> {
    return this.operation(async () => {
      const p = await this.pointer(artifact);
      if (!p) throw new RuntimeError('manifest_missing');
      // Reading the pointer is not permission to import its target. Only return a verified path.
      return this.verifyOpen(
        artifact,
        p.current,
        join(dirname(this.pointerPath(artifact)), p.current.version)
      );
    });
  }
}

export * from './runtimeSigners.js';
