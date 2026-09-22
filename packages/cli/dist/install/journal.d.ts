import type { HostCommand, HostSelection } from './hosts.js';
import type { HostRun } from './ownership.js';
import type { AdapterWriter, FileChange } from '@mnemonik/shared';
import type { HostName } from './adapters.js';
export declare const MUTATION_KINDS: readonly ['journal_created', 'planned', 'stage_intent', 'stage_written', 'staged', 'host_intent', 'host_observed', 'roots_confirmed', 'consent_recorded', 'project_stage_intent', 'project_staged', 'projects_staged', 'final_review', 'apply', 'commit_intent', 'commit_written', 'committed', 'local_commit', 'service_start_intent', 'service_started', 'upload_intent', 'upload_finished', 'complete', 'service_restored', 'project_restored', 'restored', 'credential_revoked', 'compensation_finished', 'reconciled'];
export type MutationKind = (typeof MUTATION_KINDS)[number];
export declare const digest: (bytes: Buffer | null) => string | null;
export declare function bytesAt(path: string): Promise<Buffer | null>;
export interface Target {
    id: string;
    kind: 'host' | 'runtime' | 'service' | 'project' | 'credential-reference';
    path: string;
    host?: HostName;
    group?: string;
    beforeHash: string | null;
    proposedHash: string | null;
    backup: string;
    proposed: string;
    mode: number;
    status: 'planned' | 'staged' | 'committed' | 'restored';
    staging: 'inactive' | 'additive';
    version?: string;
    artifactDigest?: string;
}
export interface Consent {
    account: string;
    roots: string[];
    exclusions: string[];
    disclosureVersion: string;
}
export interface JournalData {
    schemaVersion: 1;
    joined?: boolean;
    hostRuns?: HostRun[];
    hostRequest?: {
        command: HostCommand;
        selections: HostSelection[];
        allowMigration: boolean;
    };
    runId: string;
    generation: number;
    account: string;
    components: string[];
    hosts: HostName[];
    scopes: Partial<Record<HostName, {
        requested: string;
        effective: string;
    }>>;
    roots: string[];
    declaredTargets: string[];
    targets: Target[];
    consent?: Consent;
    credentials: Array<{
        reference: string;
        kind: 'cli' | 'component';
        component?: 'scanner';
        revoked?: boolean;
    }>;
    projects: Array<{
        selected?: boolean;
        root: string;
        uuid?: string;
        effect?: 'created' | 'restored';
        empty?: boolean;
    }>;
    services: Array<{
        id: string;
        before: string;
        started?: boolean;
        managed?: true;
    }>;
    mutations: Array<{
        sequence: number;
        event: string;
        target?: string;
    }>;
    reports: string[];
    phase: 'preparing' | 'review' | 'applying' | 'committed' | 'uploading' | 'complete' | 'rolling_back' | 'rolled_back';
    state: 'READY' | 'LIMITED' | 'ACTION_REQUIRED' | 'FAILED';
}
export type NewInstall = Pick<JournalData, 'account' | 'components' | 'hosts' | 'scopes' | 'roots' | 'credentials' | 'hostRuns' | 'hostRequest' | 'joined'>;
export declare class Journal implements AdapterWriter {
    readonly dir: string;
    readonly data: JournalData;
    assertOwned?: () => Promise<void>;
    afterMutation?: (event: MutationKind, journal: Journal) => void | Promise<void>;
    constructor(dir: string, data: JournalData);
    save(): Promise<void>;
    event(event: MutationKind, target?: string): Promise<void>;
    plan(path: string, proposed: Buffer | null, fields: Pick<Target, 'kind'> & Partial<Pick<Target, 'host' | 'group' | 'staging' | 'version' | 'artifactDigest'>>): Promise<Target>;
    propose(target: Target, bytes: Buffer): Promise<void>;
    stage(change: Target | FileChange): Promise<void>;
    change(target: Target, restore: boolean): Promise<void>;
    commit(target: Target): Promise<void>;
    restore(target: Target): Promise<void>;
    restoreFiles(): Promise<boolean>;
    reconcile(): Promise<{
        target: Target;
        state: string;
    }[]>;
}
export declare function interrupted(state?: string): Promise<Journal[]>;
export declare function abandonInterrupted(state?: string): Promise<void>;
/** A user-wide lease plus durable generation refuses rollback from an older run. */
export declare function withInstall<T>(state: string, input: NewInstall, resume: Journal | undefined, work: (journal: Journal) => Promise<T>, afterMutation?: Journal['afterMutation']): Promise<T>;
//# sourceMappingURL=journal.d.ts.map