/**
 * Code Scanner - Parse and chunk source files for embedding
 */
import { FileSelector, type FileSelectionOptions, type IndexExcludedFile } from './fileSelection.js';
export { FileSelector, DEFAULT_IGNORE_PATTERNS, fileOp, statTuple, BUILT_IN_IGNORE_DIRS, isSecretFile, DEFAULT_INCLUDE_EXTENSIONS, isCursorRulePath, languageForExtension, XCODE_AUTHORITY_PATH, isXcodeAuthorityPath, CMAKE_LISTS_PATH, isCmakeListsPath, isAuthorityOnlyPath, AUTHORITY_FILE_MATCHERS, FIXTURE_PATH_RE, isFixturePath, makeIgnoreMatcher, isGitBoundary, isProjectBoundary, rootProjectId, isLinkedWorktreeCheckout, type FileSelectionOptions, type FileStatTuple, type IndexRuleFiles, type IndexExcludedFile, } from './fileSelection.js';
/**
 * The version of the scanner's file hash: the SHA-256 of the scrubbed text
 * (`scrubSourceSecrets` over the file with NULs removed) and the content soft
 * default judged on it. The daemon caches that hash per file (size, mtime,
 * ctime, inode), so a restart or a release does not re-read and re-scrub every
 * file. Bump this number whenever redaction or the content soft defaults change
 * what they produce: every machine then re-reads and re-scrubs every file once,
 * which is exactly what a redaction fix needs. Do NOT bump it for a release that
 * leaves both unchanged; a needless bump costs every user a full re-read.
 * tests/ScrubVersion.test.ts pins the scrubber's output on a fixture next to
 * this number, so a scrubber change that forgets the bump fails there.
 */
export declare const SCRUB_VERSION = 1;
/**
 * The one file-size ceiling in Mnemonik. A file at or below this is scanned,
 * chunked, AND pushed verbatim; a file above it is uniformly outside the
 * system - not scanned, not chunked, not citable. "Scanned ⟺ verifiable".
 *
 * This is deliberately a single exported constant rather than a number
 * repeated per layer. Three ceilings previously existed and had drifted:
 * the scan ceiling here (10 MB), a 5 MB whole-file push cap in the scanner
 * daemon, and a 5 MB `content` cap in the server's scanPushSchema. Files
 * between 5 and 10 MB were therefore indexed as chunks whose source content
 * the server never received - chunks that could be retrieved but never
 * verified against, a silent fidelity split. Every consumer now imports this:
 *
 * - `CodeScanner.MAX_FILE_SIZE` / `collectAuthorityFilesWithStatus` (this file)
 * - `MAX_PUSH_CONTENT_BYTES` (packages/scanner/src/daemon.ts)
 * - `scanFileSchema.content` (src/server/routes/schemas.ts)
 *
 * Raising it means widening the stored-content pipe end to end; do not raise
 * one site alone.
 */
