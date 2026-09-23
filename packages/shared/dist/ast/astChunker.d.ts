/**
 * The AST chunker: source text in, named line-ranges out. No filesystem, no
 * logging of file contents, one pure entry point (`chunkWithAst`).
 *
 * WHY THIS EXISTS. The heuristic chunker matches a regex whose name pattern
 * requires a leading `function`/`class`/`const` keyword - a keyword a method's
 * first line never has. So it produces method-shaped chunks with no
 * `symbolName`: 1,512 methods in this repo, unnameable and therefore unusable
 * as citation anchors. Measured over the same 1,037 TypeScript files, the
 * heuristic named 16.9% of its 16,604 chunks; the tag queries name 100% of
 * 6,471 definitions.
 *
 * THE NESTING RULE. Emitting both a whole class and each of its methods would
 * duplicate every method body and double the embedding bill, so:
 *
 * - a STRUCTURAL definition - one whose body is a container of other definitions
 *   (class, interface, enum, struct, trait, object, module, namespace) - emits a
 *   HEADER chunk from its own first line to the line before its first nested
 *   definition: the declaration plus the fields that precede the first method.
 *   Real contiguous source, never an elision;
 * - every other definition is a LEAF and becomes one chunk over its FULL line
 *   range, whatever it happens to contain. A local arrow function is part of
 *   what the enclosing function IS, not a sibling of it, so definitions nested
 *   inside a leaf are not emitted separately - the leaf's chunk already carries
 *   their source verbatim. See `STRUCTURAL_KINDS` for why that distinction is
 *   load-bearing rather than cosmetic;
 * - every remaining uncovered line span becomes a `raw` chunk.
 *
 * Coverage is therefore total: every non-blank line of a file belongs to some
 * chunk, replacing the ~50% coverage of the old heuristic and giving citation
 * anchoring a line -> chunk map with no holes.
 *
 * A NEWLINE IS A TERMINATOR, NOT A LINE. `'...}\n'.split('\n')` yields a phantom
 * trailing `''` that is not a line of the file. It is dropped before any length
 * arithmetic, because `memory_file_index.end_line` feeds citation anchoring and
 * the golden eval's containment scoring, and a one-line drift misaligns both
 * silently.
 *
 * CHUNKS ARE LINE-GRANULAR, NOT BYTE-GRANULAR. A chunk's content is always
 * `lines.slice(startLine - 1, endLine).join('\n')`. That is deliberate: the tag
 * queries capture `class_declaration`, which starts at `class` and excludes the
 * `export ` in front of it, and a citation anchor that omitted `export` would
 * not match what a reader sees. Line granularity also keeps content verbatim
 * and contiguous by construction.
 *
 * SYMBOL NAMES ARE BARE. `verifyForFile`, not `CitationManager.verifyForFile`.
 * `memory_file_index.symbol_name` is one column with a partial index on
 * `(project_id, symbol_name)` and citations reference bare names; storing
 * qualified names would break lookup. The enclosing type rides beside the
 * name as `symbolContainer` so two same-named methods are distinguishable
 * on a hit without changing how `symbol:` looks them up.
 *
 * WASM MEMORY IS NOT GC'd BY THE JS HEAP. Every `Tree` and `TreeCursor` created
 * here is explicitly deleted in a `finally`. Skipping that leaks across a
 * whole-repo walk in a long-lived daemon (the scanner is one).
 */
import { type AstLanguageId } from './grammars.js';
export interface AstChunk {
    /** Verbatim contiguous source: exactly the lines `startLine..endLine`. */
    content: string;
    /** 1-based, inclusive. */
    startLine: number;
    /** 1-based, inclusive. */
    endLine: number;
    /** The existing wire enum. The finer classification lives in `symbolKind`. */
    chunkType: 'function' | 'class' | 'module' | 'raw';
    /**
     * Bare symbol name, never qualified. Present on every chunk that came from a
     * `definition.*` capture - INCLUDING the value-shaped kinds that map to
     * `chunkType: 'raw'` (`variable`, `constant`, `field`, `property`), because the
     * wire enum has no value-shaped member but the identity is real and
     * `memory_file_index.symbol_name` indexes it either way. Absent only on the
     * uncovered-span chunks, which have no capture behind them - those are exactly
     * the chunks with no `symbolKind` either.
     */
    symbolName?: string;
    /** The tag capture verbatim: 'function' | 'class' | 'method' | 'module' | ... */
    symbolKind?: string;
    /** The definition's first line, trimmed, capped at 500 chars. */
    signature?: string;
    /**
     * Name of the immediate STRUCTURAL parent - whatever `STRUCTURAL_KINDS` admits
     * for the language. Absent at module scope, and absent inside a leaf (nothing
     * inside a leaf is emitted at all).
     *
     * In TS/JS that is `class`, `interface` and a module-scope `const`; NOT `enum`
     * and NOT `namespace`, despite both being structural kinds. Enum members are
     * never captured as definitions, and `namespace Outer {}` parses as
     * `internal_module`, which typescript.tags.scm does not match - `Outer`
     * produces no definition, so it can never be anybody's container. Do not widen
     * this list from `STRUCTURAL_KINDS` alone; a kind is only reachable here if
     * some tag query also captures a definition INSIDE it.
     *
     * Never written into `symbol_name`: lookup stays on the bare name.
     */
    symbolContainer?: string;
}
export type AstChunkResult = {
    chunks: AstChunk[];
    errorNodes: number;
    parseMs: number;
    /**
     * Definitions that reached no chunk. Two chunks over one line range would
     * collide on `filePath:startLine-endLine`, the staleness key ProjectManager
     * compares, so a second definition sharing a range - `function a() {}
     * function b() {}` on one line - cannot be emitted, and neither can a
     * container whose first nested definition opens on the container's own
     * first line (`class A { m() {} }`). Two captures can also COLLAPSE onto one
     * range while widening: `int f(int), g(int);` binds two declarators to one
     * declaration (see `CollectedDefinitions.collapsedDefinitions`). All three
     * are counted here. The name is then absent from
     * `memory_file_index` and a citation to it resolves as
     * `unresolved_symbol`; counting it is what stops that being invisible.
     */
    droppedDefinitions: number;
} | {
    unsupported: 'grammar_unavailable' | 'parse_failed' | 'file_too_large';
    detail: string;
};
/**
 * Parse ceiling, derived from Task 4's measurement rather than guessed: the
 * largest source file in this repo is 415 KB (`src/agent/ContextAgent.ts`) and
 * the slowest per-file parse across 1,061 files was 108.6 ms. 2 MiB is ~5x that
 * largest real file, which bounds the worst case near half a second - while
 * still refusing the multi-megabyte generated blobs that `MAX_SCANNED_FILE_BYTES`
 * (10 MB) otherwise lets through. Above the ceiling the caller degrades to the
 * heuristic chunker, which is line-bounded and cheap.
 */
export declare const MAX_AST_PARSE_BYTES: number;
/** The wire bound on `metadata.signature` (`scanChunkSchema`); both chunkers cap at it. */
export declare const MAX_SIGNATURE_CHARS = 500;
/**
 * Chunk `content` by syntax for a language with a vendored grammar.
 *
 * Async only because `loadGrammar` is; the grammar is cached per process, so
 * after the first file of a given language there is no per-file async cost.
 * Never throws - every failure is a named `unsupported` reason with a detail the
 * caller can log before degrading.
 */
export declare function chunkWithAst(content: string, languageId: AstLanguageId, opts?: {
    maxParseBytes?: number;
}): Promise<AstChunkResult>;
//# sourceMappingURL=astChunker.d.ts.map