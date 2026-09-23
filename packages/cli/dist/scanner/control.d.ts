import { type ScannerServiceOptions } from './service.js';
export interface ScannerReceipt {
    recordedAt: number;
    snapshot: {
        devReleaseSource?: boolean;
        version: string | null;
        lifecycle: {
            state: string;
            reason: string;
            pid: number | null;
            controlId?: string;
            pauseIntervals: Array<{
                start: number;
                end: number | null;
            }>;
            readiness?: string;
            action?: string;
        };
        heartbeat: {
            lastSuccess: number | null;
        };
        startupTimings?: {
            localReadyAt?: number | null;
        };
        transfers?: {
            sinceStart: {
                files: number;
                bytes: number;
            };
            sinceInstall: {
                files: number;
                bytes: number;
            };
        };
        roots: string[];
        exclusions: string[];
        /** One entry per batch the server refused (scanner daemon `getRefusedBatches`). */
        refusedBatches?: Array<{
            project: string;
            files: number;
            issue: string;
        }>;
    };
}
export declare function scannerReceipt(stateDir: string): Promise<ScannerReceipt | null>;
export declare function controlScanner(action: 'pause' | 'resume', options: ScannerServiceOptions): Promise<ScannerReceipt>;
//# sourceMappingURL=control.d.ts.map