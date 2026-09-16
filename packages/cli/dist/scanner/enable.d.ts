import type { Readable } from 'node:stream';
import { serializeReadiness } from '@mnemonik/shared';
import { createCliCredentials } from '../auth/credentials.js';
import { type InstallSession } from '../auth/installSession.js';
import { RuntimeStore, type RuntimeSource } from '../runtime/store.js';
import { Output } from '../output.js';
import { type ScannerServiceOptions } from './service.js';
import { type Journal } from '../install/journal.js';
export interface Consent {
    userId: string;
    roots: string[];
    exclusions: string[];
    disclosureVersion: string;
}
export interface SavedState {
    schemaVersion: 1;
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
export interface EnableOptions extends ScannerServiceOptions {
    cwd: string;
    input: Readable;
    output: Output;
    nonInteractive?: boolean;
    pendingHosts?: boolean;
    journal?: Journal;
    roots?: string[];
    exclusions?: string[];
    noBrowser?: boolean;
    fetch?: typeof fetch;
    source?: () => Promise<RuntimeSource>;
    store?: RuntimeStore;
    credentials?: ReturnType<typeof createCliCredentials>;
    authorize?: (selection?: {
        roots: string[];
        exclusions: string[];
    }, installation?: string) => Promise<string>;
}
export interface PreparedScanner {
    roots: string[];
    exclusions: string[];
    files: string[];
    session: InstallSession;
    apply(journal?: Journal): Promise<ReturnType<typeof serializeReadiness>>;
    rollback(journal: Journal): Promise<void>;
    complete(document: ReturnType<typeof serializeReadiness>): Promise<void>;
}
export declare function enableScanner(options: EnableOptions): Promise<import("@mnemonik/shared").ReadinessDocument>;
/** The scanner lease spans browser review, Apply and compensation. */
export declare function prepareScanner<T>(options: EnableOptions, work: (prepared: PreparedScanner) => Promise<T>): Promise<T>;
/** Stop/unregister with the installed runtime, restore bytes, then restore the old definition. */
export declare function restoreScannerInstall(journal: Journal, options: ScannerServiceOptions & {
    fetch?: typeof fetch;
}): Promise<void>;
//# sourceMappingURL=enable.d.ts.map