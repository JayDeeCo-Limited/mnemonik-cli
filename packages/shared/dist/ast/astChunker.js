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
import { Parser } from 'web-tree-sitter';
import { loadGrammar } from './grammars.js';
/**
 * Parse ceiling, derived from Task 4's measurement rather than guessed: the
 * largest source file in this repo is 415 KB (`src/agent/ContextAgent.ts`) and
 * the slowest per-file parse across 1,061 files was 108.6 ms. 2 MiB is ~5x that
 * largest real file, which bounds the worst case near half a second - while
 * still refusing the multi-megabyte generated blobs that `MAX_SCANNED_FILE_BYTES`
 * (10 MB) otherwise lets through. Above the ceiling the caller degrades to the
 * heuristic chunker, which is line-bounded and cheap.
 */
export const MAX_AST_PARSE_BYTES = 2 * 1024 * 1024;
/**
 * Line budget for a single `raw` span chunk, mirroring `ScanOptions.maxChunkSize`
 * (8000 chars, ~2000 tokens) so AST raw spans and heuristic raw chunks land in
 * the same size class.
 */
const MAX_RAW_SPAN_CHARS = 8000;
/** The wire bound on `metadata.signature` (`scanChunkSchema`); both chunkers cap at it. */
export const MAX_SIGNATURE_CHARS = 500;
/**
 * `definition.<kind>` -> the wire enum. `chunkType` is constrained to
 * `function|class|module|raw` by `CodeChunk` and by `scanChunkSchema`;
 * `symbolKind` is not, and keeps the capture name verbatim.
 *
 * Kinds absent here (`constant`, `field`, `property`, `variable`) fall to
 * `'raw'`: the enum has no value-shaped member, and claiming a constant is a
 * `class` or a `module` would be false where `'raw'` only says "no coarse class
 * for this" - the identity is still carried by `symbolName` + `symbolKind`.
 */
const CHUNK_TYPE_BY_KIND = {
    function: 'function',
    method: 'function',
    macro: 'function',
    class: 'class',
    interface: 'class',
    enum: 'class',
    object: 'class',
    struct: 'class',
    trait: 'class',
    type: 'class',
    module: 'module',
    namespace: 'module',
};
/**
 * Kinds whose BODY IS A CONTAINER of other definitions. Only these split into a
 * header chunk; every other kind is a LEAF and gets its full line range.
 *
 * The distinction is load-bearing, not cosmetic. When every `definition.*`
 * capture counted as a nested child, a function declaring one local arrow
 * function collapsed to its first two lines: `ContextAgent.registerDocsTools`
 * spans 513 lines and was recorded as 2. A wrong extent is worse than no extent -
 * it anchors citations confidently at the wrong place instead of failing to
 * anchor them.
 *
 * A closure, a variable, a field and a property are VALUE-SHAPED: they are part
 * of what the enclosing definition IS. So is a nested helper function.
 * Definitions inside a leaf are therefore not emitted at all; the leaf's own
 * chunk carries their source verbatim, and emitting both would duplicate it and
 * double the embedding bill.
 *
 * `constant` IS IN, and only because the tag queries anchor it to module scope.
 * A module `const` is the ordinary home of a handler map or an evaluator table -
 * `export const EVALUATORS = { foo() {...}, bar: () => {...} }` - whose members
 * are separately named definitions a reader looks up by name. As a leaf it
 * suppressed all of them: 49 named symbols vanished from `src/` alone, with
 * `droppedDefinitions` at 0, which is the silent-loss class that counter exists
 * to prevent. A function-valued `const` is NOT affected: it binds
 * `definition.function` on the same range and KIND_SPECIFICITY keeps that kind,
 * so a closure and its local helpers stay one chunk. A `const` with no nested
 * definition never splits either - `headerEndRow` is only set when a child
 * exists - so the scalar case is byte-identical to the leaf behaviour.
 *
 * `type` stays out deliberately. C's `(type_definition declarator:
 * (type_identifier) @name) @definition.type` matches `typedef struct {...} Foo;`,
 * whose nested `struct_specifier` opens on the typedef's own first line - as a
 * container it would split to an empty header and be dropped entirely, so the
 * typedef is the leaf and keeps the whole range.
 */
