import { parseVueSource, walkVueTemplate, VUE_FIDELITY_MARKER } from './vueSource.js';
import { basename, extname } from 'node:path';
import { Parser } from 'web-tree-sitter';
import { loadGrammar, objcppSyntaxIssue } from './ast/grammars.js';
import { commandLineCredentialRanges, redactCredentials } from './redactCredentials.js';
import { redactHighEntropyTokens, redactSecretValue, scrubSecrets, SECRET_LABEL_RE, } from './secretPatterns.js';
function scrubPayload(text) {
    return redactCredentials(scrubSecrets(text), { commandLineOnly: true }).text;
}
/**
 * The largest source redacted with its syntax tree: the scanner's own file
 * ceiling (MAX_SCANNED_FILE_BYTES, 10 MB; repeated here because codeScanner.ts
 * imports this module). It was 2 MiB, sized from "the largest file in this
 * repository", and above it every file took the text fallback: PowerShell,
 * CMake, Groovy, Nix, Terraform and the bundled languages were stamped
 * "source-fidelity-unavailable", so connected code refused every such file
 * over 2 MiB, and other languages could keep structural [REDACTED] the
 * extractors refuse (streams F1/F2, 25 October 2026). Memory for a large
 * parse is bounded by running it in a child process sized from the file
 * (installSourceRedactor below; sourceRedactionPool.ts), not by refusing it.
 */
