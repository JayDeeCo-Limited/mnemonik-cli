export interface OutputContext {
    home?: string;
    projectRoot?: string;
}
/** Security boundary for every human and machine-readable CLI emission. */
export declare function redact(value: unknown, context?: OutputContext): string;
export interface Writable {
    isTTY?: boolean;
    supportsHyperlinks?: boolean;
    write(chunk: string): unknown;
}
export declare class Output {
    private readonly stdout;
    private readonly stderr;
    private context;
    private installationLayout;
    private lastHumanLineBlank;
    private progress?;
    constructor(stdout: Writable, stderr?: Writable, context?: OutputContext);
    setContext(context: OutputContext): void;
    beginInstallation(): void;
    installSection(): void;
    inputPrefix(): void;
    line(value?: string): number;
    write(value: string): void;
    /** Deliberate local-only identity display; never use for logs, JSON, or errors. */
    signedIn(email: string): void;
    error(value: unknown): number;
    json(value: unknown): void;
    progressLine(text: string, animated: boolean): {
        complete(result: string): void;
        stop(): void;
    };
    private emitHuman;
}
//# sourceMappingURL=output.d.ts.map