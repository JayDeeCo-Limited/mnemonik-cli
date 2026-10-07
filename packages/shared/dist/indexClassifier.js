/**
 * Default indexing rules: which files are not code an agent works with.
 *
 * Code search should return the code agents edit, not generated clients,
 * minified bundles, binary files, vendored dependencies or data dumps. These
 * rules are SOFT defaults: a project can re-include any path they exclude, and
 * that is what separates them from the hard rules that stay where they are
 * (`isSecretFile`, protected paths, symlinks, nested git boundaries and
 * `BUILT_IN_IGNORE_DIRS`, none of which can be overridden).
 *
 * Precedence, highest first:
 *   1. hard rules - applied by the callers before this module is consulted;
 *   2. the project's .gitignore / .mnemonikignore - a path they ignore is out,
 *      and a `!pattern` that matches the path ITSELF re-includes it from every
 *      soft default (a re-included parent directory does not: `.yarn/*` plus
 *      `!.yarn/releases`, Yarn's own recommended .gitignore, must not opt the
 *      bundled Yarn release back in);
 *   3. .gitattributes - `linguist-vendored` / `linguist-generated` set or
 *      `=true` excludes, `-linguist-...` or `=false` re-includes, `binary` or
 *      `-text` means binary. Hierarchical, last match wins, as git resolves it;
 *   4. the soft defaults below - path rules first, then content rules.
 *
 * ONE implementation for every place a path is judged: the daemon walk, its
 * watcher and discovery walk, the server's push backstop and the retirement
 * of stored rows. Two copies of a rule drift, and here drift means the daemon
 * and the server disagree about what exists.
 *
 * Content rules read the SCRUBBED text (`scrubSecrets`), because that is the
 * text the server receives: classifying the raw bytes on one side and the
 * scrubbed bytes on the other would let a redaction placeholder move a file
 * across the minified threshold on one side only.
 */
import { posix } from 'path';
export const INDEX_EXCLUSION_REASONS = [
    'vendored',
    'generated',
    'minified',
    'binary',
    'data_dump',
    'changelog',
];
const REASON_LABELS = {
    vendored: 'vendored code',
    generated: 'generated code',
    minified: 'minified code',
    binary: 'a binary file',
    data_dump: 'a data dump',
    changelog: 'a changelog',
};
/** Human phrase for a reason: "generated code", "a binary file". */
export function indexExclusionLabel(reason) {
    return REASON_LABELS[reason];
}
/**
 * The one line an agent sees when it asks about an excluded path. Short on
 * purpose: the agent needs to know the absence is deliberate and that its own
 * file tools still reach the file.
 */
export function indexExclusionNotice(reason, subject) {
    return subject
        ? `${subject} is not in the code index: excluded by default as ${REASON_LABELS[reason]}. Read and Grep still work on it.`
        : `Not in the code index: excluded by default as ${REASON_LABELS[reason]}. Read and Grep still work on this file.`;
}
export function isIndexExclusionReason(value) {
    return (typeof value === 'string' && INDEX_EXCLUSION_REASONS.includes(value));
}
/**
 * Directory rules, tested against a path that ends in '/' for a directory and
 * against the full file path for a file, so the same regex prunes a walk and
 * classifies a file under it. Case-sensitive, as written: `Vendor/` is the
 * CocoaPods/Swift spelling, and `Tests/fixtures/` the Swift package one.
 */
