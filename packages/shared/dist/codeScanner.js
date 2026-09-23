/**
 * Code Scanner - Parse and chunk source files for embedding
 */
import { readdir, open, lstat, realpath } from 'fs/promises';
import { constants } from 'fs';
import { join, relative, extname, sep, resolve, dirname } from 'path';
import { createHash } from 'crypto';
import ignore from 'ignore';
import { debug as logDebug, info as logInfo, warn as logWarn } from './logger.js';
import { withTimeout } from './asyncUtils.js';
import { scrubSecrets } from './secretPatterns.js';
import { isProtectedLocalPath, protectedLocalPaths } from './protectedPaths.js';
import { MAX_AST_PARSE_BYTES, MAX_SIGNATURE_CHARS, chunkWithAst, } from './ast/astChunker.js';
import { astArtifactReport, resolveAstLanguage } from './ast/grammars.js';
/**
 * File operation timeout (5 seconds) to prevent hanging on slow/unresponsive filesystems
 */
const FILE_OP_TIMEOUT_MS = 5000;
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
export const MAX_SCANNED_FILE_BYTES = 10 * 1024 * 1024; // 10MB
/** Transport ceiling; ordinary chunking may exceed maxChunkSize but never this bound. */
export const MAX_PUSH_CHUNK_CONTENT_LENGTH = 500_000;
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
export const BUILT_IN_IGNORE_DIRS = [
    // JS / web
    'node_modules',
    '.next',
    '.nuxt',
    '.output',
    'dist',
    'build',
    'coverage',
    '.turbo',
    '.vercel',
    '.svelte-kit',
    '.angular',
    '.astro',
    '.parcel-cache',
    'bower_components',
    // Python
    'venv',
    '.venv',
    'env',
    '__pycache__',
    '.tox',
    '.mypy_cache',
    '.pytest_cache',
    '.ruff_cache',
    // Native mobile - iOS / Android / React Native / Flutter (2026-07-11 Pods incident)
    'Pods',
    'DerivedData',
    '.gradle',
    '.expo',
    '.dart_tool',
    // Infra / cloud
    '.terraform',
    'cdk.out',
    '.serverless',
    // Build systems, caches, VCS
    'target',
    'bin',
    'obj',
    '.cache',
    '.git',
    '.svn',
    '.hg',
    // The coding agent's captured shell environment, written as .sh files.
    // Harmless while only source extensions were collected; the moment shell
    // scripts became collectable these scanned as project code, which would put
    // an agent's own shell state into the user's searchable memory.
    //
    // Scoped to this one directory name deliberately. `.claude/` at large holds
    // real project content - `.claude/rules.md` is indexed on purpose
    // (tests/CodeScannerIgnorePatterns.test.ts), and only `.claude/worktrees/`
    // is suppressed, by the generic nested-git-boundary rule.
    'shell-snapshots',
];
/**
 * Non-directory built-in ignore patterns (files, globs, and the segment-
 * anchored fixture rule), combined with BUILT_IN_IGNORE_DIRS to form
 * DEFAULT_OPTIONS.ignorePatterns. See `shouldIgnore` for match semantics.
 *
 * `/tests/fixtures/*`: leading '/' = segment-anchored - matches tests/fixtures/
 * at the path root or immediately after a '/', so nested packages/x/tests/
 * fixtures/ are excluded but integration-tests/fixtures/ is NOT. Fixture
 * snapshot dirs were being indexed as real source and outranking the genuine
 * file in code_search. (Nested clones/worktrees/submodules are excluded
 * generically by the isGitBoundary rule below, not a path convention.)
 */
const BUILT_IN_IGNORE_FILE_PATTERNS = [
    // NOTE: the `.env` family and every other secret-bearing FILE KIND lives in
    // `isSecretFile` below, not here. This glob engine cannot express negation
    // (`.env.example` must stay collectable) and its unanchored substring
    // matching would make `.env.*` also swallow `.environment.ts`.
    '.DS_Store',
    '*.log',
    '*.lock',
    'package-lock.json',
    'yarn.lock',
    '*.min.js',
    '*.min.css',
    '*.bundle.js',
    '*.legacy.js',
    '*.map',
    '/tests/fixtures/*',
];
/**
 * Files whose CONTENT is a credential rather than code. Today these are
 * excluded only INCIDENTALLY - `.pem`, `.key` and friends carry no
 * allowlisted extension, so nothing chunks them. That protection evaporates
 * the moment the extension allowlist widens (as it did for `.sh`/`.lua`), so
 * the exclusion is made explicit here and becomes a defended invariant:
 * unlike `ignorePatterns`, this predicate is NOT caller-overridable.
 *
 * Expressed as a predicate rather than glob strings because `shouldIgnore`'s
 * engine has no negation and matches globs as unanchored substrings - neither
 * property can state "every `.env.*` EXCEPT `.env.example`".
 *
 * Precision notes (over-exclusion is a fidelity failure in its own right):
 * - `.env` family: `/^\.env(\..+)?$/` matches `.env`, `.env.local`,
 *   `.env.production` - and deliberately NOT `.envrc` or `.environment.ts`.
 * - `.env.example` is carved out: it is authority-collected on purpose
 *   (AUTHORITY_FILE_MATCHERS) and holds placeholder values, not secrets.
 *   It is the doc-truth env_vars authority; excluding it would blind that
 *   extractor exactly as the old `process.env` over-scrub once did.
 * - `credentials` is matched ONLY directly inside a dot-directory
 *   (`.aws/credentials`, `.docker/credentials`). A bare `credentials/` is a
 *   real, common SOURCE directory name (gRPC, auth libraries) and
 *   `shouldIgnore` cannot tell a file from a directory at its call sites -
 *   an unqualified rule would silently delete that subtree from the index.
 * - `.tfvars` is excluded whole rather than per-basename: the credential file
 *   is conventionally `terraform.tfvars` but the name is free-form, and the
 *   variables that are NOT secret are visible in `.tf` anyway.
 */
const SECRET_FILE_PLACEHOLDER_BASENAMES = new Set(['.env.example']);
const SECRET_FILE_BASENAME_PATTERNS = [
    /^\.env(\..+)?$/i, // .env, .env.local, .env.production.local
    /^id_(?:rsa|dsa|ecdsa|ed25519)/i, // ssh private keys (and .pub siblings)
    /^\.(?:npmrc|netrc|pgpass)$/i, // registry / ftp / postgres password files
    /^kubeconfig$/i,
    /\.(?:pem|key|p12|pfx|keystore|jks|kubeconfig)$/i,
    // Terraform variable files: `terraform.tfvars` is the conventional home for
    // provider credentials, and unlike the entries above nothing else was
    // keeping it out - it is excluded here rather than merely left off
    // `DEFAULT_INCLUDE_EXTENSIONS`, so a future widening of the allowlist cannot
    // quietly opt a project into embedding its own cloud keys.
    /\.tfvars(\.json)?$/i,
];
/**
 * True when `relPath` names a file whose contents are credentials. Applied
 * by `shouldIgnore` (every walker: directory scan, explicit file lists, and
 * the authority-file walk) and by `makeIgnoreMatcher` (server-side backstop
 * for older or misbehaving daemons). Accepts OS-native or POSIX separators.
 */
export function isSecretFile(relPath) {
    if (!relPath)
        return false;
    const segments = relPath.split(sep).join('/').split('/');
    const base = segments[segments.length - 1] ?? '';
    if (!base || SECRET_FILE_PLACEHOLDER_BASENAMES.has(base))
        return false;
    if (SECRET_FILE_BASENAME_PATTERNS.some((re) => re.test(base)))
        return true;
    const parent = segments[segments.length - 2];
    return base === 'credentials' && parent !== undefined && parent.startsWith('.');
}
/**
 * Per-directory ignore files the walkers honor, unioned. `.gitignore` is the
 * project's own declaration of generated/vendored paths; `.mnemonikignore`
 * (same gitignore syntax) is the user's Mnemonik-specific "never index this"
 * list (e.g. `secrets/`). Matched hierarchically via the `ignore` package.
 */
