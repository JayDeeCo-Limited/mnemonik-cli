import { type ReadinessCondition } from '@mnemonik/shared';
import { type GrantTransport } from '../auth/status.js';
import type { Grant, HostAdapter, Inspection } from './adapters.js';
import { type HostPackageImports, type Target } from './adapters.js';
import { type HostArtifact, type RuntimeSource } from '../runtime/store.js';
import { type Journal } from './journal.js';
import { type OwnedTarget } from './ownership.js';
export interface HostSelection {
    component?: Target['component'];
    host: HostArtifact;
    scope: Target['scope'];
    home: string;
    projectRoot?: string;
    profilePath?: string;
}
export interface HostDependencies {
    stateDir: string;
    account: string;
    /** Continue project/scanner steps under the host install lease and journal. */
    afterHosts?(journal: Journal, results: HostResult[], refreshHosts: () => Promise<void>): Promise<void>;
    rollbackInstall?(journal: Journal): Promise<void>;
    recovery?(journal: Journal): Promise<'resume' | 'rollback'>;
    installPlan?: {
        components: string[];
        roots: string[];
    };
    env?: NodeJS.ProcessEnv;
    source?(host: HostArtifact): Promise<RuntimeSource>;
    imports?: HostPackageImports;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    fault?: Journal['afterMutation'];
    instruction?(text: string): void;
    grants?: GrantTransport;
    approveHost?: () => Promise<boolean>;
    getCliBearer?: () => Promise<string>;
    authorizeInstallSession?: (installationId: string) => Promise<string>;
    noBrowser?: boolean;
    credentialFetch?: typeof fetch;
    timeout?(host: HostArtifact): Promise<'retry' | 'skip' | 'cancel'>;
    offerRevoke?(host: HostArtifact): Promise<boolean>;
    migrate?(host: HostArtifact, scope: Target['scope']): Promise<boolean>;
    /** Explicit consent to restore a person-disabled native host policy. */
    apply?: boolean;
}
export type HostCommand = 'install' | 'repair' | 'update' | 'uninstall';
export interface HostResult {
    target: string;
    elapsedMs: number;
    status: 'READY' | 'LIMITED' | 'ACTION_REQUIRED' | 'FAILED';
    reason: string;
    detail?: string;
    action?: string;
}
export declare function codexTrustAction(resolvedPath?: string): string;
export declare const CODEX_TRUST_ACTION: string;
export declare const hostNotConnectedCondition: (host: HostArtifact) => ReadinessCondition;
export declare function hostSource(host: HostArtifact, packagePath?: string | URL): Promise<RuntimeSource>;
/** All selected targets share the ownership lease; a failed target restores only its group. */
export declare function runHosts(command: HostCommand, selections: HostSelection[], deps: HostDependencies, allowMigration?: boolean): Promise<{
    results: HostResult[];
    reports: string[];
    journal: Journal['data'];
}>;
export declare function selectOwned(state: string, host?: string, scope?: string, component?: string): Promise<{
    selected: OwnedTarget[];
    ambiguous: string[];
}>;
export declare function codexTrustConditions(deps: Pick<HostDependencies, 'stateDir' | 'env' | 'imports'>): Promise<ReadinessCondition[]>;
export declare function hookStatusConditions(deps: Pick<HostDependencies, 'stateDir' | 'env' | 'imports'>, hosts: readonly HostArtifact[]): Promise<ReadinessCondition[]>;
/** Shared native approval wait; a configured/connected listing never invents server account evidence. */
export declare function waitForHost(adapter: HostAdapter, target: Target, host: HostArtifact, deps: HostDependencies, recorded?: Grant, command?: HostCommand): Promise<Inspection>;
export declare function revokeHostGrants(host: HostArtifact, deps: HostDependencies, grantId?: string): Promise<string[]>;
/** Local logout is secondary to server revocation and never reads host token storage. */
export declare function logoutHost(host: HostArtifact, deps: HostDependencies): Promise<string[]>;
/** Resume one concrete profile under the ownership lease, with no config/runtime plan or stage. */
export declare function connectHost(selection: OwnedTarget, deps: HostDependencies): Promise<HostResult>;
//# sourceMappingURL=hosts.d.ts.map