const DIRECTORY_RULES = [
    // R2 - vendored dependencies and archive debris.
    {
        reason: 'vendored',
        rule: 'vendored directory',
        re: /(^|\/)(vendors?|Vendor|third[-_]?party|3rd[-_]?party|Godeps|Carthage|jspm_packages|site-packages|dist-packages|__MACOSX)\//,
    },
    {
        reason: 'vendored',
        rule: 'Yarn release/plugin/cache directory',
        re: /(^|\/)\.yarn\/(releases|plugins|sdks|versions|unplugged|cache)\//,
    },
    { reason: 'vendored', rule: 'documentation build output', re: /(^|\/)docs?\/_?build\// },
    // Test fixtures are copies of other code: byte-identical snapshot trees
    // stole the content-hash dedup slot from the real file and outranked it in
    // code_search. This folds in the old built-in `/tests/fixtures/*` pattern.
    { reason: 'vendored', rule: 'test fixtures', re: /(^|\/)([Tt]ests?|[Ss]pecs?)\/fixtures\// },
    { reason: 'vendored', rule: 'test fixtures', re: /(^|\/)(testdata|__fixtures__)\// },
    { reason: 'vendored', rule: 'test snapshots', re: /(^|\/)__snapshots__\// },
    // R3 - generated output directories.
    {
        reason: 'generated',
        rule: 'generated directory',
        re: /(^|\/)(__generated__|_generated|generated|autogen)\//,
    },
];
/**
 * R3 by base name. `.test.` / `.spec.` names are exempt (see
 * `isTestOrSpecName`): `Generated.test.ts` tests generated code, it is not it.
 */
const GENERATED_BASENAME_RULES = [
    // Infixes: foo.gen.ts, foo.g.dart, foo.pb.go, foo.pb.gw.go, foo.freezed.dart,
    // Form1.Designer.cs. Case-insensitive: Visual Studio writes `.Designer.cs`.
    { rule: 'generated infix', re: /\.(gen|g|pb|pb\.gw|freezed|designer)\.[^.]+$/i },
    // Protocol Buffers / gRPC outputs.
    { rule: 'protobuf/gRPC output', re: /_pb2(_grpc)?\.pyi?$/ },
    { rule: 'protobuf/gRPC output', re: /_pb\.(js|ts)$/ },
    { rule: 'protobuf/gRPC output', re: /_grpc_pb\..+$/ },
    { rule: 'protobuf/gRPC output', re: /_grpc\.pb\.go$/ },
    { rule: 'protobuf/gRPC output', re: /\.pb\.(go|cc|h|swift|dart|ts|js)$/ },
    // SpecFlow, Yarn Plug'n'Play, Delphi type libraries.
    { rule: 'SpecFlow feature binding', re: /\.feature\.cs$/ },
    { rule: "Yarn Plug'n'Play loader", re: /^\.pnp\./ },
    { rule: 'Delphi type library', re: /_tlb\.pas$/ },
];
function isTestOrSpecName(base) {
    return base.includes('.test.') || base.includes('.spec.');
}
/**
 * A base name whose stem token is `generated`: the name split on '.', minus
 * the final extension, contains the token `generated` (any case).
 * `Generated.ts`, `foo.generated.ts`, `api.generated.d.ts`; not
 * `generatedClient.ts`, not `generator.ts`.
 */
function hasGeneratedStemToken(base) {
    const tokens = base.split('.');
    if (tokens.length < 2)
        return false;
    return tokens.slice(0, -1).some((token) => token.toLowerCase() === 'generated');
}
/**
 * R9. Upper-case stems match with any extension, as the convention is
 * written (`CHANGELOG`, `NEWS`, `HISTORY.rst`). Other spellings match only as
 * a document (`History.md`, `changelog.md`): `history.ts` and `news.py` are
 * real modules in real applications.
 */
const CHANGELOG_UPPER = /^(CHANGELOG|CHANGES|HISTORY|NEWS)(\.[^/]*)?$/;
const CHANGELOG_DOC = /^(changelog|changes|history|news)(\.(md|markdown|rst|txt|adoc))?$/i;
function posixPath(relPath) {
    return relPath.replace(/\\/g, '/').replace(/^\.\//, '');
}
/**
 * Soft default for a directory, from its path alone. `dirRel` is the
 * directory's root-relative path, with or without a trailing slash. Used to
 * prune walks: nothing under a vendored or generated directory can be
 * included by a soft default.
 */
export function softDefaultForDirectory(dirRel) {
    const path = posixPath(dirRel).replace(/\/+$/, '');
    if (!path)
        return null;
    const withSlash = `${path}/`;
    for (const { reason, rule, re } of DIRECTORY_RULES) {
        if (re.test(withSlash))
            return { reason, rule };
    }
    return null;
}
/** Soft default for a file from its path alone (R2, R3 by name, R8 AppleDouble, R9). */
export function softDefaultForPath(relPath) {
    const path = posixPath(relPath);
    if (!path)
        return null;
    for (const { reason, rule, re } of DIRECTORY_RULES) {
        if (re.test(path))
            return { reason, rule };
    }
    const base = posix.basename(path);
    // R8: AppleDouble resource forks (`._name.js`) are binary metadata macOS
    // writes beside a file on non-HFS volumes and inside zip archives.
    if (base.startsWith('._'))
        return { reason: 'binary', rule: 'AppleDouble resource fork' };
    if (!isTestOrSpecName(base)) {
        if (hasGeneratedStemToken(base))
            return { reason: 'generated', rule: 'generated file name' };
        for (const { rule, re } of GENERATED_BASENAME_RULES) {
            if (re.test(base))
                return { reason: 'generated', rule };
        }
    }
    if (CHANGELOG_UPPER.test(base) || CHANGELOG_DOC.test(base)) {
        return { reason: 'changelog', rule: 'changelog file' };
    }
    return null;
}
// ---------------------------------------------------------------------------
// Content rules
// ---------------------------------------------------------------------------
/** git's binary heuristic window. */
export const BINARY_SNIFF_BYTES = 8000;
/** Header detection looks at this many leading lines. */
const HEADER_LINES = 10;
/** R5: average line length above which a .js/.mjs/.cjs/.css file is minified. */
export const MINIFIED_AVERAGE_LINE_LENGTH = 110;
/** R5: a line longer than this, in UTF-8 bytes, is a minified line. */
export const MINIFIED_LONG_LINE_BYTES = 4096;
/** R7: a .sql file with at least this many INSERT INTO statements is a dump. */
export const DATA_DUMP_INSERT_THRESHOLD = 50;
const MINIFIABLE_EXTENSION = /\.(js|mjs|cjs|css)$/i;
/**
 * Comment-line openers across the languages the scanner reads. A header rule
 * only ever reads comment lines: code that mentions "generated" in a string
 * literal is code.
 */
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|#|--|;|<!--|%|\(\*|\{-|"""|''')/;
const GO_GENERATED_HEADER = /^\/\/ Code generated .* DO NOT EDIT\.$/;
const AT_GENERATED = /@generated\b/;
const GENERATION_PHRASE = /\b(generated by|auto-generated|autogenerated|this file was generated|code generated)\b/i;
const DO_NOT_EDIT_PHRASE = /\b(do not edit|do not modify|manual changes will be overwritten)\b/i;
/**
 * R4. A file is generated by its header when, within its first ten lines:
 * a Go-style `// Code generated ... DO NOT EDIT.` line stands alone; or a
 * comment line carries `@generated`; or the comment lines carry BOTH a
 * generation phrase and a do-not-edit phrase. One phrase alone never counts -
 * hand-written files say "generated by" about their outputs all the time.
 */
function generatedByHeader(content) {
    const lines = content.split('\n', HEADER_LINES);
    let generation = false;
    let doNotEdit = false;
    for (const raw of lines) {
        const line = raw.replace(/\r$/, '');
        if (GO_GENERATED_HEADER.test(line))
            return 'Go generated-code header';
        if (!COMMENT_LINE.test(line))
            continue;
        if (AT_GENERATED.test(line))
            return '@generated marker';
        if (GENERATION_PHRASE.test(line))
            generation = true;
        if (DO_NOT_EDIT_PHRASE.test(line))
            doNotEdit = true;
    }
    return generation && doNotEdit ? 'generated + do-not-edit header' : null;
}
function utf8Length(line) {
    // A UTF-16 unit is at most 3 UTF-8 bytes; skip the exact count when even
    // that bound cannot reach the threshold.
    if (line.length * 3 <= MINIFIED_LONG_LINE_BYTES)
        return line.length;
    return Buffer.byteLength(line, 'utf8');
}
/**
 * R5. More than one line over 4,096 bytes means minified, whatever the
 * language. A single long line does not: one embedded data URI or a long
 * literal table in hand-written source is common, and a 1,024-character
 * single-line rule would exclude this repository's own src/server/tools.ts.
 */
function minified(relPath, content) {
    const lines = content.split('\n');
    let longLines = 0;
    let total = 0;
    for (const line of lines) {
        total += line.length;
        if (line.length > MINIFIED_LONG_LINE_BYTES / 3 && utf8Length(line) > MINIFIED_LONG_LINE_BYTES) {
            longLines++;
            if (longLines > 1)
                return 'two or more lines over 4,096 bytes';
        }
    }
    if (MINIFIABLE_EXTENSION.test(relPath) && lines.length > 0) {
        const average = total / lines.length;
        if (average > MINIFIED_AVERAGE_LINE_LENGTH)
            return 'average line length over 110';
    }
    return null;
}
const INSERT_INTO = /\binsert\s+into\b/gi;
const COPY_FROM_STDIN = /^\s*COPY\s+[^\n]*\bFROM\s+stdin\b/im;
/** R7. Schema lives in migrations; rows do not belong in a code index. */
function dataDump(relPath, content) {
    if (!/\.sql$/i.test(relPath))
        return null;
    if (/(^|\/)migrations\//i.test(posixPath(relPath)))
        return null;
    if (COPY_FROM_STDIN.test(content))
        return 'SQL COPY ... FROM stdin';
    let inserts = 0;
    INSERT_INTO.lastIndex = 0;
    while (INSERT_INTO.exec(content) !== null) {
        if (++inserts >= DATA_DUMP_INSERT_THRESHOLD)
            return 'SQL with 50+ INSERT INTO statements';
    }
    return null;
}
/**
 * Soft default from a file's content (R4, R5, R7, R8). `content` is the
 * decoded, scrubbed text. R8 uses git's heuristic: a NUL in the first 8,000
 * characters (which cover at least the first 8,000 bytes).
 */
export function softDefaultForContent(relPath, content) {
    if (content.slice(0, BINARY_SNIFF_BYTES).includes('\0')) {
        return { reason: 'binary', rule: 'NUL byte in the first 8,000 bytes' };
    }
    const header = generatedByHeader(content);
    if (header)
        return { reason: 'generated', rule: header };
    const minifiedRule = minified(relPath, content);
    if (minifiedRule)
        return { reason: 'minified', rule: minifiedRule };
    const dump = dataDump(relPath, content);
    if (dump)
        return { reason: 'data_dump', rule: dump };
    return null;
}
function escapeRegex(char) {
    return /[.+^${}()|[\]\\*?/]/.test(char) ? `\\${char}` : char;
}
/** git wildmatch, FNM_PATHNAME semantics: `*` stops at '/', `**` crosses it. */
function globToRegex(glob) {
    let re = '';
    let i = 0;
    while (i < glob.length) {
        if (glob.startsWith('**', i)) {
            const atSegmentStart = i === 0 || glob[i - 1] === '/';
            const next = glob[i + 2];
            if (atSegmentStart && next === '/') {
                re += '(?:.*/)?';
                i += 3;
                continue;
            }
            if (atSegmentStart && next === undefined) {
                re += '.*';
                i += 2;
                continue;
            }
            re += '[^/]*';
            i += 2;
            continue;
        }
        const char = glob[i];
        if (char === '*') {
            re += '[^/]*';
        }
        else if (char === '?') {
            re += '[^/]';
        }
        else if (char === '[') {
            const close = glob.indexOf(']', i + 2);
            if (close === -1) {
                re += '\\[';
            }
            else {
                let body = glob.slice(i + 1, close);
                if (body.startsWith('!'))
                    body = `^${body.slice(1)}`;
                re += `[${body.replace(/\\/g, '\\\\')}]`;
                i = close;
            }
        }
        else if (char === '\\' && i + 1 < glob.length) {
            re += escapeRegex(glob[i + 1]);
            i++;
        }
        else {
            re += escapeRegex(char);
        }
        i++;
    }
    return new RegExp(`^${re}$`);
}
/** Split one attributes line into its pattern and attribute tokens. */
function splitAttributesLine(line) {
    let pattern;
    let rest;
    if (line.startsWith('"')) {
        // C-style quoted pattern; only the escapes a path can need.
        let i = 1;
        let out = '';
        for (; i < line.length && line[i] !== '"'; i++) {
            if (line[i] === '\\' && i + 1 < line.length) {
                i++;
                out += line[i] === 't' ? '\t' : line[i] === 'n' ? '\n' : line[i];
            }
            else {
                out += line[i];
            }
        }
        if (i >= line.length)
            return null;
        pattern = out;
        rest = line.slice(i + 1);
    }
    else {
        const match = /^(\S+)(.*)$/.exec(line);
        if (!match)
            return null;
        pattern = match[1];
        rest = match[2];
    }
    return { pattern, attrs: rest.split(/\s+/).filter(Boolean) };
}
/**
 * Parse one .gitattributes file. Comments, blank lines, macro definitions
 * (`[attr]...`) and negative patterns (forbidden by git) are skipped. The
 * built-in `binary` macro is expanded to `-text`, which is the part of it this
 * module reads.
 */
export function parseGitattributes(text) {
    const rules = [];
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#') || line.startsWith('[attr]'))
            continue;
        const split = splitAttributesLine(line);
        if (!split || split.pattern.startsWith('!'))
            continue;
        let { pattern } = split;
        // A pattern that only matches a directory never applies to the files
        // inside it (git: "use path/** instead"), so it can classify nothing.
        if (pattern.endsWith('/'))
            continue;
        const attrs = new Map();
        for (const token of split.attrs) {
            if (token.startsWith('-'))
                attrs.set(token.slice(1), false);
            else if (token.startsWith('!'))
                attrs.set(token.slice(1), undefined);
            else if (token.includes('=')) {
                const eq = token.indexOf('=');
                attrs.set(token.slice(0, eq), token.slice(eq + 1));
            }
            else
                attrs.set(token, true);
        }
        if (attrs.get('binary') === true)
            attrs.set('text', false);
        if (attrs.size === 0)
            continue;
        const basenameOnly = !pattern.includes('/');
        if (pattern.startsWith('/'))
            pattern = pattern.slice(1);
        rules.push({ re: globToRegex(pattern), basenameOnly, attrs });
    }
    return rules;
}
function booleanAttribute(value) {
    if (value === true || value === 'true')
        return true;
    if (value === false || value === 'false')
        return false;
    return undefined;
}
/**
 * Resolve `linguist-vendored`, `linguist-generated` and binary-ness for one
 * root-relative path. `layers` are applied root first, then deeper; within a
 * file, later lines win - git's own order. `linguist-documentation` is not
 * read: documentation is what agents read.
 */
export function linguistAttributesFor(relPath, layers) {
    const path = posixPath(relPath);
    const state = new Map();
    // Array.prototype.sort is stable, so equal depths keep the caller's order.
    const ordered = [...layers].sort((a, b) => depthOf(a.baseRel) - depthOf(b.baseRel));
    for (const layer of ordered) {
        let sub;
        if (layer.baseRel === '')
            sub = path;
        else if (path.startsWith(`${layer.baseRel}/`))
            sub = path.slice(layer.baseRel.length + 1);
        else
            continue;
        const base = posix.basename(sub);
        for (const rule of layer.rules) {
            if (!(rule.basenameOnly ? rule.re.test(base) : rule.re.test(sub)))
                continue;
            for (const [name, value] of rule.attrs)
                state.set(name, value);
        }
    }
    return {
        vendored: booleanAttribute(state.get('linguist-vendored')),
        generated: booleanAttribute(state.get('linguist-generated')),
        binary: state.get('text') === false,
    };
}
function depthOf(baseRel) {
    return baseRel === '' ? 0 : baseRel.split('/').length;
}
/** True when any rule in these layers can re-include a path (`-linguist-*` or `=false`). */
export function gitattributesCanReinclude(layers) {
    return layers.some((layer) => layer.rules.some((rule) => ['linguist-vendored', 'linguist-generated'].some((name) => booleanAttribute(rule.attrs.get(name)) === false)));
}
/**
 * Should this path be indexed? `{ include: true }`, or
 * `{ include: false, reason, rule }`. Hard rules are not this function's
 * business: a caller excludes secrets, protected paths, symlinks, nested git
 * boundaries, built-in directories and user-ignored paths first.
 */
export function classifyForIndex(relPath, options = {}) {
    if (options.ignoreFileVerdict === 'unignored')
        return { include: true, override: 'ignore_file' };
    if (options.attributes && options.attributes.length > 0) {
        const attrs = linguistAttributesFor(relPath, options.attributes);
        if (attrs.vendored === true) {
            return { include: false, reason: 'vendored', rule: '.gitattributes linguist-vendored' };
        }
        if (attrs.generated === true) {
            return { include: false, reason: 'generated', rule: '.gitattributes linguist-generated' };
        }
        if (attrs.binary)
            return { include: false, reason: 'binary', rule: '.gitattributes binary' };
        if (attrs.vendored === false || attrs.generated === false) {
            return { include: true, override: 'gitattributes' };
        }
    }
    const byPath = softDefaultForPath(relPath);
    if (byPath)
        return { include: false, ...byPath };
    if (options.content !== undefined) {
        const byContent = softDefaultForContent(relPath, options.content);
        if (byContent)
            return { include: false, ...byContent };
    }
    return { include: true };
}
// ---------------------------------------------------------------------------
// Rule upload (daemon -> server)
// ---------------------------------------------------------------------------
/**
 * The daemon uploads its root .gitignore / .mnemonikignore lines verbatim
 * (`ignorePatterns`, the server's privacy list). The other rule lines the
 * walk applied ride along as gitignore COMMENT lines, so a server or matcher
 * that predates them reads them as comments and changes nothing:
 *
 *   `#mnemonik:gitignore <dir>\t<line>`      - a nested .gitignore /
 *                                              .mnemonikignore line, for
 *                                              `!pattern` overrides
 *   `#mnemonik:gitattributes <dir>\t<line>`  - a .gitattributes line; <dir>
 *                                              is empty for the root file
 *
 * With them the server and retirement judge a path exactly as the daemon did.
 */
export const NESTED_IGNORE_TAG = '#mnemonik:gitignore ';
export const GITATTRIBUTES_TAG = '#mnemonik:gitattributes ';
export function encodeNestedIgnoreLine(baseRel, line) {
    return `${NESTED_IGNORE_TAG}${baseRel}\t${line}`;
}
export function encodeGitattributesLine(baseRel, line) {
    return `${GITATTRIBUTES_TAG}${baseRel}\t${line}`;
}
function decodeTagged(line, tag) {
    if (!line.startsWith(tag))
        return null;
    const rest = line.slice(tag.length);
    const tab = rest.indexOf('\t');
    if (tab === -1)
        return null;
    const baseRel = rest.slice(0, tab);
    if (baseRel.split('/').some((segment) => segment === '..'))
        return null;
    return { baseRel, body: rest.slice(tab + 1) };
}
export function decodeIndexRules(patterns) {
    const decoded = {
        rootIgnore: [],
        nestedIgnore: new Map(),
        attributes: new Map(),
    };
    for (const line of patterns) {
        if (typeof line !== 'string')
            continue;
        const nested = decodeTagged(line, NESTED_IGNORE_TAG);
        if (nested) {
            if (nested.baseRel === '')
                continue;
            const lines = decoded.nestedIgnore.get(nested.baseRel) ?? [];
            lines.push(nested.body);
            decoded.nestedIgnore.set(nested.baseRel, lines);
            continue;
        }
        const attr = decodeTagged(line, GITATTRIBUTES_TAG);
        if (attr) {
            const lines = decoded.attributes.get(attr.baseRel) ?? [];
            lines.push(attr.body);
            decoded.attributes.set(attr.baseRel, lines);
            continue;
        }
        decoded.rootIgnore.push(line);
    }
    return decoded;
}
//# sourceMappingURL=indexClassifier.js.map