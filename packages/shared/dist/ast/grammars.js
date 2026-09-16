/**
 * The grammar registry: one module owns the question "can we AST-parse this
 * language on this machine, and if not, why not".
 *
 * Every failure mode is a named value (`wasm_missing`, `wasm_load_failed`,
 * `tags_query_missing`, `query_compile_failed`, `not_covered`) rather than a
 * null or a throw, because the consequence of a degraded install is not a crash
 * - it is quietly worse chunks, forever, with nothing in the logs. A caller that
 * gets `unavailable` can fall back to the heuristic chunker AND say why.
 *
 * Artifacts are vendored, not installed: `packages/shared/wasm/<id>.wasm` plus
 * the `<id>.tags.scm` tag queries, committed and published inside
 * `@mnemonik/shared` (see `scripts/vendor-grammars.ts` for how they get there
 * and why `npm pack` rather than devDependencies). A user's install therefore
 * pulls no grammar package, runs no postinstall, needs no compiler and fetches
 * nothing at runtime.
 *
 * Two reports answer "what can this install do" and they are NOT
 * interchangeable. `astArtifactReport` stats the vendored files and costs
 * nothing; `astCapabilityReport` instantiates all 18 grammars, which costs ~690
 * ms and ~75 MB of RSS that is never returned because web-tree-sitter exposes no
 * `Language.delete`. Startup and per-file paths use the first; the second is for
 * a diagnostic a human asked for. Grammars themselves load lazily, one per
 * language, on the first file that needs one.
 *
 * Paths resolve relative to THIS MODULE, never the CWD: the scanner daemon runs
 * from whatever directory the user happens to be in, so a CWD-relative path is
 * the kind of bug that passes every test and fails in the field. `src/ast/` and
 * `dist/ast/` sit at the same depth below the package root, so one relative
 * expression is correct for both the TS sources and the shipped build.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Language, Parser, Query } from 'web-tree-sitter';
import { warn } from '../logger.js';
const AST_LANGUAGE_ID_LIST = [
    'typescript',
    'tsx',
    'javascript',
    'python',
    'go',
    'java',
    'c',
    'cpp',
    'csharp',
    'ruby',
    'php',
    'rust',
    'scala',
    'elixir',
    'solidity',
    'bash',
    'groovy',
    'powershell',
];
/** The vendored set as a runtime value, for capability reporting and tests. */
export const AST_LANGUAGE_IDS = AST_LANGUAGE_ID_LIST;
/**
 * Ids whose vendored artifact basename differs from the id.
 *
 * `tree-sitter-c-sharp` names its file with a hyphen while every consumer of
 * this registry - `languageForExtension`, chunk metadata, the wire - spells the
 * language `csharp`. Mapping the two explicitly is cheaper than renaming a
 * vendored artifact: the vendoring script, the committed files and the
 * `--check` verifier all agree on `c-sharp`, and a rename would make this
 * module the odd one out for no gain.
 */
const ARTIFACT_BASENAME = {
    csharp: 'c-sharp',
};
/** Vendored artifact basename for an id: `csharp` -> `c-sharp`, else identity. */
export function grammarArtifactBasename(id) {
    return ARTIFACT_BASENAME[id] ?? id;
}
/**
 * Ordered tag-query files composing each grammar's EFFECTIVE query. THE source
 * of truth - `scripts/vendor-grammars.ts` imports this rather than keeping its
 * own copy, because two chains that can drift is precisely the defect this
 * layer exists to remove.
 *
 * Tag queries are DELTAS, not complete definitions. tree-sitter-typescript's
 * query holds only the TypeScript-specific patterns (`function_signature`,
 * `interface_declaration`, `abstract_class_declaration`);
 * `function_declaration`, `class_declaration`, `method_definition` and arrow
 * functions all live in javascript's query and are meant to be inherited.
 * Nothing in the query engine resolves that - composing the chain is the
 * consumer's job.
 *
 * Measured cost of not composing it: 948 definitions across 1,037 TypeScript
 * files in this repo, against 6,471 once javascript's query was prepended.
 * `cpp` inherits `c` for the same reason.
 *
 * Listed explicitly rather than inferred, and typed as a complete record, so
 * adding a language without deciding its chain is a compile error instead of a
 * query that compiles and quietly under-matches.
 */
