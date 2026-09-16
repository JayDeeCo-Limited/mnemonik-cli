import { resolveProjectIdentity } from '@mnemonik/shared';
import { type Evidence, type SetupTransport, type EnsureOptions, type SetupResult, type Owner } from './contracts.js';
import { type Fault } from './storage.js';
export * from './contracts.js';
export * from './windowsPath.js';
export { stateDirectory, recordPath, protectStateFile, windowsCurrentUserAcl, windowsCurrentAccount, atomicWrite, withLock, type Fault, type PermissionStatus, type ExecFile, } from './storage.js';
type Step = {
    complete: boolean;
    started?: boolean;
    beforeHash: string | null;
    afterHash: string | null;
};
export interface SetupRecord {
    schemaVersion: 1;
    operationId: string;
    root: string;
    scopeKey: string;
    owner?: Owner;
    nonGitSelected?: true;
    intent?: EnsureOptions['intent'];
    ignored?: {
        identityHash: string | null;
        responseHash: string;
    };
    evidence?: Evidence;
    remote?: {
        projectId: string;
        displayName?: string;
    };
    before: {
        base64: string | null;
        hash: string | null;
    };
    staged?: {
        content: string;
        hash: string;
    };
    steps: {
        remote: Step & {
            outcome?: 'created' | 'linked' | 'restored';
        };
        identity: Step;
        rollback: Step;
    };
}
export interface ExecutorDependencies {
    resolver: {
        resolveProjectIdentity: typeof resolveProjectIdentity;
    };
    transport: SetupTransport;
    /** Non-secret authenticated user + device identity, stable across token refreshes. */
    scopeKey: string;
    /** Recompute locally using the device key and repository remote. Never return the key. */
    bindContext(root: string): Promise<Evidence>;
    stateDir?: string;
    waitMs?: number;
    /** Deterministic crash injection for filesystem/transport boundary tests. */
    fault?: Fault;
}
export declare function createProjectSetupExecutor(deps: ExecutorDependencies): {
    ensureProject: (options: EnsureOptions) => Promise<SetupResult>;
    stage: (options: EnsureOptions) => Promise<SetupResult>;
    apply: (options: EnsureOptions) => Promise<SetupResult>;
    rollback: (options: EnsureOptions) => Promise<SetupResult>;
};
//# sourceMappingURL=index.d.ts.map