const IGNORE_FILE_NAMES = ['.gitignore', '.mnemonikignore'];
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
export const DEFAULT_INCLUDE_EXTENSIONS = [
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.py',
    '.rs',
    '.go',
    '.java',
    '.c',
    '.cpp',
    '.h',
    '.cs',
    '.rb',
    '.php',
    '.swift',
    '.kt',
    // Shell and Lua are the working languages of whole real projects -
    // deployment tooling, container entrypoints, imapfilter/nginx/redis
    // configuration. Omitting them meant such a project indexed ZERO code and
    // code_search could not answer anything about it, while reporting that as
    // "no indexed matches" rather than as missing coverage.
    '.sh',
    '.bash',
    '.zsh',
    '.lua',
    '.md',
    // -- Variants of languages already on the list. `.mjs`/`.cjs`/`.mts`/`.cts`/
    // `.pyi` inherit their language string from a listed extension, so their
    // absence was oversight rather than policy. The C++ spellings are a choice,
    // not an inheritance: `.h` stays 'c' (C headers dominate, and reading a C++
    // header as C is the safer default), while the unambiguously-C++ spellings
    // resolve to 'cpp'.
    '.mjs',
    '.cjs',
    '.mts',
    '.cts',
    '.pyi',
    '.hpp',
    '.hh',
    '.hxx',
    '.cc',
    '.cxx',
    '.kts',
    // -- Languages the scanner could not read at all.
    '.dart',
    '.m',
    '.mm',
    '.scala',
    '.sc',
    '.ex',
    '.exs',
    '.erl',
    '.hrl',
    '.hs',
    '.jl',
    '.ml',
    '.mli',
    '.clj',
    '.cljs',
    '.cljc',
    '.groovy',
    '.gradle',
    '.ps1',
    '.psm1',
    '.pl',
    '.pm',
    '.r',
    '.sol',
    '.zig',
    '.vue',
    '.svelte',
    // -- Infrastructure and schema DSLs, where real logic lives and where "how
    // is this deployed?" and "what does this table hold?" go unanswered today.
    '.tf',
    '.sql',
    '.proto',
    '.graphql',
    '.gql',
    '.cmake',
    '.nix',
    '.bzl',
];
/**
 * Extension -> language string, the value carried on every chunk and on the
 * wire (`/scan/push` accepts any non-empty string up to 50 chars).
 *
 * A string no grammar claims is correct and expected: the AST layer resolves
 * such a language to `null` and the heuristic chunker takes over. Keep this in
 * sync with `DEFAULT_INCLUDE_EXTENSIONS` - an allowlisted extension that lands
 * on 'unknown' still gets chunked, but nothing downstream can reason about it.
 *
 * Two extensions are genuinely ambiguous and are resolved rather than fudged:
 * `.m` is Objective-C here, not MATLAB, because a repo carrying `.m` alongside
 * `.h`/`.mm` is overwhelmingly an Apple-platform project; `.pl` is Perl, not
 * Prolog, on the same frequency argument.
 */
const EXTENSION_LANGUAGES = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.mts': 'typescript',
    '.cts': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.py': 'python',
    '.pyi': 'python',
    '.rs': 'rust',
    '.go': 'go',
    '.java': 'java',
    '.c': 'c',
    '.h': 'c',
    '.cpp': 'cpp',
    '.cc': 'cpp',
    '.cxx': 'cpp',
    '.hpp': 'cpp',
    '.hh': 'cpp',
    '.hxx': 'cpp',
    '.cs': 'csharp',
    '.rb': 'ruby',
    '.php': 'php',
    '.swift': 'swift',
    '.kt': 'kotlin',
    '.kts': 'kotlin',
    '.sh': 'shell',
    '.bash': 'shell',
    '.zsh': 'shell',
    '.lua': 'lua',
    '.md': 'markdown',
    '.dart': 'dart',
    '.m': 'objc',
    '.mm': 'objc',
    '.scala': 'scala',
    '.sc': 'scala',
    '.ex': 'elixir',
    '.exs': 'elixir',
    '.erl': 'erlang',
    '.hrl': 'erlang',
    '.hs': 'haskell',
    '.jl': 'julia',
    '.ml': 'ocaml',
    '.mli': 'ocaml',
    '.clj': 'clojure',
    '.cljs': 'clojure',
    '.cljc': 'clojure',
    '.groovy': 'groovy',
    '.gradle': 'groovy',
    '.ps1': 'powershell',
    '.psm1': 'powershell',
    '.pl': 'perl',
    '.pm': 'perl',
    '.r': 'r',
    '.sol': 'solidity',
    '.zig': 'zig',
    '.vue': 'vue',
    '.svelte': 'svelte',
    '.tf': 'terraform',
    '.sql': 'sql',
    '.proto': 'protobuf',
    '.graphql': 'graphql',
    '.gql': 'graphql',
    '.cmake': 'cmake',
    '.nix': 'nix',
    '.bzl': 'starlark',
};
/**
 * Language string for a file path or a bare extension, `'unknown'` when the
 * extension is unmapped. A free function rather than a method because callers
 * that never scan anything (AST grammar resolution, server-side symbol
 * preference) need the same answer without constructing a scanner.
 */
export function languageForExtension(filePathOrExt) {
    // `extname` FIRST. A dotfile that carries a real extension ('.eslintrc.js',
    // '.mocharc.cjs', '.prettierrc.ts') starts with '.' and contains no '/', so
    // a bare-extension-first reading swallowed the whole name and answered
    // 'unknown' - while the same file spelled 'src/.eslintrc.js' answered
    // 'javascript'. Those extensions are allowlisted, so the files are indexed
    // and reach the server with exactly the root-relative spelling that failed.
    const fromPath = EXTENSION_LANGUAGES[extname(filePathOrExt).toLowerCase()];
    if (fromPath !== undefined)
        return fromPath;
    // Fallback: the argument IS the extension ('.dart'), for which `extname`
    // returns ''. Every key contains a leading dot and no separator, so a real
    // path can never collide here.
    return EXTENSION_LANGUAGES[filePathOrExt.toLowerCase()] ?? 'unknown';
}
/**
 * THE definition of "this path is a SQL migration the schema_columns authority
 * collects verbatim". One predicate, referenced by both halves of the deal -
 * `AUTHORITY_FILE_MATCHERS` (collect it) and `isAuthorityOnlyPath` (therefore
 * do not chunk it) - because two hand-written regexes drifted once already and
 * the failure is silent in both directions.
 *
 * Root-anchored and CASE-SENSITIVE on purpose: it mirrors the server-side
 * extractor, which does `listFiles('migrations/')` (LIKE 'migrations/%') then
 * `endsWith('.sql')`, both case-sensitive. `Migrations/001.sql` (the .NET/EF
 * Core spelling) and `migrations/002.SQL` are NOT collected, so they must not
 * be suppressed from chunking either - that would index them nowhere. Same
 * reason a nested `packages/x/migrations/y.sql` is left alone.
 */
const isMigrationSqlAuthorityPath = (posixRelPath) => /^migrations\/.*\.sql$/.test(posixRelPath);
/**
 * Predicates for paths whose verbatim content is ALREADY shipped by
 * `collectAuthorityFiles` and that carry no additional value as embedded code
 * chunks. Checked at the extension gate rather than in `shouldIgnore`, because
 * `shouldIgnore` also guards the authority walk and must keep letting these
 * through.
 *
 * `migrations/**.sql` is the live case: adding `.sql` to the allowlist without
 * this exclusion would dual-collect every migration - once verbatim, once
 * chunked and embedded. On this repo alone that is 208 files of append-only
 * DDL (140 forward, the rest rollback/manual), embedded to answer questions
 * the authority path already answers exactly.
 *
 * INVARIANT: every predicate here must also appear in
 * `AUTHORITY_FILE_MATCHERS`, so no path can be excluded from chunking unless
 * the authority path definitely collects it.
 */
const AUTHORITY_ONLY_PATH_PREDICATES = [
    isMigrationSqlAuthorityPath,
];
/**
 * True when `relPath` is collected verbatim as authority content and must not
 * also be chunked. Accepts OS-native or POSIX separators.
 */
export function isAuthorityOnlyPath(relPath) {
    if (!relPath)
        return false;
    const posix = relPath.split(sep).join('/');
    return AUTHORITY_ONLY_PATH_PREDICATES.some((matches) => matches(posix));
}
const DEFAULT_OPTIONS = {
    maxChunkSize: 8000, // ~2000 tokens
    minChunkSize: 100,
    ignorePatterns: [...BUILT_IN_IGNORE_DIRS, ...BUILT_IN_IGNORE_FILE_PATTERNS],
    includeExtensions: [...DEFAULT_INCLUDE_EXTENSIONS],
    maxAstParseBytes: MAX_AST_PARSE_BYTES,
    protectedPaths: [],
};
/**
 * Matchers for authority manifest / config / CI files whose verbatim content
 * is collected by `collectAuthorityFiles` and pushed to the server for
 * doc-truth Fingerprint parsing. Operates on relative, forward-slash paths.
 */