export const QUERY_CHAIN = {
    typescript: ['javascript', 'typescript'],
    tsx: ['javascript', 'typescript'],
    javascript: ['javascript'],
    python: ['python'],
    go: ['go'],
    java: ['java'],
    c: ['c'],
    cpp: ['c', 'cpp'],
    csharp: ['csharp'],
    ruby: ['ruby'],
    php: ['php'],
    rust: ['rust'],
    scala: ['scala'],
    elixir: ['elixir'],
    solidity: ['solidity'],
    bash: ['bash'],
    groovy: ['groovy'],
    powershell: ['powershell'],
};
/**
 * Extensions whose grammar the language string alone gets WRONG.
 *
 * `.ts` and `.tsx` both report language `typescript` and need different
 * grammars out of the same npm package - a `.tsx` file parsed by the typescript
 * grammar errors on the first JSX element. This is the entire reason
 * `resolveAstLanguage` takes an extension at all.
 */
const EXTENSION_GRAMMARS = {
    '.tsx': 'tsx',
};
/**
 * Scanner language string -> grammar. Keyed on what `languageForExtension`
 * actually returns, so this table and the extension table cannot disagree about
 * what a `.zsh` file is.
 *
 * Absences are deliberate answers, not gaps. `markdown` is missing because
 * headers already are a document's semantic unit and 10,483 production chunks
 * depend on `chunkMarkdown` keeping them; `kotlin`, `swift`, `dart` and friends
 * are missing because no loadable grammar is vendored yet. Both resolve to
 * `null` and the heuristic chunker takes over.
 */
const LANGUAGE_GRAMMARS = {
    typescript: 'typescript',
    javascript: 'javascript',
    python: 'python',
    go: 'go',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    csharp: 'csharp',
    ruby: 'ruby',
    php: 'php',
    rust: 'rust',
    scala: 'scala',
    elixir: 'elixir',
    solidity: 'solidity',
    shell: 'bash',
    groovy: 'groovy',
    powershell: 'powershell',
};
const WASM_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'wasm');
/**
 * The vendored artifact directory, resolved from THIS module.
 *
 * Exported because a test of a DEGRADED install has to break artifacts, and
 * breaking the tracked ones is not an option: the unit project runs test files
 * in parallel forks, so renaming `ruby.wasm` aside is visible to every other
 * file for as long as it lasts, and any file that cold-loads Ruby inside that
 * window caches a `wasm_missing` this checkout does not have. Copy from here
 * into a temp directory and break the copy - `loadGrammar` takes the directory.
 */
export const VENDORED_ARTIFACT_DIR = WASM_DIR;
/**
 * Which grammar, if any, should parse a file with this extension and language.
 *
 * `null` means "chunk it heuristically" and is a legitimate answer for most of
 * the allowlist. Callers pass the language string `languageForExtension`
 * produced; the extension only decides cases where the language string is
 * ambiguous (`.ts` vs `.tsx`).
 */
export function resolveAstLanguage(extension, language) {
    const byExtension = EXTENSION_GRAMMARS[normalizeExtension(extension)];
    if (byExtension)
        return byExtension;
    return LANGUAGE_GRAMMARS[language.trim().toLowerCase()] ?? null;
}
/**
 * Accepts `.TSX`, `tsx`, or a whole path, and answers the lowercase dotted
 * extension. Mirrors `languageForExtension`'s ordering - `extname` first, so a
 * dotfile carrying a real extension ('.eslintrc.js') is not swallowed whole.
 */
function normalizeExtension(raw) {
    const lower = raw.trim().toLowerCase();
    if (!lower)
        return '';
    const fromPath = extname(lower);
    if (fromPath)
        return fromPath;
    return lower.startsWith('.') ? lower : `.${lower}`;
}
let parserInit = null;
/**
 * `Parser.init()` exactly once per process. web-tree-sitter instantiates its
 * WebAssembly runtime here; calling it per file would dominate the scan.
 */
function initParser() {
    parserInit ??= Parser.init();
    return parserInit;
}
/**
 * Successes AND failures, keyed by artifact directory + id. Caching the failures
 * is the point: a checkout missing one `.wasm` must not stat-and-fail once per
 * file for the whole repo walk, and must not log the same warning 30,000 times.
 *
 * The cached value is the in-flight promise, so two concurrent callers share
 * one `Language.load` rather than instantiating the grammar twice.
 */