const STRUCTURAL_KINDS = new Set([
    'class',
    'interface',
    'enum',
    'struct',
    'trait',
    'object',
    'module',
    'namespace',
    'constant',
]);
/**
 * One `Parser` per language for the life of the process. Constructing a parser
 * per file allocates and frees a wasm parser object 30,000 times on a repo walk
 * for no benefit; the parse itself is synchronous and stateless once the
 * language is set.
 */
const parsers = new Map();
function parserFor(binding) {
    const cached = parsers.get(binding.id);
    if (cached)
        return cached;
    // `Parser.init()` has already run: `loadGrammar` awaits it before
    // `Language.load`, and we only get a binding after that succeeded.
    const parser = new Parser();
    parser.setLanguage(binding.language);
    parsers.set(binding.id, parser);
    return parser;
}
/**
 * Chunk `content` by syntax for a language with a vendored grammar.
 *
 * Async only because `loadGrammar` is; the grammar is cached per process, so
 * after the first file of a given language there is no per-file async cost.
 * Never throws - every failure is a named `unsupported` reason with a detail the
 * caller can log before degrading.
 */
export async function chunkWithAst(content, languageId, opts) {
    // Size first: refusing a 6 MB generated file must not first instantiate a
    // 5 MB grammar we then throw away.
    const ceiling = opts?.maxParseBytes ?? MAX_AST_PARSE_BYTES;
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > ceiling) {
        return {
            unsupported: 'file_too_large',
            detail: `${bytes} bytes exceeds the AST parse ceiling of ${ceiling} bytes`,
        };
    }
    const loaded = await loadGrammar(languageId);
    if ('unavailable' in loaded) {
        return {
            unsupported: 'grammar_unavailable',
            detail: `${String(languageId)}: ${loaded.unavailable}: ${loaded.detail}`,
        };
    }
    const startedAt = performance.now();
    let tree;
    try {
        tree = parserFor(loaded.ok).parse(content);
    }
    catch (err) {
        return {
            unsupported: 'parse_failed',
            detail: `${languageId}: web-tree-sitter threw while parsing ${bytes} bytes: ${describe(err)}`,
        };
    }
    if (!tree) {
        // Documented return value of `Parser.parse`, not a theoretical branch: it
        // is null when the parse is cancelled or the language is unset.
        return {
            unsupported: 'parse_failed',
            detail: `${languageId}: web-tree-sitter returned no tree for ${bytes} bytes`,
        };
    }
    const parseMs = performance.now() - startedAt;
    try {
        const lines = content.split('\n');
        // A trailing newline TERMINATES the last line, it does not open a new one,
        // but `split` yields a phantom '' for it. Dropping it here - before
        // `lines.length` is read by the coverage array, `uncoveredSpans` or
        // `sliceLines` - is what keeps `endLine` equal to the file's last line
        // number. Left in, the final raw chunk of every newline-terminated file (109
        // of this repo's 268 `src/` TypeScript files) ran one line past the end, and
        // `memory_file_index.end_line` feeds citation anchoring and the golden eval's
        // containment scoring.
        if (content.endsWith('\n'))
            lines.pop();
        const collected = collectDefinitions(loaded.ok.query, tree.rootNode);
        const built = buildChunks(collected.definitions, lines);
        return {
            chunks: built.chunks,
            errorNodes: countErrorNodes(tree),
            parseMs,
            // A definition can be lost at either stage - collapsed onto another
            // definition's byte range here, or reaching no chunk in `buildChunks` - and
            // the caller logs one number, so both have to be in it.
            droppedDefinitions: built.droppedDefinitions + collected.collapsedDefinitions,
        };
    }
    finally {
        tree.delete();
    }
}
/**
 * When two tag patterns bind the same byte range (a function-valued `const`
 * matches both `definition.function` and `definition.constant`), keep the
 * more specific kind. Pattern order is not a contract `matches()` documents.
 *
 * ONLY THE WEAK KINDS ARE LISTED, and the default is the STRONG score. An
 * allow-list of strong kinds is the same shape as `CHUNK_TYPE_BY_KIND` and
 * `STRUCTURAL_KINDS`, and a fourth table keyed on `definition.<kind>` drifts
 * from the other three the moment a grammar is vendored: listing the strong
 * kinds once already omitted `struct`, `object`, `trait` and `macro`, which
 * scored 0 and LOST to `constant` - inverting the whole point of the table and
 * able to demote a structural kind to a leaf. Deny-listing the four value-shaped
 * kinds cannot fail that way: a kind nobody has thought of yet outranks a
 * `constant` instead of losing to it, which is the safe direction.
 */