export const AUTHORITY_FILE_MATCHERS = [
    (p) => p === 'package.json',
    (p) => /^(packages|apps|services|tools)\/[^/]+\/package\.json$/.test(p),
    (p) => p === 'tsconfig.json' || /^tsconfig\.[^/]+\.json$/.test(p),
    (p) => p === 'pyproject.toml',
    (p) => p === 'requirements.txt',
    (p) => p === 'setup.py',
    (p) => p === 'Cargo.toml',
    (p) => p === 'Gemfile',
    (p) => p === 'Makefile',
    (p) => p === '.env.example',
    (p) => /^\.github\/workflows\/[^/]+\.(yml|yaml)$/.test(p),
    // SQL migrations: the schema_columns authority extractor reads every .sql
    // under `migrations/` (listFiles('migrations/') -> LIKE 'migrations/%' then
    // .endsWith('.sql')). Without collecting these, that authority is empty and
    // every schema_table_enumeration claim falls to unverifiable. Shared with
    // `AUTHORITY_ONLY_PATH_PREDICATES` by reference, not by a copied regex, so
    // collection and the chunking exclusion cannot disagree.
    isMigrationSqlAuthorityPath,
];
/**
 * Segment-anchored match for the `tests/fixtures/` ignore pattern above -
 * matches at the path root or immediately after a `/`, mirroring exactly
 * what `shouldIgnore` compiles `'/tests/fixtures/*'` to. Exported so
 * server-side consumers (e.g. the `/scan/push` route) and query-time
 * consumers (e.g. `MemoryManager.searchCodePointers`'s hygiene exclusions)
 * share one definition instead of hand-rolling copies that can drift.
 */
