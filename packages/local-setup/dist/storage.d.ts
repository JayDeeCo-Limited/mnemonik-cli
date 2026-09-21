import { windowsCurrentAccountSync } from '@mnemonik/shared/hook-runtime';
export declare const hash: (bytes: string | Buffer) => string;
export declare const codeIs: (error: unknown, code: string) => boolean;
export declare function stateDirectory(platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv, home?: string): string;
export declare const recordPath: (root: string, state?: string) => string;
export declare function readBytes(path: string): Promise<Buffer | null>;
export declare function syncDirectory(path: string): Promise<void>;
export type PermissionStatus = 'private' | 'acl_pending';
export type ExecFile = (file: string, args: readonly string[], callback: (error: Error | null, stdout: string, stderr: string) => void) => unknown;
/** Resolve the process token: OpenSSH can advertise WORKGROUP as USERDOMAIN. */
export declare const windowsCurrentAccount: typeof windowsCurrentAccountSync;
/** Only a path this process just created may have privileged grants stripped;
 *  a pre-existing one must be refused by validation rather than repaired. */
export declare function windowsCurrentUserAcl(path: string, directory?: boolean, options?: {
    execFile?: ExecFile;
    username?: string;
}, created?: boolean): Promise<void>;
export declare function protectStateFile(path: string, platform?: NodeJS.Platform, aclOptions?: {
    execFile?: ExecFile;
    username?: string;
}): Promise<PermissionStatus>;
export type Fault = (point: string) => void | Promise<void>;
export declare function atomicWrite(path: string, bytes: Buffer, fault?: Fault, assertOwned?: () => Promise<void>): Promise<PermissionStatus>;
/** Cooperative mkdir lease: all consumers must use these same stale/update values. */
export declare function withLock<T>(path: string, waitMs: number, work: (assertOwned: () => Promise<void>) => Promise<T>): Promise<T>;
//# sourceMappingURL=storage.d.ts.map