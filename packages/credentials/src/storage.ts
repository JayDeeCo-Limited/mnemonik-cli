import { createHash } from 'node:crypto';
import { lstat as nodeLstat, mkdir, open, readdir, rmdir, unlink } from 'node:fs/promises';
import { constants, realpathSync, type Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import {
  atomicWrite,
  stateDirectory,
  verifyWindowsCurrentUserOnly,
  windowsCurrentUserAcl,
  type ExecFile,
  type Fault,
  type WindowsAclRun,
} from '@mnemonik/local-setup';

export { stateDirectory };

export type CredentialFailureReason =
  | 'symlink_rejected'
  | 'wrong_owner'
  | 'weak_permissions'
  | 'not_regular_file'
  | 'path_outside_state'
  | 'acl_identity_unavailable';

export class CredentialError extends Error {
  constructor(
    public readonly reason: CredentialFailureReason,
    message: string = reason
  ) {
    super(message);
    this.name = 'CredentialError';
  }
}

/** What the person does about a linked state root (the reason stays symlink_rejected). */
const STATE_ROOT_LINK_MESSAGE =
  'The Mnemonik state directory is a symbolic link. Replace it with a real directory, ' +
  'or set MNEMONIK_STATE_DIR to one.';

type Lstat = (path: string) => Promise<Stats>;
export interface SecureFileOptions {
  stateDir?: string;
  platform?: NodeJS.Platform;
  lstat?: Lstat;
  uid?: number;
  fault?: Fault;
  execFile?: ExecFile;
  username?: string;
  /** Native runner for the Windows ACL reader; tests inject fixture output. */
  aclRun?: WindowsAclRun;
}

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

export function credentialPaths(stateDir = stateDirectory(), familyId?: string) {
  const root = join(stateDir, 'credentials');
  const familyName = familyId ? digest(familyId) : '';
  return {
    root,
    records: join(root, 'records'),
    secrets: join(root, 'secrets'),
    cliRecord: join(root, 'records', 'cli.json'),
    cliSecret: join(root, 'secrets', 'cli.json'),
    rootRecord: join(root, 'records', 'root-binding.json'),
    rootSecret: join(root, 'secrets', 'root-binding.key'),
    familyRecords: join(root, 'records', 'families'),
    familySecrets: join(root, 'secrets', 'families'),
    record: join(root, 'records', 'families', `${familyName}.json`),
    secret: join(root, 'secrets', 'families', `${familyName}.json`),
  };
}

const codeIs = (error: unknown, code: string): boolean =>
  (error as NodeJS.ErrnoException).code === code;

/**
 * The canonical spelling of a (possibly not yet created) directory: realpath of its longest
 * existing prefix, with the missing tail appended as given.
 */
function canonicalDirectory(path: string): string {
  const missing: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(realpathSync.native(current), ...missing.reverse());
    } catch (error) {
      const parent = dirname(current);
      if (!codeIs(error, 'ENOENT') || parent === current) return resolve(path);
      missing.push(basename(current));
      current = parent;
    }
  }
}

/**
 * Symlink policy (the credential store design: "reject symlinks, wrong ownership, weak permissions"): the
 * directories ABOVE the configured state root are canonicalized once, at construction, and
 * trusted - the user's home or the OS temp directory may legitimately be reached through a
 * link (/home -> /data/home, macOS /var -> /private/var), and refusing those made every
 * credential operation fail. The root itself is not resolved: it and every component inside
 * it are lstat()ed on each use and a symbolic link there is refused (symlink_rejected; for
 * the root, with a message saying what to do), as are wrong owners and modes; the final open
 * adds O_NOFOLLOW. A root that is a link when configured, or is planted as one later, is
 * refused alike.
 */
export class SecureFiles {
  readonly stateDir: string;
  /** The root as configured; paths spelled through it are rebased onto `stateDir`. */
  private readonly configuredStateDir: string;
  private readonly platform: NodeJS.Platform;
  private readonly lstat: Lstat;
  private readonly uid: number | undefined;
  private readonly fault?: Fault;
  private readonly execFile?: ExecFile;
  private readonly username?: string;
  private readonly aclRun?: WindowsAclRun;

  constructor(options: SecureFileOptions = {}) {
    this.configuredStateDir = resolve(options.stateDir ?? stateDirectory());
    // Only the ancestors are resolved: following the root would trust wherever a link
    // there points.
    this.stateDir = join(
      canonicalDirectory(dirname(this.configuredStateDir)),
      basename(this.configuredStateDir)
    );
    this.platform = options.platform ?? process.platform;
    this.lstat = options.lstat ?? nodeLstat;
    this.uid = options.uid ?? process.getuid?.();
    this.fault = options.fault;
    this.execFile = options.execFile;
    this.username = options.username;
    this.aclRun = options.aclRun;
  }

  private assertInsideState(path: string): string {
    let absolute = resolve(path);
    const fromConfigured = relative(this.configuredStateDir, absolute);
    if (
      this.configuredStateDir !== this.stateDir &&
      fromConfigured !== '..' &&
      !fromConfigured.startsWith(`..${sep}`) &&
      !isAbsolute(fromConfigured)
    )
      absolute = join(this.stateDir, fromConfigured);
    const fromState = relative(this.stateDir, absolute);
    if (fromState === '..' || fromState.startsWith(`..${sep}`) || isAbsolute(fromState))
      throw new CredentialError('path_outside_state');
    return absolute;
  }