const KIND_SPECIFICITY = {
    constant: 1,
    variable: 1,
    field: 1,
    property: 1,
    type: 2,
};
const DEFAULT_KIND_SPECIFICITY = 3;
/**
 * Every `definition.*` capture with its paired `@name`, outermost first.
 *
 * `matches()` rather than `captures()`: a match is one pattern's captures, so
 * the `@name` belonging to a definition is unambiguous. `captures()` returns a
 * flat stream in which pairing is guesswork - and the composed QUERY_CHAIN
 * concatenates several files' patterns, so guessing would mispair across
 * grammars.
 */
function collectDefinitions(query, root) {
    // Keyed by byte range: the composed chain can match one node from two
    // patterns (javascript's `class` and `class_declaration` alternates, for
    // instance), and two chunks over one range would collide on
    // `filePath:startLine-endLine`, the key ProjectManager uses for staleness.
    const byRange = new Map();
    let collapsedDefinitions = 0;
    for (const match of query.matches(root)) {
        let definition;
        let kind = '';
        let name;
        for (const capture of match.captures) {
            if (!definition && capture.name.startsWith('definition.')) {
                definition = capture.node;
                kind = capture.name.slice('definition.'.length);
            }
            else if (!name && capture.name === 'name') {
                name = capture.node;
            }
        }
        if (!definition)
            continue;
        const extent = widenToDefinition(definition);
        const key = `${extent.startIndex}:${extent.endIndex}`;
        // A `@name` from outside the definition's extent would be a query bug;
        // dropping it costs a name, keeping it would attach a wrong one.
        const named = name && name.startIndex >= extent.startIndex && name.endIndex <= extent.endIndex
            ? name.text
            : undefined;
        const existing = byRange.get(key);
        if (existing) {
            // Two names over one range means a real symbol is gone from
            // `memory_file_index`, and a citation to it will resolve as
            // `unresolved_symbol`; the same name twice means the same symbol twice.
            if (named !== undefined && existing.name !== undefined && existing.name !== named) {
                collapsedDefinitions++;
            }
            else {
                const incomingPri = KIND_SPECIFICITY[kind] ?? DEFAULT_KIND_SPECIFICITY;
                const existingPri = KIND_SPECIFICITY[existing.kind] ?? DEFAULT_KIND_SPECIFICITY;
                if (incomingPri > existingPri)
                    existing.kind = kind;
                if (named && !existing.name)
                    existing.name = named;
            }
            continue;
        }
        byRange.set(key, {
            startIndex: extent.startIndex,
            endIndex: extent.endIndex,
            startRow: extent.startPosition.row,
            endRow: extent.endPosition.row,
            kind,
            ...(named ? { name: named } : {}),
        });
    }
    // Start ascending, end descending: a parent therefore always precedes the
    // children it contains, which is what makes the single-pass stack below
    // correct.
    const definitions = [...byRange.values()].sort((a, b) => a.startIndex === b.startIndex ? b.endIndex - a.endIndex : a.startIndex - b.startIndex);
    return { definitions, collapsedDefinitions };
}
/**
 * Ascend from a `@definition.*` capture to the node that actually SPANS the
 * definition.
 *
 * Some tag queries bind the capture to a node that names the definition without
 * containing its body. `c.tags.scm` and `cpp.tags.scm` are the loud case:
 *
 *     (function_declarator declarator: (identifier) @name) @definition.function
 *
 * `function_declarator` ends at the closing paren of the parameter list, so
 * naming it alone reproduces - for two whole languages - the exact defect this
 * module exists to fix: a named signature line plus an anonymous raw chunk
 * holding the body.
 *
 * The rule is general rather than a C special case, and it takes TWO forms
 * because C and C++ nest declarators inside other declarators:
 *
 * 1. THE `declarator` FIELD. Ascend while the node is bound to its parent's
 *    `declarator` field. That field is the grammar's own statement of "this node
 *    is the declarator OF something larger", so the ascent lands on the node that
 *    owns the body (`function_definition`, `declaration`, `field_declaration`,
 *    through any `pointer_declarator` or `array_declarator` in between).
 * 2. A DECLARATOR WRAPPER. `int &f()` parses as
 *    `(function_definition declarator: (reference_declarator (function_declarator ...)))`
 *    and `int (*f(void))[4]` as `... (parenthesized_declarator (pointer_declarator ...))`.
 *    Neither `reference_declarator` nor `parenthesized_declarator` NAMES the
 *    declarator it wraps - the child sits in an unnamed field - so rule 1 alone
 *    stopped dead at `function_declarator` and reproduced the very defect above
 *    for `T &operator[]`, `std::string &name()`, and every other
 *    reference-returning accessor in real C++. So also ascend when the parent is
 *    itself a declarator that holds this declarator in an UNNAMED field.
 *
 * Both forms keep the property that made rule 1 safe: neither can reach an
 * unrelated ancestor. Rule 1 follows a field the grammar defines only within a
 * declaration; rule 2 requires BOTH ends to be declarator nodes, and a
 * `field_declaration_list` is not one - a method inside a class body therefore
 * still stops at its own `function_definition` and a class is never swallowed.
 * Grammars that already bind the whole definition (every JS/TS, Python, Go, Rust,
 * Ruby pattern) fail both conditions on the first iteration, which makes this a
 * no-op for them: TypeScript's `variable_declarator` sits unnamed in a
 * `lexical_declaration`, which is not a declarator, so rule 2 does not fire and
 * `const a = 1; const b = () => 2;` stays two statements.
 */
