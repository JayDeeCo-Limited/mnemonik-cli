export interface OutputContext {
    home?: string;
    projectRoot?: string;
}
/** Security boundary for every human and machine-readable CLI emission. */
export declare function redact(value: unknown, context?: OutputContext): string;
export interface Writable {
    write(chunk: string): unknown;
}
export declare class Output {
    private readonly stdout;
    private readonly stderr;
    private context;
    constructor(stdout: Writable, stderr?: Writable, context?: OutputContext);
    setContext(context: OutputContext): void;
    line(value?: string): void;
    /** Deliberate local-only identity display; never use for logs, JSON, or errors. */
    signedIn(email: string): void;
    error(value: unknown): void;
    json(value: unknown): void;
}
//# sourceMappingURL=output.d.ts.map