export declare const MAX_SCANNED_FILE_BYTES: number;
/** Transport ceiling; ordinary chunking may exceed maxChunkSize but never this bound. */
export declare const MAX_PUSH_CHUNK_CONTENT_LENGTH = 500000;
export interface CodeChunk {
    content: string;
    filePath: string;
    language: string;
    startLine: number;
    endLine: number;
    chunkType: 'function' | 'class' | 'module' | 'raw';
    contentHash: string;
    metadata: {
        fileName: string;
        extension: string;
        size: number;
        signature?: string;
        symbolName?: string;
        symbolKind?: string;
        /** Immediate structural container. Never written into symbolName. */
        symbolContainer?: string;
        /**
         * Ordinal of this piece among the pieces one oversize chunk was split
         * into (0, 1, 2, ...); absent for a chunk that was not split. Part of the
         * chunk's identity on the server: a piece with no newline keeps its
         * predecessor's line span, so the span alone does not tell them apart.
         */
        piece?: number;
    };
}
/** CodeScanner's options: the file selection's (fileSelection.ts) and its chunking. */
export interface ScanOptions extends FileSelectionOptions {
    maxChunkSize?: number;
    minChunkSize?: number;
    /**
     * Byte ceiling above which a file is chunked heuristically instead of parsed.
     * Defaults to `MAX_AST_PARSE_BYTES`; exposed so a caller (and the routing
     * test) can drive the degradation path through production code rather than a
     * mock.
     */
    maxAstParseBytes?: number;
}
/**
 * Log which grammars this install ships - ONCE per process, at daemon start,
 * never per file.
 *
 * A missing grammar silently degrades every file of that language to the
 * heuristic chunker. Per-file warnings would say so 30,000 times and drown the
 * log; saying nothing is how a half-broken install looks healthy. One startup
 * line naming the vendored grammars, and a WARNING when an artifact is missing,
 * is the whole contract.
 *
 * Deliberately a `statSync` of the artifacts (`astArtifactReport`) and not a
 * load of them (`astCapabilityReport`). Loading all 18 to print this line costs
 * ~690 ms and ~75 MB of RSS that is never returned - web-tree-sitter exposes no
 * `Language.delete` - which is a permanent tax on a daemon watching a pure
 * TypeScript repo, paid to pre-answer a question about seventeen languages it
 * will never see. Grammars load lazily instead, on the first file of a language,
 * and the two failure modes only a load can detect (`wasm_load_failed`,
 * `query_compile_failed`) are warned there, once per language, by the
 * `grammar_unavailable` branch in `chunkFile`.
 *
 * Cheap to call repeatedly: this latches, and the report instantiates nothing.
 */
