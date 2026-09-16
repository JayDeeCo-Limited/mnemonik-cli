/** @internal Shared by settings I/O and runtime installation error handling. */
export declare function errorCode(error: unknown): string | undefined;
/** Non-invasive lock location shared by installers and settings editors. */
export declare function installerConfigLockPath(configPath: string, runtimeParent?: string): string;
/** Resolve aliases before locking or updating configuration files. */
export declare function canonicalizeConfigTargets(paths: string[]): Promise<string[]>;
/** @internal Shared by atomic settings writes and durable runtime installation. */
export declare function syncDirectory(path: string): Promise<void>;
export declare function withFileLock<T>(lockPath: string, action: () => Promise<T>): Promise<T>;
export declare function withFileLocks<T>(lockPaths: string[], action: () => Promise<T>): Promise<T>;
export declare function readTextIfExists(path: string): Promise<string | null>;
export declare function atomicWriteText(path: string, next: string, expectedCurrent: string | null, options?: {
    mode?: number;
}): Promise<void>;
export declare function atomicRestoreText(path: string, original: string | null, expectedCurrent: string): Promise<void>;
export interface AtomicTextChange {
    path: string;
    expected: string | null;
    next: string | null;
}
export declare function atomicWriteTransaction(changes: AtomicTextChange[]): Promise<void>;
//# sourceMappingURL=settingsIo.d.ts.map