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
    };
}
export declare function scannerReceipt(stateDir: string): Promise<ScannerReceipt | null>;
export declare function controlScanner(action: 'pause' | 'resume', options: ScannerServiceOptions): Promise<ScannerReceipt>;
//# sourceMappingURL=control.d.ts.map