function widenToDefinition(node) {
    let current = node;
    for (;;) {
        const parent = current.parent;
        if (!parent)
            return current;
        // `childrenForFieldName`, not `childForFieldName`: `int a, f(int x);` binds
        // two declarators to one declaration, and the singular accessor answers only
        // the first - which would refuse to widen every declarator but one.
        const boundToDeclaratorField = parent
            .childrenForFieldName('declarator')
            .some((child) => child.id === current.id);
        if (!boundToDeclaratorField && !wrapsDeclarator(parent, current))
            return current;
        current = parent;
    }
}
/** A declarator node type, by the grammars' own naming convention. */
function isDeclarator(node) {
    return node.type.endsWith('_declarator');
}
/**
 * True when `parent` is a declarator that wraps `child` without naming the field
 * - `reference_declarator` (`&` / `&&`) and `parenthesized_declarator` (`( ... )`),
 * whose grammar rules are a bare token sequence around the inner declarator.
 *
 * Both ends must be declarators, and the field must be UNNAMED: a declarator's
 * named fields hold things that are NOT the wrapped declarator (`parameters`,
 * `size`, `value`), and ascending out of one of those would leave the
 * declaration the capture belongs to.
 */
function wrapsDeclarator(parent, child) {
    if (!isDeclarator(parent) || !isDeclarator(child))
        return false;
    return fieldNameForChild(parent, child) === null;
}
/**
 * The field name binding `child` to `parent`, or null when the child sits in an
 * unnamed field. `Node` exposes no direct accessor, so the index has to be found
 * first; declarator nodes have a handful of children, so the scan is trivial.
 */
