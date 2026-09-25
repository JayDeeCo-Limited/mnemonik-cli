import { pidIsScanner } from '@mnemonik/shared';
import type { ServiceDefinition, ServiceOperation, ServiceResult, SupervisorStatus } from '@mnemonik/shared';
import { RuntimeStore, type Verified } from '../runtime/store.js';
export declare const SCANNER_RESTART_MESSAGE = "Background indexing stopped responding. Mnemonik restarted it.";
export declare const SCANNER_RESTART_ACTION = "Wait a minute, then check again.";
export interface ScannerServiceOptions {
    stateDir: string;
    pidIdentity?: typeof pidIsScanner;
    signal?: typeof process.kill;
    onScannerRestartRequested?: () => void;
    /** Called once a pause left by an installation that did not finish is undone. */
    onAbandonedPauseResumed?: () => void;
    platform?: NodeJS.Platform;
    home?: string;
    uid?: number;
    systemPlist?: string;
    supervisorRun?: (file: string, args: string[]) => Promise<string>;
    captureDefinition?: boolean;
    /** Keep the new supervisor's platform fixes available while restoring an older runtime. */
    supervisorRuntime?: Verified;
    store?: RuntimeStore;
    describe?: () => Promise<ServiceDefinition>;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    command?: (operation: ServiceOperation, definition?: ServiceDefinition) => Promise<ServiceResult>;
    timeout?: (phase: 'service' | 'heartbeat') => Promise<'retry' | 'skip'>;
    waiting?: (phase: 'service' | 'heartbeat', ms: number) => void;
}
export declare const SCANNER_LIMITED_SENTENCE = "Background indexing could not be started.";
export declare const SCANNER_LIMITED_ACTION = "Run mnemonik install to try again.";
export declare class ScannerServiceLimited extends Error {
    readonly reason: string;
    readonly status = "LIMITED";
    get summary(): string;
    get action(): string;
    constructor(reason: string, message?: string);
}
export declare function scannerService(options: ScannerServiceOptions): {
    status: () => Promise<SupervisorStatus>;
    recover(): Promise<boolean>;
    readonly verified: boolean;
    inspect(): Promise<{
        id: string;
        before: string;
    }[]>;
    start(_id?: string, heartbeatAfter?: number): Promise<{
        started: true;
        alreadyRunning: false;
    } | {
        started: false;
        alreadyRunning: true;
    }>;
    exportPreview(out: string): Promise<{
        stdout: string;
        stderr: string;
    }>;
    replace(runtime: Verified, replacement: NonNullable<ServiceDefinition['replacement']>): Promise<void>;
    restart(): Promise<{
        started: true;
        alreadyRunning: false;
    } | {
        started: false;
        alreadyRunning: true;
    }>;
    stop(): Promise<void>;
    uninstall(): Promise<void>;
    restore(_id: string, before: string): Promise<void>;
};
//# sourceMappingURL=service.d.ts.map