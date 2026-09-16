import { type ScannerServiceOptions } from '../scanner/service.js';
import type { createCredentialAdapter, CredentialTransport } from '@mnemonik/credentials';
import type { ProjectExecutor } from '../project.js';
import { type ScannerPickerResult } from '../scanner/picker.js';
import { type HostAdapter, type HostName, type Target } from './adapters.js';
import { type Consent, type Journal, type MutationKind, type NewInstall } from './journal.js';
export interface InstallUI {
    batch(hosts: HostName[]): Promise<'connect' | 'cancel'>;
    waiting(host: HostName | 'scanner service' | 'scanner heartbeat'): void;
    timeout(host: HostName | 'scanner service' | 'scanner heartbeat'): Promise<'retry' | 'skip' | 'cancel'>;
    roots(): Promise<{
        picked: ScannerPickerResult;
        account: string;
        disclosureVersion: string;
    }>;
    consent(fields: Consent): Promise<boolean>;
    review(journal: Journal): Promise<'apply' | 'back' | 'cancel'>;
    cancel(): Promise<'revoke' | 'keep-cli'>;
    recovery(reports: string[]): Promise<'resume' | 'rollback'>;
}
export interface InstallDependencies {
    stateDir: string;
    input: NewInstall;
    adapters: HostAdapter[];
    ui: InstallUI;
    targets?: Partial<Record<HostName, Target>>;
    executor: Pick<ProjectExecutor, 'stage' | 'apply' | 'rollback'>;
    projectStateDir?: string;
    revokeCli(): Promise<void>;
    revokeComponent(reference: string): Promise<boolean>;
    /** Adds journaled runtime, service and credential-reference proposals during review. */
    prepare?(journal: Journal): Promise<void>;
    scannerService?: Omit<ScannerServiceOptions, 'stateDir'>;
    services?: {
        readonly verified?: boolean;
        inspect(): Promise<Array<{
            id: string;
            before: string;
        }>>;
        start(id: string): Promise<{
            started: true;
            alreadyRunning: false;
        } | {
            started: false;
            alreadyRunning: true;
        }>;
        restore(id: string, before: string): Promise<void>;
    };
    upload?: {
        /** The server uses this operation ID as its idempotency key. */
        start(operationId: string): Promise<{
            uploaded: boolean;
            deduplicated: boolean;
        }>;
        deletionAction: string;
    };
    projectEmpty?(uuid: string): Promise<boolean>;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    signal?: AbortSignal;
    fault?: (event: MutationKind, journal: Journal) => void | Promise<void>;
}
/** Uses the credential package's locked refresh/revocation path; never journals tokens. */
export declare const componentRevoker: (adapter: ReturnType<typeof createCredentialAdapter>, transport: CredentialTransport) => (reference: string) => Promise<boolean>;
export declare function revokeInstallComponent(stateDir: string, reference: string, fetcher?: typeof fetch): Promise<boolean>;
export declare const consentMatches: (a: Consent | undefined, b: Consent) => boolean;
export declare function installFailureReason(error: unknown): string;
export declare function compensate(journal: Journal, deps: InstallDependencies, keepCli?: boolean): Promise<void>;
export declare function reconcile(journal: Journal, deps: InstallDependencies): Promise<boolean>;
export declare function runInstall(deps: InstallDependencies, resume?: Journal): Promise<import("./journal.js").JournalData>;
//# sourceMappingURL=transaction.d.ts.map