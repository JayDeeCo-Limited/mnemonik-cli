/**
 * Default indexing rules: which files are not code an agent works with.
 *
 * Code search should return the code agents edit, not generated clients,
 * minified bundles, binary files, vendored dependencies or data dumps. These
 * rules are SOFT defaults: a project can re-include any path they exclude, and
 * that is what separates them from the hard rules that stay where they are
 * (`isSecretFile`, protected paths, symlinks, nested git boundaries and
 * `BUILT_IN_IGNORE_DIRS`, none of which can be overridden).
 *
 * Precedence, highest first:
 *   1. hard rules - applied by the callers before this module is consulted;
 *   2. the project's .gitignore / .mnemonikignore - a path they ignore is out,
 *      and a `!pattern` that matches the path ITSELF re-includes it from every
 *      soft default (a re-included parent directory does not: `.yarn/*` plus
 *      `!.yarn/releases`, Yarn's own recommended .gitignore, must not opt the
 *      bundled Yarn release back in);
 *   3. .gitattributes - `linguist-vendored` / `linguist-generated` set or
 *      `=true` excludes, `-linguist-...` or `=false` re-includes, `binary` or
 *      `-text` means binary. Hierarchical, last match wins, as git resolves it;
 *   4. the soft defaults below - path rules first, then content rules.
 *
 * ONE implementation for every place a path is judged: the daemon walk, its
 * watcher and discovery walk, the server's push backstop and the retirement
 * of stored rows. Two copies of a rule drift, and here drift means the daemon
 * and the server disagree about what exists.
 *
 * Content rules read the SCRUBBED text (`scrubSecrets`), because that is the
 * text the server receives: classifying the raw bytes on one side and the
 * scrubbed bytes on the other would let a redaction placeholder move a file
 * across the minified threshold on one side only.
 */
export declare const INDEX_EXCLUSION_REASONS: readonly ['vendored', 'generated', 'minified', 'binary', 'data_dump', 'changelog'];
export type IndexExclusionReason = (typeof INDEX_EXCLUSION_REASONS)[number];
/** A soft default (or a .gitattributes attribute) excluded the path. */
export interface IndexExclusion {
    reason: IndexExclusionReason;
    /**
     * The concrete rule, for operators and the retirement shape guard. Never
     * carries a per-file number, so paths group by rule.
     */
    rule: string;
}
export type IndexClassification = {
    include: true;
    /**
     * Set when a project rule re-included the path. Content rules do not run
     * for an overridden path: the project has said it is code.
     */
    override?: 'ignore_file' | 'gitattributes';
} | ({
    include: false;
} & IndexExclusion);
/** What a project's .gitignore / .mnemonikignore stack says about one path. */
export type IgnoreFileVerdict = 'ignored' | 'unignored' | 'unmatched';
/** Human phrase for a reason: "generated code", "a binary file". */
export declare function indexExclusionLabel(reason: IndexExclusionReason): string;
/**
 * The one line an agent sees when it asks about an excluded path. Short on
 * purpose: the agent needs to know the absence is deliberate and that its own
 * file tools still reach the file.
 */
export declare function indexExclusionNotice(reason: IndexExclusionReason, subject?: string): string;
export declare function isIndexExclusionReason(value: unknown): value is IndexExclusionReason;
/**
 * Soft default for a directory, from its path alone. `dirRel` is the
 * directory's root-relative path, with or without a trailing slash. Used to
 * prune walks: nothing under a vendored or generated directory can be
 * included by a soft default.
 */
export declare function softDefaultForDirectory(dirRel: string): IndexExclusion | null;
/** Soft default for a file from its path alone (R2, R3 by name, R8 AppleDouble, R9). */
export declare function softDefaultForPath(relPath: string): IndexExclusion | null;
/** git's binary heuristic window. */
export declare const BINARY_SNIFF_BYTES = 8000;
/** R5: average line length above which a .js/.mjs/.cjs/.css file is minified. */
export declare const MINIFIED_AVERAGE_LINE_LENGTH = 110;
/** R5: a line longer than this, in UTF-8 bytes, is a minified line. */
export declare const MINIFIED_LONG_LINE_BYTES = 4096;
/** R7: a .sql file with at least this many INSERT INTO statements is a dump. */
export declare const DATA_DUMP_INSERT_THRESHOLD = 50;
/**
 * Soft default from a file's content (R4, R5, R7, R8). `content` is the
 * decoded, scrubbed text. R8 uses git's heuristic: a NUL in the first 8,000
 * characters (which cover at least the first 8,000 bytes).
 */
