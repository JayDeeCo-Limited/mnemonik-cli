export interface RedactCredentialsOptions {
    /**
     * Values already found to be credentials elsewhere (another row of the same
     * store), redacted wherever they recur in this text. The redaction script
     * passes the values its census found, so a password written once in a
     * command and once in prose is gone from every row.
     */
    knownValues?: Iterable<string>;
    /**
     * Run only the command-line password rules (and the recurrence pass). For
     * scanner code chunks, whose content the scanner already scrubbed with its
     * own patterns and where the broad named-value rule misreads code.
     */
    commandLineOnly?: boolean;
}
export declare function redactCredentials(text: string, options?: RedactCredentialsOptions): {
    text: string;
    redactions: number;
    kinds: string[];
};
/** Source callers edit literal AST spans within these existing command-line matches. */
export declare function commandLineCredentialRanges(text: string): Array<{
    start: number;
    end: number;
}>;
/**
 * The credential values the context rules (command-line passwords, URL
 * passwords, named values, Bearer tokens) would redact from `text`, for a
 * caller that redacts them across many texts (`knownValues`). The values are
 * secrets: never log, print, store or return them.
 */
export declare function credentialValues(text: string, options?: Pick<RedactCredentialsOptions, 'commandLineOnly'>): Set<string>;
//# sourceMappingURL=redactCredentials.d.ts.map