const loads = new Map();
/**
 * Ids whose `Language` has actually been instantiated, same keying as `loads`.
 *
 * This is a permanent record rather than a cache index because entries cannot be removed:
 * a loaded Language cannot be freed (see `attemptLoad`), so this set IS the
 * permanent wasm memory this process is holding. `loadedGrammarIds` reads it,
 * and the startup path is asserted against it.
 */
const instantiated = new Set();
// NUL separator, escaped rather than literal: the directory half is an
// arbitrary path, so the separator has to be a byte a path cannot contain.
const cacheKey = (artifactDir, id) => `${artifactDir}\0${id}`;
/**
 * Load (or return the cached) grammar binding for `id`. Never throws.
 *
 * `artifactDir` defaults to the vendored directory and every production caller
 * omits it. It exists so a degraded install can be exercised against a COPY of
 * the artifacts (see `VENDORED_ARTIFACT_DIR`); the cache is keyed by directory,
 * so a broken copy cannot poison the real grammar's cache entry.
 */
export function loadGrammar(id, artifactDir = WASM_DIR) {
    const key = cacheKey(artifactDir, id);
    const cached = loads.get(key);
    if (cached)
        return cached;
    const pending = loadUncached(id, artifactDir);
    loads.set(key, pending);
    return pending;
}
/**
 * Which grammars this process has instantiated - what is resident in wasm
 * memory right now, not what is vendored or what was asked for.
 *
 * Exists because the cost is permanent and therefore worth being able to state:
 * `astArtifactReport` reports it, and a test asserts the scanner's startup line
 * leaves it empty.
 */
export function loadedGrammarIds(artifactDir = WASM_DIR) {
    return AST_LANGUAGE_IDS.filter((id) => instantiated.has(cacheKey(artifactDir, id)));
}
async function loadUncached(id, artifactDir) {
    const result = await attemptLoad(id, artifactDir);
    if ('unavailable' in result) {
        // Logged once per id thanks to the cache above. A degradation nobody can
        // see in the logs is indistinguishable from working software.
        warn('ast grammar unavailable', { id, reason: result.unavailable, detail: result.detail });
    }
    return result;
}
function resolveArtifacts(id, artifactDir) {
    const wasmPath = join(artifactDir, `${grammarArtifactBasename(id)}.wasm`);
    if (!isNonEmptyFile(wasmPath)) {
        return { unavailable: 'wasm_missing', detail: `missing or empty grammar artifact ${wasmPath}` };
    }
    // Composed BEFORE the grammar loads: reading three small files is cheaper
    // than instantiating a megabyte of WebAssembly only to discard it.
    let source = '';
    for (const part of QUERY_CHAIN[id]) {
        const tagsPath = join(artifactDir, `${grammarArtifactBasename(part)}.tags.scm`);
        if (!isNonEmptyFile(tagsPath)) {
            return {
                unavailable: 'tags_query_missing',
                detail: `${id} needs the query chain [${QUERY_CHAIN[id].join(', ')}] but ${tagsPath} is missing or empty`,
            };
        }
        try {
            source += `${readFileSync(tagsPath, 'utf8')}\n`;
        }
        catch (err) {
            return {
                unavailable: 'tags_query_missing',
                detail: `${id}: could not read ${tagsPath}: ${describe(err)}`,
            };
        }
    }
    return { wasmPath, source };
}
async function attemptLoad(id, artifactDir) {
    if (!AST_LANGUAGE_IDS.includes(id)) {
        return {
            unavailable: 'not_covered',
            detail: `${String(id)} is not a vendored grammar; expected one of ${AST_LANGUAGE_IDS.join(', ')}`,
        };
    }
    const artifacts = resolveArtifacts(id, artifactDir);
    if ('unavailable' in artifacts)
        return artifacts;
    const { wasmPath, source } = artifacts;
    let language;
    try {
        await initParser();
        language = await Language.load(wasmPath);
    }
    catch (err) {
        // Presence is not loadability: tree-sitter-dart ships a 741 KB .wasm that
        // Language.load rejects because the artifact predates the current wasm ABI.
        return {
            unavailable: 'wasm_load_failed',
            detail: `${wasmPath} exists but web-tree-sitter rejected it (ABI mismatch?): ${describe(err)}`,
        };
    }
    instantiated.add(cacheKey(artifactDir, id));
    // A loaded Language cannot be freed: web-tree-sitter 0.26.11 exposes
    // `delete()` on Tree and Query but NOT on Language. The failure results below
    // are cached, so a grammar whose query is broken leaks its Language exactly
    // once per process rather than once per file - which is why the cache matters
    // for more than latency. Trees are a different story and must be deleted per
    // file by the chunker; the JS heap does not GC wasm memory.
    let query;
    try {
        query = new Query(language, source);
    }
    catch (err) {
        return {
            unavailable: 'query_compile_failed',
            detail: `${id} tag query [${QUERY_CHAIN[id].join(', ')}] failed to compile: ${describe(err)}`,
        };
    }
    if (!query.captureNames.some((name) => name.startsWith('definition.'))) {
        // Compiles, matches, names nothing: the chunker would emit only raw chunks
        // and look like it was working. Unavailable is the honest answer.
        query.delete();
        return {
            unavailable: 'query_compile_failed',
            detail: `${id} tag query [${QUERY_CHAIN[id].join(', ')}] compiled but captures no definition.* - it would name nothing`,
        };
    }
    return { ok: { id, language, query } };
}
const isNonEmptyFile = (path) => existsSync(path) && statSync(path).size > 0;
const describe = (err) => err instanceof Error ? err.message.slice(0, 200) || err.constructor.name : String(err);
/**
 * What this install has VENDORED, answered without instantiating anything.
 *
 * Every check is a `statSync` plus a few hundred bytes of `.scm`: the grammar's
 * `.wasm` is present and non-empty, and so is every tag-query file in its chain.
 * Microseconds, and zero permanent memory - which is what makes it the right
 * answer for a startup line (see `logAstCapabilityOnce`).
 *
 * It shares `resolveArtifacts` with the real loader, so it cannot report a
 * grammar as vendored that `loadGrammar` would reject for a missing artifact.
 * What it deliberately cannot see is the two failure modes that require the
 * grammar in memory - `wasm_load_failed` and `query_compile_failed`. Those are
 * reported by `astCapabilityReport` when a human asks, and warned once per
 * language by the scan path on the first file that needs them
 * (`grammar_unavailable` in codeScanner); paying ~75 MB up front to pre-answer
 * the question for 18 languages a repo probably does not contain is the wrong
 * trade.
 *
 * `loaded` is what is resident so far, which for a fresh process is nothing:
 * grammars load lazily, per language, on the first file that needs one.
 */
