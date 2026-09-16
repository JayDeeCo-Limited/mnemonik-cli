import type { ServiceDefinition, ServiceOperation, ServiceResult, SupervisorStatus } from '@mnemonik/shared';
import { RuntimeStore } from '../runtime/store.js';
export interface ScannerServiceOptions {
    stateDir: string;
    captureDefinition?: boolean;
    store?: RuntimeStore;
    describe?: () => Promise<ServiceDefinition>;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    command?: (operation: ServiceOperation, definition?: ServiceDefinition) => Promise<ServiceResult>;
    timeout?: (phase: 'service' | 'heartbeat') => Promise<'retry' | 'skip'>;
    waiting?: (phase: 'service' | 'heartbeat', ms: number) => void;
}
export declare class ScannerServiceLimited extends Error {
    readonly reason: string;
    readonly status = "LIMITED";
    readonly action = "mnemonik scanner enable";
    constructor(reason: string, message?: string);
}
export declare function scannerService(options: ScannerServiceOptions): {
    status: () => Promise<SupervisorStatus>;
    readonly verified: boolean;
    inspect(): Promise<{
        id: string;
        before: string;
    }[]>;
    start(_id?: string): Promise<{
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