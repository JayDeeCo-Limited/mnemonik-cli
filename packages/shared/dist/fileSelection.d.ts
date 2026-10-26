/**
 * Which files the scanner indexes under a root: the walk, every ignore rule it
 * applies (.gitignore, .mnemonikignore, .gitattributes, the built-in and soft
 * defaults, secret files, protected paths, nested projects) and its limits.
 *
 * It is its own module, apart from codeScanner.ts, so a caller that only needs
 * the selection (the CLI's estimate before the first scan) loads none of the
 * chunker, the source redaction or the compilers behind it (26 Oct 2026: the
 * public CLI bundled the Svelte and Vue compilers into its estimate). It is the
 * scanner's own selection, not a copy: CodeScanner extends FileSelector.
 * Exported alone as `@mnemonik/shared/file-selection`.
 */
import { type Stats } from 'fs';
import { type Ignore } from 'ignore';
import { type GitattributesLayer, type GitattributesRule, type IgnoreFileVerdict, type IndexClassification, type IndexExclusionReason } from './indexClassifier.js';
/**
 * Run one filesystem operation within FILE_OP_TIMEOUT_MS, and once more within
 * FILE_OP_RETRY_TIMEOUT_MS if the first attempt timed out. Other errors are not
 * retried: ENOENT, EACCES and the containment refusals answer the same way twice.
 */
export declare function fileOp<T>(op: () => Promise<T>, label: string, budgets?: {
    first: number;
    retry: number;
}): Promise<T>;
/** A file's identity on disk as the stat cache compares it. */
export interface FileStatTuple {
    size: number;
    mtimeMs: number;
    ctimeMs: number;
    ino: number;
}
export declare function statTuple(stats: Stats): FileStatTuple;
/**
 * Mutable per-walk state threaded through the recursive traversals.
 * `complete` starts true and is latched false by any caught fs error
 * (readdir failure, per-entry lstat/realpath/stat throw) - meaning the
 * result may be missing entries that still exist on disk. Callers that
 * derive *removals* from a walk must treat an incomplete walk as
 * untrustworthy; adds/changes are unaffected.
 */
export interface WalkState {
    complete: boolean;
    /** Entries a filesystem error or timeout left out of this walk (a blind spot). */
    unreadable?: number;
    /** The first few of them, with the error code or message. */
    unreadableSamples?: Array<{
        path: string;
        reason: string;
    }>;
    /**
     * The directories on the path from the root to the one being walked, by
     * device and inode. Symlinks are never followed, so a loop needs a bind
     * mount or a filesystem cycle; reaching one of its own ancestors ends it
     * (what the old depth cap of 10 was for) and makes the walk incomplete.
     * Only ancestors count: the same directory reached twice without a loop (a
     * bind mount in two places) is walked both times, since skipping it would
     * leave a walk that looks complete and the removed-files diff would delete
     * that subtree.
     */
    ancestors?: Set<string>;
    /**
     * When present, every rule file the walk reads is recorded here by
     * directory, so the daemon can upload the lines it actually applied.
     */
    rules?: Map<string, IndexRuleFiles>;
}
/** An entry the walk could not read: the walk is no longer complete, and it counts. */
export declare function markUnreadable(walk: WalkState, path: string, error: unknown): void;
/**
 * Enter a directory unless it is one of its own ancestors. Returns the
 * function that leaves it again (call it once its subtree is walked), or null
 * for a cycle, which is not walked and makes the walk incomplete, so the
 * removed-files diff never treats what it did not see as deleted.
 */
export declare function enterDirectory(walk: WalkState, path: string): Promise<(() => void) | null>;
/** The rule-file lines one directory contributed to a walk. */
export interface IndexRuleFiles {
    /** .gitignore + .mnemonikignore lines, unioned, in read order. */
    ignore: string[];
    /** .gitattributes lines, in read order. */
    attributes: string[];
}
/**
 * A file a walk declined to index because a soft default excluded it.
 * `stage: 'content'` means the file was read and its content decided.
 */