function fieldNameForChild(parent, child) {
    for (let i = 0; i < parent.childCount; i++) {
        if (parent.child(i)?.id === child.id)
            return parent.fieldNameForChild(i);
    }
    return null;
}
function buildChunks(definitions, lines) {
    // `headerEndRow[i]` is the 0-based row of definition `i`'s first nested
    // definition - set only for STRUCTURAL definitions, since only they split.
    // `suppressed[i]` marks a definition that lies inside a leaf and is therefore
    // already carried, verbatim, by that leaf's own chunk.
    const headerEndRow = new Map();
    const suppressed = new Uint8Array(definitions.length);
    const containerName = new Array(definitions.length);
    const open = [];
    for (let i = 0; i < definitions.length; i++) {
        const current = definitions[i];
        if (!current)
            continue;
        while (open.length > 0) {
            const top = definitions[open[open.length - 1] ?? -1];
            if (top && top.endIndex > current.startIndex)
                break;
            open.pop();
        }
        const parentIndex = open[open.length - 1];
        const parent = parentIndex === undefined ? undefined : definitions[parentIndex];
        if (parentIndex !== undefined && parent) {
            if (suppressed[parentIndex] === 1 || !STRUCTURAL_KINDS.has(parent.kind)) {
                // Inside a leaf (or inside something already inside one). Suppression
                // propagates: a class declared inside a function belongs to that
                // function's chunk, and so do the class's own methods.
                suppressed[i] = 1;
            }
            else {
                if (parent.name)
                    containerName[i] = parent.name;
                if (!headerEndRow.has(parentIndex)) {
                    headerEndRow.set(parentIndex, current.startRow);
                }
            }
        }
        open.push(i);
    }
    const chunks = [];
    const emittedRanges = new Set();
    const covered = new Uint8Array(lines.length + 2);
    let droppedDefinitions = 0;
    /** True when the chunk was emitted; false when its range cannot carry one. */
    const emit = (chunk) => {
        if (chunk.endLine < chunk.startLine)
            return false;
        const key = `${chunk.startLine}:${chunk.endLine}`;
        if (emittedRanges.has(key))
            return false;
        if (chunk.content.trim() === '')
            return false;
        emittedRanges.add(key);
        chunks.push(chunk);
        for (let line = chunk.startLine; line <= chunk.endLine; line++)
            covered[line] = 1;
        return true;
    };
    for (let i = 0; i < definitions.length; i++) {
        const definition = definitions[i];
        if (!definition || suppressed[i] === 1)
            continue;
        // THE ONE 0-based -> 1-based conversion. `Point.row` is 0-based; startLine
        // and endLine are 1-based inclusive. A structural definition's first child
        // starts on `headerEnd + 1`, so its header ends on the line before that:
        // `headerEnd`. When the child opens on the container's own first line
        // (`class A { m() {} }`) that range is empty, `emit` refuses it and the
        // refusal is counted - emitting the line anyway would duplicate the child's
        // source. Clamped to the last real line so a definition whose node runs to
        // end-of-file cannot name a line that does not exist.
        const headerEnd = headerEndRow.get(i);
        const startLine = definition.startRow + 1;
        const endLine = Math.min(headerEnd ?? definition.endRow + 1, lines.length);
        const content = sliceLines(lines, startLine, endLine);
        const signature = (content.split('\n')[0] ?? '').trim().slice(0, MAX_SIGNATURE_CHARS);
        const emitted = emit({
            content,
            startLine,
            endLine,
            chunkType: CHUNK_TYPE_BY_KIND[definition.kind] ?? 'raw',
            ...(definition.name ? { symbolName: definition.name } : {}),
            symbolKind: definition.kind,
            ...(signature ? { signature } : {}),
            ...(containerName[i] ? { symbolContainer: containerName[i] } : {}),
        });
        // A definition that reaches no chunk reaches no index either, and a citation
        // to it resolves as `unresolved_symbol`. It cannot be emitted without
        // colliding on the staleness key, so it is counted and reported instead of
        // vanishing - a silent no-op is the defect class, not the collision.
        if (!emitted)
            droppedDefinitions++;
    }
    for (const span of uncoveredSpans(covered, lines.length)) {
        for (const [startLine, endLine] of splitSpan(lines, span)) {
            // Uncovered spans are not counted when refused: a whitespace-only span is
            // owed no chunk, which is the documented contract of `splitSpan`.
            emit({
                content: sliceLines(lines, startLine, endLine),
                startLine,
                endLine,
                chunkType: 'raw',
            });
        }
    }
    return {
        chunks: chunks.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine),
        droppedDefinitions,
    };
}
const sliceLines = (lines, startLine, endLine) => lines.slice(startLine - 1, endLine).join('\n');
/** Maximal runs of lines no definition chunk claimed, as 1-based inclusive pairs. */
function uncoveredSpans(covered, lineCount) {
    const spans = [];
    let start = null;
    for (let line = 1; line <= lineCount; line++) {
        if (covered[line] === 1) {
            if (start !== null)
                spans.push([start, line - 1]);
            start = null;
        }
        else if (start === null) {
            start = line;
        }
    }
    if (start !== null)
        spans.push([start, lineCount]);
    return spans;
}
/**
 * Break an uncovered span on line boundaries so no chunk exceeds
 * `MAX_RAW_SPAN_CHARS`. No overlap - overlap would re-embed the same lines - and
 * no mid-line splitting: two chunks over one line range would collide on the
 * `filePath:startLine-endLine` staleness key, so an over-long single line is
 * left whole and the embedding layer truncates it with a warning
 * (`EmbeddingService` caps each input at the 8191-token per-input limit).
 *
 * Whitespace-only spans yield nothing - `emit` drops them, and the blank lines
 * between definitions are the one thing total coverage does not owe a chunk.
 */