export const MAX_SOURCE_REDACTION_BYTES = 10 * 1024 * 1024;
let outOfProcess = null;
export function installSourceRedactor(redactor) {
    outOfProcess = redactor;
}
/** Source syntax stays executable; unsupported or incomplete input uses the conservative scrubber. */
export async function scrubSourceSecrets(text, filePath, options) {
    if (outOfProcess && text && outOfProcess.routes(filePath, Buffer.byteLength(text, 'utf8')))
        return outOfProcess.redact(text, filePath, options);
    return scrubSourceSecretsInProcess(text, filePath);
}
/** The redaction itself, in this process. The out-of-process worker calls this. */
export async function scrubSourceSecretsInProcess(text, filePath) {
    const extension = extname(filePath).toLowerCase();
    if (extension === '.vue')
        return scrubVueSource(text);
    if (extension === '.svelte')
        return scrubSvelteSource(text);
    const bundledLanguages = {
        '.go': 'go',
        '.java': 'java',
        '.cs': 'csharp',
        '.scala': 'scala',
        '.sc': 'scala',
        '.rb': 'ruby',
        '.php': 'php',
        '.ex': 'elixir',
        '.exs': 'elixir',
        '.sol': 'solidity',
        '.kt': 'kotlin',
        '.kts': 'kotlin',
        '.dart': 'dart',
        '.erl': 'erlang',
        '.hrl': 'erlang',
        '.hs': 'haskell',
        '.ml': 'ocaml',
        '.mli': 'ocaml_interface',
        '.clj': 'clojure',
        '.cljs': 'clojure',
        '.cljc': 'clojure',
        '.jl': 'julia',
        '.pl': 'perl',
        '.pm': 'perl',
        '.r': 'r',
        '.zig': 'zig',
        '.proto': 'protobuf',
        '.graphql': 'graphql',
        '.gql': 'graphql',
    };
    const bundledLanguage = bundledLanguages[extension];
    const language = bundledLanguage ??
        (extension === '.cmake' || basename(filePath) === 'CMakeLists.txt'
            ? 'cmake'
            : ['.ts', '.mts', '.cts'].includes(extension)
                ? 'typescript'
                : extension === '.tsx'
                    ? 'tsx'
                    : ['.js', '.jsx', '.mjs', '.cjs'].includes(extension)
                        ? 'javascript'
                        : ['.py', '.pyi', '.bzl'].includes(extension)
                            ? 'python'
                            : ['.sh', '.bash', '.zsh'].includes(extension)
                                ? 'bash'
                                : extension === '.swift'
                                    ? 'swift'
                                    : extension === '.sql'
                                        ? 'sql'
                                        : extension === '.lua'
                                            ? 'lua'
                                            : extension === '.rs'
                                                ? 'rust'
                                                : extension === '.nix'
                                                    ? 'nix'
                                                    : extension === '.tf'
                                                        ? 'terraform'
                                                        : ['.m', '.mm'].includes(extension)
                                                            ? 'objcpp'
                                                            : extension === '.c'
                                                                ? 'c'
                                                                : ['.h', '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx'].includes(extension)
                                                                    ? 'cpp'
                                                                    : ['.groovy', '.gradle'].includes(extension)
                                                                        ? 'groovy'
                                                                        : ['.ps1', '.psm1'].includes(extension)
                                                                            ? 'powershell'
                                                                            : null);
    const fallback = (source = text, payloadsScrubbed = false) => {
        // A completed AST payload pass must not be reinterpreted as prose (e.g. proto field numbers).
        const clean = payloadsScrubbed ? source : scrubPayload(source);
        if (!text)
            return clean;
        if (bundledLanguage) {
            const marker = `/* mnemonik:${bundledLanguage}-source-fidelity-unavailable */`;
            const nativeMarker = {
                erlang: `% mnemonik:${bundledLanguage}-source-fidelity-unavailable`,
                haskell: `-- mnemonik:${bundledLanguage}-source-fidelity-unavailable`,
                ocaml: `(* mnemonik:${bundledLanguage}-source-fidelity-unavailable *)`,
                ocaml_interface: `(* mnemonik:${bundledLanguage}-source-fidelity-unavailable *)`,
                clojure: `; mnemonik:${bundledLanguage}-source-fidelity-unavailable`,
                zig: `// mnemonik:${bundledLanguage}-source-fidelity-unavailable`,
            };
            const comment = nativeMarker[bundledLanguage] ??
                (['ruby', 'elixir', 'julia', 'perl', 'r', 'graphql'].includes(bundledLanguage)
                    ? marker.replace('/* ', '# ').replace(' */', '')
                    : bundledLanguage === 'php'
                        ? `<?php ${marker} ?>`
                        : marker);
            return clean.startsWith(comment) ? clean : comment + '\n' + clean;
        }
        if (extension === '.bzl') {
            const marker = '# mnemonik:starlark-source-fidelity-unavailable\n';
            return clean.startsWith(marker) ? clean : marker + clean;
        }
        if (language === 'powershell') {
            const marker = '# mnemonik:powershell-source-fidelity-unavailable\n';
            return clean.startsWith(marker) ? clean : marker + clean;
        }
        // A fallback may repair syntax accidentally; these graph extractors must never trust it.
        if (language === 'cmake' || language === 'groovy') {
            const marker = `// mnemonik:${language}-source-fidelity-unavailable`;
            const comment = language === 'cmake' ? marker.replace('//', '#') : marker;
            return clean.startsWith(comment) ? clean : comment + '\n' + clean;
        }
        const marker = language === 'nix'
            ? '/* mnemonik:nix-source-fidelity-unavailable */'
            : '/* mnemonik:terraform-source-fidelity-unavailable */';
        return (language === 'terraform' || language === 'nix') && !clean.startsWith(marker)
            ? marker + clean
            : clean;
    };
    if (!text || !language || Buffer.byteLength(text, 'utf8') > MAX_SOURCE_REDACTION_BYTES) {
        return fallback();
    }
    let parser;
    let tree = null;
    try {
        const grammar = await loadGrammar(language);
        if ('unavailable' in grammar)
            return fallback();
        parser = new Parser();
        parser.setLanguage(grammar.ok.language);
        tree = parser.parse(text);
        if (!tree)
            return fallback();
        if (tree.rootNode.hasError) {
            // These bindings have no prose-style credential '=' label. Recover AST-proven payloads;
            // opaque ERROR spans are scrubbed conservatively and always remain unavailable.
            return bundledLanguage && ['clojure', 'r', 'protobuf', 'graphql'].includes(bundledLanguage)
                ? fallback(redactBundledNode(tree.rootNode, bundledLanguage, true), true)
                : fallback();
        }
        const root = tree.rootNode;
        if (language === 'objcpp' && objcppSyntaxIssue(root))
            return fallback();
        const redacted = bundledLanguage
            ? redactBundledNode(root, bundledLanguage)
            : language === 'cmake'
                ? redactCmakeNode(root)
                : language === 'bash'
                    ? redactShellNode(root, commandLineCredentialRanges(text))
                    : language === 'swift'
                        ? redactSwiftNode(root)
                        : language === 'sql'
                            ? redactSqlNode(root)
                            : language === 'lua'
                                ? redactLuaNode(root)
                                : language === 'rust'
                                    ? redactRustNode(root)
                                    : language === 'nix'
                                        ? redactNixNode(root)
                                        : language === 'terraform'
                                            ? redactTerraformNode(root)
                                            : ['objcpp', 'c', 'cpp'].includes(language)
                                                ? redactCFamilyNode(root)
                                                : language === 'groovy'
                                                    ? redactGroovyNode(root)
                                                    : language === 'powershell'
                                                        ? redactPowershellNode(root)
                                                        : redactNode(root);
        const clean = text.slice(0, root.startIndex) + redacted + text.slice(root.endIndex);
        if (bundledLanguage && clean !== text) {
            const proof = parser.parse(clean);
            try {
                if (!proof || proof.rootNode.hasError)
                    return fallback(clean);
            }
            finally {
                proof?.delete();
            }
        }
        return clean;
    }
    catch {
        return fallback();
    }
    finally {
        tree?.delete();
        parser?.delete();
    }
}
/** Bundled L1 grammars expose literal payloads separately from executable expressions. */
function redactBundledNode(root, language, incomplete = false) {
    const labeled = new Set();
    const heredocs = [];
    const label = (node) => {
        if (!node)
            return false;
        if (language === 'julia' && node.type === 'typed_expression')
            return label(node.firstNamedChild);
        if (language === 'perl' && node.type === 'variable_declaration')
            return label(node.childForFieldName('variable'));
        if (language === 'perl' && node.type === 'scalar')
            return label(node.firstNamedChild);
        if (language === 'kotlin' &&
            ['navigation_expression', 'directly_assignable_expression'].includes(node.type)) {
            const last = node.lastNamedChild;
            return label(last?.type === 'navigation_suffix' ? last.firstNamedChild : node.firstNamedChild);
        }
        if (language === 'dart' && node.type === 'assignable_expression') {
            const last = node.lastNamedChild;
            return label(last?.type === 'unconditional_assignable_selector'
                ? last.firstNamedChild
                : node.firstNamedChild);
        }
        if ([
            'expression',
            'literal_element',
            'variable_name',
            'assignable_expression',
            'directly_assignable_expression',
        ].includes(node.type))
            return label(node.firstNamedChild);
        const field = node.childForFieldName('field') ??
            node.childForFieldName('member') ??
            node.childForFieldName('property') ??
            node.childForFieldName('name') ??
            node;
        return SECRET_LABEL_RE.test(field.text
            .trim()
            .replace(/^[$@]+|["':]+$/g, '')
            .replace(/^["']/, ''));
    };
    const mark = (key, value) => {
        if (!key || !value)
            return;
        if (label(key))
            labeled.add(value.id);
        else if (key.type === 'tuple_pattern' && value.type === 'tuple_expression')
            key.namedChildren.forEach((part, i) => mark(part, value.namedChildren[i] ?? null));
    };
    const payload = (text, sensitive) => scrubPayload(text)
        .split(/(\r\n|[\r\n])/)
        .map((part, i) => i % 2
        ? part
        : part.replace(/^(\s*)([\s\S]*?)(\s*)$/, (_match, lead, body, tail) => lead + literalPayload(body, sensitive) + tail))
        .join('');
    const visit = (node, sensitive = false) => {
        sensitive ||= labeled.has(node.id);
        const original = node.text;
        const type = node.type;
        if (incomplete && type === 'ERROR')
            return redactSecretValue(original);
        if ([
            'comment',
            'line_comment',
            'block_comment',
            'documentation_comment',
            'multiline_comment',
        ].includes(type)) {
            if (language === 'clojure') {
                if (original.startsWith(';'))
                    return ';' + scrubPayload(original.slice(1));
                if (original.startsWith('#!'))
                    return '#!' + scrubPayload(original.slice(2));
                // Reader-discard and (comment ...) contain forms, not line-comment payloads.
                let clean = '';
                let offset = node.startIndex;
                for (const child of node.namedChildren) {
                    clean +=
                        original.slice(offset - node.startIndex, child.startIndex - node.startIndex) +
                            visit(child);
                    offset = child.endIndex;
                }
                return clean + original.slice(offset - node.startIndex);
            }
            if (language === 'erlang')
                return '%' + scrubPayload(original.slice(1));
            if (language === 'haskell')
                return original.startsWith('{-')
                    ? '{-' + scrubPayload(original.slice(2, -2)) + '-}'
                    : '--' + scrubPayload(original.slice(2));
            if (language === 'ocaml' || language === 'ocaml_interface')
                return '(*' + scrubPayload(original.slice(2, -2)) + '*)';
            if (original.startsWith('#'))
                return '#' + scrubPayload(original.slice(1));
            return original.startsWith('/*')
                ? '/*' + scrubPayload(original.slice(2, -2)) + '*/'
                : '//' + scrubPayload(original.slice(2));
        }
        if (['erlang', 'haskell', 'ocaml', 'ocaml_interface', 'clojure'].includes(language) &&
            ['char', 'character'].includes(type)) {
            if (sensitive || scrubPayload(original) !== original)
                throw new Error('Restricted literal payload');
            return original;
        }
        if ((language === 'ocaml' || language === 'ocaml_interface') && type === 'quoted_string') {
            const opening = /^\{([a-z_]*)\|/.exec(original);
            const closing = opening ? '|' + opening[1] + '}' : '';
            if (!opening || !original.endsWith(closing))
                throw new Error('Opaque quoted literal boundary');
            return (opening[0] +
                payload(original.slice(opening[0].length, -closing.length), sensitive) +
                closing);
        }
        if (language === 'perl' && type === 'interpolated_string_literal') {
            const content = node.childForFieldName('content');
            return content
                ? original.slice(0, content.startIndex - node.startIndex) +
                    visit(content, sensitive) +
                    original.slice(content.endIndex - node.startIndex)
                : original;
        }
        if (language === 'perl' && type === 'string_content') {
            let clean = '';
            let offset = node.startIndex;
            for (const child of node.namedChildren.filter((c) => !['escape_sequence', 'escaped_delimiter'].includes(c.type))) {
                clean +=
                    payload(original.slice(offset - node.startIndex, child.startIndex - node.startIndex), sensitive) + visit(child);
                offset = child.endIndex;
            }
            return clean + payload(original.slice(offset - node.startIndex), sensitive);
        }
        if (type === 'heredoc_beginning') {
            heredocs.push(sensitive);
            return original;
        }
        if (language === 'ruby' && type === 'heredoc_body')
            sensitive = heredocs.shift() ?? false;
        if (type === 'hex_string_literal')
            return sensitive
                ? original.replace(/(["'])([0-9a-fA-F_\s]*)\1/g, (_match, quote, body) => quote + body.replace(/[0-9a-fA-F_]/g, '') + quote)
                : original;
        // shortcut: restricted character/symbol literals use fallback; add native placeholders if needed.
        if (['character_literal', 'rune_literal', 'simple_symbol', 'atom'].includes(type)) {
            if (sensitive || scrubPayload(original) !== original)
                throw new Error('Restricted literal payload');
            return original;
        }
        if (sensitive &&
            /^(?:int|float|imaginary|integer|real|decimal_integer|hex_integer|octal_integer|binary_integer|decimal_floating_point|hex_floating_point|number)(?:_literal)?$/.test(type))
            return '"' + redactSecretValue(original) + '"';
        const string = [
            'string',
            'interpreted_string_literal',
            'raw_string_literal',
            'verbatim_string_literal',
            'encapsed_string',
            'unicode_string_literal',
            'string_value',
            'interpolated_string',
            'sigil',
        ].includes(type) ||
            (type === 'string_literal' && language !== 'solidity');
        if (string) {
            const first = node.firstChild;
            const last = node.lastChild;
            const quotedStart = node.childForFieldName('quoted_start') ??
                (language === 'r' ? node.childForFieldName('open') : null);
            const quotedEnd = node.childForFieldName('quoted_end') ??
                (language === 'r' ? node.childForFieldName('close') : null);
            const opening = quotedStart ?? first;
            const closing = quotedEnd ?? last;
            const match = /^(?:r|@|unicode)?("{3,}|'{3,}|"|'|`)/.exec(original);
            const start = quotedStart
                ? quotedStart.endIndex
                : opening && /^(?:%[qQwWiIxrs]?[^\w\s]|["'`]+)$/.test(opening.text)
                    ? opening.endIndex
                    : match
                        ? node.startIndex + match[0].length
                        : null;
            const end = quotedEnd
                ? quotedEnd.startIndex
                : match?.[1]
                    ? node.endIndex - match[1].length
                    : closing && closing.id !== opening?.id
                        ? closing.startIndex
                        : null;
            if (start === null || end === null || end < start)
                throw new Error('Opaque literal boundary');
            const substitutions = node.children.filter((child) => child.startIndex >= start &&
                child.endIndex <= end &&
                ![
                    'string_content',
                    'content',
                    'string_fragment',
                    'multiline_string_fragment',
                    'raw_string_content',
                    'raw_string_literal_content',
                    'interpreted_string_literal_content',
                    'string_literal_content',
                    'quoted_content',
                    'escape_sequence',
                ].includes(child.type));
            let result = original.slice(0, start - node.startIndex);
            let offset = start;
            for (const child of substitutions) {
                result += payload(original.slice(offset - node.startIndex, child.startIndex - node.startIndex), sensitive);
                result += visit(child); // Runtime interpolation never inherits credential sensitivity.
                offset = child.endIndex;
            }
            return (result +
                payload(original.slice(offset - node.startIndex, end - node.startIndex), sensitive) +
                original.slice(end - node.startIndex));
        }
        if (['string_content', 'heredoc_content', 'quoted_content', 'nowdoc_body'].includes(type))
            return payload(original, sensitive);
        if (language === 'julia' && type === 'assignment')
            mark(node.firstNamedChild, node.lastNamedChild);
        if (language === 'r' && type === 'binary_operator') {
            const op = node.childForFieldName('operator')?.text;
            if (['<-', '<<-', '=', ':='].includes(op ?? ''))
                mark(node.childForFieldName('lhs'), node.childForFieldName('rhs'));
            if (['->', '->>'].includes(op ?? ''))
                mark(node.childForFieldName('rhs'), node.childForFieldName('lhs'));
        }
        if (language === 'r' && ['parameter', 'argument'].includes(type))
            mark(node.childForFieldName('name'), node.childForFieldName('default') ?? node.childForFieldName('value'));
        if (language === 'zig' && ['assignment_statement', 'field_declaration'].includes(type))
            mark(node.childForFieldName('name'), node.childForFieldName('expression') ?? node.childForFieldName('default'));
        if (language === 'protobuf' && type === 'field') {
            const name = node.namedChildren.find((c) => c.type === 'identifier');
            for (const option of node.namedChildren.find((c) => c.type === 'field_options')
                ?.namedChildren ?? []) {
                if (option.type !== 'field_option' ||
                    option.namedChildren.find((c) => c.type === 'identifier')?.text !== 'default')
                    continue;
                const constant = option.namedChildren.find((c) => c.type === 'constant');
                mark(name ?? null, constant?.namedChildren.find((c) => c.type === 'string') ?? null);
            }
        }
        if (language === 'graphql' && type === 'object_field')
            mark(node.namedChildren.find((c) => c.type === 'name') ?? null, node.namedChildren.find((c) => c.type === 'value') ?? null);
        if (language === 'graphql' &&
            ['input_value_definition', 'variable_definition'].includes(type)) {
            const name = type === 'input_value_definition'
                ? node.namedChildren.find((c) => c.type === 'name')
                : node.namedChildren.find((c) => c.type === 'variable')?.firstNamedChild;
            const value = node.namedChildren.find((c) => c.type === 'default_value')?.firstNamedChild;
            mark(name ?? null, value ?? null);
        }
        if (language === 'erlang' && type === 'match_expr')
            mark(node.childForFieldName('lhs'), node.childForFieldName('rhs'));
        if (language === 'haskell' && type === 'bind') {
            const name = node.childForFieldName('name');
            mark(name, node.childForFieldName('expression'));
            for (const match of node.childrenForFieldName('match'))
                mark(name, match.childForFieldName('expression'));
        }
        if ((language === 'ocaml' || language === 'ocaml_interface') && type === 'let_binding')
            mark(node.childForFieldName('pattern'), node.childForFieldName('body'));
        if (language === 'clojure' && type === 'list') {
            const forms = node.namedChildren.filter((c) => c.type !== 'comment');
            if (forms[0]?.type === 'symbol' &&
                forms[0].text === 'def' &&
                forms[1]?.type === 'symbol' &&
                forms.length >= 3)
                mark(forms[1], forms.at(-1) ?? null);
            if (forms[0]?.type === 'symbol' && forms[0].text === 'let' && forms[1]?.type === 'vector') {
                const bindings = forms[1].namedChildren.filter((c) => c.type !== 'comment');
                for (let i = 0; i + 1 < bindings.length; i += 2)
                    mark(bindings[i] ?? null, bindings[i + 1] ?? null);
            }
        }
        if (language === 'kotlin' && type === 'assignment')
            mark(node.firstNamedChild, node.lastNamedChild);
        if (language === 'dart' && type === 'assignment_expression_without_cascade')
            mark(node.childForFieldName('left'), node.childForFieldName('right'));
        if (language === 'kotlin' && type === 'property_declaration') {
            const key = node.namedChildren.find((c) => c.type === 'variable_declaration')?.firstNamedChild;
            const equals = node.children.findIndex((c) => c.type === '=');
            if (equals >= 0)
                mark(key ?? null, node.children[equals + 1] ?? null);
        }
        if (language === 'dart' &&
            [
                'initialized_variable_definition',
                'initialized_identifier',
                'static_final_declaration',
            ].includes(type)) {
            const equals = node.children.findIndex((c) => c.type === '=');
            if (equals >= 0)
                mark(node.childForFieldName('name') ?? node.firstNamedChild, node.children[equals + 1] ?? null);
        }
        // These grammars place defaults beside the parameter rather than inside it.
        if ((language === 'kotlin' && type === 'function_value_parameters') ||
            (language === 'dart' && type === 'optional_formal_parameters')) {
            node.children.forEach((child, i, children) => {
                if (!['=', ':'].includes(child.type))
                    return;
                const parameter = children[i - 1];
                mark(parameter?.childForFieldName('name') ?? parameter?.firstNamedChild ?? null, children[i + 1] ?? null);
            });
        }
        if (language === 'dart' && type === 'named_argument')
            mark(node.firstNamedChild?.firstNamedChild ?? null, node.lastNamedChild);
        if (language === 'kotlin' &&
            type === 'value_argument' &&
            node.children.some((c) => c.type === '='))
            mark(node.firstNamedChild, node.lastNamedChild);
        if (type === 'var_spec' || type === 'const_spec') {
            const names = node.childrenForFieldName('name');
            const values = node.childForFieldName('value')?.namedChildren ?? [];
            names.forEach((name, i) => mark(name, values[i] ?? null));
        }
        else if (language === 'go' &&
            ['short_var_declaration', 'assignment_statement'].includes(type)) {
            const names = node.childForFieldName('left')?.namedChildren ?? [];
            const values = node.childForFieldName('right')?.namedChildren ?? [];
            names.forEach((name, i) => mark(name, values[i] ?? null));
        }
        else if (type === 'variable_declarator') {
            mark(node.childForFieldName('name'), node.childForFieldName('value') ?? node.namedChildren[1] ?? null);
        }
        else if (language === 'php' && type === 'property_element') {
            mark(node.childForFieldName('name'), node.childForFieldName('default_value'));
        }
        else if (language === 'csharp' && type === 'property_declaration') {
            mark(node.childForFieldName('name'), node.childForFieldName('value'));
        }
        else if (['val_definition', 'var_definition'].includes(type)) {
            mark(node.childForFieldName('pattern'), node.childForFieldName('value'));
        }
        else if (['assignment', 'assignment_expression', 'operator_assignment'].includes(type) ||
            (language === 'elixir' &&
                type === 'binary_operator' &&
                node.childForFieldName('operator')?.text === '=')) {
            mark(node.childForFieldName('left'), node.childForFieldName('right'));
        }
        else if (['pair', 'keyed_element'].includes(type)) {
            mark(node.childForFieldName('key'), node.childForFieldName('value'));
        }
        else if (language === 'php' &&
            type === 'array_element_initializer' &&
            node.children.some((c) => c.type === '=>')) {
            mark(node.namedChildren[0] ?? null, node.namedChildren[1] ?? null);
        }
        else if (type === 'state_variable_declaration') {
            mark(node.childForFieldName('name'), node.childForFieldName('value'));
        }
        else if (language === 'solidity' && type === 'variable_declaration_statement') {
            mark(node.namedChildren
                .find((c) => c.type === 'variable_declaration')
                ?.childForFieldName('name') ?? null, node.childForFieldName('value'));
        }
        if ([
            'parameter',
            'optional_parameter',
            'simple_parameter',
            'class_parameter',
            'named_argument',
        ].includes(type)) {
            const equals = node.children.findIndex((child) => child.type === '=');
            if (equals >= 0)
                mark(node.childForFieldName('name') ?? node.firstNamedChild, node.children[equals + 1] ?? null);
        }
        let result = '';
        let offset = node.startIndex;
        for (const child of node.namedChildren) {
            result += original.slice(offset - node.startIndex, child.startIndex - node.startIndex);
            const carry = sensitive &&
                (((type !== 'list' || language !== 'clojure') &&
                    [
                        'expression',
                        'expression_list',
                        'literal_element',
                        'literal_value',
                        'array',
                        'array_creation_expression',
                        'hash',
                        'list',
                        'keywords',
                        'tuple_expression',
                        'initializer_expression',
                        'collection_expression',
                        'parenthesized_expression',
                        'unary_expression',
                        'interpolated_string_expression',
                        'string_literal',
                        'heredoc',
                        'heredoc_body',
                        'nowdoc',
                        'regex',
                        'quoted_atom',
                        'delimited_symbol',
                    ].includes(type)) ||
                    (language === 'clojure' && ['vector', 'hash_map', 'set'].includes(type)) ||
                    (language === 'erlang' && type === 'binary' && child.type === 'bin_element') ||
                    (language === 'erlang' &&
                        type === 'bin_element' &&
                        child.id === node.childForFieldName('element')?.id) ||
                    (language === 'haskell' &&
                        type === 'conditional' &&
                        [node.childForFieldName('then')?.id, node.childForFieldName('else')?.id].includes(child.id)) ||
                    (['ocaml', 'ocaml_interface'].includes(language) &&
                        ((type === 'if_expression' && ['then_clause', 'else_clause'].includes(child.type)) ||
                            (['then_clause', 'else_clause'].includes(type) &&
                                child.id === node.childForFieldName('expression')?.id))) ||
                    (language === 'haskell' && type === 'literal') ||
                    (language === 'graphql' &&
                        ['value', 'list_value', 'object_value', 'object_field'].includes(type)) ||
                    (['kotlin', 'dart'].includes(language) &&
                        [
                            'collection_literal',
                            'list_literal',
                            'set_or_map_literal',
                            'additive_expression',
                            'if_null_expression',
                            'elvis_expression',
                        ].includes(type)) ||
                    (type === 'composite_literal' && child.id === node.childForFieldName('body')?.id) ||
                    (type === 'array_element_initializer' && child.id === node.lastNamedChild?.id) ||
                    (['binary_expression', 'binary_operator'].includes(type) &&
                        ['+', '.', '<>', '||', '??'].includes(node.childForFieldName('operator')?.text ?? '')) ||
                    (['conditional_expression', 'ternary_expression'].includes(type) &&
                        child.id !== node.childForFieldName('condition')?.id) ||
                    (['pair', 'keyed_element'].includes(type) &&
                        child.id === node.childForFieldName('value')?.id) ||
                    ([
                        'method_invocation',
                        'member_access_expression',
                        'field_expression',
                        'field_access',
                        'member_expression',
                    ].includes(type) &&
                        child.id === node.childForFieldName('object')?.id) ||
                    (['invocation_expression', 'call_expression', 'call'].includes(type) &&
                        [
                            node.childForFieldName('function')?.id,
                            node.childForFieldName('receiver')?.id,
                        ].includes(child.id)));
            result += visit(child, carry);
            offset = child.endIndex;
        }
        return result + original.slice(offset - node.startIndex);
    };
    return visit(root);
}
/** CMake substitutions remain source expressions; only AST argument/comment payloads are scrubbed. */
function redactCmakeNode(node, sensitive = false) {
    const original = node.text;
    const type = node.type;
    const payload = (value) => sensitive && value.trim() ? redactSecretValue(value) : literalPayload(value, false);
    if (type === 'line_comment')
        return '#' + scrubPayload(original.slice(1));
    if (type === 'bracket_comment' || type === 'bracket_argument') {
        const payload = node.namedChildren.find((n) => n.type.endsWith('_content'));
        if (!payload)
            return original;
        const clean = type === 'bracket_comment'
            ? scrubPayload(payload.text)
            : sensitive
                ? redactSecretValue(payload.text)
                : literalPayload(payload.text, false);
        return (original.slice(0, payload.startIndex - node.startIndex) +
            clean +
            original.slice(payload.endIndex - node.startIndex));
    }
    if (type === 'variable_ref')
        return original;
    if (type === 'escape_sequence')
        return sensitive ? redactSecretValue(original) : original;
    if (type === 'quoted_element' || type === 'unquoted_argument') {
        // Generator expressions have no inner AST in this grammar; withhold fidelity instead of rewriting them.
        if (original.includes('$<'))
            throw new Error('Opaque CMake generator expression');
        let result = '';
        let offset = node.startIndex;
        for (const child of node.namedChildren) {
            result += payload(original.slice(offset - node.startIndex, child.startIndex - node.startIndex));
            result += redactCmakeNode(child, sensitive);
            offset = child.endIndex;
        }
        result += payload(original.slice(offset - node.startIndex));
        return type === 'unquoted_argument' && result !== original ? '"' + result + '"' : result;
    }
    const args = type === 'argument_list' ? node.namedChildren.filter((n) => n.type === 'argument') : [];
    const set = node.parent?.namedChildren.find((n) => n.type === 'identifier')?.text.toLowerCase() === 'set';
    const key = set ? args[0] : null;
    const label = key?.firstNamedChild;
    const literalKey = label?.type === 'unquoted_argument' && !label.namedChildCount
        ? label.text
        : label?.type === 'quoted_argument' && !label.firstNamedChild?.namedChildCount
            ? label.text.slice(1, -1)
            : null;
    const name = literalKey?.match(/^ENV\{([^{}]+)\}$/)?.[1] ?? literalKey;
    const labeled = name !== null && SECRET_LABEL_RE.test(name);
    let result = '';
    let offset = node.startIndex;
    for (const child of node.namedChildren) {
        result += original.slice(offset - node.startIndex, child.startIndex - node.startIndex);
        result +=
            child.id === key?.id || (type === 'normal_command' && child.type === 'identifier')
                ? child.text
                : redactCmakeNode(child, sensitive || (labeled && args.some((a) => a.id === child.id)));
        offset = child.endIndex;
    }
    return result + original.slice(offset - node.startIndex);
}
/** PowerShell's AST separates command syntax from literal strings and interpolation nodes. */
function redactPowershellNode(node, sensitive = false) {
    const original = node.text;
    const type = node.type;
    if (type === 'comment')
        return original.startsWith('<#')
            ? '<#' + scrubPayload(original.slice(2, -2)) + '#>'
            : '#' + scrubPayload(original.slice(1));
    if (type === 'string_literal') {
        const here = original.startsWith('@');
        const prefix = here ? 2 : 1;
        const expandable = node.firstNamedChild;
        const substitutions = expandable?.type.startsWith('expandable_')
            ? expandable.namedChildren
            : [];
        const payload = (text) => text
            // Retain quote/dollar/control escapes and physical continuation boundaries verbatim.
            .split(/(`(?:\r\n|[0abefnrtv`"'$\r\n])|''|\r\n|[\r\n])/g)
            .map((part, index) => index % 2
            ? part
            : sensitive && part
                ? redactSecretValue(part)
                : literalPayload(part, false))
            .join('');
        let result = original.slice(0, prefix);
        let offset = node.startIndex + prefix;
        for (const child of substitutions) {
            result += payload(original.slice(offset - node.startIndex, child.startIndex - node.startIndex));
            result += redactPowershellNode(child); // Runtime references/subexpressions are not credential values.
            offset = child.endIndex;
        }
        return (result + payload(original.slice(offset - node.startIndex, -prefix)) + original.slice(-prefix));
    }
    if (sensitive && type === 'generic_token')
        return literalPayload(original, true);
    if (sensitive && ['integer_literal', 'real_literal'].includes(type))
        return "'" + redactSecretValue(original) + "'";
    const assignment = type === 'assignment_expression';
    const key = assignment || type === 'hash_entry' ? node.firstNamedChild : null;
    const value = assignment
        ? node.childForFieldName('value')
        : type === 'hash_entry'
            ? node.namedChildren[1]
            : null;
    let label = key;
    while (label && label.type !== 'string_literal') {
        if (label.type === 'element_access' || label.namedChildCount === 1)
            label = label.firstNamedChild;
        else
            break;
    }
    if (label?.type === 'member_access')
        label = label.lastNamedChild?.firstNamedChild ?? label.lastNamedChild;
    const labelText = label?.type === 'string_literal' ? label.text.slice(1, -1) : label?.text;
    const labeled = !!labelText &&
        SECRET_LABEL_RE.test(labelText
            .replace(/^\$\{?|}$/g, '')
            .split(':')
            .at(-1) ?? '');
    const valueWrapper = sensitive &&
        (type === 'pipeline' ||
            type === 'pipeline_chain' ||
            type === 'statement_list' ||
            type === 'hash_literal_body' ||
            type === 'expression_with_unary_operator' ||
            (type.endsWith('_expression') &&
                ![
                    'sub_expression',
                    'member_access',
                    'invokation_expression',
                    'script_block_expression',
                ].includes(type)));
    let result = '';
    let offset = node.startIndex;
    let argumentSensitive = false;
    for (const child of node.namedChildren) {
        result += original.slice(offset - node.startIndex, child.startIndex - node.startIndex);
        if (type === 'command_elements' && child.type === 'command_parameter')
            argumentSensitive = SECRET_LABEL_RE.test(child.text.replace(/^-|:$/g, ''));
        const argument = type === 'command_elements' &&
            !['command_parameter', 'command_argument_sep'].includes(child.type);
        result += redactPowershellNode(child, valueWrapper ||
            ((labeled || (sensitive && type === 'hash_entry')) && child.id === value?.id) ||
            (argument && argumentSensitive));
        if (argument)
            argumentSensitive = false;
        offset = child.endIndex;
    }
    return result + original.slice(offset - node.startIndex);
}
/** Nix literal payloads have spans; lambda bodies and application arguments remain runtime code. */
function redactNixNode(node, sensitive = false) {
    const type = node.type;
    const original = node.text;
    if (type === 'comment')
        return redactNode(node);
    if (type === 'string_fragment')
        return sensitive ? redactSecretValue(original) : literalPayload(original, false);
    if (type === 'escape_sequence' || type === 'dollar_escape')
        return original;
    if ((type === 'integer_expression' ||
        type === 'float_expression' ||
        (type === 'unary_expression' &&
            ['integer_expression', 'float_expression'].includes(node.childForFieldName('argument')?.type ?? ''))) &&
        sensitive)
        return '"' + redactSecretValue(original) + '"';
    if (type === 'uri_expression') {
        const clean = literalPayload(original, sensitive);
        return clean === original ? original : JSON.stringify(clean);
    }
    if (['path_expression', 'hpath_expression', 'spath_expression'].includes(type) &&
        (sensitive || scrubPayload(original) !== original))
        throw new Error('Nix path fidelity unavailable');
    const key = type === 'binding' ? node.childForFieldName('attrpath') : null;
    const name = key?.lastNamedChild ?? (type === 'formal' ? node.childForFieldName('name') : null);
    const labeled = name?.type === 'identifier'
        ? secretLabel(name)
        : name?.type === 'string_expression' &&
            !name.namedChildren.some((n) => n.type === 'interpolation')
            ? SECRET_LABEL_RE.test(name.text.slice(1, -1))
            : false;
    const value = node.childForFieldName(type === 'formal' ? 'default' : 'expression');
    let result = '';
    let offset = node.startIndex;
    let escapedDollar = false;
    for (const child of node.namedChildren) {
        result += original.slice(offset - node.startIndex, child.startIndex - node.startIndex);
        const carry = sensitive &&
            ([
                'string_expression',
                'indented_string_expression',
                'list_expression',
                'parenthesized_expression',
                'attrset_expression',
                'rec_attrset_expression',
                'binding_set',
            ].includes(type) ||
                (type === 'binding' && child.id === value?.id) ||
                (['let_expression', 'with_expression', 'assert_expression'].includes(type) &&
                    child.id === node.childForFieldName('body')?.id) ||
                (type === 'interpolation' && child.id === node.childForFieldName('expression')?.id) ||
                (type === 'unary_expression' && child.id === node.childForFieldName('argument')?.id) ||
                (type === 'if_expression' && child.id !== node.childForFieldName('condition')?.id) ||
                (type === 'binary_expression' &&
                    ['+', '++'].includes(node.childForFieldName('operator')?.text ?? '')) ||
                (type === 'apply_expression' && child.id === node.childForFieldName('function')?.id) ||
                (type === 'select_expression' && child.type !== 'attrpath'));
        const structural = child.id === key?.id ||
            (escapedDollar && child.type === 'string_fragment' && child.text === '$');
        result += structural
            ? child.text
            : redactNixNode(child, carry || (labeled && child.id === value?.id));
        escapedDollar = child.type === 'dollar_escape';
        offset = child.endIndex;
    }
    return result + original.slice(offset - node.startIndex);
}
/** HCL exposes literal spans separately from interpolation/directive expressions. */
function redactTerraformNode(node, sensitive = false) {
    const original = node.text;
    const type = node.type;
    if (type === 'comment')
        return redactNode(node);
    // Resource labels and object keys are identifiers, even when the AST calls them strings.
    if (type === 'block')
        sensitive = false;
    if (type === 'template_literal') {
        if (!sensitive)
            return literalPayload(original, false);
        // Escape tokens remain literal; scrubbing must not turn $${ into an interpolation.
        return original
            .split(/(\\["\\nrt]|\$\$\{|%%\{|[{}])/g)
            .map((part, index) => (index % 2 ? part : literalPayload(part, sensitive)))
            .join('');
    }
    if (type === 'numeric_lit' && sensitive)
        return '"' + redactSecretValue(original) + '"';
    const key = type === 'attribute' ? node.firstNamedChild : node.childForFieldName('key');
    const value = type === 'attribute' ? node.namedChildren[1] : node.childForFieldName('val');
    const keyName = key?.type === 'expression' ? key.firstNamedChild : key;
    const literalKey = keyName?.type === 'literal_value' ? keyName.firstNamedChild : keyName;
    const container = type === 'attribute' ? node.parent?.parent : null;
    const containerName = container?.namedChildren[1];
    const secretDefault = container?.type === 'block' &&
        ((container.firstNamedChild?.text === 'variable' && key?.text === 'default') ||
            (container.firstNamedChild?.text === 'output' && key?.text === 'value')) &&
        containerName?.type === 'string_lit' &&
        SECRET_LABEL_RE.test(containerName.text.slice(1, -1));
    const labeled = secretDefault ||
        (literalKey?.type === 'string_lit'
            ? SECRET_LABEL_RE.test(literalKey.text.slice(1, -1))
            : secretLabel(literalKey ?? null));
    let result = '';
    let offset = node.startIndex;
    for (const child of node.namedChildren) {
        result += original.slice(offset - node.startIndex, child.startIndex - node.startIndex);
        const carry = sensitive &&
            ([
                'expression',
                'operation',
                'unary_operation',
                'binary_operation',
                'literal_value',
                'template_expr',
                'string_lit',
                'quoted_template',
                'heredoc_template',
                'collection_value',
                'tuple',
                'object',
                'template_directive',
            ].includes(type) ||
                (['template_for', 'template_if'].includes(type) &&
                    ![
                        'template_for_start',
                        'template_for_end',
                        'template_if_intro',
                        'template_else_intro',
                        'template_if_end',
                    ].includes(child.type)) ||
                (type === 'conditional' && child.id !== node.firstNamedChild?.id) ||
                (type === 'object_elem' && child.id === value?.id));
        // Block labels and object keys are never literal values to scrub.
        result +=
            (type === 'block' && child.type === 'string_lit') || child.id === key?.id
                ? child.text
                : redactTerraformNode(child, carry || (labeled && child.id === value?.id));
        offset = child.endIndex;
    }
    return result + original.slice(offset - node.startIndex);
}
/** Groovy's quoted strings and comments have spans; command calls remain executable syntax. */
function redactGroovyNode(node, sensitive = false) {
    const original = node.text;
    const type = node.type;
    if (type === 'line_comment')
        return '//' + scrubPayload(original.slice(2));
    if (type === 'block_comment')
        return '/*' + scrubPayload(original.slice(2, -2)) + '*/';
    const operand = type === 'unary_expression' ? node.childForFieldName('operand') : null;
    const numeric = (kind) => kind.endsWith('_integer_literal') || kind.endsWith('_floating_point_literal');
    if (sensitive && (numeric(type) || (operand && numeric(operand.type))))
        return '"' + redactSecretValue(original) + '"';
    if (type === 'character_literal' || type === 'string_literal') {
        const delimiter = type === 'character_literal' ? "'" : node.firstChild?.text;
        if (!delimiter)
            throw new Error('Incomplete Groovy string');
        // The inherited Java rule leaves Groovy GString expressions opaque, not AST substitutions.
        if (delimiter.startsWith('"') && original.includes('$'))
            throw new Error('Opaque Groovy GString interpolation');
        return (delimiter +
            literalPayload(original.slice(delimiter.length, -delimiter.length), sensitive) +
            delimiter);
    }
    const key = type === 'variable_declarator'
        ? node.childForFieldName('name')
        : type === 'assignment_expression'
            ? node.childForFieldName('left')
            : type === 'map_item'
                ? node.childForFieldName('key')
                : null;
    const value = node.childForFieldName(type === 'assignment_expression' ? 'right' : 'value');
    const field = key?.childForFieldName('field') ?? key;
    const name = field && ['character_literal', 'string_literal'].includes(field.type)
        ? field.text.slice(1, -1)
        : field?.text;
    const labeled = !!name && SECRET_LABEL_RE.test(name);
    let result = '';
    let offset = node.startIndex;
    for (const child of node.namedChildren) {
        result += original.slice(offset - node.startIndex, child.startIndex - node.startIndex);
        const carry = sensitive &&
            (type === 'parenthesized_expression' ||
                type === 'array_literal' ||
                type === 'map_literal' ||
                (type === 'map_item' && child.id === value?.id) ||
                (type === 'method_invocation' && child.id === node.childForFieldName('object')?.id) ||
                (type === 'field_access' && child.id === node.childForFieldName('object')?.id) ||
                (type === 'juxt_function_call' && child.id === node.childForFieldName('name')?.id) ||
                (type === 'binary_expression' && node.childForFieldName('operator')?.text === '+') ||
                (type === 'ternary_expression' && child.id !== node.childForFieldName('condition')?.id));
        result += redactGroovyNode(child, carry || (labeled && child.id === value?.id));
        offset = child.endIndex;
    }
    return result + original.slice(offset - node.startIndex);
}
/** Keep C/Objective-C++ prefixes, raw delimiters and runtime expressions outside literal payloads. */
function redactCFamilyNode(node, sensitive = false) {
    const original = node.text;
    const type = node.type;
    if (sensitive &&
        (type === 'number_literal' ||
            (type === 'unary_expression' &&
                node.childForFieldName('argument')?.type === 'number_literal')))
        return '"' + redactSecretValue(original) + '"';
    if (type === 'comment')
        return original.startsWith('/*')
            ? '/*' + scrubPayload(original.slice(2, -2)) + '*/'
            : '//' + scrubPayload(original.slice(2));
    // Unknown macro arguments have no literal/expression boundaries to preserve.
    if (type === 'objc_macro_argument_text')
        throw new Error('Opaque Objective-C++ macro arguments');
    if (type === 'preproc_arg')
        return scrubPayload(original);
    if (type === 'raw_string_literal') {
        const content = node.namedChildren.find((child) => child.type === 'raw_string_content');
        if (!content)
            return original;
        return (original.slice(0, content.startIndex - node.startIndex) +
            literalPayload(content.text, sensitive) +
            original.slice(content.endIndex - node.startIndex));
    }
    if (type === 'string_literal' || type === 'char_literal') {
        const quote = type === 'char_literal' ? "'" : '"';
        const start = original.indexOf(quote) + 1;
        const end = original.lastIndexOf(quote);
        return (original.slice(0, start) +
            literalPayload(original.slice(start, end), sensitive) +
            original.slice(end));
    }
    const label = (key) => {
        if (!key)
            return false;
        let current = key;
        while (current.type.endsWith('_declarator') || current.type === 'objc_string_literal') {
            const inner = current.childForFieldName('declarator') ??
                current.childForFieldName('value') ??
                current.firstNamedChild;
            if (!inner)
                return false;
            current = inner;
        }
        const field = current.childForFieldName('field') ??
            (current.type === 'field_designator' ? current.firstNamedChild : null) ??
            current;
        const content = field.namedChildren.find((child) => child.type === 'string_content');
        return SECRET_LABEL_RE.test(content?.text ?? field.text);
    };
    const key = type === 'init_declarator'
        ? node.childForFieldName('declarator')
        : type === 'assignment_expression'
            ? node.childForFieldName('left')
            : type === 'objc_dictionary_entry'
                ? node.childForFieldName('key')
                : null;
    const sensitiveValue = type === 'initializer_pair' ? node.childrenForFieldName('designator').some(label) : label(key);
    const value = node.childForFieldName(type === 'assignment_expression' ? 'right' : 'value');
    let result = '';
    let offset = node.startIndex;
    for (const child of node.namedChildren) {
        result += original.slice(offset - node.startIndex, child.startIndex - node.startIndex);
        const carry = sensitive &&
            (type === 'objc_string_literal' ||
                type === 'concatenated_string' ||
                type === 'user_defined_literal' ||
                type === 'parenthesized_expression' ||
                type === 'initializer_list' ||
                (type === 'unary_expression' && child.id === node.childForFieldName('argument')?.id) ||
                (type === 'initializer_pair' && child.id === value?.id) ||
                type === 'objc_array_literal' ||
                type === 'objc_dictionary_literal' ||
                (type === 'objc_dictionary_entry' && child.id === value?.id) ||
                (type === 'objc_boxed_expression' && child.id === value?.id) ||
                (type === 'message_expression' && child.id === node.childForFieldName('receiver')?.id) ||
                (type === 'call_expression' && child.id === node.childForFieldName('function')?.id) ||
                (type === 'field_expression' && child.id === node.childForFieldName('argument')?.id) ||
                (type === 'conditional_expression' &&
                    child.id !== node.childForFieldName('condition')?.id) ||
                (type === 'binary_expression' && node.childForFieldName('operator')?.text === '+'));
        result += redactCFamilyNode(child, carry || (sensitiveValue && child.id === value?.id));
        offset = child.endIndex;
    }
    return result + original.slice(offset - node.startIndex);
}
/** Rust raw/byte prefixes belong to the delimiter, never to the credential payload. */
function redactRustNode(node, sensitive = false, labeled = new Set()) {
    sensitive ||= labeled.has(node.id);
    const original = node.text;
    const type = node.type;
    if (type === 'line_comment')
        return '//' + scrubPayload(original.slice(2));
    if (type === 'block_comment')
        return '/*' + scrubPayload(original.slice(2, -2)) + '*/';
    if (sensitive && ['integer_literal', 'float_literal', 'char_literal'].includes(type))
        return '"' + redactSecretValue(original) + '"';
    if (type === 'string_literal' || type === 'raw_string_literal') {
        const start = original.indexOf('"') + 1;
        const end = original.lastIndexOf('"');
        return (original.slice(0, start) +
            literalPayload(original.slice(start, end), sensitive) +
            original.slice(end));
    }
    const label = (key) => {
        if (!key)
            return false;
        const name = (key.childForFieldName('field') ?? key).text;
        return SECRET_LABEL_RE.test(['string_literal', 'raw_string_literal'].includes(key.type)
            ? name.slice(name.indexOf('"') + 1, name.lastIndexOf('"'))
            : name.replace(/^r#/, ''));
    };
    const mark = (pattern, value) => {
        if (!pattern || !value)
            return;
        if (['ref_pattern', 'mut_pattern', 'reference_pattern'].includes(pattern.type)) {
            mark(pattern.firstNamedChild, value);
            return;
        }
        if (label(pattern))
            labeled.add(value.id);
        else if (pattern.type === 'tuple_pattern' && value.type === 'tuple_expression')
            pattern.namedChildren.forEach((part, index) => mark(part, value.namedChildren[index] ?? null));
    };
    if (type === 'let_declaration')
        mark(node.childForFieldName('pattern'), node.childForFieldName('value'));
    if (type === 'const_item' || type === 'static_item')
        mark(node.childForFieldName('name'), node.childForFieldName('value'));
    if (type === 'field_initializer')
        mark(node.childForFieldName('field'), node.childForFieldName('value'));
    if (type === 'assignment_expression')
        mark(node.childForFieldName('left'), node.childForFieldName('right'));
    // Attribute/macro arguments are token trees, but literal key/value boundaries remain explicit.
    if (type === 'token_tree') {
        const children = node.children.filter((child) => !['line_comment', 'block_comment'].includes(child.type));
        let valueSensitive = sensitive;
        let genericDepth = 0;
        for (const [index, child] of children.entries()) {
            const previous = children[index - 1];
            // Token trees flatten type arguments too. Their commas and associated-type
            // bindings are not macro value boundaries; const arguments are not values.
            if (child.text === '<' &&
                (genericDepth > 0 || ['::', '=', ':', '('].includes(previous?.text ?? ''))) {
                genericDepth++;
                continue;
            }
            if (genericDepth > 0) {
                if (child.text === '>' || child.text === '>>')
                    genericDepth -= child.text.length;
                genericDepth = Math.max(0, genericDepth);
                continue;
            }
            const nextKey = children[index + 1];
            const nextBinding = nextKey &&
                ['identifier', 'string_literal', 'raw_string_literal'].includes(nextKey.type) &&
                ['=', ':'].includes(children[index + 2]?.text ?? '');
            if (child.text === ';' || (child.text === ',' && nextBinding))
                valueSensitive = sensitive;
            else if (['=', ':'].includes(child.text) && label(previous ?? null))
                valueSensitive = true;
            else if (valueSensitive) {
                const callArguments = child.type === 'token_tree' &&
                    child.text.startsWith('(') &&
                    (previous?.type === 'identifier' ||
                        ['>', ')', ']'].includes(previous?.text.at(-1) ?? ''));
                const key = children[index + 1]?.text === ':';
                if (!callArguments && !key)
                    labeled.add(child.id);
            }
        }
    }
    let result = '';
    let offset = node.startIndex;
    for (const child of node.namedChildren) {
        result += original.slice(offset - node.startIndex, child.startIndex - node.startIndex);
        // Carry a secret label through value wrappers, never into runtime call arguments/conditions.
        const carry = sensitive &&
            ([
                'parenthesized_expression',
                'unary_expression',
                'binary_expression',
                'field_expression',
                'reference_expression',
                'try_expression',
                'await_expression',
                'block',
                'expression_statement',
                'else_clause',
                'tuple_expression',
                'array_expression',
            ].includes(type) ||
                (type === 'call_expression' && child.id === node.childForFieldName('function')?.id) ||
                (type === 'match_expression' && child.id === node.childForFieldName('body')?.id) ||
                type === 'match_block' ||
                (type === 'match_arm' && child.id === node.childForFieldName('value')?.id) ||
                (type === 'type_cast_expression' && child.id === node.childForFieldName('value')?.id) ||
                (type === 'if_expression' && child.id !== node.childForFieldName('condition')?.id));
        result += redactRustNode(child, carry, labeled);
        offset = child.endIndex;
    }
    return result + original.slice(offset - node.startIndex);
}
/** Lua exposes payload spans for both quoted and level-matched long-bracket literals. */
function redactLuaNode(node, sensitive = false, labeled = new Set()) {
    sensitive ||= labeled.has(node.id);
    const original = node.text;
    if (node.type === 'string' || node.type === 'comment') {
        const content = node.childForFieldName('content');
        if (!content)
            return original;
        const suffix = original.slice(content.endIndex - node.startIndex);
        let payload = node.type === 'comment'
            ? scrubPayload(content.text)
            : literalPayload(content.text, sensitive);
        if (payload !== content.text && suffix.startsWith(']')) {
            // A placeholder must not introduce a closing long bracket, including at the boundary.
            payload = payload.split(suffix).join('] ' + suffix.slice(1));
            if ((payload + suffix).indexOf(suffix) < payload.length)
                payload += ' ';
        }
        return original.slice(0, content.startIndex - node.startIndex) + payload + suffix;
    }
    if (node.type === 'number' && sensitive)
        return "'" + redactSecretValue(original) + "'";
    const label = (key) => {
        if (key?.type === 'bracket_index_expression') {
            const field = key.childForFieldName('field');
            return field?.type === 'string' && secretLabel(field);
        }
        return secretLabel(key?.type === 'dot_index_expression' ? key.childForFieldName('field') : key);
    };
    if (node.type === 'assignment_statement') {
        const names = node.namedChildren.find((child) => child.type === 'variable_list')?.namedChildren ?? [];
        const values = node.namedChildren.find((child) => child.type === 'expression_list')?.namedChildren ?? [];
        values.forEach((value, index) => {
            if (label(names[index] ?? null))
                labeled.add(value.id);
        });
    }
    else if (node.type === 'field' && label(node.childForFieldName('name'))) {
        const value = node.childForFieldName('value');
        if (value)
            labeled.add(value.id);
    }
    const carry = sensitive &&
        (node.type === 'parenthesized_expression' ||
            node.type === 'unary_expression' ||
            (node.type === 'binary_expression' &&
                ['..', 'and', 'or'].includes(node.childForFieldName('operator')?.text ?? '')));
    let result = '';
    let offset = node.startIndex;
    for (const child of node.namedChildren) {
        result += original.slice(offset - node.startIndex, child.startIndex - node.startIndex);
        result += redactLuaNode(child, carry, labeled);
        offset = child.endIndex;
    }
    return result + original.slice(offset - node.startIndex);
}
function sqlSecretLabel(node) {
    if (!node)
        return false;
    if (['field', 'object_reference', 'column'].includes(node.type))
        return sqlSecretLabel(node.childForFieldName('name') ?? node.firstNamedChild);
    // This dialect-neutral grammar sometimes calls PostgreSQL quoted identifiers literals.
    if (node.type === 'identifier' || (node.type === 'literal' && node.text.startsWith('"')))
        return SECRET_LABEL_RE.test(node.text.startsWith('`')
            ? node.text.slice(1, -1).replaceAll('``', '`')
            : node.text.replace(/^"|"$/g, '').replaceAll('""', '"'));
    return false;
}
function redactSqlNode(node, sensitive = false) {
    if (node.type === 'create_function') {
        const language = node.namedChildren.find((child) => child.type === 'function_language');
        const body = node.namedChildren.find((child) => child.type === 'function_body');
        // Opaque/procedural bodies have no established inner syntax; the caller uses fallback.
        if (language?.namedChildren.find((child) => child.type === 'identifier')?.text.toLowerCase() !==
            'sql' ||
            body?.namedChildren.some((child) => child.type === 'literal'))
            throw new Error('Opaque SQL function body');
    }
    const original = node.text;
    if (node.type === 'comment')
        return '--' + scrubPayload(original.slice(2));
    if (node.type === 'marginalia')
        return '/*' + scrubPayload(original.slice(2, -2)) + '*/';
    if (node.type === 'literal') {
        if (original.startsWith('"'))
            return original; // PostgreSQL identifier, never a secret value.
        const opening = /^(?:[eEnNbBxX]|[uU]&)?'|^\$[A-Za-z_0-9]*\$/.exec(original)?.[0];
        if (opening) {
            const closing = opening.startsWith('$') ? opening : "'";
            if (!original.endsWith(closing))
                throw new Error('Incomplete SQL literal');
            const payload = original.slice(opening.length, -closing.length);
            // Scrub the whole payload on a match: SQL doubled quotes must not leave a secret suffix.
            const redacted = literalPayload(payload, sensitive);
            return opening + (redacted === payload ? payload : redactSecretValue(payload)) + closing;
        }
        if (node.namedChildren.some((child) => child.type.startsWith('keyword_')))
            return original;
        if (/^[+\-\d.]/.test(original))
            return sensitive ? "'" + redactSecretValue(original) + "'" : original;
        // shortcut: unrecognized typed literals use fallback until their boundaries are established.
        throw new Error('Unsupported SQL literal');
    }
    const left = node.childForFieldName('left');
    const right = node.childForFieldName('right');
    const labeled = ['assignment', 'binary_expression'].includes(node.type) && sqlSecretLabel(left);
    const columnLabel = node.type === 'column_definition' && sqlSecretLabel(node.childForFieldName('name'));
    const argumentLabel = node.type === 'function_argument' &&
        sqlSecretLabel(node.namedChildren.find((child) => child.type === 'identifier') ?? null);
    const argumentDefaultMarker = argumentLabel
        ? node.children.find((child) => ['keyword_default', '='].includes(child.type))
        : undefined;
    const argumentDefaultValue = argumentDefaultMarker
        ? node.namedChildren.find((child) => child.startIndex >= argumentDefaultMarker.endIndex &&
            !['comment', 'marginalia'].includes(child.type))
        : undefined;
    const aliasLabel = node.type === 'term' && sqlSecretLabel(node.childForFieldName('alias'));
    const insert = node.type === 'list' && node.parent?.type === 'insert' ? node.parent : null;
    const columns = insert?.namedChildren.find((child) => child.type === 'list');
    const columnValues = columns?.namedChildren.some((child) => child.type === 'column') && columns.id !== node.id
        ? columns.namedChildren.filter((child) => !['comment', 'marginalia'].includes(child.type))
        : [];
    let result = '';
    let offset = node.startIndex;
    let index = 0;
    let previous = null;
    for (const child of node.namedChildren) {
        result += original.slice(offset - node.startIndex, child.startIndex - node.startIndex);
        const carry = sensitive &&
            ((node.type === 'binary_expression' && node.childForFieldName('operator')?.text === '||') ||
                (node.type === 'cast' &&
                    child.id ===
                        (node.childForFieldName('parameter') ??
                            node.namedChildren.find((part) => !['comment', 'marginalia'].includes(part.type)))?.id) ||
                ['list', 'array', 'parenthesized_expression'].includes(node.type) ||
                (node.type === 'case' &&
                    (previous?.type === 'keyword_then' || previous?.type === 'keyword_else')));
        result += redactSqlNode(child, carry ||
            (labeled && child.id === right?.id) ||
            (node.type === 'binary_expression' && sqlSecretLabel(right) && child.id === left?.id) ||
            (columnLabel && previous?.type === 'keyword_default') ||
            child.id === argumentDefaultValue?.id ||
            (aliasLabel && child.id === node.childForFieldName('value')?.id) ||
            child.id === node.childForFieldName('password')?.id ||
            sqlSecretLabel(columnValues[index] ?? null));
        if (!['comment', 'marginalia'].includes(child.type)) {
            previous = child;
            index++;
        }
        offset = child.endIndex;
    }
    return result + original.slice(offset - node.startIndex);
}
function swiftSecretLabel(node) {
    if (!node)
        return false;
    if (node.type.endsWith('string_literal')) {
        const opening = /^(#+)?("""|")/.exec(node.text);
        return Boolean(opening && SECRET_LABEL_RE.test(node.text.slice(opening[0].length, -opening[0].length)));
    }
    if (['simple_identifier', 'type_identifier'].includes(node.type))
        return SECRET_LABEL_RE.test(node.text.replace(/^`|`$/g, ''));
    return swiftSecretLabel(node.childForFieldName('suffix') ??
        node.childForFieldName('bound_identifier') ??
        node.childForFieldName('name') ??
        node.firstNamedChild);
}
function redactSwiftNode(node, sensitive = false) {
    const original = node.text;
    if (node.type === 'comment' || node.type === 'multiline_comment') {
        // Swift permits nested block comments; retain every delimiter from the parsed comment.
        return original
            .split(/(\/\*|\*\/)/)
            .map((part) => (part === '/*' || part === '*/' ? part : scrubPayload(part)))
            .join('');
    }
    if (['line_string_literal', 'multi_line_string_literal', 'raw_string_literal'].includes(node.type)) {
        const opening = /^(#+)?("""|")/.exec(original);
        if (!opening)
            throw new Error('Swift string delimiter unavailable');
        const closing = opening[2] + (opening[1] ?? '');
        if (!original.endsWith(closing))
            throw new Error('Swift string is incomplete');
        const payload = (text) => {
            if (opening[2] !== '"""')
                return literalPayload(text, sensitive);
            // Keep required opening newlines/closing indentation; scrub multiline secrets together.
            const leading = /^\s*/.exec(text)?.[0] ?? '';
            const body = text.slice(leading.length);
            const trailing = /\s*$/.exec(body)?.[0] ?? '';
            return (leading + literalPayload(body.slice(0, body.length - trailing.length), sensitive) + trailing);
        };
        let result = opening[0];
        let offset = node.startIndex + opening[0].length;
        for (const child of node.children) {
            if (!['\\(', ')', 'interpolated_expression', 'raw_str_interpolation'].includes(child.type))
                continue;
            result += payload(original.slice(offset - node.startIndex, child.startIndex - node.startIndex));
            result += redactSwiftNode(child);
            offset = child.endIndex;
        }
        return result + payload(original.slice(offset - node.startIndex, -closing.length)) + closing;
    }
    if (sensitive && ['integer_literal', 'real_literal'].includes(node.type))
        return '"' + redactSecretValue(original) + '"';
    let labeled = node.type === 'assignment'
        ? swiftSecretLabel(node.childForFieldName('target'))
        : node.type === 'value_argument'
            ? swiftSecretLabel(node.childForFieldName('name'))
            : false;
    let result = '';
    let offset = node.startIndex;
    for (const [index, child] of node.children.entries()) {
        const field = node.fieldNameForChild(index);
        if ((node.type === 'property_declaration' && field === 'name') ||
            (node.type === 'dictionary_literal' && field === 'key') ||
            child.type === 'parameter')
            labeled = swiftSecretLabel(child);
        const value = (field === 'value' &&
            ['property_declaration', 'dictionary_literal', 'value_argument'].includes(node.type)) ||
            (field === 'result' && node.type === 'assignment') ||
            field === 'default_value';
        const carry = sensitive &&
            ([
                'tuple_expression',
                'additive_expression',
                'nil_coalescing_expression',
                'try_expression',
                'await_expression',
            ].includes(node.type) ||
                (node.type === 'as_expression' && field === 'expr') ||
                (node.type === 'prefix_expression' && field === 'target') ||
                (node.type === 'ternary_expression' && field !== 'condition'));
        result += original.slice(offset - node.startIndex, child.startIndex - node.startIndex);
        result += redactSwiftNode(child, carry || (labeled && value));
        offset = child.endIndex;
    }
    return result + original.slice(offset - node.startIndex);
}
function redactShellNode(root, ranges) {
    for (const range of ranges) {
        let literal = root.descendantForIndex(range.start, range.start);
        while (literal && !['word', 'string', 'raw_string', 'ansi_c_string'].includes(literal.type))
            literal = literal.parent;
        // Regex rules can stop at an escaped quote/space; the AST owns the complete literal.
        if (literal)
            range.end = Math.max(range.end, literal.endIndex);
    }
    let rangeIndex = 0;
    const payload = (text, start, sensitive, boundary) => {
        while (rangeIndex < ranges.length) {
            const range = ranges[rangeIndex];
            if (!range || range.end > start)
                break;
            rangeIndex++;
        }
        let result = '';
        let offset = start;
        for (let i = rangeIndex; i < ranges.length; i++) {
            const range = ranges[i];
            if (!range || range.start >= start + text.length)
                break;
            if (range.start < boundary)
                continue;
            const begin = Math.max(offset, range.start);
            const end = Math.min(start + text.length, range.end);
            if (begin >= end)
                continue;
            result +=
                text.slice(offset - start, begin - start) +
                    redactSecretValue(text.slice(begin - start, end - start));
            offset = end;
        }
        return literalPayload(result + text.slice(offset - start), sensitive);
    };
    const visit = (node, sensitive = false, boundary = 0) => {
        const original = node.text;
        if (['simple_expansion', 'command_substitution', 'arithmetic_expansion'].includes(node.type)) {
            // An enclosing credential rule must not taint arguments inside a runtime expression.
            boundary = node.startIndex;
            sensitive = false;
        }
        if (node.type === 'expansion') {
            // A CLI credential argument can supply the label even when this is not an assignment.
            for (let i = rangeIndex; i < ranges.length; i++) {
                const range = ranges[i];
                if (!range || range.start > node.startIndex)
                    break;
                if (range.start >= boundary && range.end >= node.endIndex)
                    sensitive = true;
            }
            boundary = node.startIndex;
            // Defaults/alternates are value literals; the parameter name remains a reference.
            sensitive = sensitive && /^:?[+=-]$/.test(node.childForFieldName('operator')?.text ?? '');
        }
        if (node.type === 'comment')
            return '#' + scrubPayload(original.slice(1));
        if (node.type === 'raw_string' || node.type === 'ansi_c_string') {
            const prefix = node.type === 'ansi_c_string' ? 2 : 1;
            return (original.slice(0, prefix) +
                payload(original.slice(prefix, -1), node.startIndex + prefix, sensitive, boundary) +
                "'");
        }
        if (node.type === 'word') {
            if (node.parent?.type === 'command_name' ||
                node.id === node.parent?.childForFieldName('name')?.id)
                return original;
            const redacted = payload(original, node.startIndex, sensitive, boundary);
            return redacted === original ? original : "'" + redacted.replaceAll("'", "'\\''") + "'";
        }
        const isText = node.type === 'string' || node.type === 'heredoc_body';
        const value = node.type === 'variable_assignment' ? node.childForFieldName('value') : null;
        const labeled = value && secretLabel(node.childForFieldName('name'));
        const children = isText
            ? node.namedChildren.filter((child) => !['string_content', 'heredoc_content'].includes(child.type))
            : node.namedChildren;
        let result = node.type === 'string' ? '"' : '';
        let offset = node.startIndex + (node.type === 'string' ? 1 : 0);
        for (const child of children) {
            const gap = original.slice(offset - node.startIndex, child.startIndex - node.startIndex);
            result += isText ? payload(gap, offset, sensitive, boundary) : gap;
            result += visit(child, (sensitive &&
                (isText ||
                    node.type === 'concatenation' ||
                    (node.type === 'expansion' && child.type !== 'variable_name'))) ||
                Boolean(labeled && child.id === value?.id), boundary);
            offset = child.endIndex;
        }
        const end = node.endIndex - (node.type === 'string' ? 1 : 0);
        const tail = original.slice(offset - node.startIndex, end - node.startIndex);
        return (result +
            (isText ? payload(tail, offset, sensitive, boundary) : tail) +
            (node.type === 'string' ? '"' : ''));
    };
    return visit(root);
}
function secretLabel(node) {
    if (!node)
        return false;
    const property = node.childForFieldName('property') ?? node.childForFieldName('attribute') ?? node;
    const name = property.type === 'string'
        ? (property.namedChildren.find((child) => child.type === 'string_content')?.text ??
            property.text.slice(1, -1))
        : property.text;
    return SECRET_LABEL_RE.test(name);
}
function literalPayload(text, sensitive) {
    if (sensitive && /[A-Za-z0-9]/.test(text))
        return redactSecretValue(text);
    // Only the entropy backstop needs an opening quote; labeled values must not consume it.
    return redactHighEntropyTokens('"' + scrubPayload(text) + '"').slice(1, -1);
}
function redactNode(node, sensitive = false) {
    const original = node.text;
    if (node.type === 'comment') {
        if (original.startsWith('#'))
            return '#' + scrubPayload(original.slice(1));
        return original.startsWith('/*')
            ? '/*' + scrubPayload(original.slice(2, -2)) + '*/'
            : '//' + scrubPayload(original.slice(2));
    }
    const stringStart = node.type === 'string' && node.firstNamedChild?.type === 'string_start'
        ? node.firstNamedChild
        : null;
    if (node.type === 'string' && !stringStart) {
        return original[0] + literalPayload(original.slice(1, -1), sensitive) + original.at(-1);
    }
    if (node.type === 'property_identifier' &&
        node.parent?.type === 'pair' &&
        node.parent.childForFieldName('key')?.id === node.id) {
        const payload = literalPayload(original, false);
        return payload === original ? original : '"' + payload + '"';
    }
    if (['number', 'integer', 'float'].includes(node.type) && sensitive)
        return `'${redactSecretValue(original)}'`;
    if (node.type === 'template_string' || stringStart) {
        const stringEnd = stringStart ? node.lastNamedChild : null;
        let result = stringStart?.text ?? '`';
        let offset = stringStart?.endIndex ?? node.startIndex + 1;
        for (const child of node.namedChildren) {
            if (child.type !== 'template_substitution' && child.type !== 'interpolation')
                continue;
            result += literalPayload(original.slice(offset - node.startIndex, child.startIndex - node.startIndex), sensitive);
            result += redactNode(child);
            offset = child.endIndex;
        }
        return (result +
            literalPayload(original.slice(offset - node.startIndex, (stringEnd?.startIndex ?? node.endIndex - 1) - node.startIndex), sensitive) +
            (stringEnd?.text ?? '`'));
    }
    if (node.type === 'regex_pattern' || node.type === 'jsx_text')
        return scrubPayload(original);
    // A bare `token: value` fragment is also a valid JS labeled statement.
    if (node.type === 'labeled_statement' && secretLabel(node.childForFieldName('label'))) {
        const body = node.childForFieldName('body');
        if (body?.firstNamedChild?.type === 'identifier')
            return scrubPayload(original);
    }
    let value = null;
    let key = null;
    if ([
        'variable_declarator',
        'pair',
        'public_field_definition',
        'assignment_pattern',
        'required_parameter',
        'default_parameter',
        'typed_default_parameter',
        'keyword_argument',
    ].includes(node.type)) {
        key =
            node.childForFieldName('name') ??
                node.childForFieldName('key') ??
                node.childForFieldName('pattern') ??
                node.childForFieldName('left');
        value = node.childForFieldName('value') ?? node.childForFieldName('right');
    }
    else if (['assignment_expression', 'assignment', 'augmented_assignment', 'named_expression'].includes(node.type)) {
        key = node.childForFieldName('left');
        value = node.childForFieldName('right');
    }
    else if (node.type === 'jsx_attribute') {
        [key = null, value = null] = node.namedChildren;
    }
    const labeled = secretLabel(key);
    let result = '';
    let offset = node.startIndex;
    for (const child of node.namedChildren) {
        result += original.slice(offset - node.startIndex, child.startIndex - node.startIndex);
        // Carry labels through value wrappers, never through call arguments or conditions.
        const carry = sensitive &&
            (node.type === 'array' ||
                node.type === 'object' ||
                (node.type === 'pair' && child.id === value?.id) ||
                (node.type === 'unary_expression' && child.id === node.childForFieldName('argument')?.id) ||
                node.type === 'concatenated_string' ||
                node.type === 'binary_operator' ||
                node.type === 'unary_operator' ||
                (node.type === 'call' && child.id === node.childForFieldName('function')?.id) ||
                (node.type === 'attribute' && child.id === node.childForFieldName('object')?.id) ||
                (node.type === 'conditional_expression' && child.id !== node.namedChildren[1]?.id) ||
                ([
                    'parenthesized_expression',
                    'as_expression',
                    'satisfies_expression',
                    'non_null_expression',
                ].includes(node.type) &&
                    child.id === node.firstNamedChild?.id) ||
                (node.type === 'type_assertion' && child.id === node.lastNamedChild?.id) ||
                (['binary_expression', 'boolean_operator'].includes(node.type) &&
                    ['+', '||', '&&', '??', 'or', 'and'].includes(node.childForFieldName('operator')?.text ?? '')) ||
                (node.type === 'ternary_expression' &&
                    child.id !== node.childForFieldName('condition')?.id));
        result += redactNode(child, carry || (labeled && child.id === value?.id));
        offset = child.endIndex;
    }
    return result + original.slice(offset - node.startIndex);
}
/** Sanitize parser-owned payload spans; no SFC boundary is inferred from text matching. */
/**
 * Apply replacement spans to `text` in one pass, or null when two overlap
 * (or a span is malformed).
 * The result equals applying them one at a time from the last start to the
 * first (spans that start together: the one added later lands first), which
 * is what the Vue scrubber did with a slice-and-concatenate per edit; that
 * copied the whole file for every edit, about 40 s for a 1 MB component.
 */
export function applySpanEdits(text, edits) {
    // Stable sort, then reversed: ascending start, and among equal starts the
    // later-added edit first, exactly as the one-at-a-time order placed them.
    const ordered = [...edits].sort((a, b) => b.start - a.start).reverse();
    const pieces = [];
    let offset = 0;
    for (const e of ordered) {
        if (e.start < offset || e.end < e.start || e.end > text.length)
            return null;
        pieces.push(text.slice(offset, e.start), e.clean);
        offset = e.end;
    }
    pieces.push(text.slice(offset));
    return pieces.join('');
}
async function scrubVueSource(text) {
    if (!text)
        return text;
    const parsed = await parseVueSource(text, true);
    const fallback = () => (text.startsWith(VUE_FIDELITY_MARKER) ? '' : VUE_FIDELITY_MARKER) + scrubPayload(text);
    if ('reason' in parsed)
        return fallback();
    const { descriptor, nodeTypes: VueNodeTypes } = parsed;
    const edits = [];
    let faithful = true;
    const script = descriptor.scriptSetup ?? descriptor.script;
    // Reuse exactly the JS/TS AST literal/comment rules, with their existing credential engine.
    const grammar = await loadGrammar(script?.lang === 'ts' ? 'typescript' : 'javascript');
    if ('unavailable' in grammar)
        return fallback();
    const parser = new Parser();
    parser.setLanguage(grammar.ok.language);
    const syntaxPayload = (source, sensitive = false, expression = false, decoded = source) => {
        if (decoded !== source) {
            const clean = syntaxPayload(decoded, sensitive, expression);
            if (clean === decoded)
                return source;
            faithful = false;
            // Entity decoding has no raw literal-span proof. Keep valid HTML and withhold graph facts.
            if (JSON.stringify(clean.match(/\r\n|\r|\n/g)) !== JSON.stringify(source.match(/\r\n|\r|\n/g)))
                return literalPayload(source, true);
            return clean
                .replace(/&/g, '&amp;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
        }
        const prefix = expression ? `const ${sensitive ? 'password' : '__mnemonik_vue'} = (` : '';
        const suffix = expression ? '\n);' : '';
        const full = prefix + source + suffix;
        const tree = parser.parse(full);
        try {
            if (!tree || tree.rootNode.hasError) {
                const clean = sensitive ? redactSecretValue(source) : scrubPayload(source);
                // Unsupported sensitive values cannot establish source fidelity.
                if (!expression || sensitive || clean !== source)
                    faithful = false;
                return clean;
            }
            const clean = full.slice(0, tree.rootNode.startIndex) +
                redactNode(tree.rootNode) +
                full.slice(tree.rootNode.endIndex);
            return clean.slice(prefix.length, clean.length - suffix.length);
        }
        finally {
            tree?.delete();
        }
    };
    const edit = (start, end, clean) => {
        edits.push({ start, end, clean });
    };
    try {
        if (script)
            edit(script.loc.start.offset, script.loc.end.offset, syntaxPayload(script.content));
        walkVueTemplate(parsed, (node) => {
            if (node.type === VueNodeTypes.TEXT)
                edit(node.loc.start.offset, node.loc.end.offset, literalPayload(node.loc.source, false));
            if (node.type === VueNodeTypes.COMMENT)
                edit(node.loc.start.offset, node.loc.end.offset, '<!--' + scrubPayload(node.loc.source.slice(4, -3)) + '-->');
            if (node.type === VueNodeTypes.INTERPOLATION &&
                node.content.type === VueNodeTypes.SIMPLE_EXPRESSION)
                edit(node.content.loc.start.offset, node.content.loc.end.offset, syntaxPayload(node.content.loc.source, false, true, node.content.content));
            if (node.type !== VueNodeTypes.ELEMENT)
                return;
            for (const prop of node.props) {
                if (prop.type === VueNodeTypes.ATTRIBUTE && prop.value) {
                    const raw = prop.value.loc.source;
                    const quoted = raw.startsWith('"') || raw.startsWith("'");
                    edit(prop.value.loc.start.offset, prop.value.loc.end.offset, quoted
                        ? raw.slice(0, 1) +
                            literalPayload(raw.slice(1, -1), SECRET_LABEL_RE.test(prop.name)) +
                            raw.slice(-1)
                        : literalPayload(raw, SECRET_LABEL_RE.test(prop.name)));
                }
                if (prop.type !== VueNodeTypes.DIRECTIVE)
                    continue;
                if (prop.exp?.type === VueNodeTypes.SIMPLE_EXPRESSION)
                    edit(prop.exp.loc.start.offset, prop.exp.loc.end.offset, syntaxPayload(prop.exp.loc.source, prop.arg?.type === VueNodeTypes.SIMPLE_EXPRESSION &&
                        prop.arg.isStatic &&
                        SECRET_LABEL_RE.test(prop.arg.content), true, prop.exp.content));
                if (prop.arg?.type === VueNodeTypes.SIMPLE_EXPRESSION && !prop.arg.isStatic)
                    edit(prop.arg.loc.start.offset, prop.arg.loc.end.offset, syntaxPayload(prop.arg.loc.source, false, true, prop.arg.content));
            }
        });
        for (const style of descriptor.styles) {
            const clean = scrubPayload(style.content);
            // No CSS/preprocessor AST proof is claimed. Changed opaque content blocks graph publication.
            if (clean !== style.content)
                faithful = false;
            edit(style.loc.start.offset, style.loc.end.offset, clean);
        }
        // Descriptor gaps contain outer tags/comments, not executable script/template bodies.
        // Policy still applies there; altered opaque boundaries cannot establish graph fidelity.
        const blocks = [script, descriptor.template, ...descriptor.styles]
            .filter((b) => b !== null && b !== undefined)
            .sort((a, b) => a.loc.start.offset - b.loc.start.offset);
        let gapStart = 0;
        for (const block of blocks) {
            const gap = text.slice(gapStart, block.loc.start.offset);
            const clean = scrubPayload(gap);
            if (clean !== gap)
                faithful = false;
            edit(gapStart, block.loc.start.offset, clean);
            gapStart = block.loc.end.offset;
        }
        const tail = text.slice(gapStart);
        const cleanTail = scrubPayload(tail);
        if (cleanTail !== tail)
            faithful = false;
        edit(gapStart, text.length, cleanTail);
        const clean = applySpanEdits(text, edits);
        if (clean === null)
            return fallback();
        if ('reason' in (await parseVueSource(clean)))
            faithful = false;
        return faithful || clean.startsWith(VUE_FIDELITY_MARKER) ? clean : VUE_FIDELITY_MARKER + clean;
    }
    catch {
        return fallback();
    }
    finally {
        parser.delete();
    }
}
/** Official component offsets delimit payloads; existing JS/TS rules handle script expressions. */
async function scrubSvelteSource(text) {
    const marker = '<!-- mnemonik:svelte-source-fidelity-unavailable -->\n';
    const fallback = () => (text.startsWith(marker) ? '' : marker) + scrubPayload(text);
    if (!text)
        return text;
    if (text.includes('mnemonik:svelte-source-fidelity-unavailable'))
        return fallback();
    if (Buffer.byteLength(text, 'utf8') > MAX_SOURCE_REDACTION_BYTES)
        return fallback();
    let parser;
    try {
        // No clock and no node count decide this file: both refused large
        // components outright (a 4 s deadline and 200,000 nodes). Memory is
        // bounded by the process the parse runs in (installSourceRedactor).
        const { parse } = await import('svelte/compiler');
        const ast = parse(text, { modern: true });
        const edits = [];
        let faithful = true;
        // Grammars first: loading one initializes tree-sitter, and a Parser
        // constructed before that throws. In a fresh process (a redaction child,
        // or a scanner whose first file is a component) that made every Svelte
        // file take the unfaithful fallback.
        const js = await loadGrammar('javascript');
        const ts = await loadGrammar('typescript');
        if ('unavailable' in js || 'unavailable' in ts)
            return fallback();
        parser = new Parser();
        parser.setLanguage(js.ok.language);
        const activeParser = parser;
        const syntax = (source, expression = false, sensitive = false) => {
            const prefix = expression ? `const ${sensitive ? 'password' : '__mnemonik_svelte'} = (` : '';
            const suffix = expression ? '\n);' : '';
            const full = prefix + source + suffix;
            const tree = activeParser.parse(full);
            try {
                if (!tree || tree.rootNode.hasError) {
                    faithful = false;
                    return sensitive ? literalPayload(source, true) : scrubPayload(source);
                }
                const clean = full.slice(0, tree.rootNode.startIndex) +
                    redactNode(tree.rootNode) +
                    full.slice(tree.rootNode.endIndex);
                return clean.slice(prefix.length, clean.length - suffix.length);
            }
            finally {
                tree?.delete();
            }
        };
        const edit = (start, end, clean) => {
            if (typeof start !== 'number' ||
                typeof end !== 'number' ||
                start < 0 ||
                end < start ||
                end > text.length)
                throw new Error('Component offsets unavailable');
            edits.push({ start, end, clean: clean(text.slice(start, end)) });
        };
        let templateTs = false;
        for (const script of [ast.module, ast.instance]) {
            if (!script)
                continue;
            const lang = script.attributes.find((a) => a.name === 'lang');
            const language = !lang
                ? 'js'
                : Array.isArray(lang.value) && lang.value.length === 1 && lang.value[0]?.type === 'Text'
                    ? lang.value[0].data
                    : null;
            if (!['js', 'ts'].includes(language ?? '') || script.attributes.some((a) => a.name === 'src'))
                return fallback();
            parser.setLanguage(language === 'ts' ? ts.ok.language : js.ok.language);
            const offsets = script.content;
            edit(offsets.start, offsets.end, (raw) => syntax(raw));
            if (script === ast.instance)
                templateTs = language === 'ts';
        }
        parser.setLanguage(templateTs ? ts.ok.language : js.ok.language);
        const pending = [
            { value: ast.fragment, sensitive: false },
        ];
        while (pending.length) {
            const entry = pending.pop();
            if (!entry || !entry.value || typeof entry.value !== 'object')
                continue;
            if (Array.isArray(entry.value)) {
                for (const value of entry.value)
                    pending.push({ value, sensitive: entry.sensitive });
                continue;
            }
            const node = entry.value;
            const type = typeof node.type === 'string' ? node.type : '';
            if (type === 'Text') {
                edit(node.start, node.end, (raw) => literalPayload(raw, entry.sensitive));
                continue;
            }
            if (type === 'Comment') {
                edit(node.start, node.end, (raw) => '<!--' + scrubPayload(raw.slice(4, -3)) + '-->');
                continue;
            }
            if (/Expression$/.test(type) ||
                ['Identifier', 'Literal', 'TemplateLiteral', 'VariableDeclaration'].includes(type)) {
                edit(node.start, node.end, (raw) => syntax(raw, type !== 'VariableDeclaration', entry.sensitive));
                continue;
            }
            const sensitive = entry.sensitive ||
                (type === 'Attribute' && typeof node.name === 'string' && SECRET_LABEL_RE.test(node.name));
            for (const [key, value] of Object.entries(node))
                if (key !== 'parent' && value && typeof value === 'object')
                    pending.push({ value, sensitive });
        }
        if (ast.css)
            edit(ast.css.start, ast.css.end, (raw) => {
                const clean = scrubPayload(raw);
                if (clean !== raw)
                    faithful = false;
                return clean;
            });
        // Unparsed tags and boundaries cannot establish fidelity if policy changes them.
        edits.sort((a, b) => a.start - b.start);
        let offset = 0;
        let clean = '';
        for (const e of edits) {
            if (e.start < offset)
                return fallback();
            const gap = text.slice(offset, e.start);
            const cleanGap = scrubPayload(gap);
            if (gap !== cleanGap)
                faithful = false;
            clean += cleanGap + e.clean;
            offset = e.end;
        }
        const tail = text.slice(offset);
        const cleanTail = scrubPayload(tail);
        if (tail !== cleanTail)
            faithful = false;
        clean += cleanTail;
        parse(clean, { modern: true });
        return faithful ? clean : marker + clean;
    }
    catch {
        return fallback();
    }
    finally {
        parser?.delete();
    }
}
//# sourceMappingURL=sourceRedaction.js.map