export declare function logAstCapabilityOnce(): Promise<void>;
export declare class CodeScanner extends FileSelector {
    private options;
    constructor(options?: ScanOptions);
    /**
     * Scan a directory recursively and extract code chunks
     * No depth limit: symlinks are skipped and WalkState.ancestors ends any cycle.
     */
    scanDirectory(rootPath: string): Promise<CodeChunk[]>;
    /**
     * Completeness-aware variant of `scanDirectory`. `complete === false`
     * means at least one fs error was swallowed during the walk, so the
     * chunk set may be missing files that still exist on disk - callers
     * deriving removals from the result must not trust it as an inventory.
     * Chunks are secret-scrubbed before returning (same daemon-side
     * redaction guarantee as `scanFiles`). `chunkless` lists the Markdown and
     * instruction files that chunked to nothing, as `scanFiles` reports them.
     */
    scanDirectoryWithStatus(rootPath: string): Promise<{
        chunks: CodeChunk[];
        complete: boolean;
        chunkless: string[];
        /** Files a soft default excluded by their content (path exclusions are not listed). */
        excluded: IndexExcludedFile[];
    }>;
    /**
     * Scan specific files and extract code chunks.
     * Pass rootPath to compute proper relative file paths in chunk metadata.
     *
     * `chunkless`, when given, receives the path (spelled as a chunk's `filePath`)
     * of every Markdown or instruction file that passed every gate and was read,
     * but yielded no chunk because each section fell under `minChunkSize`. The
     * daemon still pushes such a file's whole content: it is a doc the project
     * owns, and it would otherwise never reach the server.
     *
     * `excluded`, when given, receives every chunkable file a soft default
     * excluded (indexClassifier.ts), by path or by content. The daemon tells the
     * server about content exclusions so the server can retire what an earlier
     * version of the file left in the index.
     */
    scanFiles(filePaths: string[], rootPath: string, chunkless?: string[], excluded?: IndexExcludedFile[]): Promise<CodeChunk[]>;
    /**
     * Daemon-side secret redaction: scrub credentials from chunk content
     * before they leave this process. contentHash is recomputed from the
     * scrubbed content so the server-side dedup cache (which keys on
     * contentHash) hits when team members push the same scrubbed text.
     * Server still re-applies source sanitation in the /scan/push handler as
     * defense in depth (idempotent). Shared by `scanFiles` (watcher path)
     * and `scanDirectoryWithStatus` (initial/full-rescan path) so both
     * honor the same redaction guarantee.
     */
    private scrubChunks;
    /**
     * Recursively traverse directory
     * Added depth parameter with max limit
     */
    private traverseDirectory;
    /**
     * Parse a file and extract code chunks.
     * Size limit is the shared `MAX_SCANNED_FILE_BYTES` ceiling - the same
     * number the daemon and the server's scanPushSchema enforce, so anything
     * chunked here can always be shipped and stored verbatim.
     */
    private static readonly MAX_FILE_SIZE;
    private parseFile;
    /**
     * Hold every AST chunk at or under `maxChunkSize`, or answer `null` when this
     * file cannot be held there on line boundaries.
     *
     * The AST chunker bounds only the spans it invents (`MAX_RAW_SPAN_CHARS`); a
     * chunk that came from a definition is exactly as big as the definition, and a
     * span that is one enormous line is left whole on purpose. Both used to reach
     * the wire verbatim, where `scanChunkSchema` caps content at 500,000 chars and
     * rejects the WHOLE push if any chunk is over - so one generated file stopped
     * all scanning for that push - and where anything past 8191 tokens is only
     * partially embedded.
     *
     * The invariants, all of which the split preserves:
     * - content stays verbatim contiguous source: `lines[startLine-1..endLine-1]`
     *   joined by '\n', never a join of disjoint regions and never an elision;
     * - total coverage is unchanged: the pieces tile the original range, in order,
     *   with no gap and no overlap;
     * - the definition's identity rides on the piece that carries its signature -
     *   the first one - and the continuations are plain `raw` spans, because a
     *   continuation is not the definition and must not claim its name.
     *
     * `null` (the caller degrades the whole file to the heuristic chunker) is
     * reserved for the one shape a line-boundary split cannot fix: a single line
     * longer than the cap, as every generated `*_pb2.py` has. Cutting mid-line
     * would give two chunks the same `filePath:startLine-endLine` staleness key,
     * which is the collision the chunker refuses everywhere else.
     */
    private boundAstChunks;
    /**
     * Detect language from file extension
     */
    private detectLanguage;
    /**
     * Chunk markdown files by headers
     */
    private chunkMarkdown;
    /**
     * Find the index of the closing brace matching the opening brace at openIndex.
     * Handles nested braces. Skips braces inside string literals, template literals,
     * single-line comments, multi-line comments, and regex literals.
     */
    private findMatchingBrace;
    /**
     * Extract structured chunks (functions, classes)
     * Uses brace-matching for TS/JS/Rust so nested braces are not truncated at first \n}
     */
    private extractStructuredChunks;
    /**
     * Get regex patterns for language
     */
    private getLanguagePatterns;
    /**
     * Raw chunking with overlap, bounded by character count (not line count).
     *
     * Line-count estimates do not bound long-line files such as minified JS,
     * JSON blobs and generated code. Walk lines and accumulate character
     * length; emit when the next
     * line would push the running total past `maxChunkSize`. Single lines
     * longer than `maxChunkSize` are force-split into char-based segments.
     * 10% overlap is carried by character count from the tail of the
     * just-emitted chunk.
     */
    private chunkRaw;
    /**
     * Generate content hash for drift detection
     */
    private hash;
    /**
     * Walk the project for authority manifest/config/CI files and return their
     * verbatim content. Reuses ignorePatterns; matches AUTHORITY_FILE_MATCHERS
     * (not includeExtensions). Content-only - no chunking, no embeddings.
     */
    collectAuthorityFiles(projectRoot: string): Promise<Array<{
        path: string;
        content: string;
        hash: string;
    }>>;
    /**
     * Completeness-aware variant of `collectAuthorityFiles`. `complete ===
     * false` means an fs error hid part of the walk, so authority paths may
     * be missing - the daemon folds this into the same removal gate as
     * `listFilesWithStatus` (a partial authority walk would likewise drop
     * inventory entries and read as deletion).
     */
    collectAuthorityFilesWithStatus(projectRoot: string, onFile?: (file: {
        path: string;
        content: string;
        hash: string;
    }) => Promise<void>): Promise<{
        files: Array<{
            path: string;
            content: string;
            hash: string;
        }>;
        complete: boolean;
        /** Entries a filesystem error or timeout left out. */
        unreadable: number;
        /** The first few unreadable entries, with the reason. */
        unreadableSamples: Array<{
            path: string;
            reason: string;
        }>;
    }>;
}
//# sourceMappingURL=codeScanner.d.ts.map