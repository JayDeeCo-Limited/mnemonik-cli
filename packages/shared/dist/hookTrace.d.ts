export type HookTraceHost = 'cursor' | 'claude-code' | 'codex' | 'copilot';
/** Past this size the file is renamed to `<host>.jsonl.1` (replacing any older one). */
export declare const HOOK_TRACE_MAX_BYTES: number;
export declare const HOOK_TRACE_ENV = "MNEMONIK_HOOK_TRACE";
export interface HookTraceCall {
    /** URL path only; id-like segments become `:id`, never a query string. */
    path: string;
    status?: number;
    /** `timeout`, `aborted`, a system code such as `ECONNREFUSED`, or an error name. */
    error?: string;
    /** Still waiting for an answer when the process exited. */
    pending?: true;
    ms: number;
}
export interface HookTraceOutput {
    bytes: number;
    /** Byte size of each output field set; nested host fields as `hookSpecificOutput.<name>`. */
    sizes: Record<string, number>;
    permission?: string;
    decision?: string;
    continue?: boolean;
}
/** Written as the recorder starts, before stdin is read. */
export interface HookTraceStart {
    v: 1;
    phase: 'start';
    ts: string;
    host: HookTraceHost;
    hookVersion?: string;
    pid: number;
    id: string;
    /** From process start, including Node start-up and module load. */
    processMs: number;
}
/** Written once stdin is read and the event is known. */
export interface HookTraceInput {
    v: 1;
    phase: 'input';
    ts: string;
    host: HookTraceHost;
    pid: number;
    id: string;
    event: string | null;
    hostVersion?: string;
    sessionId?: string;
    conversationId?: string;
    generationId?: string;
    agentId?: string;
    turnId?: string;
    tool?: string;
    cwd?: string;
    inputBytes: number;
    /** Byte size of each top-level input field's JSON value. Values are never recorded. */
    fields: Record<string, number>;
    /** Time from the recorder starting to the event being known (mostly the stdin read). */
    readMs: number;
}
export interface HookTraceEnd {
    v: 1;
    phase: 'end';
    ts: string;
    host: HookTraceHost;
    pid: number;
    id: string;
    event: string | null;
    projectId?: string;
    output: HookTraceOutput | null;
    calls: HookTraceCall[];
    /** From the recorder starting (after module load) to exit. */
    durationMs: number;
    /** From process start, including Node start-up and module load. */
    processMs: number;
    exitCode: number;
    /** Name or system code of the error the hook failed open on. */
    errorKind?: string;
    /** Its message, scrubbed and cut to 80 characters. */
    error?: string;
}
export type HookTraceRecord = HookTraceStart | HookTraceInput | HookTraceEnd;
export declare function hookTraceEnabled(env?: NodeJS.ProcessEnv): boolean;
export declare function hookTraceDirectory(stateDir?: string): string;
export declare function hookTraceFile(host: HookTraceHost, stateDir?: string): string;
/** Append one line, rotating first when the file is full. Throws; callers swallow. */
export declare function appendHookTraceLine(file: string, record: HookTraceRecord): void;
/** Field names and sizes, the decision fields' short enum values, never text. */
export declare function summarizeHookOutput(text: string): HookTraceOutput;
export declare function errorKind(error: unknown): string;
/** The message, whitespace folded, secrets scrubbed, cut to 80 characters. */
export declare function scrubHookTraceMessage(error: unknown): string;
export interface HookTraceCallToken {
    input: unknown;
    startedAt: number;
}
export interface HookTraceOptions {
    host: HookTraceHost;
    hookVersion?: string;
    env?: NodeJS.ProcessEnv;
    stateDir?: string;
}
export declare class HookTrace {
    private readonly host;
    private readonly file;
    private readonly hookVersion?;
    private readonly id;
    private readonly startedAt;
    private opened;
    private started;
    private ended;
    private event;
    private outputSummary;
    private error?;
    private errorKind?;
    private projectId?;
    private readonly calls;
    private readonly inFlight;
    constructor(host: HookTraceHost, file: string | undefined, hookVersion?: string | undefined);
    get enabled(): boolean;
    private write;
    /**
     * Write the `start` line: pid, run id and time since process start, nothing
     * from the editor. Runs before stdin is read, so a run killed while the
     * editor is still sending its event leaves this line.
     */
    open(): void;
    /** Write the `input` line. `input` is the parsed payload, or null when none parsed. */
    begin(input: unknown, event?: string | null): void;
    /** The exact text the hook wrote to stdout (or nothing). */
    output(text: string | null | undefined): void;
    /** The error the hook failed open on. */
    fail(error: unknown): void;
    project(projectId: string | undefined): void;
    /** A call has gone out; {@link settle} records it, {@link finish} records it as pending. */
    callStarted(input: unknown): HookTraceCallToken;
    settle(token: HookTraceCallToken, status?: number, error?: unknown): void;
    call(input: unknown, startedAt: number, status?: number, error?: unknown): void;
    /** Write the `end` line once. Runs from the process `exit` event. */
    finish(exitCode?: number): void;
}
/** Resolved project ids reach the trace from the shared identity cache. */
export declare function noteHookTraceProject(projectId: string | undefined): void;
/**
 * Start this process's recorder: one per hook process. Writes the `start`
 * line at once (so call it before reading stdin), times every `fetch` the
 * process makes (path, status or error kind, duration; `pending` when still
 * waiting at exit) and writes the `end` line from the process `exit` event,
 * so every exit path is covered.
 */
export declare function startHookTrace(options: HookTraceOptions): HookTrace;
//# sourceMappingURL=hookTrace.d.ts.map