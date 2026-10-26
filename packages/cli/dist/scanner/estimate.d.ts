/**
 * What the person sees before the first scan: how many files will be
 * indexed, how much they hold, and roughly how long indexing will take
 * (assessment item 8; owner decision of 25 October 2026). The count is the
 * scanner's own file selection (the shared FileSelector, with every ignore
 * rule it applies), and the time comes from the server's measured throughput
 * and current queue (`GET /api/v1/scan/ingest/estimate`). Neither blocks
 * anything: a count that takes too long, or an estimate the server cannot
 * give, is simply not shown.
 */
export interface FolderCount {
    files: number;
    bytes: number;
    /** The walk stopped at its time bound; the numbers are a lower bound. */
    partial: boolean;
}
export interface ServerEstimate {
    files: number;
    lowSeconds: number;
    highSeconds: number;
    basis: 'measured' | 'typical';
    accountsAhead: number;
}
/** A count longer than this is shown as "at least". */
export declare const COUNT_TIME_BOUND_MS = 30000;
type Lister = (root: string) => Promise<{
    paths: string[];
}>;
/** The files the scanner would index under these folders, and their total size. */
export declare function countIndexableFiles(roots: readonly string[], options?: {
    list?: Lister;
    timeBoundMs?: number;
    now?: () => number;
}): Promise<FolderCount>;
export declare function formatBytes(bytes: number): string;
/** "about 5 minutes", "about 10 to 20 minutes", "about 2 to 4 hours". */
export declare function formatDurationRange(lowSeconds: number, highSeconds: number): string;
/** The lines shown before the first scan. */
export declare function onboardingEstimateLines(count: FolderCount, estimate: ServerEstimate | null): string[];
export {};
//# sourceMappingURL=estimate.d.ts.map