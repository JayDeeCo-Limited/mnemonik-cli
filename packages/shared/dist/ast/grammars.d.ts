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
import { Language, Query } from 'web-tree-sitter';
declare const AST_LANGUAGE_ID_LIST: readonly ['typescript', 'tsx', 'javascript', 'python', 'go', 'java', 'c', 'cpp', 'csharp', 'ruby', 'php', 'rust', 'scala', 'elixir', 'solidity', 'bash', 'groovy', 'powershell'];
/** A language this build can AST-parse. Exactly the vendored set, no aspirations. */
export type AstLanguageId = (typeof AST_LANGUAGE_ID_LIST)[number];
/** The vendored set as a runtime value, for capability reporting and tests. */
export declare const AST_LANGUAGE_IDS: readonly AstLanguageId[];
/** Vendored artifact basename for an id: `csharp` -> `c-sharp`, else identity. */
export declare function grammarArtifactBasename(id: AstLanguageId): string;
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
export declare const QUERY_CHAIN: Readonly<Record<AstLanguageId, readonly AstLanguageId[]>>;
/** A loaded grammar plus its compiled query. Compiled once, reused per file. */
export interface GrammarBinding {
    id: AstLanguageId;
    language: Language;
    query: Query;
}
/** Why a grammar is not usable, always with a human-readable detail. */
export type GrammarUnavailableReason = 'not_covered' | 'wasm_missing' | 'wasm_load_failed' | 'tags_query_missing' | 'query_compile_failed';
export type GrammarLoad = {
    ok: GrammarBinding;
} | {
    unavailable: GrammarUnavailableReason;
    detail: string;
};
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
export declare const VENDORED_ARTIFACT_DIR: string;
/**
 * Which grammar, if any, should parse a file with this extension and language.
 *
 * `null` means "chunk it heuristically" and is a legitimate answer for most of
 * the allowlist. Callers pass the language string `languageForExtension`
 * produced; the extension only decides cases where the language string is
 * ambiguous (`.ts` vs `.tsx`).
 */
export declare function resolveAstLanguage(extension: string, language: string): AstLanguageId | null;
/**
 * Load (or return the cached) grammar binding for `id`. Never throws.
 *
 * `artifactDir` defaults to the vendored directory and every production caller
 * omits it. It exists so a degraded install can be exercised against a COPY of
 * the artifacts (see `VENDORED_ARTIFACT_DIR`); the cache is keyed by directory,
 * so a broken copy cannot poison the real grammar's cache entry.
 */
export declare function loadGrammar(id: AstLanguageId, artifactDir?: string): Promise<GrammarLoad>;
/**
 * Which grammars this process has instantiated - what is resident in wasm
 * memory right now, not what is vendored or what was asked for.
 *
 * Exists because the cost is permanent and therefore worth being able to state:
 * `astArtifactReport` reports it, and a test asserts the scanner's startup line
 * leaves it empty.
 */
export declare function loadedGrammarIds(artifactDir?: string): AstLanguageId[];
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
export declare function astArtifactReport(artifactDir?: string): {
    vendored: AstLanguageId[];
    loaded: AstLanguageId[];
    missing: Array<{
        id: AstLanguageId;
        reason: 'wasm_missing' | 'tags_query_missing';
        detail: string;
    }>;
};
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
export declare function astCapabilityReport(artifactDir?: string): Promise<{
    available: AstLanguageId[];
    unavailable: Array<{
        id: AstLanguageId;
        reason: GrammarUnavailableReason;
        detail: string;
    }>;
}>;
export {};
//# sourceMappingURL=grammars.d.ts.map