  private components(path: string): string[] {
    const absolute = resolve(path);
    const root = parse(absolute).root;
    const parts = absolute.slice(root.length).split(sep).filter(Boolean);
    const result: string[] = [];
    let current = root;
    for (const part of parts) {
      current = join(current, part);
      result.push(current);
    }
    return result;
  }

  private async inspect(path: string, expectFile: boolean, allowMissing: boolean): Promise<void> {
    const absolute = this.assertInsideState(path);
    for (const component of this.components(absolute)) {
      // Above the canonical root is trusted (see the class comment).
      if (component !== this.stateDir && !component.startsWith(`${this.stateDir}${sep}`)) continue;
      let value: Stats;
      try {
        value = await this.lstat(component);
      } catch (error) {
        if (allowMissing && codeIs(error, 'ENOENT')) continue;
        throw error;
      }
      if (value.isSymbolicLink())
        throw new CredentialError(
          'symlink_rejected',
          component === this.stateDir ? STATE_ROOT_LINK_MESSAGE : undefined
        );
      const final = component === absolute;
      if (this.platform === 'win32') {
        // Windows has no uid or mode bits to read; the DACL is the permission.
        // Only the path being used is read, one icacls export per call (L-131).
        if (final) await this.verifyWindowsPrivate(component);
      } else {
        if (this.uid !== undefined && value.uid !== this.uid)
          throw new CredentialError('wrong_owner');
        const allowed = final && expectFile ? 0o600 : 0o700;
        if ((value.mode & 0o777 & ~allowed) !== 0) throw new CredentialError('weak_permissions');
      }
      if (final && expectFile && !value.isFile()) throw new CredentialError('not_regular_file');
      if (final && !expectFile && !value.isDirectory())
        throw new CredentialError('not_regular_file');
    }
  }

  private async verifyWindowsPrivate(path: string): Promise<void> {
    try {
      await verifyWindowsCurrentUserOnly(path, this.stateDir, this.aclRun);
    } catch (error) {
      if ((error as Error).message === 'acl_permissions')
        throw new CredentialError('weak_permissions');
      throw error;
    }
  }

  private async makeDirectory(path: string): Promise<void> {
    let created = false;
    try {
      await mkdir(path, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (!codeIs(error, 'EEXIST')) throw error;
    }
    if (this.platform === 'win32')
      await windowsCurrentUserAcl(
        path,
        true,
        { execFile: this.execFile, username: this.username },
        created
      );
    await this.inspect(path, false, false);
  }

  async ensureParent(path: string): Promise<void> {
    const absolute = this.assertInsideState(path);
    await this.inspect(absolute, true, true);
    for (const component of this.components(dirname(absolute))) {
      if (component === this.stateDir || component.startsWith(`${this.stateDir}${sep}`))
        await this.makeDirectory(component);
    }
    await this.inspect(dirname(absolute), false, false);
  }

  async read(path: string): Promise<Buffer | null> {
    const absolute = this.assertInsideState(path);
    try {
      await this.inspect(absolute, true, false);
      const noFollow = this.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
      const handle = await open(absolute, constants.O_RDONLY | noFollow);
      try {
        return await handle.readFile();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (codeIs(error, 'ENOENT')) return null;
      if (codeIs(error, 'ELOOP')) throw new CredentialError('symlink_rejected');
      throw error;
    }
  }

  async write(path: string, bytes: Buffer, point: string): Promise<void> {
    const absolute = this.assertInsideState(path);
    await this.ensureParent(absolute);
    await this.inspect(absolute, true, true);
    try {
      await atomicWrite(absolute, bytes, async (atomicPoint) => {
        await this.fault?.(atomicPoint === 'mid_write' ? `before_${point}_rename` : atomicPoint);
      });
    } catch (error) {
      const prefix = `${basename(absolute)}.`;
      for (const name of await this.list(dirname(absolute))) {
        if (name.startsWith(prefix) && name.endsWith('.tmp'))
          await this.remove(join(dirname(absolute), name));
      }
      throw error;
    }
    if (this.platform === 'win32')
      await windowsCurrentUserAcl(absolute, false, {
        execFile: this.execFile,
        username: this.username,
      });
    await this.inspect(absolute, true, false);
  }

  async remove(path: string): Promise<void> {
    const absolute = this.assertInsideState(path);
    try {
      await this.inspect(absolute, true, false);
      await unlink(absolute);
    } catch (error) {
      if (!codeIs(error, 'ENOENT')) throw error;
    }
  }

  async list(path: string): Promise<string[]> {
    const absolute = this.assertInsideState(path);
    try {
      await this.inspect(absolute, false, false);
      return await readdir(absolute);
    } catch (error) {
      if (codeIs(error, 'ENOENT')) return [];
      throw error;
    }
  }

  async removeEmptyDirectories(paths: string[]): Promise<void> {
    for (const path of paths) {
      try {
        await this.inspect(path, false, false);
        await rmdir(path);
      } catch (error) {
        if (!codeIs(error, 'ENOENT') && !codeIs(error, 'ENOTEMPTY')) throw error;
      }
    }
  }
}
