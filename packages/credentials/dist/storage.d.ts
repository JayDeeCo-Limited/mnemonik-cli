import { type Stats } from 'node:fs';
import { stateDirectory, type ExecFile, type Fault, type WindowsAclRun } from '@mnemonik/local-setup';
export { stateDirectory };
export type CredentialFailureReason = 'symlink_rejected' | 'wrong_owner' | 'weak_permissions' | 'not_regular_file' | 'path_outside_state' | 'acl_identity_unavailable';
export declare class CredentialError extends Error {
    readonly reason: CredentialFailureReason;
    constructor(reason: CredentialFailureReason, message?: string);
}
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
export declare function credentialPaths(stateDir?: string, familyId?: string): {
    root: string;
    records: string;
    secrets: string;
    cliRecord: string;
    cliSecret: string;
    rootRecord: string;
    rootSecret: string;
    familyRecords: string;
    familySecrets: string;
    record: string;
    secret: string;
};
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
export declare class SecureFiles {
    readonly stateDir: string;
    /** The root as configured; paths spelled through it are rebased onto `stateDir`. */
    private readonly configuredStateDir;
    private readonly platform;
    private readonly lstat;
    private readonly uid;
    private readonly fault?;
    private readonly execFile?;
    private readonly username?;
    private readonly aclRun?;
    constructor(options?: SecureFileOptions);
    private assertInsideState;
    private components;
    private inspect;
    private verifyWindowsPrivate;
    private makeDirectory;
    ensureParent(path: string): Promise<void>;
    read(path: string): Promise<Buffer | null>;
    write(path: string, bytes: Buffer, point: string): Promise<void>;
    remove(path: string): Promise<void>;
    list(path: string): Promise<string[]>;
    removeEmptyDirectories(paths: string[]): Promise<void>;
}
//# sourceMappingURL=storage.d.ts.map