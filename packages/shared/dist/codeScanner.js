/**
 * Code Scanner - Parse and chunk source files for embedding
 */
import { readdir, lstat } from 'fs/promises';
import { join, relative, extname, sep } from 'path';
import { createHash } from 'crypto';
import { debug as logDebug, info as logInfo, warn as logWarn } from './logger.js';
import { scrubSourceSecrets } from './sourceRedaction.js';
import { MAX_AST_PARSE_BYTES, MAX_SIGNATURE_CHARS, chunkWithAst, } from './ast/astChunker.js';
import { astArtifactReport, resolveAstLanguage } from './ast/grammars.js';
import { softDefaultForContent } from './indexClassifier.js';
import { FileSelector, DEFAULT_IGNORE_PATTERNS, fileOp, markUnreadable, enterDirectory, DEFAULT_INCLUDE_EXTENSIONS, isCursorRulePath, languageForExtension, AUTHORITY_FILE_MATCHERS, } from './fileSelection.js';
// The selection moved to fileSelection.ts; its names stay exported from here.
export { FileSelector, DEFAULT_IGNORE_PATTERNS, fileOp, statTuple, BUILT_IN_IGNORE_DIRS, isSecretFile, DEFAULT_INCLUDE_EXTENSIONS, isCursorRulePath, languageForExtension, XCODE_AUTHORITY_PATH, isXcodeAuthorityPath, CMAKE_LISTS_PATH, isCmakeListsPath, isAuthorityOnlyPath, AUTHORITY_FILE_MATCHERS, FIXTURE_PATH_RE, isFixturePath, makeIgnoreMatcher, isGitBoundary, isProjectBoundary, rootProjectId, isLinkedWorktreeCheckout, } from './fileSelection.js';
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
export const SCRUB_VERSION = 1;
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
const DEFAULT_OPTIONS = {
    maxChunkSize: 8000, // ~2000 tokens
    minChunkSize: 100,
    ignorePatterns: [...DEFAULT_IGNORE_PATTERNS],
    includeExtensions: [...DEFAULT_INCLUDE_EXTENSIONS],
    maxAstParseBytes: MAX_AST_PARSE_BYTES,
    protectedPaths: [],
};
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
export class CodeScanner extends FileSelector {
    options;
    constructor(options = {}) {
        super(options);
        this.options = { ...DEFAULT_OPTIONS, ...options };
    }
    /**
     * Scan a directory recursively and extract code chunks
     * No depth limit: symlinks are skipped and WalkState.ancestors ends any cycle.
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
     * redaction guarantee as `scanFiles`). `chunkless` lists the Markdown and
     * instruction files that chunked to nothing, as `scanFiles` reports them.
     */
    async scanDirectoryWithStatus(rootPath) {
        rootPath = await this.canonicalRoot(rootPath);
        const chunks = [];
        const chunkless = [];
        const excluded = [];
        const walk = { complete: true };
        await this.traverseDirectory(rootPath, rootPath, chunks, 0, walk, [], chunkless, excluded);
        return { chunks: await this.scrubChunks(chunks), complete: walk.complete, chunkless, excluded };
    }
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
    async scanFiles(filePaths, rootPath, chunkless, excluded) {
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
                // Explicit file lists arrive from watcher events, which can race a
                // worktree/nested-clone appearing - apply the same nested-git-boundary
                // rule the walks use (an ancestor between root and the file carrying
                // its own .git means the file belongs to another repository).
                if (rootPath && (await this.insideNestedGitBoundary(filePath, rootPath))) {
                    continue;
                }
                if (!this.isChunkable(filePath, fileRel))
                    continue;
                // Honor .gitignore/.mnemonikignore/.gitattributes on the incremental
                // path too, by reconstructing this file's ancestor rule stack (memoized
                // per directory across the batch), and judge it exactly as the walks do.
                let applyContentRules = true;
                if (rootPath && !fileRel.startsWith('..')) {
                    const stack = await this.buildIgnoreStackForFile(fileRel, rootPath, ignoreCache, walk);
                    const decision = this.classifyEntry(fileRel, stack);
                    if (!decision)
                        continue;
                    if (!decision.include) {
                        excluded?.push({
                            path: fileRel,
                            reason: decision.reason,
                            rule: decision.rule,
                            stage: 'path',
                        });
                        continue;
                    }
                    applyContentRules = !decision.override;
                }
                const fileChunks = await this.parseFile(filePath, rootPath || filePath, undefined, chunkless, { applyContentRules, ...(excluded ? { excluded } : {}) });
                chunks.push(...fileChunks);
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
     * Server still re-applies source sanitation in the /scan/push handler as
     * defense in depth (idempotent). Shared by `scanFiles` (watcher path)
     * and `scanDirectoryWithStatus` (initial/full-rescan path) so both
     * honor the same redaction guarantee.
     */
    async scrubChunks(chunks) {
        const result = [];
        for (const chunk of chunks) {
            const scrubbed = await scrubSourceSecrets(chunk.content.replace(/\0/g, ''), chunk.filePath);
            if (scrubbed.length <= MAX_PUSH_CHUNK_CONTENT_LENGTH) {
                result.push(...(scrubbed === chunk.content
                    ? [chunk]
                    : [{ ...chunk, content: scrubbed, contentHash: this.hash(scrubbed) }]));
                continue;
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
            result.push(...pieces);
        }
        return result;
    }
    /**
     * Recursively traverse directory
     * Added depth parameter with max limit
     */
    async traverseDirectory(currentPath, rootPath, chunks, depth, walk, stack = [], chunkless, excluded) {
        if (this.isProtected(currentPath))
            return;
        // Wrap readdir with timeout to prevent hanging
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
                        await this.traverseDirectory(fullPath, rootPath, chunks, depth + 1, walk, localStack, chunkless, excluded);
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
                    const fileChunks = await this.parseFile(fullPath, rootPath, stats, chunkless, {
                        applyContentRules: !decision.override,
                        ...(excluded ? { excluded } : {}),
                    });
                    chunks.push(...fileChunks);
                }
            }
            catch (error) {
                markUnreadable(walk, fullPath, error);
                logDebug('Error traversing directory', { path: fullPath, error });
            }
        }
    }
    /**
     * Parse a file and extract code chunks.
     * Size limit is the shared `MAX_SCANNED_FILE_BYTES` ceiling - the same
     * number the daemon and the server's scanPushSchema enforce, so anything
     * chunked here can always be shipped and stored verbatim.
     */
    static MAX_FILE_SIZE = MAX_SCANNED_FILE_BYTES;
    async parseFile(filePath, rootPath, enumerated, chunkless, contentGate = {
        applyContentRules: true,
    }) {
        try {
            // Check file size before reading to avoid memory issues
            // Wrap stat with timeout
            const stats = enumerated ?? (await fileOp(() => lstat(filePath), `stat: ${filePath}`));
            if (stats.size > CodeScanner.MAX_FILE_SIZE) {
                logDebug('Skipping file exceeding size limit', {
                    filePath,
                    size: stats.size,
                    limit: CodeScanner.MAX_FILE_SIZE,
                });
                return [];
            }
            // Wrap readFile with timeout
            let content = await fileOp(() => this.readConfined(filePath, rootPath, stats), `readFile: ${filePath}`);
            const relativePath = relative(rootPath, filePath);
            // Content soft defaults (binary, generated header, minified, data dump),
            // read from the SCRUBBED text because that is what the server receives
            // and re-judges - the two sides must not straddle a threshold. A NUL in
            // the first 8,000 bytes now means "binary, skip" (git's heuristic)
            // instead of strip-and-index.
            if (contentGate.applyContentRules) {
                const byContent = softDefaultForContent(relativePath, await scrubSourceSecrets(content, relativePath));
                if (byContent) {
                    contentGate.excluded?.push({
                        path: relativePath.split(sep).join('/'),
                        reason: byContent.reason,
                        rule: byContent.rule,
                        stage: 'content',
                    });
                    logDebug('Skipping file excluded by a content soft default', {
                        filePath: relativePath,
                        ...byContent,
                    });
                    return [];
                }
            }
            // NUL sanitation (ingestion boundary, daemon side): Postgres `text`
            // columns reject the literal NUL byte (U+0000) - a single one aborts
            // the whole INSERT/UPDATE. Text that is otherwise included can still
            // carry a stray NUL past the binary window. Strip before any chunking so
            // every chunk's content, its contentHash, and its embedding all agree -
            // mirrors the server-side strip in ProjectManager (kept as defense in
            // depth for content that reaches the server via an older scanner) but
            // doing it here means the daemon never even transmits the NUL bytes.
            if (content.includes('\0')) {
                content = content.replace(/\0/g, '');
            }
            const language = this.detectLanguage(filePath);
            // Try to extract functions/classes
            if (language === 'markdown') {
                const sections = this.chunkMarkdown(content, relativePath, stats.size);
                // Every section fell under minChunkSize (a short CLAUDE.md or
                // .cursorrules). The file was read and parsed; it chunks to nothing.
                if (sections.length === 0)
                    chunkless?.push(relativePath);
                return sections;
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
        // Cursor rule files are Markdown whatever their spelling, so they chunk
        // at headings like every other instruction file.
        if (isCursorRulePath(filePath))
            return 'markdown';
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
        const walk = async (dir, depth, stack = []) => {
            if (this.isProtected(dir))
                return;
            let entries;
            try {
                if (depth === 0 && !(await enterDirectory(walkState, dir)))
                    return;
                if (!(await this.confineSymlink(dir, projectRoot)))
                    throw new Error('scanner_containment');
                entries = await fileOp(() => readdir(dir, { withFileTypes: true }), `readdir: ${dir}`);
            }
            catch (error) {
                markUnreadable(walkState, dir, error);
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
                    stats = await fileOp(() => lstat(full), `lstat: ${full}`);
                }
                catch (error) {
                    markUnreadable(walkState, full, error);
                    continue;
                }
                if (this.skipSymlink(stats))
                    continue;
                const isDir = stats.isDirectory(), isFile = stats.isFile();
                if (this.ignoredByStack(rel, isDir, localStack))
                    continue; // .gitignore/.mnemonikignore
                if (isDir) {
                    if (await this.isBoundary(full, projectRoot))
                        continue; // a subproject or worktree
                    const leave = await enterDirectory(walkState, full);
                    if (!leave)
                        continue;
                    try {
                        await walk(full, depth + 1, localStack);
                    }
                    finally {
                        leave();
                    }
                }
                else if (isFile && AUTHORITY_FILE_MATCHERS.some((m) => m(rel))) {
                    let file;
                    try {
                        if (stats.size > MAX_SCANNED_FILE_BYTES)
                            continue;
                        let content = await fileOp(() => this.readConfined(full, projectRoot, stats), `readFile: ${full}`);
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
                    catch (error) {
                        /* unreadable - skip */
                        markUnreadable(walkState, full, error);
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
        return {
            files: out,
            complete: walkState.complete,
            unreadable: walkState.unreadable ?? 0,
            unreadableSamples: walkState.unreadableSamples ?? [],
        };
    }
}
//# sourceMappingURL=codeScanner.js.map