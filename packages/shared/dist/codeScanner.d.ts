/**
 * Code Scanner - Parse and chunk source files for embedding
 */
import { type Stats } from 'fs';
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
    };
}
export interface ScanOptions {
    maxChunkSize?: number;
    minChunkSize?: number;
    ignorePatterns?: string[];
    includeExtensions?: string[];
    /**
     * Byte ceiling above which a file is chunked heuristically instead of parsed.
     * Defaults to `MAX_AST_PARSE_BYTES`; exposed so a caller (and the routing
     * test) can drive the degradation path through production code rather than a
     * mock.
     */
    maxAstParseBytes?: number;
    /** Additional protected paths for isolated homes/tests; defaults can only be extended. */
    protectedPaths?: readonly string[];
}
/**
 * Directory basenames the scanner never indexes, across every ecosystem -
 * generated output, package-manager/build caches, and vendored deps. SINGLE
 * SOURCE OF TRUTH: the scanner package's discovery + watch walks import this
 * (`packages/scanner/src/{discovery,watcher}.ts`) and `src/core/utils.ts`
 * derives from it, so every ignore surface agrees instead of drifting (the
 * pre-2026-07 state had four divergent copies). Add only UNAMBIGUOUS names -
 * a project's own `.gitignore` / `.mnemonikignore` covers the ambiguous,
 * project-specific cases (`vendor/`, custom dirs) hierarchically.
 */
export declare const BUILT_IN_IGNORE_DIRS: readonly string[];
/**
 * True when `relPath` names a file whose contents are credentials. Applied
 * by `shouldIgnore` (every walker: directory scan, explicit file lists, and
 * the authority-file walk) and by `makeIgnoreMatcher` (server-side backstop
 * for older or misbehaving daemons). Accepts OS-native or POSIX separators.
 */
export declare function isSecretFile(relPath: string): boolean;
/**
 * Every file type the scanner will chunk, by extension. Matched
 * case-INSENSITIVELY (see `isIncludedExtension`), so lowercase spellings here
 * also cover `.R`, `.SQL`, `.PS1` and the uppercase `.C`/`.H` of older trees.
 *
 * Exported because this list IS the product's language coverage: a project
 * written in something absent from it indexes zero code, and `code_search`
 * reports that as "no indexed matches" rather than "I do not read this
 * language" - invisible to the developer and to us. Coverage is a separate
 * dial from parse quality: a language with no structured extractor falls
 * through to `chunkRaw`, which is what Go, Java and C already get in
 * production, and crude chunks beat no chunks by an enormous margin.
 *
 * Data formats (`.json`, `.yaml`, `.toml`, `.lock`) are deliberately absent:
 * the ones that carry meaning are already collected verbatim by
 * `AUTHORITY_FILE_MATCHERS`, and blanket-indexing the extension would pull in
 * lockfiles and generated output. `.tfvars` is absent for a different reason -
 * `terraform.tfvars` is a conventional home for provider credentials and
 * `isSecretFile` now excludes it outright.
 */
export declare const DEFAULT_INCLUDE_EXTENSIONS: readonly string[];
/**
 * Language string for a file path or a bare extension, `'unknown'` when the
 * extension is unmapped. A free function rather than a method because callers
 * that never scan anything (AST grammar resolution, server-side symbol
 * preference) need the same answer without constructing a scanner.
 */
export declare function languageForExtension(filePathOrExt: string): string;
/**
 * True when `relPath` is collected verbatim as authority content and must not
 * also be chunked. Accepts OS-native or POSIX separators.
 */
export declare function isAuthorityOnlyPath(relPath: string): boolean;
/**
 * Matchers for authority manifest / config / CI files whose verbatim content
 * is collected by `collectAuthorityFiles` and pushed to the server for
 * doc-truth Fingerprint parsing. Operates on relative, forward-slash paths.
 */
