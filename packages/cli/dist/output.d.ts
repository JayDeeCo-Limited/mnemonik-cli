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
    private headingNext;
    private progress?;
    constructor(stdout: Writable, stderr?: Writable, context?: OutputContext);
    setContext(context: OutputContext): void;
    beginInstallation(): void;
    installSection(): void;
    /** A heading that is not a numbered step: flush left, with a blank line above it. */
    heading(value: string): number;
    inputPrefix(): void;
    line(value?: string): number;
    write(value: string): void;
    /** Deliberate local-only identity display; never use for logs, JSON, or errors. */
    signedIn(email: string): void;
    /** The account line of plain `auth status`: the same deliberate display, or nothing. */
    signedInAs(email: string | undefined): void;
    error(value: unknown, human?: boolean): number;
    json(value: unknown): void;
    progressLine(text: string, animated: boolean): {
        complete(result: string): void;
        stop(): void;
    };
    private emitHuman;
}
//# sourceMappingURL=output.d.ts.map