export const FIXTURE_PATH_RE = /(^|\/)tests\/fixtures\//;
export function isFixturePath(path) {
    return FIXTURE_PATH_RE.test(path);
}
const BUILT_IN_IGNORE_DIR_SET = new Set(BUILT_IN_IGNORE_DIRS);
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
export function makeIgnoreMatcher(extraPatterns = []) {
    const cleaned = extraPatterns.filter((p) => typeof p === 'string' && p.trim().length > 0);
    const ig = cleaned.length > 0 ? ignore().add([...cleaned]) : null;
    return (relPath) => {
        if (!relPath)
            return false;
        const norm = relPath.split(sep).join('/');
        if (norm.split('/').some((s) => BUILT_IN_IGNORE_DIR_SET.has(s)))
            return true;
        if (isSecretFile(norm))
            return true;
        if (ig) {
            try {
                return ig.ignores(norm);
            }
            catch {
                // `ignore` throws on absolute/`..` paths (safeScanPath already rejects
                // those upstream); built-ins were already checked, so fail open here.
                return false;
            }
        }
        return false;
    };
}
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
export async function isGitBoundary(dirPath) {
    try {
        await withTimeout(lstat(join(dirPath, '.git')), FILE_OP_TIMEOUT_MS, `lstat timed out: ${join(dirPath, '.git')}`);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Latch for `logAstCapabilityOnce`. A promise, not a boolean: two concurrent
 * callers must both wait on the same report rather than the second returning
 * before the first has logged.
 */
let astCapabilityLog = null;
/**
 * `reason:grammar` pairs already warned about, for the reasons that are
 * process-global rather than file-specific.
 *
 * Only `grammar_unavailable` qualifies: `loadGrammar` caches its failure, so the
 * answer is identical for every file of that language and warning per file
 * printed 1,037 lines in one scan of this repo. `file_too_large` and
 * `parse_failed` are properties of one file and stay per file.
 */
const reportedGrammarFallbacks = new Set();
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
export function logAstCapabilityOnce() {
    astCapabilityLog ??= (async () => {
        const report = astArtifactReport();
        const detail = {
            grammars: report.vendored.length,
            languages: report.vendored.join(' '),
        };
        if (report.missing.length > 0) {
            logWarn('AST chunking: some vendored grammar artifacts are missing', {
                ...detail,
                missing: report.missing.map((m) => `${m.id}(${m.reason}: ${m.detail})`).join('; '),
            });
        }
        else {
            logInfo('AST chunking ready (grammars load lazily, per language)', detail);
        }
    })();
    return astCapabilityLog;
}
export class CodeScanner {
    options;
    protectedPaths;
    /** Cumulative observations since this scanner started, including repeated walks. */
    skipReasons = { symlink_skipped: 0 };
    skipSymlink(stats) {
        if (!stats.isSymbolicLink())
            return false; // Includes Windows junctions.
        this.skipReasons.symlink_skipped++;
        return true;
    }
    /**
     * `includeExtensions` folded to lowercase for matching. The gate used to
     * compare `extname()` verbatim while `detectLanguage` lowercased, so a
     * project spelling its files the canonical way - `.R` for R, `.SQL`/`.PS1`
     * on Windows, `.C`/`.H` in older C trees - indexed zero of them and nothing
     * said why.
     */
    includeExtensionSet;
    constructor(options = {}) {
        this.options = { ...DEFAULT_OPTIONS, ...options };
        this.protectedPaths = [
            ...new Set([...protectedLocalPaths(), ...(options.protectedPaths ?? [])]),
        ];
        this.includeExtensionSet = new Set(this.options.includeExtensions.map((ext) => ext.toLowerCase()));
    }
    isProtected(path) {
        return isProtectedLocalPath(path, this.protectedPaths);
    }
    async isProtectedRead(path) {
        if (this.isProtected(path))
            return true;
        return isProtectedLocalPath(await realpath(path), this.protectedPaths);
    }
    /**
     * The chunkable-file gate, shared by every walker and by the explicit
     * file-list path so all three agree on what exists. `relPath` is the path
     * relative to the scan root (OS-native separators accepted).
     */
    isChunkable(absOrRelPath, relPath) {
        if (!this.includeExtensionSet.has(extname(absOrRelPath).toLowerCase()))
            return false;
        if (isAuthorityOnlyPath(relPath)) {
            logDebug('Skipping chunking for authority-collected path', { relPath });
            return false;
        }
        return true;
    }
    /**
     * Read `.gitignore` + `.mnemonikignore` in `absDir` and compile them into one
     * ignore layer (the two files are unioned - `.mnemonikignore` is just an
     * additional gitignore-syntax exclusion list). Returns null when neither file
     * exists. FAIL-CLOSED: a non-ENOENT read error (EISDIR, EACCES, timeout)
     * latches `walk.complete = false` so callers deriving *removals* from the walk
     * treat it as untrustworthy rather than silently ignoring nothing.
     */
    async loadIgnoreLayer(absDir, baseRel, walk, rootPath) {
        if (this.isProtected(absDir))
            return null;
        const patterns = [];
        for (const name of IGNORE_FILE_NAMES) {
            const filePath = join(absDir, name);
            try {
                const content = await withTimeout(this.readConfined(filePath, rootPath), FILE_OP_TIMEOUT_MS, `readFile timed out: ${filePath}`);
                for (const line of content.split(/\r?\n/))
                    patterns.push(line);
            }
            catch (err) {
                if (err.message === 'symlink_skipped')
                    continue;
                if (err?.code !== 'ENOENT') {
                    walk.complete = false;
                    logDebug('Ignore-file read failed (fail-closed)', { path: filePath, err });
                }
            }
        }
        // `ignore` tolerates blank/comment lines; null when nothing meaningful.
        if (patterns.length === 0)
            return null;
        const ig = ignore().add(patterns);
        return { baseRel, ig };
    }
    /**
     * True when `entryRel` (relative to the scan root) is excluded by any ignore
     * layer in `stack`. Tested deepest-first: the first layer that explicitly
     * ignores OR re-includes (via a `!negation`) wins, matching git's rule that a
     * deeper `.gitignore` overrides a shallower one. Directories are tested with a
     * trailing slash so `foo/` dir-only rules match the directory itself.
     */
    ignoredByStack(entryRel, isDir, stack) {
        for (let i = stack.length - 1; i >= 0; i--) {
            const layer = stack[i];
            if (!layer)
                continue;
            const { baseRel, ig } = layer;
            let sub;
            if (baseRel === '') {
                sub = entryRel;
            }
            else if (entryRel === baseRel || !entryRel.startsWith(baseRel + '/')) {
                continue; // this layer does not cover entryRel
            }
            else {
                sub = entryRel.slice(baseRel.length + 1);
            }
            if (!sub)
                continue;
            const res = ig.test(isDir ? sub + '/' : sub);
            if (res.ignored)
                return true;
            if (res.unignored)
                return false;
        }
        return false;
    }
    /**
     * Reconstruct the root->parent ignore-layer stack for a single file, for the
     * incremental `scanFiles` path (which has a flat file list, not a recursive
     * walk). Layers are memoized per directory in `cache` across a batch.
     */
    async buildIgnoreStackForFile(fileRel, rootPath, cache, walk) {
        const dirs = [''];
        let acc = '';
        for (const seg of fileRel.split('/').slice(0, -1)) {
            acc = acc === '' ? seg : `${acc}/${seg}`;
            dirs.push(acc);
        }
        const stack = [];
        for (const dir of dirs) {
            let layer = cache.get(dir);
            if (layer === undefined) {
                layer = await this.loadIgnoreLayer(dir === '' ? rootPath : join(rootPath, dir), dir, walk, rootPath);
                cache.set(dir, layer);
            }
            if (layer)
                stack.push(layer);
        }
        return stack;
    }
    /**
     * True when any directory strictly between `rootPath` and `filePath`
     * carries its own `.git` entry (see isGitBoundary). Paths that don't
     * resolve under `rootPath` are not judged here (return false) - the
     * server's path validation handles escapes.
     */
    async insideNestedGitBoundary(filePath, rootPath) {
        const rel = relative(rootPath, filePath);
        if (!rel || rel.startsWith('..'))
            return false;
        const segments = rel.split(sep);
        let current = rootPath;
        // Walk intermediate directories only (exclude the file itself).
        for (let i = 0; i < segments.length - 1; i++) {
            const segment = segments[i];
            if (segment === undefined)
                continue;
            current = join(current, segment);
            if (await isGitBoundary(current))
                return true;
        }
        return false;
    }
    /**
     * Maximum directory depth for recursive scanning
     * Prevents runaway recursion on deep/symlinked structures
     */
    static MAX_DEPTH = 10;
    canonicalRoots = new Map();
    async canonicalRoot(root) {
        let canonical = this.canonicalRoots.get(root);
        if (!canonical) {
            canonical = await realpath(root);
            this.canonicalRoots.set(root, canonical);
        }
        return canonical;
    }
    static containsCanonical(candidate, root, paths = { sep, resolve }, caseInsensitive = process.platform === 'win32') {
        // realpath expands filesystem aliases (including Windows 8.3 names). Never guess a short name.
        candidate = paths.resolve(candidate);
        root = paths.resolve(root);
        if (caseInsensitive) {
            candidate = candidate.toLowerCase();
            root = root.toLowerCase();
        }
        return (candidate === root || candidate.startsWith(root.endsWith(paths.sep) ? root : root + paths.sep));
    }
    async confineSymlink(fullPath, canonicalRoot) {
        // Check each component: explicit-file callers must not bypass the walkers'
        // no-symlink policy by supplying a path through an in-root directory link.
        let path = resolve(fullPath);
        if (!CodeScanner.containsCanonical(path, canonicalRoot))
            return false;
        for (;;) {
            if (this.skipSymlink(await lstat(path)))
                throw new Error('symlink_skipped');
            if (CodeScanner.containsCanonical(canonicalRoot, path))
                break;
            path = dirname(path);
        }
        return CodeScanner.containsCanonical(await realpath(fullPath), canonicalRoot);
    }
    async readConfined(fullPath, canonicalRoot, enumerated) {
        const expected = enumerated ?? (await lstat(fullPath));
        if (this.skipSymlink(expected))
            throw new Error('symlink_skipped');
        if (!expected.isFile())
            throw new Error('scanner_not_regular');
        if (!(await this.confineSymlink(fullPath, canonicalRoot)))
            throw new Error('scanner_containment');
        const canonical = await realpath(fullPath);
        if (!CodeScanner.containsCanonical(canonical, canonicalRoot) ||
            (await this.isProtectedRead(canonical)))
            throw new Error('scanner_containment');
        // O_NONBLOCK also prevents a substituted FIFO from hanging before fstat.
        const flags = constants.O_RDONLY |
            (constants.O_NONBLOCK ?? 0) |
            (process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0));
        const handle = await open(fullPath, flags).catch((error) => {
            if (error.code === 'ELOOP') {
                this.skipReasons.symlink_skipped++;
                throw new Error('symlink_skipped');
            }
            throw error;
        });
        try {
            const actual = await handle.stat();
            if (!actual.isFile())
                throw new Error('scanner_not_regular');
            if (actual.dev !== expected.dev || actual.ino !== expected.ino)
                throw new Error('scanner_identity_changed');
            // Windows has no O_NOFOLLOW; lstat is Node's junction/reparse-link check.
            if (process.platform === 'win32' && this.skipSymlink(await lstat(fullPath)))
                throw new Error('symlink_skipped');
            // Linux also proves the opened object is still at the checked path.
            if (process.platform === 'linux' &&
                (await realpath(`/proc/self/fd/${handle.fd}`)) !== canonical)
                throw new Error('scanner_containment');
            return await handle.readFile('utf-8');
        }
        finally {
            await handle.close();
        }
    }
    /**
     * Scan a directory recursively and extract code chunks
     * Added max depth (10) to prevent infinite recursion
     */
    async scanDirectory(rootPath) {
        const { chunks } = await this.scanDirectoryWithStatus(rootPath);
        return chunks;
    }
    /**
     * Completeness-aware variant of `scanDirectory`. `complete === false`
     * means at least one fs error was swallowed during the walk, so the
     * chunk set may be missing files that still exist on disk - callers
     * deriving removals from the result must not trust it as an inventory.
     * Chunks are secret-scrubbed before returning (same daemon-side
     * redaction guarantee as `scanFiles`).
     */
    async scanDirectoryWithStatus(rootPath) {
        rootPath = await this.canonicalRoot(rootPath);
        const chunks = [];
        const walk = { complete: true };
        await this.traverseDirectory(rootPath, rootPath, chunks, 0, walk);
        return { chunks: this.scrubChunks(chunks), complete: walk.complete };
    }
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
    async listFiles(rootPath) {
        const { paths } = await this.listFilesWithStatus(rootPath);
        return paths;
    }
    /**
     * Completeness-aware variant of `listFiles`. `complete === false` means
     * an fs error truncated part of the walk - the returned paths may be
     * missing files that still exist on disk. The daemon's reconcile channel
     * MUST NOT derive removedFiles from an incomplete inventory (a truncated
     * walk otherwise reads as mass deletion and deprecates live memories).
     */
    async listFilesWithStatus(rootPath) {
        rootPath = await this.canonicalRoot(rootPath);
        const paths = [];
        const walk = { complete: true };
        await this.traversePaths(rootPath, rootPath, paths, 0, walk);
        return {
            paths: paths.filter((p) => !/(^|[/\\])\.\.([/\\]|$)/.test(p)),
            complete: walk.complete,
        };
    }
    async traversePaths(currentPath, rootPath, out, depth, walk, stack = []) {
        if (depth >= CodeScanner.MAX_DEPTH)
            return;
        if (this.isProtected(currentPath))
            return;
        let entries;
        try {
            if (!(await this.confineSymlink(currentPath, rootPath)))
                throw new Error('scanner_containment');
            entries = await withTimeout(readdir(currentPath), FILE_OP_TIMEOUT_MS, `readdir timed out: ${currentPath}`);
        }
        catch (error) {
            walk.complete = false;
            logDebug('Error traversing directory (listFiles)', { path: currentPath, error });
            return;
        }
        const dirRel = currentPath === rootPath ? '' : relative(rootPath, currentPath).split(sep).join('/');
        const localLayer = await this.loadIgnoreLayer(currentPath, dirRel, walk, rootPath);
        const localStack = localLayer ? [...stack, localLayer] : stack;
        for (const entry of entries) {
            const fullPath = join(currentPath, entry);
            const relativePath = relative(rootPath, fullPath);
            if (this.isProtected(fullPath))
                continue;
            if (this.shouldIgnore(relativePath))
                continue;
            // Per-entry isolation: a single bad entry (dangling symlink, raced
            // deletion, permission denial, fs timeout) must not abort the rest of
            // the directory - but the inventory is no longer removal-trustworthy.
            try {
                const lstats = await withTimeout(lstat(fullPath), FILE_OP_TIMEOUT_MS, `lstat timed out: ${fullPath}`);
                if (this.skipSymlink(lstats))
                    continue;
                const stats = lstats;
                if (stats.isDirectory()) {
                    if (this.ignoredByStack(relativePath, true, localStack))
                        continue; // .gitignore/.mnemonikignore
                    if (await isGitBoundary(fullPath))
                        continue; // another repo's subtree
                    await this.traversePaths(fullPath, rootPath, out, depth + 1, walk, localStack);
                }
                else if (stats.isFile()) {
                    if (this.ignoredByStack(relativePath, false, localStack))
                        continue;
                    if (this.isChunkable(fullPath, relativePath)) {
                        out.push(relativePath);
                    }
                }
            }
            catch (error) {
                walk.complete = false;
                logDebug('Error traversing directory (listFiles)', { path: fullPath, error });
            }
        }
    }
    /**
     * Scan specific files and extract code chunks.
     * Pass rootPath to compute proper relative file paths in chunk metadata.
     */
    async scanFiles(filePaths, rootPath) {
        rootPath = await this.canonicalRoot(rootPath);
        const chunks = [];
        const ignoreCache = new Map();
        const walk = { complete: true };
        for (const filePath of filePaths) {
            try {
                if (!(await this.confineSymlink(filePath, rootPath)))
                    continue;
                if (this.isProtected(filePath) || (rootPath && this.isProtected(rootPath)))
                    continue;
                const fileRel = rootPath ? relative(rootPath, filePath).split(sep).join('/') : filePath;
                if (this.shouldIgnore(fileRel)) {
                    continue;
                }
                // Honor .gitignore/.mnemonikignore on the incremental path too, by
                // reconstructing this file's ancestor ignore-layer stack (memoized
                // per directory across the batch).
                if (rootPath && !fileRel.startsWith('..')) {
                    const stack = await this.buildIgnoreStackForFile(fileRel, rootPath, ignoreCache, walk);
                    if (this.ignoredByStack(fileRel, false, stack)) {
                        continue;
                    }
                }
                // Explicit file lists arrive from watcher events, which can race a
                // worktree/nested-clone appearing - apply the same nested-git-boundary
                // rule the walks use (an ancestor between root and the file carrying
                // its own .git means the file belongs to another repository).
                if (rootPath && (await this.insideNestedGitBoundary(filePath, rootPath))) {
                    continue;
                }
                if (this.isChunkable(filePath, fileRel)) {
                    const fileChunks = await this.parseFile(filePath, rootPath || filePath);
                    chunks.push(...fileChunks);
                }
            }
            catch (error) {
                logDebug('Error scanning file', { filePath, error });
            }
        }
        return this.scrubChunks(chunks);
    }
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
    scrubChunks(chunks) {
        return chunks.flatMap((chunk) => {
            const scrubbed = scrubSecrets(chunk.content);
            if (scrubbed.length <= MAX_PUSH_CHUNK_CONTENT_LENGTH) {
                return scrubbed === chunk.content
                    ? [chunk]
                    : [{ ...chunk, content: scrubbed, contentHash: this.hash(scrubbed) }];
            }
            const pieces = [];
            let startLine = chunk.startLine;
            // Each piece carries its ordinal: pieces of one long line share the same
            // line span, and the server keys a chunk on (path, span, piece).
            for (let offset = 0, piece = 0; offset < scrubbed.length; piece++) {
                let end = Math.min(offset + MAX_PUSH_CHUNK_CONTENT_LENGTH, scrubbed.length);
                // Keep a UTF-16 surrogate pair together at a transport boundary.
                if (end < scrubbed.length && /[\uD800-\uDBFF]/.test(scrubbed.charAt(end - 1)))
                    end--;
                const content = scrubbed.slice(offset, end);
                const endLine = startLine + (content.match(/\n/g)?.length ?? 0);
                pieces.push({
                    ...chunk,
                    content,
                    startLine,
                    endLine,
                    contentHash: this.hash(content),
                    metadata: { ...chunk.metadata, piece },
                });
                startLine = endLine;
                offset = end;
            }
            return pieces;
        });
    }
    /**
     * Recursively traverse directory
     * Added depth parameter with max limit
     */
    async traverseDirectory(currentPath, rootPath, chunks, depth, walk, stack = []) {
        // Prevent infinite recursion
        if (depth >= CodeScanner.MAX_DEPTH) {
            logDebug('Max directory depth reached, skipping', { path: currentPath, depth });
            return;
        }
        if (this.isProtected(currentPath))
            return;
        // Wrap readdir with timeout to prevent hanging
        let entries;
        try {
            if (!(await this.confineSymlink(currentPath, rootPath)))
                throw new Error('scanner_containment');
            entries = await withTimeout(readdir(currentPath), FILE_OP_TIMEOUT_MS, `readdir timed out: ${currentPath}`);
        }
        catch (error) {
            walk.complete = false;
            logDebug('Error traversing directory', { path: currentPath, error });
            return;
        }
        // Layer this directory's .gitignore/.mnemonikignore onto the inherited stack.
        const dirRel = currentPath === rootPath ? '' : relative(rootPath, currentPath).split(sep).join('/');
        const localLayer = await this.loadIgnoreLayer(currentPath, dirRel, walk, rootPath);
        const localStack = localLayer ? [...stack, localLayer] : stack;
        for (const entry of entries) {
            const fullPath = join(currentPath, entry);
            const relativePath = relative(rootPath, fullPath);
            if (this.isProtected(fullPath))
                continue;
            // Check ignore patterns
            if (this.shouldIgnore(relativePath)) {
                continue;
            }
            // Per-entry isolation: a single bad entry (dangling symlink, raced
            // deletion, permission denial, fs timeout) must not abort the rest of
            // the directory - but the scan is no longer removal-trustworthy.
            try {
                const lstats = await withTimeout(lstat(fullPath), FILE_OP_TIMEOUT_MS, `lstat timed out: ${fullPath}`);
                if (this.skipSymlink(lstats))
                    continue;
                const stats = lstats;
                if (stats.isDirectory()) {
                    if (this.ignoredByStack(relativePath, true, localStack))
                        continue; // .gitignore/.mnemonikignore
                    if (await isGitBoundary(fullPath))
                        continue; // another repo's subtree
                    await this.traverseDirectory(fullPath, rootPath, chunks, depth + 1, walk, localStack);
                }
                else if (stats.isFile()) {
                    if (this.ignoredByStack(relativePath, false, localStack))
                        continue;
                    if (this.isChunkable(fullPath, relativePath)) {
                        const fileChunks = await this.parseFile(fullPath, rootPath, stats);
                        chunks.push(...fileChunks);
                    }
                }
            }
            catch (error) {
                walk.complete = false;
                logDebug('Error traversing directory', { path: fullPath, error });
            }
        }
    }
    /**
     * Check if path should be ignored
     * Fixed glob-to-regex conversion and substring matching.
     * - Escape regex special chars before replacing * with .*
     * - Replace ALL * occurrences (not just the first)
     * - For non-glob patterns, match on path segments to avoid false positives
     *   (e.g., '.env' should not match '.environment.ts')
     */
    shouldIgnore(path) {
        // Credential-bearing file kinds first, and outside the overridable
        // `ignorePatterns` list - a caller-supplied pattern set must not be able
        // to opt a project back into indexing its own private keys.
        if (isSecretFile(path))
            return true;
        const segments = path.split('/');
        return this.options.ignorePatterns.some((pattern) => {
            if (pattern.includes('*')) {
                // A leading '/' opts a glob pattern into SEGMENT-ANCHORED matching:
                // the pattern body must start at the beginning of the path or right
                // after a '/'. Without it, glob patterns keep their historical
                // unanchored substring semantics - anchoring is opt-in per pattern so
                // this change cannot alter any existing pattern's behavior.
                // (Motivating bug: unanchored 'tests/fixtures/*' also matched
                // 'integration-tests/fixtures/...' in every indexed project.)
                const anchored = pattern.startsWith('/');
                const body = anchored ? pattern.slice(1) : pattern;
                // Escape regex special chars, then replace all * with .*
                const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
                const source = escaped.replace(/\*/g, '.*');
                const regex = new RegExp(anchored ? `(^|/)${source}` : source);
                return regex.test(path);
            }
            // For non-glob patterns, check if any path segment matches exactly
            // or if the full path ends with the pattern (for extension-like patterns)
            return segments.some((segment) => segment === pattern) || path.endsWith('/' + pattern);
        });
    }
    /**
     * Parse a file and extract code chunks.
     * Size limit is the shared `MAX_SCANNED_FILE_BYTES` ceiling - the same
     * number the daemon and the server's scanPushSchema enforce, so anything
     * chunked here can always be shipped and stored verbatim.
     */
    static MAX_FILE_SIZE = MAX_SCANNED_FILE_BYTES;
    async parseFile(filePath, rootPath, enumerated) {
        try {
            // Check file size before reading to avoid memory issues
            // Wrap stat with timeout
            const stats = enumerated ??
                (await withTimeout(lstat(filePath), FILE_OP_TIMEOUT_MS, `stat timed out: ${filePath}`));
            if (stats.size > CodeScanner.MAX_FILE_SIZE) {
                logDebug('Skipping file exceeding size limit', {
                    filePath,
                    size: stats.size,
                    limit: CodeScanner.MAX_FILE_SIZE,
                });
                return [];
            }
            // Wrap readFile with timeout
            let content = await withTimeout(this.readConfined(filePath, rootPath, stats), FILE_OP_TIMEOUT_MS, `readFile timed out: ${filePath}`);
            // NUL sanitation (ingestion boundary, daemon side): Postgres `text`
            // columns reject the literal NUL byte (U+0000) - a single one aborts
            // the whole INSERT/UPDATE. Some source files legitimately contain
            // them. Strip before any chunking so every chunk's content, its
            // contentHash, and its embedding all agree - mirrors the server-side
            // strip in ProjectManager (kept as defense in depth for content that
            // reaches the server via an older scanner) but doing it here means
            // the daemon never even transmits the NUL bytes.
            if (content.includes('\0')) {
                content = content.replace(/\0/g, '');
            }
            const relativePath = relative(rootPath, filePath);
            const language = this.detectLanguage(filePath);
            // Try to extract functions/classes
            if (language === 'markdown') {
                return this.chunkMarkdown(content, relativePath, stats.size);
            }
            const fileMetadata = {
                fileName: filePath.split('/').pop() || '',
                extension: extname(filePath),
                size: stats.size,
            };
            // AST first for the languages with a vendored grammar. `null` means "no
            // grammar for this" - the honest majority of the allowlist - and the
            // heuristic path below takes over with no log, because that is not a
            // degradation.
            const astLanguage = resolveAstLanguage(fileMetadata.extension, language);
            if (astLanguage) {
                const ast = await chunkWithAst(content, astLanguage, {
                    maxParseBytes: this.options.maxAstParseBytes,
                });
                if ('chunks' in ast) {
                    // A definition the chunker could not place reaches no chunk, so its
                    // name reaches no index and a citation to it resolves as
                    // `unresolved_symbol`. It cannot be emitted (two chunks over one line
                    // range collide on the `filePath:startLine-endLine` staleness key), but
                    // a scan that quietly loses symbols must not look like a healthy one.
                    if (ast.droppedDefinitions > 0) {
                        logWarn('AST chunker dropped definitions that share a line range', {
                            filePath: relativePath,
                            grammar: astLanguage,
                            droppedDefinitions: ast.droppedDefinitions,
                        });
                    }
                    // `errorNodes` is handed back precisely so this degradation is not
                    // silent, and discarding it made it silent. One ERROR node can swallow
                    // the rest of a file - `typeof import(...)` in a type argument does
                    // exactly that to tree-sitter-typescript - after which no definition is
                    // captured and the file arrives as one unnamed whole-file chunk. Naming
                    // the file, the error count and how many definitions survived is what
                    // makes that visible in a scan log.
                    //
                    // Deliberately NOT a fallback to the heuristic path: measured on the
                    // real construct (tests/AgentInjectionDeliveryWiring.test.ts), the
                    // heuristic path names nothing either (its name pattern needs a
                    // leading `function`/`class`/`const`) AND covers less - it emitted 3
                    // chunks starting at line 18 and dropped lines 1-17, because the
                    // uncovered-region supplement only fires above 50 lines. Trading
                    // total coverage for no gain is worse than one honest blob, so the
                    // AST result stands and the log says so.
                    if (ast.errorNodes > 0) {
                        logWarn('AST parse errors; extents and symbol names degraded for this file', {
                            filePath: relativePath,
                            grammar: astLanguage,
                            errorNodes: ast.errorNodes,
                            definitions: ast.chunks.filter((chunk) => chunk.symbolKind).length,
                            chunks: ast.chunks.length,
                        });
                    }
                    // The wire cap (`scanChunkSchema` allows 500,000 chars) and the
                    // embedding cap (8191 tokens per input) are both downstream of
                    // `maxChunkSize`, and the AST chunker only bounds its uncovered spans:
                    // a definition chunk is whatever the definition is. `boundAstChunks`
                    // makes the cap unreachable by construction, or answers null when the
                    // file cannot be bounded on line boundaries at all.
                    const bounded = this.boundAstChunks(ast.chunks);
                    if (bounded) {
                        // Zero chunks here means the file has no non-whitespace line - the AST
                        // chunker covers every other line by construction - so returning
                        // nothing is the correct answer, not a lost file.
                        return bounded.map(({ symbolName, symbolKind, signature, symbolContainer, ...chunk }) => ({
                            ...chunk,
                            filePath: relativePath,
                            language,
                            contentHash: this.hash(chunk.content),
                            metadata: {
                                ...fileMetadata,
                                ...(signature ? { signature } : {}),
                                ...(symbolName ? { symbolName } : {}),
                                ...(symbolKind ? { symbolKind } : {}),
                                ...(symbolContainer ? { symbolContainer } : {}),
                            },
                        }));
                    }
                    // One line longer than `maxChunkSize` - a generated `*_pb2.py` carries
                    // the whole serialized descriptor on one. Splitting it would have to
                    // cut mid-line, and two chunks over one line range collide on the
                    // `filePath:startLine-endLine` staleness key, so the whole file goes to
                    // the heuristic chunker, which force-splits long lines by character
                    // count. Loud, because a file that loses its symbol names must not look
                    // like a healthy one.
                    logWarn('AST chunk exceeds maxChunkSize on a single line; heuristic chunking instead', {
                        filePath: relativePath,
                        grammar: astLanguage,
                        maxChunkSize: this.options.maxChunkSize,
                        longestLine: content
                            .split('\n')
                            .reduce((longest, line) => Math.max(longest, line.length), 0),
                    });
                }
                else if (ast.unsupported === 'grammar_unavailable') {
                    // Process-global, not per file: `loadGrammar` caches its failures, so
                    // every file of this language degrades for the same reason. Warned per
                    // file, this printed 1,037 identical lines in one scan of this repo -
                    // the log flood `logAstCapabilityOnce` exists to avoid. Once per
                    // (reason, grammar); the file-specific reasons below stay per file.
                    const key = `${ast.unsupported}:${astLanguage}`;
                    if (!reportedGrammarFallbacks.has(key)) {
                        reportedGrammarFallbacks.add(key);
                        logWarn('AST chunking unavailable for a whole language; heuristic chunking instead', {
                            grammar: astLanguage,
                            reason: ast.unsupported,
                            detail: ast.detail,
                            firstFile: relativePath,
                            note: 'logged once per grammar per process; every file of this language degrades',
                        });
                    }
                }
                else {
                    // Not a silent no-op: name the file AND the reason, then degrade to the
                    // heuristic path. A degraded scan indistinguishable from a healthy one
                    // is the defect class this routing exists to avoid - and degrading to
                    // zero chunks would delete the file from the index instead.
                    logWarn('AST chunking unavailable; falling back to heuristic chunking', {
                        filePath: relativePath,
                        grammar: astLanguage,
                        reason: ast.unsupported,
                        detail: ast.detail,
                    });
                }
            }
            const structuredChunks = this.extractStructuredChunks(content, language);
            if (structuredChunks.length > 0) {
                const mapped = structuredChunks.map(({ signature, symbolName, ...chunk }) => ({
                    ...chunk,
                    filePath: relativePath,
                    language,
                    metadata: {
                        ...fileMetadata,
                        ...(signature && { signature }),
                        ...(symbolName && { symbolName }),
                    },
                }));
                // Coverage check: if structured chunks cover less than 50% of file lines,
                // supplement with raw chunks for uncovered regions. This prevents a single
                // small match from blocking all raw chunking in large files.
                const totalLines = content.split('\n').length;
                const coveredLines = new Set();
                for (const chunk of structuredChunks) {
                    for (let l = chunk.startLine; l <= chunk.endLine; l++) {
                        coveredLines.add(l);
                    }
                }
                const coverageRatio = coveredLines.size / totalLines;
                if (coverageRatio < 0.5 && totalLines > 50) {
                    const rawChunks = this.chunkRaw(content, relativePath, language, stats.size);
                    // Only keep raw chunks that don't overlap with structured chunks
                    const supplemental = rawChunks.filter((rc) => {
                        for (const sc of structuredChunks) {
                            if (rc.startLine <= sc.endLine && rc.endLine >= sc.startLine) {
                                return false;
                            }
                        }
                        return true;
                    });
                    mapped.push(...supplemental);
                }
                return mapped;
            }
            // Fall back to raw chunking
            return this.chunkRaw(content, relativePath, language, stats.size);
        }
        catch (error) {
            logDebug('Error parsing file', { filePath, error });
            return [];
        }
    }
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
    boundAstChunks(chunks) {
        const max = this.options.maxChunkSize;
        if (chunks.every((chunk) => chunk.content.length <= max))
            return [...chunks];
        const bounded = [];
        for (const chunk of chunks) {
            if (chunk.content.length <= max) {
                bounded.push(chunk);
                continue;
            }
            // `content` is exactly `startLine..endLine` joined by '\n', so this split
            // recovers the file's own lines for that range.
            const lines = chunk.content.split('\n');
            if (lines.some((line) => line.length > max))
                return null;
            /** `from`/`to` are 0-based offsets into `lines`, inclusive. */
            const emit = (from, to) => {
                const content = lines.slice(from, to + 1).join('\n');
                // A piece of nothing but blank lines is owed no chunk (the chunker's own
                // rule) and `scanChunkSchema` requires content.min(1) anyway.
                if (content.trim() === '')
                    return;
                const isFirst = from === 0;
                bounded.push({
                    content,
                    startLine: chunk.startLine + from,
                    endLine: chunk.startLine + to,
                    chunkType: isFirst ? chunk.chunkType : 'raw',
                    ...(isFirst && chunk.symbolName ? { symbolName: chunk.symbolName } : {}),
                    ...(isFirst && chunk.symbolKind ? { symbolKind: chunk.symbolKind } : {}),
                    ...(isFirst && chunk.signature ? { signature: chunk.signature } : {}),
                    ...(isFirst && chunk.symbolContainer ? { symbolContainer: chunk.symbolContainer } : {}),
                });
            };
            let pieceStart = 0;
            let pieceLength = 0;
            for (let i = 0; i < lines.length; i++) {
                const lineLength = (lines[i] ?? '').length;
                // The '\n' the join will put back is part of what has to fit.
                const withLine = i === pieceStart ? lineLength : pieceLength + 1 + lineLength;
                if (i > pieceStart && withLine > max) {
                    emit(pieceStart, i - 1);
                    pieceStart = i;
                    pieceLength = lineLength;
                }
                else {
                    pieceLength = withLine;
                }
            }
            emit(pieceStart, lines.length - 1);
        }
        return bounded;
    }
    /**
     * Detect language from file extension
     */
    detectLanguage(filePath) {
        return languageForExtension(filePath);
    }
    /**
     * Chunk markdown files by headers
     */
    chunkMarkdown(content, filePath, size) {
        const chunks = [];
        const lines = content.split('\n');
        let currentChunk = [];
        let currentStartLine = 1;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line === undefined)
                continue;
            const isHeader = /^#{1,6}\s/.test(line);
            // If we hit a new header and have content, push the previous chunk
            if (isHeader && currentChunk.length > 0) {
                const chunkContent = currentChunk.join('\n').trim();
                if (chunkContent.length >= this.options.minChunkSize) {
                    chunks.push({
                        content: chunkContent,
                        filePath,
                        language: 'markdown',
                        startLine: currentStartLine,
                        endLine: i, // Previous line
                        chunkType: 'module', // Treat sections as modules
                        contentHash: this.hash(chunkContent),
                        metadata: {
                            fileName: filePath.split('/').pop() || '',
                            extension: '.md',
                            size,
                        },
                    });
                }
                currentChunk = [];
                currentStartLine = i + 1;
                // currentHeader = line; // unused
            }
            currentChunk.push(line);
            // If chunk gets too big, force a split (fallback to raw-like behavior but inside markdown logic)
            if (currentChunk.join('\n').length > this.options.maxChunkSize) {
                const chunkContent = currentChunk.join('\n').trim();
                chunks.push({
                    content: chunkContent,
                    filePath,
                    language: 'markdown',
                    startLine: currentStartLine,
                    endLine: i + 1,
                    chunkType: 'raw',
                    contentHash: this.hash(chunkContent),
                    metadata: {
                        fileName: filePath.split('/').pop() || '',
                        extension: '.md',
                        size,
                    },
                });
                currentChunk = [];
                currentStartLine = i + 2;
            }
        }
        // Push remaining content
        if (currentChunk.length > 0) {
            const chunkContent = currentChunk.join('\n').trim();
            if (chunkContent.length >= this.options.minChunkSize) {
                chunks.push({
                    content: chunkContent,
                    filePath,
                    language: 'markdown',
                    startLine: currentStartLine,
                    endLine: lines.length,
                    chunkType: 'module',
                    contentHash: this.hash(chunkContent),
                    metadata: {
                        fileName: filePath.split('/').pop() || '',
                        extension: '.md',
                        size,
                    },
                });
            }
        }
        return chunks;
    }
    /**
     * Find the index of the closing brace matching the opening brace at openIndex.
     * Handles nested braces. Skips braces inside string literals, template literals,
     * single-line comments, multi-line comments, and regex literals.
     */
    findMatchingBrace(content, openIndex) {
        if (content[openIndex] !== '{')
            return -1;
        let depth = 1;
        let i = openIndex + 1;
        const len = content.length;
        while (i < len) {
            const c = content.charAt(i);
            const next = content.charAt(i + 1);
            // Single-line comment
            if (c === '/' && next === '/') {
                i = content.indexOf('\n', i);
                if (i === -1)
                    return -1;
                i++;
                continue;
            }
            // Multi-line comment
            if (c === '/' && next === '*') {
                i = content.indexOf('*/', i + 2);
                if (i === -1)
                    return -1;
                i += 2;
                continue;
            }
            // String literals (single or double quote)
            if (c === "'" || c === '"') {
                i++;
                while (i < len && content.charAt(i) !== c) {
                    if (content.charAt(i) === '\\')
                        i++; // skip escaped char
                    i++;
                }
                i++; // skip closing quote
                continue;
            }
            // Template literal
            if (c === '`') {
                i++;
                while (i < len && content.charAt(i) !== '`') {
                    if (content.charAt(i) === '\\')
                        i++; // skip escaped char
                    i++;
                }
                i++; // skip closing backtick
                continue;
            }
            // Regex literal - heuristic: / after operator chars or keywords that precede expressions
            if (c === '/' && i > 0) {
                // Look back for operator context (skip whitespace)
                let j = i - 1;
                while (j >= 0 && (content.charAt(j) === ' ' || content.charAt(j) === '\t'))
                    j--;
                const prev = j >= 0 ? content.charAt(j) : '\n';
                // Check for keywords that precede regex: return, typeof, void, delete, throw, new, case, in, instanceof
                let isRegexContext = '=({[,;:!&|?+->~^%\n'.includes(prev);
                if (!isRegexContext && j >= 0 && /[a-z]/.test(prev)) {
                    // Extract the word ending at position j
                    let wordStart = j;
                    while (wordStart > 0 && /[a-z]/.test(content.charAt(wordStart - 1)))
                        wordStart--;
                    const word = content.substring(wordStart, j + 1);
                    const regexKeywords = [
                        'return',
                        'typeof',
                        'void',
                        'delete',
                        'throw',
                        'new',
                        'case',
                        'in',
                        'instanceof',
                        'yield',
                        'await',
                    ];
                    isRegexContext = regexKeywords.includes(word);
                }
                if (isRegexContext) {
                    i++;
                    while (i < len && content.charAt(i) !== '/') {
                        if (content.charAt(i) === '\\') {
                            i++; // skip escaped char
                        }
                        else if (content.charAt(i) === '[') {
                            // character class - skip to ]
                            i++;
                            while (i < len && content.charAt(i) !== ']') {
                                if (content.charAt(i) === '\\')
                                    i++;
                                i++;
                            }
                        }
                        i++;
                    }
                    i++; // skip closing /
                    continue;
                }
            }
            if (c === '{')
                depth++;
            else if (c === '}') {
                depth--;
                if (depth === 0)
                    return i;
            }
            i++;
        }
        return -1;
    }
    /**
     * Extract structured chunks (functions, classes)
     * Uses brace-matching for TS/JS/Rust so nested braces are not truncated at first \n}
     */
    extractStructuredChunks(content, language) {
        const chunks = [];
        const patterns = this.getLanguagePatterns(language);
        const useBraceMatch = ['typescript', 'javascript', 'rust'].includes(language);
        for (const pattern of patterns) {
            let match;
            const regex = new RegExp(pattern.regex, 'gm');
            while ((match = regex.exec(content)) !== null) {
                let matchContent;
                if (useBraceMatch && pattern.regex.endsWith('\\{')) {
                    const openBraceIndex = match.index + match[0].length - 1;
                    if (content[openBraceIndex] === '{') {
                        const closeIndex = this.findMatchingBrace(content, openBraceIndex);
                        if (closeIndex >= 0) {
                            matchContent = content.slice(match.index, closeIndex + 1);
                        }
                        else {
                            matchContent = match[0];
                        }
                    }
                    else {
                        matchContent = match[0];
                    }
                }
                else {
                    matchContent = match[0];
                }
                const startLine = content.substring(0, match.index).split('\n').length;
                const endLine = startLine + matchContent.split('\n').length - 1;
                if (matchContent.length >= this.options.minChunkSize &&
                    matchContent.length <= this.options.maxChunkSize) {
                    // Extract function/class signature and symbol name
                    const firstLine = (matchContent.split('\n')[0] ?? '').trim();
                    // Capped like the AST chunker's: a minified one-line bundle makes the
                    // whole chunk its "first line", and an uncapped signature fails the
                    // server's 500-char bound for the entire push batch.
                    const signature = firstLine.replace(/\{$/, '').trim().slice(0, MAX_SIGNATURE_CHARS) || undefined;
                    const nameMatch = firstLine.match(/(?:function|class|const|interface|type|enum|export\s+(?:default\s+)?(?:function|class|const|interface|type|enum))\s+(\w+)/);
                    const symbolName = nameMatch?.[1] || undefined;
                    chunks.push({
                        content: matchContent.trim(),
                        startLine,
                        endLine,
                        chunkType: pattern.type,
                        contentHash: this.hash(matchContent),
                        signature,
                        symbolName,
                    });
                }
            }
        }
        return chunks;
    }
    /**
     * Get regex patterns for language
     */
    getLanguagePatterns(language) {
        switch (language) {
            case 'typescript':
            case 'javascript':
                return [
                    // Classes (body extracted via brace-matching)
                    {
                        regex: '(?:export\\s+)?(?:abstract\\s+)?class\\s+\\w+[^{]*\\{',
                        type: 'class',
                    },
                    // Functions (body extracted via brace-matching)
                    {
                        regex: '(?:export\\s+)?(?:async\\s+)?function\\s+\\w+[^{]*\\{',
                        type: 'function',
                    },
                    // Arrow functions (body extracted via brace-matching)
                    {
                        regex: '(?:export\\s+)?const\\s+\\w+\\s*=\\s*(?:async\\s+)?\\([^)]*\\)\\s*=>\\s*\\{',
                        type: 'function',
                    },
                    // Class methods - matches indented methods with optional modifiers.
                    // Excludes control flow keywords (if, for, while, switch, catch, return).
                    {
                        regex: '^\\s+(?:(?:private|protected|public|static|abstract|override|readonly|async|get|set)\\s+)*(?!if|for|while|switch|catch|return|throw|new|import|export)\\w+\\s*(?:<[^>]*>)?\\s*\\([^)]*\\)[^{]*\\{',
                        type: 'function',
                    },
                ];
            case 'python':
                return [
                    // Classes
                    { regex: 'class\\s+\\w+[^:]*:[^]*?(?=\\nclass\\s|\\ndef\\s|$)', type: 'class' },
                    // Functions
                    { regex: 'def\\s+\\w+[^:]*:[^]*?(?=\\ndef\\s|\\nclass\\s|$)', type: 'function' },
                ];
            case 'rust':
                return [
                    // Functions (body extracted via brace-matching)
                    { regex: '(?:pub\\s+)?fn\\s+\\w+[^{]*\\{', type: 'function' },
                    // Structs (single-line style; no nested braces in pattern)
                    { regex: '(?:pub\\s+)?struct\\s+\\w+[^}]*\\}', type: 'class' },
                ];
            default:
                return [];
        }
    }
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
    chunkRaw(content, filePath, language, size) {
        const chunks = [];
        const lines = content.split('\n');
        const maxBytes = this.options.maxChunkSize;
        const minBytes = this.options.minChunkSize;
        const overlapBytes = Math.floor(maxBytes * 0.1);
        const fileName = filePath.split('/').pop() || '';
        const extension = extname(filePath);
        let currentLines = [];
        let currentLen = 0;
        let chunkStartIdx = 0;
        const emit = (linesArr, startIdx) => {
            const text = linesArr.join('\n');
            if (text.length < minBytes)
                return;
            chunks.push({
                content: text.trim(),
                filePath,
                language,
                startLine: startIdx + 1,
                endLine: startIdx + linesArr.length,
                chunkType: 'raw',
                contentHash: this.hash(text),
                metadata: { fileName, extension, size },
            });
        };
        const flushWithOverlap = () => {
            if (currentLines.length === 0)
                return;
            emit(currentLines, chunkStartIdx);
            const overlapTail = [];
            let overlapLen = 0;
            for (let j = currentLines.length - 1; j >= 0; j--) {
                const line = currentLines[j];
                if (line === undefined)
                    continue;
                const lineLen = line.length + 1;
                if (overlapLen + lineLen > overlapBytes)
                    break;
                overlapTail.unshift(line);
                overlapLen += lineLen;
            }
            chunkStartIdx = chunkStartIdx + currentLines.length - overlapTail.length;
            currentLines = overlapTail;
            currentLen = overlapLen;
        };
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line === undefined)
                continue;
            if (line.length >= maxBytes) {
                if (currentLines.length > 0) {
                    emit(currentLines, chunkStartIdx);
                    currentLines = [];
                    currentLen = 0;
                }
                // Every segment of one line has the same line span, so each carries
                // its ordinal: the server keys a chunk on (path, span, piece).
                let piece = 0;
                for (let offset = 0; offset < line.length; offset += maxBytes) {
                    const segment = line.slice(offset, offset + maxBytes);
                    if (segment.length < minBytes)
                        continue;
                    chunks.push({
                        content: segment.trim(),
                        filePath,
                        language,
                        startLine: i + 1,
                        endLine: i + 1,
                        chunkType: 'raw',
                        contentHash: this.hash(segment),
                        metadata: { fileName, extension, size, piece: piece++ },
                    });
                }
                continue;
            }
            const lineLen = line.length + 1;
            if (currentLen + lineLen > maxBytes && currentLen >= minBytes) {
                flushWithOverlap();
            }
            if (currentLines.length === 0) {
                chunkStartIdx = i;
            }
            currentLines.push(line);
            currentLen += lineLen;
        }
        if (currentLines.length > 0) {
            emit(currentLines, chunkStartIdx);
        }
        return chunks;
    }
    /**
     * Generate content hash for drift detection
     */
    hash(content) {
        return createHash('sha256').update(content).digest('hex').substring(0, 16);
    }
    /**
     * Walk the project for authority manifest/config/CI files and return their
     * verbatim content. Reuses ignorePatterns; matches AUTHORITY_FILE_MATCHERS
     * (not includeExtensions). Content-only - no chunking, no embeddings.
     */
    async collectAuthorityFiles(projectRoot) {
        const { files } = await this.collectAuthorityFilesWithStatus(projectRoot);
        return files;
    }
    /**
     * Completeness-aware variant of `collectAuthorityFiles`. `complete ===
     * false` means an fs error hid part of the walk, so authority paths may
     * be missing - the daemon folds this into the same removal gate as
     * `listFilesWithStatus` (a partial authority walk would likewise drop
     * inventory entries and read as deletion).
     */
    async collectAuthorityFilesWithStatus(projectRoot, onFile) {
        projectRoot = await this.canonicalRoot(projectRoot);
        const out = [];
        const walkState = { complete: true };
        // M2: cap walk depth to match the scanner's MAX_DEPTH (10)
        const walk = async (dir, depth, stack = []) => {
            if (depth >= CodeScanner.MAX_DEPTH)
                return;
            if (this.isProtected(dir))
                return;
            let entries;
            try {
                if (!(await this.confineSymlink(dir, projectRoot)))
                    throw new Error('scanner_containment');
                entries = await readdir(dir, { withFileTypes: true });
            }
            catch {
                walkState.complete = false;
                return;
            }
            const dirRel = dir === projectRoot ? '' : relative(projectRoot, dir).split(sep).join('/');
            const localLayer = await this.loadIgnoreLayer(dir, dirRel, walkState, projectRoot);
            const localStack = localLayer ? [...stack, localLayer] : stack;
            for (const ent of entries) {
                const full = join(dir, ent.name);
                const rel = relative(projectRoot, full).split(sep).join('/');
                if (this.isProtected(full))
                    continue;
                if (this.shouldIgnore(rel))
                    continue;
                let stats;
                try {
                    stats = await lstat(full);
                }
                catch {
                    walkState.complete = false;
                    continue;
                }
                if (this.skipSymlink(stats))
                    continue;
                const isDir = stats.isDirectory(), isFile = stats.isFile();
                if (this.ignoredByStack(rel, isDir, localStack))
                    continue; // .gitignore/.mnemonikignore
                if (isDir) {
                    if (await isGitBoundary(full))
                        continue; // another repo's subtree
                    await walk(full, depth + 1, localStack);
                }
                else if (isFile && AUTHORITY_FILE_MATCHERS.some((m) => m(rel))) {
                    let file;
                    try {
                        if (stats.size > MAX_SCANNED_FILE_BYTES)
                            continue;
                        let content = await this.readConfined(full, projectRoot, stats);
                        // Authority files honor the same single ceiling as chunked files
                        // (MAX_SCANNED_FILE_BYTES). Manifests are tiny; one this large is
                        // anomalous, so say so rather than dropping it silently - a
                        // missing authority file otherwise looks identical to a project
                        // that simply has no manifest.
                        if (content.length > MAX_SCANNED_FILE_BYTES) {
                            logWarn('Authority file exceeds the scan ceiling; excluded from push', {
                                path: rel,
                                size: content.length,
                                limit: MAX_SCANNED_FILE_BYTES,
                            });
                            continue;
                        }
                        // NUL sanitation (ingestion boundary, daemon side): Postgres
                        // `text` columns reject the literal NUL byte (U+0000). Authority
                        // files are shipped verbatim (no chunking), so strip here before
                        // hashing so the hash and the transmitted content always agree.
                        if (content.includes('\0')) {
                            content = content.replace(/\0/g, '');
                        }
                        const hash = createHash('sha256').update(content).digest('hex');
                        file = { path: rel, content, hash };
                    }
                    catch {
                        /* unreadable - skip */
                        walkState.complete = false;
                    }
                    // The consumer owns backpressure; its abort must leave the walk immediately.
                    if (file) {
                        if (onFile)
                            await onFile(file);
                        else
                            out.push(file);
                    }
                }
            }
        };
        await walk(projectRoot, 0);
        return { files: out, complete: walkState.complete };
    }
}
//# sourceMappingURL=codeScanner.js.map