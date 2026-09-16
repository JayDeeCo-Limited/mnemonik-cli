import { type Stats } from 'node:fs';
import { stateDirectory, type ExecFile, type Fault } from '@mnemonik/local-setup';
export { stateDirectory };
export type CredentialFailureReason = 'symlink_rejected' | 'wrong_owner' | 'weak_permissions' | 'not_regular_file' | 'path_outside_state' | 'acl_identity_unavailable';
export declare class CredentialError extends Error {
    readonly reason: CredentialFailureReason;
    constructor(reason: CredentialFailureReason);
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
export declare class SecureFiles {
    readonly stateDir: string;
    private readonly platform;
    private readonly lstat;
    private readonly uid;
    private readonly fault?;
    private readonly execFile?;
    private readonly username?;
    constructor(options?: SecureFileOptions);
    private assertInsideState;
    private components;
    private inspect;
    private makeDirectory;
    ensureParent(path: string): Promise<void>;
    read(path: string): Promise<Buffer | null>;
    write(path: string, bytes: Buffer, point: string): Promise<void>;
    remove(path: string): Promise<void>;
    list(path: string): Promise<string[]>;
    removeEmptyDirectories(paths: string[]): Promise<void>;
}
//# sourceMappingURL=storage.d.ts.map