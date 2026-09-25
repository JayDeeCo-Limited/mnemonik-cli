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
        /** The scanner's last failure until it recovers; `cause` is the line it logged. */
        failure?: {
            kind: string;
            at: string;
            cause: string;
            /** push_rejected: the server's stated reason. */
            reason?: string;
            /** watcher_error: the project's name. */
            project?: string;
        } | null;
    };
}
/** The scanner paused itself because its saved consent does not cover it. */
export declare function pausedForConsent(receipt: ScannerReceipt | null | undefined): boolean;
export declare function scannerReceipt(stateDir: string): Promise<ScannerReceipt | null>;
/** The install run that paused the scanner, so a later command can tell when it is gone. */
export interface PauseOwner {
    /** The install journal's run id. */
    session: string;
    pid: number;
    at: number;
}
export declare const ABANDONED_PAUSE_RESUMED = "Background indexing was paused by an installation that did not finish. Mnemonik resumed it.";
export declare function controlScanner(action: 'pause' | 'resume' | 'stop', options: ScannerServiceOptions, owner?: PauseOwner): Promise<ScannerReceipt>;
/**
 * An install pauses a running scanner while it works and resumes it when it
 * stops. One that died on the way leaves the pause behind, and nothing else
 * would undo it. A pause a person chose carries no owner and is left alone.
 */
export declare function resumeAbandonedPause(options: ScannerServiceOptions): Promise<boolean>;
//# sourceMappingURL=control.d.ts.map