export declare const AUTHORITY_FILE_MATCHERS: Array<(relPath: string) => boolean>;
/**
 * Segment-anchored match for the `tests/fixtures/` ignore pattern above -
 * matches at the path root or immediately after a `/`, mirroring exactly
 * what `shouldIgnore` compiles `'/tests/fixtures/*'` to. Exported so
 * server-side consumers (e.g. the `/scan/push` route) and query-time
 * consumers (e.g. `MemoryManager.searchCodePointers`'s hygiene exclusions)
 * share one definition instead of hand-rolling copies that can drift.
 */
export declare const FIXTURE_PATH_RE: RegExp;
export declare function isFixturePath(path: string): boolean;
/**
 * Server-side ignore matcher for defense-in-depth path dropping on /scan/push,
 * /scan/reconcile, and file_push. Combines the universal BUILT_IN_IGNORE_DIRS
 * (segment-exact) with a project's uploaded .gitignore/.mnemonikignore patterns
 * (gitignore syntax via the `ignore` package). Built once per request and reused
 * across all pushed paths (root-relative, forward-slash). This does NOT replace
 * the daemon's precise hierarchical walk - it backstops it so a buggy, stale, or
 * malicious client cannot index a path the project ignores, making .mnemonikignore
 * a hard guarantee rather than best-effort.
 */
export declare function makeIgnoreMatcher(extraPatterns?: readonly string[]): (relPath: string) => boolean;
/**
 * True when `dirPath` is the root of a DIFFERENT repository than the one
 * being scanned: it carries its own `.git` entry. A `.git` FILE marks a
 * linked git worktree (wherever the user keeps them) or a submodule
 * checkout; a `.git` DIRECTORY marks a nested clone. Files under such a
 * boundary belong to that repository's own project identity - scanning them
 * into the parent project is wrong attribution for any codebase, so the
 * walkers skip these subtrees. Convention-free: this is git's own marker,
 * not a host/tool path layout. The scan ROOT is exempt by construction
 * (callers only test child directories).
 */