export function astArtifactReport(artifactDir = WASM_DIR) {
    const vendored = [];
    const missing = [];
    for (const id of AST_LANGUAGE_IDS) {
        const artifacts = resolveArtifacts(id, artifactDir);
        if ('unavailable' in artifacts) {
            missing.push({ id, reason: artifacts.unavailable, detail: artifacts.detail });
        }
        else {
            vendored.push(id);
        }
    }
    return { vendored, loaded: loadedGrammarIds(artifactDir), missing };
}
/**
 * What this install can actually AST-PARSE, and why not for the rest. Loads
 * every vendored grammar and compiles every query, so it catches the two things
 * `astArtifactReport` cannot: an artifact that exists and does not load, and a
 * query that does not compile or names no definitions.
 *
 * NOT free, and the cost is memory rather than only latency: measured on this
 * checkout, ~690 ms and ~75 MB of RSS that is never given back. web-tree-sitter
 * 0.26.11 exposes no `Language.delete` (see `attemptLoad`), so all 18 grammars
 * stay resident for the life of the process - including the fifteen a given repo
 * has no files for. Caching makes the second call free; it does not make the
 * first one cheap.
 *
 * So: fine for a diagnostic a human asked for (`doctor`, a `--check` script,
 * this suite). Wrong for a daemon's startup line - that is `astArtifactReport`.
 */
export async function astCapabilityReport(artifactDir = WASM_DIR) {
    const available = [];
    const unavailable = [];
    for (const id of AST_LANGUAGE_IDS) {
        const loaded = await loadGrammar(id, artifactDir);
        if ('ok' in loaded)
            available.push(id);
        else
            unavailable.push({ id, reason: loaded.unavailable, detail: loaded.detail });
    }
    return { available, unavailable };
}
//# sourceMappingURL=grammars.js.map