function splitSpan(lines, [spanStart, spanEnd]) {
    const pieces = [];
    let start = spanStart;
    let length = 0;
    for (let line = spanStart; line <= spanEnd; line++) {
        const lineLength = (lines[line - 1] ?? '').length + 1;
        if (line > start && length + lineLength > MAX_RAW_SPAN_CHARS) {
            pieces.push([start, line - 1]);
            start = line;
            length = 0;
        }
        length += lineLength;
    }
    pieces.push([start, spanEnd]);
    return pieces;
}
/**
 * ERROR and MISSING nodes, so a caller can see that a file parsed badly instead
 * of inferring it from thin chunks.
 *
 * Short-circuits on a clean tree, and descends only into subtrees whose own
 * `hasError` is true - 97.6% of this repo's TypeScript files have no error at
 * all, and they must not pay for a full tree walk.
 */
function countErrorNodes(tree) {
    if (!tree.rootNode.hasError)
        return 0;
    const cursor = tree.walk();
    let count = 0;
    try {
        for (;;) {
            const node = cursor.currentNode;
            if (node.isError || node.isMissing)
                count++;
            if (node.hasError && cursor.gotoFirstChild())
                continue;
            for (;;) {
                if (cursor.gotoNextSibling())
                    break;
                if (!cursor.gotoParent())
                    return count;
            }
        }
    }
    finally {
        cursor.delete();
    }
}
const describe = (err) => err instanceof Error ? err.message.slice(0, 200) || err.constructor.name : String(err);
//# sourceMappingURL=astChunker.js.map