export declare function isGitBoundary(dirPath: string): Promise<boolean>;
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
export declare class CodeScanner {
    private options;
    private readonly protectedPaths;
    /** Cumulative observations since this scanner started, including repeated walks. */
    readonly skipReasons: {
        symlink_skipped: number;
    };
    private skipSymlink;
    /**
     * `includeExtensions` folded to lowercase for matching. The gate used to
     * compare `extname()` verbatim while `detectLanguage` lowercased, so a
     * project spelling its files the canonical way - `.R` for R, `.SQL`/`.PS1`
     * on Windows, `.C`/`.H` in older C trees - indexed zero of them and nothing
     * said why.
     */
    private readonly includeExtensionSet;
    constructor(options?: ScanOptions);
    private isProtected;
    private isProtectedRead;
    /**
     * The chunkable-file gate, shared by every walker and by the explicit
     * file-list path so all three agree on what exists. `relPath` is the path
     * relative to the scan root (OS-native separators accepted).
     */
    private isChunkable;
    /**
     * Read `.gitignore` + `.mnemonikignore` in `absDir` and compile them into one
     * ignore layer (the two files are unioned - `.mnemonikignore` is just an
     * additional gitignore-syntax exclusion list). Returns null when neither file
     * exists. FAIL-CLOSED: a non-ENOENT read error (EISDIR, EACCES, timeout)
     * latches `walk.complete = false` so callers deriving *removals* from the walk
     * treat it as untrustworthy rather than silently ignoring nothing.
     */
    private loadIgnoreLayer;
    /**
     * True when `entryRel` (relative to the scan root) is excluded by any ignore
     * layer in `stack`. Tested deepest-first: the first layer that explicitly
     * ignores OR re-includes (via a `!negation`) wins, matching git's rule that a
     * deeper `.gitignore` overrides a shallower one. Directories are tested with a
     * trailing slash so `foo/` dir-only rules match the directory itself.
     */
    private ignoredByStack;
    /**
     * Reconstruct the root->parent ignore-layer stack for a single file, for the
     * incremental `scanFiles` path (which has a flat file list, not a recursive
     * walk). Layers are memoized per directory in `cache` across a batch.
     */
    private buildIgnoreStackForFile;
    /**
     * True when any directory strictly between `rootPath` and `filePath`
     * carries its own `.git` entry (see isGitBoundary). Paths that don't
     * resolve under `rootPath` are not judged here (return false) - the
     * server's path validation handles escapes.
     */
    private insideNestedGitBoundary;
    /**
     * Maximum directory depth for recursive scanning
     * Prevents runaway recursion on deep/symlinked structures
     */
    private static readonly MAX_DEPTH;
    private canonicalRoots;
    private canonicalRoot;
    static containsCanonical(candidate: string, root: string, paths?: {
        sep: "/" | "\\";
        resolve: (...paths: string[]) => string;
    }, caseInsensitive?: boolean): boolean;
    private confineSymlink;
    readConfined(fullPath: string, canonicalRoot: string, enumerated?: Stats): Promise<string>;
    /**
     * Scan a directory recursively and extract code chunks
     * Added max depth (10) to prevent infinite recursion
     */
    scanDirectory(rootPath: string): Promise<CodeChunk[]>;
    /**
     * Completeness-aware variant of `scanDirectory`. `complete === false`
     * means at least one fs error was swallowed during the walk, so the
     * chunk set may be missing files that still exist on disk - callers
     * deriving removals from the result must not trust it as an inventory.
     * Chunks are secret-scrubbed before returning (same daemon-side
     * redaction guarantee as `scanFiles`).
     */
    scanDirectoryWithStatus(rootPath: string): Promise<{
        chunks: CodeChunk[];
        complete: boolean;
    }>;
    /**
     * Enumerate scan-eligible relative file paths under `rootPath` without
     * reading or chunking content. Same walk + ignorePatterns + extension
     * filter as `scanDirectory`, but bounded to O(file count) directory ops
     * - cheap enough to call on every periodic reconcile tick.
     *
     * Returns relative paths normalized against `rootPath`, matching the
     * shape the server stores in `memories.metadata->>'filePath'`. Use this
     * for the scanner reconciliation channel (`POST /api/v1/scan/reconcile`).
     *
     * Defensive: skips any path whose `relative()` result contains a `..`
     * traversal segment (can happen when a symlink resolves under root but
     * the readdir entry path doesn't normalize cleanly). The server's
     * `safeScanPath` rejects such paths; filtering here keeps a single
     * malformed entry from failing the entire reconcile push.
     */
    listFiles(rootPath: string): Promise<string[]>;
    /**
     * Completeness-aware variant of `listFiles`. `complete === false` means
     * an fs error truncated part of the walk - the returned paths may be
     * missing files that still exist on disk. The daemon's reconcile channel
     * MUST NOT derive removedFiles from an incomplete inventory (a truncated
     * walk otherwise reads as mass deletion and deprecates live memories).
     */
    listFilesWithStatus(rootPath: string): Promise<{
        paths: string[];
        complete: boolean;
    }>;
    private traversePaths;
    /**
     * Scan specific files and extract code chunks.
     * Pass rootPath to compute proper relative file paths in chunk metadata.
     */
    scanFiles(filePaths: string[], rootPath: string): Promise<CodeChunk[]>;
    /**
     * Daemon-side secret redaction: scrub credentials from chunk content
     * before they leave this process. contentHash is recomputed from the
     * scrubbed content so the server-side dedup cache (which keys on
     * contentHash) hits when team members push the same scrubbed text.
     * Server still re-applies scrubSecrets in the /scan/push handler as
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
     * Check if path should be ignored
     * Fixed glob-to-regex conversion and substring matching.
     * - Escape regex special chars before replacing * with .*
     * - Replace ALL * occurrences (not just the first)
     * - For non-glob patterns, match on path segments to avoid false positives
     *   (e.g., '.env' should not match '.environment.ts')
     */
    private shouldIgnore;
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
    }>;
}
//# sourceMappingURL=codeScanner.d.ts.map