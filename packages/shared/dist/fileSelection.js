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
import { readdir, readFile, open, lstat, realpath } from 'fs/promises';
import { constants } from 'fs';
import { join, relative, extname, sep, resolve, dirname } from 'path';
import ignore from 'ignore';
import { debug as logDebug } from './logger.js';
import { isProtectedLocalPath, protectedLocalPaths } from './protectedPaths.js';
import { readIdentityFile } from './projectIdentityFile.js';
import { classifyForIndex, gitattributesCanReinclude, parseGitattributes, softDefaultForDirectory, } from './indexClassifier.js';
/**
 * First budget for one filesystem operation (readdir, lstat, read). It keeps a
 * hung mount (a dead network share, a stalled cloud placeholder) from holding
 * the walk forever, which is why it has existed since the scanner did.
 *
 * Five seconds alone was the whole story until October 2026, and a slow but
 * working filesystem (network home, WSL across the 9P bridge, a cloud drive
 * fetching on demand) lost files in silence: the walk was merely marked
 * incomplete. So an operation that runs out of this budget is tried once more
 * with FILE_OP_RETRY_TIMEOUT_MS, and what still fails is counted in the walk's
 * `unreadable` total, which the daemon reports to the server as a blind spot.
 */
const FILE_OP_TIMEOUT_MS = 5000;
/** The second, last attempt at an operation the first budget did not cover. */
const FILE_OP_RETRY_TIMEOUT_MS = 30_000;
/** A filesystem operation that did not finish in its budget. */
class FileOpTimeoutError extends Error {
    constructor(label, timeoutMs) {
        super(`${label} timed out after ${timeoutMs} ms`);
        this.name = 'FileOpTimeoutError';
    }
}
function timedOp(op, timeoutMs, label) {
    let timer;
    return Promise.race([
        op,
        new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new FileOpTimeoutError(label, timeoutMs)), timeoutMs);
        }),
    ]).finally(() => clearTimeout(timer));
}
/**
 * Run one filesystem operation within FILE_OP_TIMEOUT_MS, and once more within
 * FILE_OP_RETRY_TIMEOUT_MS if the first attempt timed out. Other errors are not
 * retried: ENOENT, EACCES and the containment refusals answer the same way twice.
 */
export async function fileOp(op, label, budgets = {
    first: FILE_OP_TIMEOUT_MS,
    retry: FILE_OP_RETRY_TIMEOUT_MS,
}) {
    try {
        return await timedOp(op(), budgets.first, label);
    }
    catch (error) {
        if (!(error instanceof FileOpTimeoutError))
            throw error;
        return timedOp(op(), budgets.retry, label);
    }
}
export function statTuple(stats) {
    return { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, ino: stats.ino };
}
/** How many unreadable entries a walk names (doctor shows them); the rest are counted. */
const UNREADABLE_SAMPLES = 5;
/** An entry the walk could not read: the walk is no longer complete, and it counts. */
export function markUnreadable(walk, path, error) {
    walk.complete = false;
    walk.unreadable = (walk.unreadable ?? 0) + 1;
    walk.unreadableSamples ??= [];
    if (walk.unreadableSamples.length < UNREADABLE_SAMPLES)
        walk.unreadableSamples.push({
            path,
            reason: error?.code ??
                (error instanceof Error ? error.message : 'unreadable'),
        });
}
/**
 * A directory's identity: device and inode as exact integers. Read with bigint
 * stats because a 64-bit inode above 2^53 loses precision as a number, and two
 * distinct directories could then share a key. Null where the filesystem
 * reports no inode (some Windows filesystems), which cannot identify a loop.
 */
async function directoryKey(path) {
    const stats = await lstat(path, { bigint: true });
    return stats.ino ? `${stats.dev}:${stats.ino}` : null;
}
/**
 * Enter a directory unless it is one of its own ancestors. Returns the
 * function that leaves it again (call it once its subtree is walked), or null
 * for a cycle, which is not walked and makes the walk incomplete, so the
 * removed-files diff never treats what it did not see as deleted.
 */