export interface IndexExcludedFile {
    /** Root-relative POSIX path, spelled as a chunk's `filePath`. */
    path: string;
    reason: IndexExclusionReason;
    rule: string;
    stage: 'path' | 'content';
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
 * Non-directory built-in ignore patterns (files, globs, and the segment-
 * anchored fixture rule), combined with BUILT_IN_IGNORE_DIRS to form
 * DEFAULT_OPTIONS.ignorePatterns. See `shouldIgnore` for match semantics.
 *
 * `/tests/fixtures/*`: leading '/' = segment-anchored - matches tests/fixtures/
 * at the path root or immediately after a '/', so nested packages/x/tests/
 * fixtures/ are excluded but integration-tests/fixtures/ is NOT. Fixture
 * snapshot dirs were being indexed as real source and outranking the genuine
 * file in code_search. (Subprojects and linked worktrees are excluded
 * generically by the isProjectBoundary rule below, not a path convention.)
 */
export declare const BUILT_IN_IGNORE_FILE_PATTERNS: readonly string[];
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
 * Cursor's rule files: `.cursorrules`, and any `.mdc` under `.cursor/rules/`.
 * Cursor is a launch host, so these are instruction files, the same class as
 * CLAUDE.md and AGENTS.md. Neither spelling can come in through
 * `DEFAULT_INCLUDE_EXTENSIONS`: `.cursorrules` has no extension (`extname`
 * answers ''), and `.mdc` is not a format this scanner reads anywhere else. So
 * both are admitted by path at the chunking gate (`isChunkable`) and chunked as
 * Markdown. They are not `.md` paths, so their whole-file content lands in
 * project_source_content.
 *
 * Matched at any depth, because Cursor also reads nested `.cursor/rules`
 * directories in a monorepo. Case-sensitive, as Cursor spells them. Accepts
 * OS-native or POSIX separators.
 */
export declare function isCursorRulePath(relPath: string): boolean;
/**
 * Language string for a file path or a bare extension, `'unknown'` when the
 * extension is unmapped. A free function rather than a method because callers
 * that never scan anything (AST grammar resolution, server-side symbol
 * preference) need the same answer without constructing a scanner.
 */
export declare function languageForExtension(filePathOrExt: string): string;
/** Content-only build authority, shared by scanner collection and server admission. */
export declare const XCODE_AUTHORITY_PATH: RegExp;
export declare const isXcodeAuthorityPath: (path: string) => boolean;
/** Exact CMake build entrypoint; ordinary .txt files remain outside collection. */
export declare const CMAKE_LISTS_PATH: RegExp;
export declare const isCmakeListsPath: (path: string) => boolean;
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
 * Segment-anchored match for `tests/fixtures/` - matches at the path root or
 * immediately after a `/`. Indexing no longer uses it (the fixture rule is the
 * soft default in indexClassifier.ts, which a project can override); it stays
 * for query-time hygiene over rows indexed before that rule existed
 * (`MemoryManager.searchCodePointers`).
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
 * There is no depth limit on a project's walk. A cap of 10 folders guarded the
 * first scanner (February 2026) against runaway recursion through symlinked
 * trees; symlinks have long been skipped by every walker (confineSymlink,
 * skipSymlink), and WalkState.ancestors ends a bind-mount cycle. The cap only hid
 * ordinary deep files (Java and Kotlin package trees, Next.js monorepos), and the
 * watcher, which had no cap, then pushed a deep file the next walk reported removed.
 */
/**
 * True when `dirPath` starts a subtree that is not this project's to index.
 * A file belongs to the project of the nearest `.mnemonik.json` above it, so:
 *  - a folder with its own identity file is a subproject, indexed as its own
 *    project, never also into this one. A file naming the enclosing project
 *    (`enclosingProjectId`, a copy) is the same project, and a
 *    configuration-only file (no `projectId`) names none: neither is a
 *    boundary. A file that cannot be read as an identity still is, and so is
 *    a copy in a full clone (its own `.git` DIRECTORY): a second checkout of
 *    the project, whose files would otherwise be indexed twice;
 *  - a linked worktree (a `.git` FILE whose git directory has a `commondir`,
 *    or is missing) is another checkout of a project, indexed from its main
 *    checkout.
 * A nested clone or a submodule without its own `.mnemonik.json` belongs to
 * this project and is indexed with it (its `.git` directory is ignored by the
 * built-in rules). The scan ROOT is exempt by construction (callers only test
 * child directories).
 */
export declare function isProjectBoundary(dirPath: string, enclosingProjectId?: string): Promise<boolean>;
/**
 * The project a scan root's own identity file names, or undefined: the
 * enclosing project for isProjectBoundary.
 */
export declare function rootProjectId(rootPath: string): Promise<string | undefined>;
/**
 * True when `dirPath` is the top of a linked git worktree: its `.git` is a
 * FILE pointing at a git directory that has a `commondir`, or at one that no
 * longer exists (a pruned or moved worktree, or one made on another machine):
 * nothing shows it is this project's own. A submodule's `.git` file points at
 * `.git/modules/<name>`, which exists and has no `commondir`.
 */
export declare function isLinkedWorktreeCheckout(dirPath: string): Promise<boolean>;
/**
 * One directory's compiled ignore-file rules, keyed by its path relative to
 * the scan root (`''` = root). A stack of these, root->leaf, is threaded
 * through the walkers; `ignoredByStack` tests deepest-first so a nested
 * `.gitignore` overrides a shallower one (git precedence).
 */
export interface IgnoreLayer {
    baseRel: string;
    /** Compiled .gitignore + .mnemonikignore; null when this directory has neither. */
    ig: Ignore | null;
    /** Any `!pattern` line: a path under here may be re-included from a soft default. */
    hasNegation: boolean;
    /** Parsed .gitattributes; null when this directory has none. */
    attributes: GitattributesRule[] | null;
}
export type IgnoreStack = IgnoreLayer[];
/** The selection settings CodeScanner's options share (see ScanOptions). */
export interface FileSelectionOptions {
    ignorePatterns?: string[];
    includeExtensions?: string[];
    /** Additional protected paths for isolated homes/tests; defaults can only be extended. */
    protectedPaths?: readonly string[];
}
/** The ignore patterns applied when a caller gives none. */
export declare const DEFAULT_IGNORE_PATTERNS: readonly string[];
/**
 * The scanner's file selection. `listFilesWithStatus` is the inventory every
 * scan and the CLI's estimate count; CodeScanner adds reading and chunking.
 */
export declare class FileSelector {
    protected readonly selection: Required<FileSelectionOptions>;
    protected readonly protectedPaths: readonly string[];
    /** Cumulative observations since this scanner started, including repeated walks. */
    readonly skipReasons: {
        symlink_skipped: number;
    };
    protected skipSymlink(stats: Stats): boolean;
    /**
     * `includeExtensions` folded to lowercase for matching. The gate used to
     * compare `extname()` verbatim while `detectLanguage` lowercased, so a
     * project spelling its files the canonical way - `.R` for R, `.SQL`/`.PS1`
     * on Windows, `.C`/`.H` in older C trees - indexed zero of them and nothing
     * said why.
     */
    protected readonly includeExtensionSet: ReadonlySet<string>;
    constructor(options?: FileSelectionOptions);
    protected isProtected(path: string): boolean;
    protected isProtectedRead(path: string): Promise<boolean>;
    /**
     * The chunkable-file gate, shared by every walker and by the explicit
     * file-list path so all three agree on what exists. `relPath` is the path
     * relative to the scan root (OS-native separators accepted).
     */
    protected isChunkable(absOrRelPath: string, relPath: string): boolean;
    /**
     * Read `.gitignore` + `.mnemonikignore` + `.gitattributes` in `absDir` and
     * compile them into one layer (the two ignore files are unioned -
     * `.mnemonikignore` is just an additional gitignore-syntax exclusion list).
     * Returns null when none of the three exists. FAIL-CLOSED: a non-ENOENT read
     * error (EISDIR, EACCES, timeout) latches `walk.complete = false` so callers
     * deriving *removals* from the walk treat it as untrustworthy rather than
     * silently ignoring nothing.
     */
    protected loadIgnoreLayer(absDir: string, baseRel: string, walk: WalkState, rootPath: string): Promise<IgnoreLayer | null>;
    /**
     * What the .gitignore / .mnemonikignore layers in `stack` say about
     * `entryRel` (relative to the scan root). Tested deepest-first: the first
     * layer that explicitly ignores OR re-includes (via a `!negation`) wins,
     * matching git's rule that a deeper `.gitignore` overrides a shallower one.
     * Directories are tested with a trailing slash so `foo/` dir-only rules
     * match the directory itself. `'unignored'` means a negation matched this
     * path itself; a re-included parent directory leaves its files `'unmatched'`.
     */
    protected ignoreVerdict(entryRel: string, isDir: boolean, stack: IgnoreStack): IgnoreFileVerdict;
    protected ignoredByStack(entryRel: string, isDir: boolean, stack: IgnoreStack): boolean;
    protected static attributeLayers(stack: IgnoreStack): GitattributesLayer[];
    /**
     * Skip this directory? User-ignored directories are skipped as before. A
     * directory a soft default excludes (vendor/, generated/, ...) is pruned too -
     * nothing under it can be indexed - UNLESS a rule above it could re-include
     * something inside it: a `!pattern` or a `-linguist-*` attribute. Then the
     * walk descends and judges each file, so the override works. Rule files
     * INSIDE a pruned directory are never read: a vendored library's own
     * .gitignore negations are not the project's intent.
     */
    protected skipDirectory(relPath: string, stack: IgnoreStack): boolean;
    /**
     * The index decision for a file from its path and the rule stack: `null`
     * when a user ignore rule excludes it, otherwise the classifier's answer
     * (precedence in indexClassifier.ts). Content rules are the caller's next
     * step for an included path without an `override`.
     */
    protected classifyEntry(relPath: string, stack: IgnoreStack): IndexClassification | null;
    /**
     * Reconstruct the root->parent ignore-layer stack for a single file, for the
     * incremental `scanFiles` path (which has a flat file list, not a recursive
     * walk). Layers are memoized per directory in `cache` across a batch.
     */
    protected buildIgnoreStackForFile(fileRel: string, rootPath: string, cache: Map<string, IgnoreLayer | null>, walk: WalkState): Promise<IgnoreStack>;
    /**
     * A predicate for walkers outside this class (the daemon's file watcher):
     * true when the walk would descend into `absDir`, by the same rules
     * `listFiles` applies - user ignore files and soft-default directories,
     * with their overrides. Rule files are read once per directory for the life
     * of the returned predicate; take a fresh one after a rule file changes.
     * Directories outside `rootPath`, and the root itself, always pass.
     */
    directoryFilter(rootPath: string): (absDir: string) => Promise<boolean>;
    /**
     * True when any directory strictly between `rootPath` and `filePath`
     * starts a subtree this project does not index (see isProjectBoundary). Paths that don't
     * resolve under `rootPath` are not judged here (return false) - the
     * server's path validation handles escapes.
     */
    protected insideNestedGitBoundary(filePath: string, rootPath: string): Promise<boolean>;
    protected rootProjectIds: Map<string, {
        at: number;
        projectId: Promise<string | undefined>;
    }>;
    /**
     * isProjectBoundary, with the scan root's own project as the enclosing one.
     * The root's file is read at most once a minute: a walk tests many folders,
     * and a project relinked since is seen on the next scan.
     */
    protected isBoundary(dirPath: string, rootPath: string): Promise<boolean>;
    protected canonicalRoots: Map<string, string>;
    protected canonicalRoot(root: string): Promise<string>;
    static containsCanonical(candidate: string, root: string, paths?: {
        sep: "/" | "\\";
        resolve: (...paths: string[]) => string;
    }, caseInsensitive?: boolean): boolean;
    protected confineSymlink(fullPath: string, canonicalRoot: string): Promise<boolean>;
    readConfined(fullPath: string, canonicalRoot: string, enumerated?: Stats): Promise<string>;
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
        /**
         * Listed paths a project rule re-included (a `!pattern` or a
         * `-linguist-*` attribute). Content rules do not apply to them; every
         * other listed path still answers to the content rules when read.
         */
        overridden: Set<string>;
        /** Entries a filesystem error or timeout left out. */
        unreadable: number;
        /** The first few unreadable entries, with the reason. */
        unreadableSamples: Array<{
            path: string;
            reason: string;
        }>;
        /** Each listed path's size, times and inode, for the daemon's stat cache. */
        stats: Map<string, FileStatTuple>;
    }>;
    /**
     * The rule files the last complete `listFilesWithStatus` walk of `rootPath`
     * applied, by directory ('' = root). Null before the first complete walk.
     * The daemon uploads these lines so the server judges paths as it did.
     */
    indexRuleFiles(rootPath: string): Promise<ReadonlyMap<string, IndexRuleFiles> | null>;
    protected readonly ruleFilesByRoot: Map<string, Map<string, IndexRuleFiles>>;
    protected traversePaths(currentPath: string, rootPath: string, out: string[], depth: number, walk: WalkState, stack?: IgnoreStack, overridden?: Set<string>, statsOut?: Map<string, FileStatTuple>): Promise<void>;
    /**
     * Check if path should be ignored
     * Fixed glob-to-regex conversion and substring matching.
     * - Escape regex special chars before replacing * with .*
     * - Replace ALL * occurrences (not just the first)
     * - For non-glob patterns, match on path segments to avoid false positives
     *   (e.g., '.env' should not match '.environment.ts')
     */
    protected shouldIgnore(path: string): boolean;
}
//# sourceMappingURL=fileSelection.d.ts.map