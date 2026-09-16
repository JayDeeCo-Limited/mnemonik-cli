import { type Execute, type Signer } from './runtimeSigners.js';
export type HostArtifact = 'claude-code' | 'codex' | 'cursor' | 'grok';
export type Artifact = 'cli' | 'scanner' | HostArtifact;
export type Reason = 'digest_mismatch' | 'manifest_missing' | 'unsigned' | 'permission' | 'acl_unavailable' | 'lock_held';
export declare class RuntimeError extends Error {
    readonly reason: Reason;
    constructor(reason: Reason);
}
export declare const hash: (bytes: Buffer | string) => string;
export declare function safePath(path: string): string;
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
    files: Record<string, {
        sha256: string;
        size: number;
        executable: boolean;
    }>;
    totalSize: number;
    source: {
        kind: 'npm';
        packages: NpmReceipt[];
        launchedFrom: string;
    } | {
        kind: 'release';
        url: string;
    };
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
export declare const missing: (e: unknown) => boolean;
export declare const versionName: (v: string) => string;
/** Only stdlib and the accepted bootstrap's signer adapter may load before verifyRuntime returns. */
export declare class RuntimeReader {
    readonly run?: Execute | undefined;
    readonly options: {
        allowUnsigned?: boolean;
        cacheDirectories?: boolean;
    };
    private readonly now;
    readonly state: string;
    private static readonly windowsSignatures;
    private readonly windowsAudit;
    private readonly windowsStats;
    private readonly windowsDirectories;
    private audits;
    private readonly auditsInFlight;
    private activeOperation;
    private operations;
    constructor(state: string, run?: Execute | undefined, options?: {
        allowUnsigned?: boolean;
        cacheDirectories?: boolean;
    }, now?: () => number);
    pointerPath(artifact: Artifact): string;
    private guardedPath;
    private auditRoot;
    private traceAudit;
    private invalidateAudit;
    private audit;
    private auditPending;
    inspect(path: string, directory?: boolean, allowMissing?: boolean, replacing?: boolean): Promise<void>;
    /** Call only after an owned atomic replacement: its parent ctime is our own write. */
    recordReplacement(path: string): Promise<void>;
    bytes(path: string): Promise<Buffer>;
    /** An owned inheritable ACL update can change every cached descendant's ctime. */
    protected recordAclWrite(path: string): Promise<void>;
    protected pointer(artifact: Artifact): Promise<Pointer | undefined>;
    private operation;
    protected verifyAt(artifact: Artifact, ref: Reference, directory: string): Promise<Verified>;
    private verifyOpen;
    verifyRuntime(artifact: Artifact): Promise<Verified>;
}
export * from './runtimeSigners.js';
//# sourceMappingURL=runtimeReader.d.ts.map