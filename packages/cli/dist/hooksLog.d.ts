import { type HookTraceEnd, type HookTraceInput, type HookTraceStart } from '@mnemonik/shared/hook-runtime';
/**
 * Every host whose hooks write a trace. VS Code Copilot runs the Claude Code
 * dispatcher and traces as `copilot`; it is not a launch host, so this list is
 * the reader's own.
 */
export declare const tracedHosts: readonly ['claude-code', 'codex', 'cursor', 'copilot'];
export type TracedHost = (typeof tracedHosts)[number];
export declare const tracedHostLabels: Record<TracedHost, string>;
/** A run with no `end` this long after it started is not running, whatever its pid says. */
export declare const UNFINISHED_AFTER_MS = 60000;
export interface HookInvocation {
    host: TracedHost;
    id: string;
    pid: number;
    event: string | null;
    /** When the run started (its `start` line, or a later line when the start rotated away). */
    ts: string;
    /** finished; running (no end yet, process alive, under a minute old); unfinished. */
    state: 'finished' | 'running' | 'unfinished';
    start?: HookTraceStart;
    input?: HookTraceInput;
    end?: HookTraceEnd;
}
export interface HooksLogOptions {
    hosts?: readonly TracedHost[];
    stateDir: string;
    /** Whether a pid is still running; process.kill(pid, 0) by default. */
    alive?: (pid: number) => boolean;
    /** The clock; Date.now by default. */
    now?: () => number;
    /** Read at most this many trailing bytes of each file (doctor). */
    tailBytes?: number;
}
export declare function processAlive(pid: number): boolean;
/** Every recorded invocation of the given hosts, its lines merged by run id, oldest first. */
export declare function readHookInvocations(options: HooksLogOptions): Promise<HookInvocation[]>;
/** What the hook answered, in a few words. */
export declare function outcome(end: HookTraceEnd): string;
/** One plain line per invocation. */
export declare function invocationLine(invocation: HookInvocation): string;
export interface FollowOptions {
    signal?: AbortSignal;
    pollMs?: number;
}
/**
 * Print the last `last` invocations, then, with `follow`, each invocation as it
 * finishes (or is found unfinished) until the signal aborts.
 */
export declare function hooksLog(options: HooksLogOptions & {
    last: number;
    follow?: FollowOptions | false;
    print: (invocation: HookInvocation) => void;
}): Promise<HookInvocation[]>;
/**
 * Doctor: one plain line per coding tool that has a trace, saying when its
 * hooks last ran and, when that run was stopped, where to look. No event
 * names, ids or paths.
 */
export declare function hookActivityLines(stateDir: string, now: number, alive?: (pid: number) => boolean): Promise<string[]>;
//# sourceMappingURL=hooksLog.d.ts.map