import { type Worker } from 'node:worker_threads';
/** At and above this length a file gets a child of its own, sized from it. */
export declare const LARGE_FILE_BYTES: number;
/** The shared child's heap: comfortably above any file under LARGE_FILE_BYTES. */
export declare const SHARED_HEAP_MB = 256;
export declare const STALL_POLL_MS = 5000;
/** One minute without any CPU while holding a file. */
export declare const STALL_POLLS = 12;
/**
 * CPU a single file may use. Generous: the slowest files measured (26 October
 * 2026, loaded host) were a 3.1 MB Svelte component at 23 s and a 9.9 MB Vue
 * component at 17 s.
 */
export declare const CPU_CEILING_SECONDS = 300;
/**
 * CPU a single file may use in the shared small-file child before it is sent
 * to a child of its own: one tenant's crafted file must not stall small-file
 * redaction for everyone on the task.
 */
export declare const SHARED_CPU_CEILING_SECONDS = 30;
/**
 * Failures that say something about the file itself, which a scanner counts
 * as strikes against that revision: it ran to the CPU ceiling, ran out of
 * memory at twice its heap, or could not be redacted. Not counted: a child
 * that would not fit in memory now, or one that stalled; those are retried.
 */
export declare const STRIKE_REASONS: ReadonlySet<string>;
/** Large children a pool runs at once, memory permitting. */
export declare const MAX_LARGE_CHILDREN = 2;
/**
 * A scanner's total memory, itself and its redaction children: the systemd
 * unit's MemoryMax, and the budget used where no control group limits it.
 */
export declare const SCANNER_TOTAL_MEMORY_MB = 1536;
/**
 * The heap a file's child may use: 128 MB plus 16 MB per MB of source (as F2's
 * parse pool), or 110 MB per MB for Vue and Svelte components. Measured 26
 * October 2026 (Liftoff-only): a 9.9 MB Vue component of about 100,000
 * template nodes ran out of memory at 900 MB and completed at 1,228 MB (peak
 * resident 1.13 GB); a 3.1 MB Svelte component completed at 500 MB.
 */
export declare function redactionHeapMb(bytes: number, filePath?: string): number;
/** Resident memory a child uses beyond its heap (code, grammars, buffers). */
export declare const CHILD_OVERHEAD_MB = 128;
/** Memory left free for everything else when a large child is admitted. */
export declare const ADMISSION_RESERVE_MB = 256;
/** What a memory probe reports, in MB. */
export interface MemoryReading {
    limitMb: number;
    usedMb: number;
    /** Whether usedMb already includes this pool's running children. */
    includesChildren: boolean;
    source: string;
}
export type MemoryProbe = () => MemoryReading | Promise<MemoryReading>;
export interface CgroupMemory {
    /** null when the group has no limit. */
    limitMb: number | null;
    /** memory.current: everything charged, page cache included. */
    currentMb: number;
    /** memory.current less inactive file cache: what the kernel cannot easily reclaim. */
    workingSetMb: number;
}
type ReadText = (path: string) => string;
/** This process's control group memory (v2, else v1), or null where there is none. */
export declare function cgroupMemory(read?: ReadText): CgroupMemory | null;
/**
 * The API server's probe: the task's memory limit (ECS task metadata, else the
 * cgroup, else the host: the caller supplies it) less the container's working
 * set (memory.current less inactive file cache, which the kernel reclaims
 * first). Without a control group, this process's resident memory.
 */
export declare function containerMemoryProbe(limitMb: () => number | Promise<number>, read?: ReadText): MemoryProbe;
/**
 * A scanner's probe. Under a control group limit (Linux, the systemd unit):
 * the limit less the working set, since the scanner's file reads leave page
 * cache the kernel reclaims before it would kill anything. Elsewhere (macOS,
 * Windows, an unlimited group): the scanner's own total budget less its own
 * resident memory, never the machine's free memory, which on macOS counts
 * compressed and cached pages as used and would refuse almost everything.
 */