export declare function softDefaultForContent(relPath: string, content: string): IndexExclusion | null;
/** Attribute state after git's rules: set, unset (`-a`), or a value. */
type AttributeValue = true | false | string;
export interface GitattributesRule {
    /** Matched against the path relative to the attributes file's directory. */
    re: RegExp;
    /** No '/' in the pattern: match the base name at any depth. */
    basenameOnly: boolean;
    /** `undefined` = `!attr` (reset to unspecified). */
    attrs: ReadonlyMap<string, AttributeValue | undefined>;
}
/** One .gitattributes file: its directory relative to the root ('' = root). */
export interface GitattributesLayer {
    baseRel: string;
    rules: readonly GitattributesRule[];
}
/**
 * Parse one .gitattributes file. Comments, blank lines, macro definitions
 * (`[attr]...`) and negative patterns (forbidden by git) are skipped. The
 * built-in `binary` macro is expanded to `-text`, which is the part of it this
 * module reads.
 */
export declare function parseGitattributes(text: string): GitattributesRule[];
/** The attributes this module reads, resolved for one path. */
export interface LinguistAttributes {
    /** true = vendored, false = explicitly not vendored, undefined = unspecified. */
    vendored?: boolean;
    generated?: boolean;
    binary: boolean;
}
/**
 * Resolve `linguist-vendored`, `linguist-generated` and binary-ness for one
 * root-relative path. `layers` are applied root first, then deeper; within a
 * file, later lines win - git's own order. `linguist-documentation` is not
 * read: documentation is what agents read.
 */
export declare function linguistAttributesFor(relPath: string, layers: readonly GitattributesLayer[]): LinguistAttributes;
/** True when any rule in these layers can re-include a path (`-linguist-*` or `=false`). */
export declare function gitattributesCanReinclude(layers: readonly GitattributesLayer[]): boolean;
export interface ClassifyForIndexOptions {
    /**
     * Decoded, scrubbed file content. Omit to classify by path only; the
     * result then says nothing about content rules, which the caller applies
     * later unless `override` is set.
     */
    content?: string;
    /**
     * The project's .gitignore / .mnemonikignore verdict for this path. An
     * `'ignored'` path is excluded before this function is consulted;
     * `'unignored'` - a `!pattern` matched the path itself - re-includes it.
     */
    ignoreFileVerdict?: IgnoreFileVerdict;
    /** The .gitattributes files that apply, any order (resolved root first). */
    attributes?: readonly GitattributesLayer[];
}
/**
 * Should this path be indexed? `{ include: true }`, or
 * `{ include: false, reason, rule }`. Hard rules are not this function's
 * business: a caller excludes secrets, protected paths, symlinks, nested git
 * boundaries, built-in directories and user-ignored paths first.
 */
export declare function classifyForIndex(relPath: string, options?: ClassifyForIndexOptions): IndexClassification;
/**
 * The daemon uploads its root .gitignore / .mnemonikignore lines verbatim
 * (`ignorePatterns`, the server's privacy list). The other rule lines the
 * walk applied ride along as gitignore COMMENT lines, so a server or matcher
 * that predates them reads them as comments and changes nothing:
 *
 *   `#mnemonik:gitignore <dir>\t<line>`      - a nested .gitignore /
 *                                              .mnemonikignore line, for
 *                                              `!pattern` overrides
 *   `#mnemonik:gitattributes <dir>\t<line>`  - a .gitattributes line; <dir>
 *                                              is empty for the root file
 *
 * With them the server and retirement judge a path exactly as the daemon did.
 */
export declare const NESTED_IGNORE_TAG = "#mnemonik:gitignore ";
export declare const GITATTRIBUTES_TAG = "#mnemonik:gitattributes ";
export declare function encodeNestedIgnoreLine(baseRel: string, line: string): string;
export declare function encodeGitattributesLine(baseRel: string, line: string): string;
/** Uploaded rules, split back into their layers. */
export interface DecodedIndexRules {
    /** Root .gitignore / .mnemonikignore lines (the privacy list), in order. */
    rootIgnore: string[];
    /** Nested ignore-file lines by directory, in upload order. */
    nestedIgnore: Map<string, string[]>;
    /** .gitattributes lines by directory ('' = root), in upload order. */
    attributes: Map<string, string[]>;
}
export declare function decodeIndexRules(patterns: readonly string[]): DecodedIndexRules;
export {};
//# sourceMappingURL=indexClassifier.d.ts.map