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
  | 'lock_held';
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
  async inspect(
    path: string,
    directory = false,
    allowMissing = false,
    replacing = false
  ): Promise<void> {
    const absolute = this.guardedPath(path);
    const windowsPaths: string[] = [];
    let part = parse(absolute).root;
    for (const name of absolute.slice(part.length).split(sep)) {
      part = join(part, name);
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
    }
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
  async bytes(path: string): Promise<Buffer> {
    await this.inspect(path);
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
    const actual: string[] = [];
    const walk = async (dir: string, prefix = ''): Promise<void> => {
      await this.inspect(dir, true);
      for (const name of await readdir(dir)) {
        const key = prefix + name;
        if (!prefix && name === 'manifest.json') continue;
        const path = join(dir, name);
        if ((await lstat(path)).isDirectory()) await walk(path, key + '/');
        else {
          await this.inspect(path);
          actual.push(key);
        }
      }
    };
    await walk(directory);
    if (actual.sort().join('\n') !== Object.keys(m.files).sort().join('\n'))
      throw new RuntimeError('digest_mismatch');
    let total = 0;
    for (const [name, expected] of Object.entries(m.files)) {
      if (
        !expected ||
        !/^[a-f0-9]{64}$/.test(expected.sha256) ||
        !Number.isSafeInteger(expected.size) ||
        expected.size < 0 ||
        typeof expected.executable !== 'boolean'
      )
        throw new RuntimeError('digest_mismatch');
      const path = join(directory, safePath(name));
      const contents = await this.bytes(path);
      if (hash(contents) !== expected.sha256 || contents.length !== expected.size)
        throw new RuntimeError('digest_mismatch');
      if (
        process.platform !== 'win32' &&
        ((await lstat(path)).mode & 0o777) !== (expected.executable ? 0o700 : 0o600)
      )
        throw new RuntimeError('permission');
      total += contents.length;
    }
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