export async function enterDirectory(walk, path) {
    let key;
    try {
        key = await directoryKey(path);
    }
    catch {
        key = null; // the walk's own lstat already succeeded; without a key, no loop can be shown
    }
    if (key === null)
        return () => undefined;
    walk.ancestors ??= new Set();
    if (walk.ancestors.has(key)) {
        markUnreadable(walk, path, Object.assign(new Error('directory cycle'), { code: 'ELOOP' }));
        return null;
    }
    const entered = key;
    walk.ancestors.add(entered);
    return () => {
        walk.ancestors?.delete(entered);
    };
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
 * file in code_search. (Subprojects and linked worktrees are excluded
 * generically by the isProjectBoundary rule below, not a path convention.)
 */
export const BUILT_IN_IGNORE_FILE_PATTERNS = [
    // NOTE: the `.env` family and every other secret-bearing FILE KIND lives in
    // `isSecretFile` below, not here. This glob engine cannot express negation
    // (`.env.example` must stay collectable) and its unanchored substring
    // matching would make `.env.*` also swallow `.environment.ts`.
    //
    // `/tests/fixtures/*` used to live here. It is now a soft default in
    // indexClassifier.ts (test fixtures, R2), which a project can re-include.
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
/** Per-directory attributes file: linguist overrides and binary marks (indexClassifier.ts). */
const ATTRIBUTES_FILE_NAME = '.gitattributes';
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
export function isCursorRulePath(relPath) {
    if (!relPath)
        return false;
    const posix = relPath.split(sep).join('/');
    return /(^|\/)\.cursorrules$/.test(posix) || /(^|\/)\.cursor\/rules\/.+\.mdc$/.test(posix);
}
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
    if (isCmakeListsPath(filePathOrExt))
        return 'cmake';
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
/** Content-only build authority, shared by scanner collection and server admission. */
export const XCODE_AUTHORITY_PATH = /(?:^|\/)[^/]+\.xcodeproj\/project\.pbxproj$|\.xcconfig$/;
export const isXcodeAuthorityPath = (path) => XCODE_AUTHORITY_PATH.test(path);
/** Exact CMake build entrypoint; ordinary .txt files remain outside collection. */
export const CMAKE_LISTS_PATH = /(?:^|\/)CMakeLists\.txt$/;
export const isCmakeListsPath = (path) => CMAKE_LISTS_PATH.test(path);
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
    isXcodeAuthorityPath,
    isCmakeListsPath,
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
    isXcodeAuthorityPath,
    isCmakeListsPath,
];
/**
 * Segment-anchored match for `tests/fixtures/` - matches at the path root or
 * immediately after a `/`. Indexing no longer uses it (the fixture rule is the
 * soft default in indexClassifier.ts, which a project can override); it stays
 * for query-time hygiene over rows indexed before that rule existed
 * (`MemoryManager.searchCodePointers`).
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
        await fileOp(() => lstat(join(dirPath, '.git')), `lstat: ${join(dirPath, '.git')}`);
        return true;
    }
    catch {
        return false;
    }
}
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
export async function isProjectBoundary(dirPath, enclosingProjectId) {
    if (await lstatWithin(join(dirPath, '.mnemonik.json'))) {
        const identity = await fileOp(() => readIdentityFile(dirPath, { configurationOnlyAbsent: true }), `identity read: ${dirPath}`).catch(() => undefined);
        if (!identity)
            return true;
        if (identity.kind === 'ok') {
            if (identity.identity.projectId !== enclosingProjectId)
                return true;
            if ((await lstatWithin(join(dirPath, '.git')))?.isDirectory())
                return true;
        }
        else if (identity.kind !== 'absent')
            return true;
    }
    return isLinkedWorktreeCheckout(dirPath);
}
/**
 * The project a scan root's own identity file names, or undefined: the
 * enclosing project for isProjectBoundary.
 */
export async function rootProjectId(rootPath) {
    const identity = await fileOp(() => readIdentityFile(rootPath), `identity read: ${rootPath}`).catch(() => undefined);
    return identity?.kind === 'ok' ? identity.identity.projectId : undefined;
}
const lstatWithin = (path) => fileOp(() => lstat(path), `lstat: ${path}`).catch(() => undefined);
/**
 * True when `dirPath` is the top of a linked git worktree: its `.git` is a
 * FILE pointing at a git directory that has a `commondir`, or at one that no
 * longer exists (a pruned or moved worktree, or one made on another machine):
 * nothing shows it is this project's own. A submodule's `.git` file points at
 * `.git/modules/<name>`, which exists and has no `commondir`.
 */
export async function isLinkedWorktreeCheckout(dirPath) {
    const marker = await lstatWithin(join(dirPath, '.git'));
    if (!marker?.isFile())
        return false;
    try {
        const pointer = /^gitdir:\s*(.+?)\s*$/im.exec(await fileOp(() => readFile(join(dirPath, '.git'), 'utf8'), `read: ${join(dirPath, '.git')}`))?.[1];
        if (!pointer)
            return false;
        const gitDirectory = resolve(dirPath, pointer);
        if (!(await lstatWithin(gitDirectory)))
            return true;
        return !!(await lstatWithin(join(gitDirectory, 'commondir')));
    }
    catch {
        return false;
    }
}
/** The ignore patterns applied when a caller gives none. */
export const DEFAULT_IGNORE_PATTERNS = [
    ...BUILT_IN_IGNORE_DIRS,
    ...BUILT_IN_IGNORE_FILE_PATTERNS,
];
/**
 * The scanner's file selection. `listFilesWithStatus` is the inventory every
 * scan and the CLI's estimate count; CodeScanner adds reading and chunking.
 */
export class FileSelector {
    selection;
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
        this.selection = {
            ignorePatterns: [...DEFAULT_IGNORE_PATTERNS],
            includeExtensions: [...DEFAULT_INCLUDE_EXTENSIONS],
            protectedPaths: [],
            ...options,
        };
        this.protectedPaths = [
            ...new Set([...protectedLocalPaths(), ...(options.protectedPaths ?? [])]),
        ];
        this.includeExtensionSet = new Set(this.selection.includeExtensions.map((ext) => ext.toLowerCase()));
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
        if (!this.includeExtensionSet.has(extname(absOrRelPath).toLowerCase()) &&
            !isCursorRulePath(relPath)) {
            return false;
        }
        if (isAuthorityOnlyPath(relPath)) {
            logDebug('Skipping chunking for authority-collected path', { relPath });
            return false;
        }
        return true;
    }
    /**
     * Read `.gitignore` + `.mnemonikignore` + `.gitattributes` in `absDir` and
     * compile them into one layer (the two ignore files are unioned -
     * `.mnemonikignore` is just an additional gitignore-syntax exclusion list).
     * Returns null when none of the three exists. FAIL-CLOSED: a non-ENOENT read
     * error (EISDIR, EACCES, timeout) latches `walk.complete = false` so callers
     * deriving *removals* from the walk treat it as untrustworthy rather than
     * silently ignoring nothing.
     */
    async loadIgnoreLayer(absDir, baseRel, walk, rootPath) {
        if (this.isProtected(absDir))
            return null;
        const read = async (name) => {
            const filePath = join(absDir, name);
            try {
                const content = await fileOp(() => this.readConfined(filePath, rootPath), `readFile: ${filePath}`);
                return content.split(/\r?\n/);
            }
            catch (err) {
                if (err.message === 'symlink_skipped')
                    return null;
                if (err?.code !== 'ENOENT') {
                    markUnreadable(walk, filePath, err);
                    logDebug('Rule-file read failed (fail-closed)', { path: filePath, err });
                }
                return null;
            }
        };
        const patterns = [];
        for (const name of IGNORE_FILE_NAMES) {
            const lines = await read(name);
            if (lines)
                patterns.push(...lines);
        }
        const attributeLines = (await read(ATTRIBUTES_FILE_NAME)) ?? [];
        if (patterns.length > 0 || attributeLines.length > 0) {
            walk.rules?.set(baseRel, { ignore: patterns, attributes: attributeLines });
        }
        const attributes = attributeLines.length > 0 ? parseGitattributes(attributeLines.join('\n')) : [];
        // `ignore` tolerates blank/comment lines; null when nothing meaningful.
        if (patterns.length === 0 && attributes.length === 0)
            return null;
        return {
            baseRel,
            ig: patterns.length > 0 ? ignore().add(patterns) : null,
            hasNegation: patterns.some((line) => line.trimStart().startsWith('!')),
            attributes: attributes.length > 0 ? attributes : null,
        };
    }
    /**
     * What the .gitignore / .mnemonikignore layers in `stack` say about
     * `entryRel` (relative to the scan root). Tested deepest-first: the first
     * layer that explicitly ignores OR re-includes (via a `!negation`) wins,
     * matching git's rule that a deeper `.gitignore` overrides a shallower one.
     * Directories are tested with a trailing slash so `foo/` dir-only rules
     * match the directory itself. `'unignored'` means a negation matched this
     * path itself; a re-included parent directory leaves its files `'unmatched'`.
     */
    ignoreVerdict(entryRel, isDir, stack) {
        for (let i = stack.length - 1; i >= 0; i--) {
            const layer = stack[i];
            if (!layer?.ig)
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
                return 'ignored';
            if (res.unignored)
                return 'unignored';
        }
        return 'unmatched';
    }
    ignoredByStack(entryRel, isDir, stack) {
        return this.ignoreVerdict(entryRel, isDir, stack) === 'ignored';
    }
    static attributeLayers(stack) {
        return stack.flatMap((layer) => layer.attributes ? [{ baseRel: layer.baseRel, rules: layer.attributes }] : []);
    }
    /**
     * Skip this directory? User-ignored directories are skipped as before. A
     * directory a soft default excludes (vendor/, generated/, ...) is pruned too -
     * nothing under it can be indexed - UNLESS a rule above it could re-include
     * something inside it: a `!pattern` or a `-linguist-*` attribute. Then the
     * walk descends and judges each file, so the override works. Rule files
     * INSIDE a pruned directory are never read: a vendored library's own
     * .gitignore negations are not the project's intent.
     */
    skipDirectory(relPath, stack) {
        const posixRel = relPath.split(sep).join('/');
        const verdict = this.ignoreVerdict(posixRel, true, stack);
        if (verdict === 'ignored')
            return true;
        if (verdict === 'unignored')
            return false;
        if (!softDefaultForDirectory(posixRel))
            return false;
        const canReinclude = stack.some((layer) => layer.hasNegation) ||
            gitattributesCanReinclude(FileSelector.attributeLayers(stack));
        return !canReinclude;
    }
    /**
     * The index decision for a file from its path and the rule stack: `null`
     * when a user ignore rule excludes it, otherwise the classifier's answer
     * (precedence in indexClassifier.ts). Content rules are the caller's next
     * step for an included path without an `override`.
     */
    classifyEntry(relPath, stack) {
        const posixRel = relPath.split(sep).join('/');
        const verdict = this.ignoreVerdict(posixRel, false, stack);
        if (verdict === 'ignored')
            return null;
        return classifyForIndex(posixRel, {
            ignoreFileVerdict: verdict,
            attributes: FileSelector.attributeLayers(stack),
        });
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
     * A predicate for walkers outside this class (the daemon's file watcher):
     * true when the walk would descend into `absDir`, by the same rules
     * `listFiles` applies - user ignore files and soft-default directories,
     * with their overrides. Rule files are read once per directory for the life
     * of the returned predicate; take a fresh one after a rule file changes.
     * Directories outside `rootPath`, and the root itself, always pass.
     */
    directoryFilter(rootPath) {
        const cache = new Map();
        return async (absDir) => {
            try {
                const root = await this.canonicalRoot(rootPath);
                const rel = relative(root, absDir).split(sep).join('/');
                if (!rel || rel.startsWith('..'))
                    return true;
                const stack = await this.buildIgnoreStackForFile(rel, root, cache, { complete: true });
                return !this.skipDirectory(rel, stack);
            }
            catch {
                // Fail open: watching a directory the walk would skip costs a watch
                // handle; not watching one it would index loses changes.
                return true;
            }
        };
    }
    /**
     * True when any directory strictly between `rootPath` and `filePath`
     * starts a subtree this project does not index (see isProjectBoundary). Paths that don't
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
            if (await this.isBoundary(current, rootPath))
                return true;
        }
        return false;
    }
    rootProjectIds = new Map();
    /**
     * isProjectBoundary, with the scan root's own project as the enclosing one.
     * The root's file is read at most once a minute: a walk tests many folders,
     * and a project relinked since is seen on the next scan.
     */
    async isBoundary(dirPath, rootPath) {
        let cached = this.rootProjectIds.get(rootPath);
        if (!cached || Date.now() - cached.at > 60_000) {
            cached = { at: Date.now(), projectId: rootProjectId(rootPath) };
            this.rootProjectIds.set(rootPath, cached);
        }
        return isProjectBoundary(dirPath, await cached.projectId);
    }
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
        if (!FileSelector.containsCanonical(path, canonicalRoot))
            return false;
        for (;;) {
            if (this.skipSymlink(await lstat(path)))
                throw new Error('symlink_skipped');
            if (FileSelector.containsCanonical(canonicalRoot, path))
                break;
            path = dirname(path);
        }
        return FileSelector.containsCanonical(await realpath(fullPath), canonicalRoot);
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
        if (!FileSelector.containsCanonical(canonical, canonicalRoot) ||
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
        const overridden = new Set();
        const stats = new Map();
        const walk = { complete: true, rules: new Map() };
        await this.traversePaths(rootPath, rootPath, paths, 0, walk, [], overridden, stats);
        // Only a complete walk replaces the record: a partial one may be missing
        // rule files, and uploading it would tell the server fewer rules exist.
        if (walk.complete && walk.rules)
            this.ruleFilesByRoot.set(rootPath, walk.rules);
        return {
            paths: paths.filter((p) => !/(^|[/\\])\.\.([/\\]|$)/.test(p)),
            complete: walk.complete,
            overridden,
            unreadable: walk.unreadable ?? 0,
            unreadableSamples: walk.unreadableSamples ?? [],
            stats,
        };
    }
    /**
     * The rule files the last complete `listFilesWithStatus` walk of `rootPath`
     * applied, by directory ('' = root). Null before the first complete walk.
     * The daemon uploads these lines so the server judges paths as it did.
     */
    async indexRuleFiles(rootPath) {
        return this.ruleFilesByRoot.get(await this.canonicalRoot(rootPath)) ?? null;
    }
    ruleFilesByRoot = new Map();
    async traversePaths(currentPath, rootPath, out, depth, walk, stack = [], overridden, statsOut) {
        if (this.isProtected(currentPath))
            return;
        let entries;
        try {
            if (!(await this.confineSymlink(currentPath, rootPath)))
                throw new Error('scanner_containment');
            // The root is the first ancestor; every other directory enters before it recurses.
            if (depth === 0 && !(await enterDirectory(walk, currentPath)))
                return;
            entries = await fileOp(() => readdir(currentPath), `readdir: ${currentPath}`);
        }
        catch (error) {
            markUnreadable(walk, currentPath, error);
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
                const lstats = await fileOp(() => lstat(fullPath), `lstat: ${fullPath}`);
                if (this.skipSymlink(lstats))
                    continue;
                const stats = lstats;
                if (stats.isDirectory()) {
                    // .gitignore/.mnemonikignore, then soft-default directories
                    if (this.skipDirectory(relativePath, localStack))
                        continue;
                    if (await this.isBoundary(fullPath, rootPath))
                        continue; // a subproject or worktree
                    const leave = await enterDirectory(walk, fullPath);
                    if (!leave)
                        continue;
                    try {
                        await this.traversePaths(fullPath, rootPath, out, depth + 1, walk, localStack, overridden, statsOut);
                    }
                    finally {
                        leave();
                    }
                }
                else if (stats.isFile()) {
                    if (!this.isChunkable(fullPath, relativePath))
                        continue;
                    const decision = this.classifyEntry(relativePath, localStack);
                    if (!decision?.include)
                        continue;
                    out.push(relativePath);
                    statsOut?.set(relativePath, statTuple(stats));
                    if (decision.override)
                        overridden?.add(relativePath);
                }
            }
            catch (error) {
                markUnreadable(walk, fullPath, error);
                logDebug('Error traversing directory (listFiles)', { path: fullPath, error });
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
        return this.selection.ignorePatterns.some((pattern) => {
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
}
//# sourceMappingURL=fileSelection.js.map