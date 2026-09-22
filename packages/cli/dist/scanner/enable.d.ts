import type { Readable } from 'node:stream';
import { serializeReadiness } from '@mnemonik/shared';
import { createCliCredentials } from '../auth/credentials.js';
import { type InstallSession } from '../auth/installSession.js';
import { RuntimeStore, type RuntimeSource } from '../runtime/store.js';
import { Output } from '../output.js';
import { type ScannerServiceOptions } from './service.js';
import { type Journal } from '../install/journal.js';
import { type ProjectExecutor } from '../project.js';
import { type ScannerConsentDraft } from './picker.js';
export interface Consent {
    userId: string;
    roots: string[];
    exclusions: string[];
    disclosureVersion: string;
}
export interface SavedState {
    schemaVersion: 1;
    boundary?: string;
    config: {
        roots: string[];
        exclusions: string[];
        serverUrl: string;
        credentialFamilyId?: string;
        deviceInstallationId?: string;
    };
    consent?: Consent;
    paused: boolean;
    pauseIntervals: Array<{
        start: number;
        end: number | null;
        reason: string;
    }>;
    devReleaseSource?: boolean;
}
export declare const scannerStateBytes: (state: SavedState) => Buffer;
export declare const SCANNER_APPROVAL_WAIT = "Waiting for approval in your browser, up to 10 minutes.";
export declare function updateScannerRoots(options: {
    stateDir: string;
    bearer: string;
    add: string[];
    remove: string[];
    fetch?: typeof fetch;
}): Promise<{
    status: 'updated';
    state: SavedState;
} | {
    status: 'disclosure_required';
}>;
export interface EnableOptions extends ScannerServiceOptions {
    cwd: string;
    home?: string;
    input: Readable;
    readAnswer?: () => Promise<string | undefined>;
    output: Output;
    nonInteractive?: boolean;
    pendingHosts?: boolean;
    journal?: Journal;
    roots?: string[];
    exclusions?: string[];
    noBrowser?: boolean;
    approvalAnnounced?: boolean;
    fetch?: typeof fetch;
    source?: () => Promise<RuntimeSource>;
    store?: RuntimeStore;
    credentials?: ReturnType<typeof createCliCredentials>;
    authorize?: (selection?: ScannerConsentDraft, installation?: string) => Promise<string>;
    projectExecutor?: ProjectExecutor;
    projectStateDir?: string;
}
export interface PreparedScanner {
    roots: string[];
    exclusions: string[];
    files: string[];
    session: InstallSession;
    projectExecutor(): Promise<ProjectExecutor>;
    apply(journal?: Journal, roots?: readonly string[]): Promise<ReturnType<typeof serializeReadiness>>;
    rollback(journal: Journal): Promise<void>;
    complete(document: ReturnType<typeof serializeReadiness>): Promise<void>;
}
export declare function enableScanner(options: EnableOptions): Promise<ReturnType<typeof serializeReadiness>>;
/** The scanner lease spans browser review, Apply and compensation. */
export declare function prepareScanner<T>(options: EnableOptions, work: (prepared: PreparedScanner) => Promise<T>): Promise<T>;
/** Stop/unregister with the installed runtime, restore bytes, then restore the old definition. */
export declare function restoreScannerInstall(journal: Journal, options: ScannerServiceOptions & {
    fetch?: typeof fetch;
}): Promise<void>;
//# sourceMappingURL=enable.d.ts.map