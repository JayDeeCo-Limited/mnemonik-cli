/**
 * The largest source redacted with its syntax tree: the scanner's own file
 * ceiling (MAX_SCANNED_FILE_BYTES, 10 MB; repeated here because codeScanner.ts
 * imports this module). It was 2 MiB, sized from "the largest file in this
 * repository", and above it every file took the text fallback: PowerShell,
 * CMake, Groovy, Nix, Terraform and the bundled languages were stamped
 * "source-fidelity-unavailable", so connected code refused every such file
 * over 2 MiB, and other languages could keep structural [REDACTED] the
 * extractors refuse (streams F1/F2, 25 October 2026). Memory for a large
 * parse is bounded by running it in a child process sized from the file
 * (installSourceRedactor below; sourceRedactionPool.ts), not by refusing it.
 */
export declare const MAX_SOURCE_REDACTION_BYTES: number;
/**
 * Where a process sends source it should not parse in its own memory: the
 * server sends Swift and every file of a megabyte or more to a Liftoff-only
 * child sized from the file; the scanner sends large files to its own
 * child. Unset (tests, small tools), everything is redacted in process.
 */
export interface SourceRedactionOptions {
    /** 'interactive' when an agent is waiting on this file (file_push). */
    priority?: 'interactive' | 'background';
}
export interface SourceRedactor {
    routes(filePath: string, bytes: number): boolean;
    redact(text: string, filePath: string, options?: SourceRedactionOptions): Promise<string>;
}
export declare function installSourceRedactor(redactor: SourceRedactor | null): void;
/** Source syntax stays executable; unsupported or incomplete input uses the conservative scrubber. */
export declare function scrubSourceSecrets(text: string, filePath: string, options?: SourceRedactionOptions): Promise<string>;
/** The redaction itself, in this process. The out-of-process worker calls this. */
export declare function scrubSourceSecretsInProcess(text: string, filePath: string): Promise<string>;
/** Sanitize parser-owned payload spans; no SFC boundary is inferred from text matching. */
/**
 * Apply replacement spans to `text` in one pass, or null when two overlap
 * (or a span is malformed).
 * The result equals applying them one at a time from the last start to the
 * first (spans that start together: the one added later lands first), which
 * is what the Vue scrubber did with a slice-and-concatenate per edit; that
 * copied the whole file for every edit, about 40 s for a 1 MB component.
 */
export declare function applySpanEdits(text: string, edits: ReadonlyArray<{
    start: number;
    end: number;
    clean: string;
}>): string | null;
//# sourceMappingURL=sourceRedaction.d.ts.map