export declare function scannerMemoryProbe(totalBudgetMb?: number, read?: ReadText, 
/** Children are worker threads, so this process's own resident memory includes them. */
childrenInProcess?: boolean): MemoryProbe;
export type RedactionPriority = 'interactive' | 'background';
export interface RedactionInput {
    text: string;
    filePath: string;
    /** An agent waiting on this file (file_push) goes before background ingest. */
    priority?: RedactionPriority;
}
declare function parsePsTime(text: string): number | null;
/** CPU seconds (user + system) a process has used: /proc on Linux, `ps` elsewhere, null on Windows. */
export declare function processCpuSeconds(pid: number | undefined): Promise<number | null>;
export { parsePsTime as parsePsTimeForTest };
/**
 * What the pool needs from a redaction child: a forked process (the server),
 * or a worker thread (the scanner: redactionWorkerThread).
 */
export interface RedactionChild {
    readonly pid?: number;
    readonly channel?: {
        ref?(): void;
        unref?(): void;
    } | null;
    send(message: unknown, callback?: (error: Error | null) => void): boolean;
    on(event: string, listener: (...args: any[]) => void): unknown;
    once(event: string, listener: (...args: any[]) => void): unknown;
    kill(signal?: NodeJS.Signals): boolean;
    ref?(): void;
    unref?(): void;
    /** CPU seconds this child has used, where it can say so itself (a worker thread, on any platform). */
    cpuSeconds?(): Promise<number | null>;
    /**
     * Memory this child is using now, in MB, where it can say so itself: a
     * worker thread's heap plus its external memory (WebAssembly and Buffers,
     * which resourceLimits does not bound).
     */
    memoryMb?(): Promise<number | null>;
}
/**
 * A worker thread as a redaction child. Its heap is the Worker's
 * resourceLimits (sized per file by the caller), and running out of it ends
 * the worker, not the process, reported as out of memory so the pool retries
 * with twice the heap. Its CPU time comes from the Worker itself, on every
 * platform, even while its own thread is busy (review of 26 Oct 2026: on
 * Windows there was no CPU ceiling or stall detection).
 */
export declare function redactionWorkerThread(worker: Worker): RedactionChild;
export interface ProcessTimings {
    pollMs: number;
    stallPolls: number;
    cpuCeilingSeconds: number;
    cpuSeconds: (pid: number | undefined) => Promise<number | null>;
}
export interface SourceRedactionPoolOptions {
    /** Start a worker child that runs runSourceRedactionWorker, with this heap. */
    spawn: (heapMb: number) => RedactionChild;
    /** Counted, logged and reported failures: never silent. */
    onFailure: (reason: string, details: {
        bytes: number;
        extension: string;
    }) => void;
    onRetry?: (reason: string, details: {
        bytes: number;
        extension: string;
    }) => void;
    /** Memory a new child is judged against (default: scannerMemoryProbe()). */
    memory?: MemoryProbe;
    /** Memory, in MB, held by admitted work not yet redacted (bodies waiting in this task). */
    heldMb?: () => number;
    maxLargeChildren?: number;
    cpuCeilingSeconds?: number;
    /** CPU a file may use in the shared small-file child before it gets its own. */
    sharedCpuCeilingSeconds?: number;
    pollMs?: number;
    stallPolls?: number;
    cpuSeconds?: (pid: number | undefined) => Promise<number | null>;
}
export declare class SourceRedactionPool {
    private readonly options;
    private shared;
    private readonly sharedQueue;
    private readonly largeQueue;
    private readonly running;
    private seq;
    private admitting;
    private admitAgain;
    /** Large children finished so far (admission re-reads memory when this moves during a read). */
    private finished;
    private readonly timings;
    constructor(options: SourceRedactionPoolOptions);
    /** Large children running now (tests and diagnostics). */
    get largeRunning(): number;
    /** Interactive before background; arrival order within each. */
    private enqueue;
    private runShared;
    /**
     * Memory the redaction children use now, in MB, each counted at most up to
     * its budget: what a scanner's own memory ceiling leaves out when its
     * children are worker threads in its process.
     */
    childrenUsedMb(): number;
    private admitLarge;
    private submit;
    /** Redact one source; throws a counted, logged error for this file when it cannot. */
    redact(input: RedactionInput): Promise<string>;
    private fail;
    /** Tests and shutdown. */
    close(): void;
}
/**
 * The child side: redact each file sent over IPC, in this process, and
 * answer with its id and this process's resident memory (so the parent can
 * recycle a child whose WebAssembly memory has grown).
 */
export declare function runSourceRedactionWorker(): void;
//# sourceMappingURL=sourceRedactionPool.d.ts.map