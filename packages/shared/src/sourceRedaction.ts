import { extname } from 'node:path';
import { Parser, type Node, type Tree } from 'web-tree-sitter';
import { loadGrammar } from './ast/grammars.js';
import { MAX_AST_PARSE_BYTES } from './ast/astChunker.js';
import { commandLineCredentialRanges, redactCredentials } from './redactCredentials.js';
import {
  redactHighEntropyTokens,
  redactSecretValue,
  scrubSecrets,
  SECRET_LABEL_RE,
} from './secretPatterns.js';

function scrubPayload(text: string): string {
  return redactCredentials(scrubSecrets(text), { commandLineOnly: true }).text;
}

/** Source syntax stays executable; unsupported or incomplete input uses the conservative scrubber. */
export async function scrubSourceSecrets(text: string, filePath: string): Promise<string> {
  const extension = extname(filePath).toLowerCase();
  const language = ['.ts', '.mts', '.cts'].includes(extension)
    ? 'typescript'
    : extension === '.tsx'
      ? 'tsx'
      : ['.js', '.jsx', '.mjs', '.cjs'].includes(extension)
        ? 'javascript'
        : ['.py', '.pyi'].includes(extension)
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
                    : null;
  if (!text || !language || Buffer.byteLength(text, 'utf8') > MAX_AST_PARSE_BYTES) {
    return scrubPayload(text);
  }
  let parser: Parser | undefined;
  let tree: Tree | null = null;
  try {
    const grammar = await loadGrammar(language);
    if ('unavailable' in grammar) return scrubPayload(text);
    parser = new Parser();
    parser.setLanguage(grammar.ok.language);
    tree = parser.parse(text);
    if (!tree || tree.rootNode.hasError) return scrubPayload(text);
    const root = tree.rootNode;

    const redacted =
      language === 'bash'
        ? redactShellNode(root, commandLineCredentialRanges(text))
        : language === 'swift'
          ? redactSwiftNode(root)
          : language === 'sql'
            ? redactSqlNode(root)
            : language === 'lua'
              ? redactLuaNode(root)
              : language === 'rust'
                ? redactRustNode(root)
                : redactNode(root);
    return text.slice(0, root.startIndex) + redacted + text.slice(root.endIndex);
  } catch {
    return scrubPayload(text);
  } finally {
    tree?.delete();
    parser?.delete();
  }
}

/** Rust raw/byte prefixes belong to the delimiter, never to the credential payload. */
function redactRustNode(node: Node, sensitive = false, labeled = new Set<number>()): string {
  sensitive ||= labeled.has(node.id);
  const original = node.text;
  const type = node.type;
  if (type === 'line_comment') return '//' + scrubPayload(original.slice(2));
  if (type === 'block_comment') return '/*' + scrubPayload(original.slice(2, -2)) + '*/';
  if (sensitive && ['integer_literal', 'float_literal', 'char_literal'].includes(type))
    return '"' + redactSecretValue(original) + '"';
  if (type === 'string_literal' || type === 'raw_string_literal') {
    const start = original.indexOf('"') + 1;
    const end = original.lastIndexOf('"');
    return (
      original.slice(0, start) +
      literalPayload(original.slice(start, end), sensitive) +
      original.slice(end)
    );
  }
  const label = (key: Node | null): boolean => {
    if (!key) return false;
    const name = (key.childForFieldName('field') ?? key).text;
    return SECRET_LABEL_RE.test(
      ['string_literal', 'raw_string_literal'].includes(key.type)
        ? name.slice(name.indexOf('"') + 1, name.lastIndexOf('"'))
        : name.replace(/^r#/, '')
    );
  };
  const mark = (pattern: Node | null, value: Node | null): void => {
    if (!pattern || !value) return;
    if (['ref_pattern', 'mut_pattern', 'reference_pattern'].includes(pattern.type)) {
      mark(pattern.firstNamedChild, value);
      return;
    }
    if (label(pattern)) labeled.add(value.id);
    else if (pattern.type === 'tuple_pattern' && value.type === 'tuple_expression')
      pattern.namedChildren.forEach((part, index) =>
        mark(part, value.namedChildren[index] ?? null)
      );
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
    const children = node.children.filter(
      (child) => !['line_comment', 'block_comment'].includes(child.type)
    );
    let valueSensitive = sensitive;
    let genericDepth = 0;
    for (const [index, child] of children.entries()) {
      const previous = children[index - 1];
      // Token trees flatten type arguments too. Their commas and associated-type
      // bindings are not macro value boundaries; const arguments are not values.
      if (
        child.text === '<' &&
        (genericDepth > 0 || ['::', '=', ':', '('].includes(previous?.text ?? ''))
      ) {
        genericDepth++;
        continue;
      }
      if (genericDepth > 0) {
        if (child.text === '>' || child.text === '>>') genericDepth -= child.text.length;
        genericDepth = Math.max(0, genericDepth);
        continue;
      }
      const nextKey = children[index + 1];
      const nextBinding =
        nextKey &&
        ['identifier', 'string_literal', 'raw_string_literal'].includes(nextKey.type) &&
        ['=', ':'].includes(children[index + 2]?.text ?? '');
      if (child.text === ';' || (child.text === ',' && nextBinding)) valueSensitive = sensitive;
      else if (['=', ':'].includes(child.text) && label(previous ?? null)) valueSensitive = true;
      else if (valueSensitive) {
        const callArguments =
          child.type === 'token_tree' &&
          child.text.startsWith('(') &&
          (previous?.type === 'identifier' ||
            ['>', ')', ']'].includes(previous?.text.at(-1) ?? ''));
        const key = children[index + 1]?.text === ':';
        if (!callArguments && !key) labeled.add(child.id);
      }
    }
  }
  let result = '';
  let offset = node.startIndex;
  for (const child of node.namedChildren) {
    result += original.slice(offset - node.startIndex, child.startIndex - node.startIndex);
    // Carry a secret label through value wrappers, never into runtime call arguments/conditions.
    const carry =
      sensitive &&
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
function redactLuaNode(node: Node, sensitive = false, labeled = new Set<number>()): string {
  sensitive ||= labeled.has(node.id);
  const original = node.text;
  if (node.type === 'string' || node.type === 'comment') {
    const content = node.childForFieldName('content');
    if (!content) return original;
    const suffix = original.slice(content.endIndex - node.startIndex);
    let payload =
      node.type === 'comment'
        ? scrubPayload(content.text)
        : literalPayload(content.text, sensitive);
    if (payload !== content.text && suffix.startsWith(']')) {
      // A placeholder must not introduce a closing long bracket, including at the boundary.
      payload = payload.split(suffix).join('] ' + suffix.slice(1));
      if ((payload + suffix).indexOf(suffix) < payload.length) payload += ' ';
    }
    return original.slice(0, content.startIndex - node.startIndex) + payload + suffix;
  }
  if (node.type === 'number' && sensitive) return "'" + redactSecretValue(original) + "'";
  const label = (key: Node | null): boolean => {
    if (key?.type === 'bracket_index_expression') {
      const field = key.childForFieldName('field');
      return field?.type === 'string' && secretLabel(field);
    }
    return secretLabel(key?.type === 'dot_index_expression' ? key.childForFieldName('field') : key);
  };
  if (node.type === 'assignment_statement') {
    const names =
      node.namedChildren.find((child) => child.type === 'variable_list')?.namedChildren ?? [];
    const values =
      node.namedChildren.find((child) => child.type === 'expression_list')?.namedChildren ?? [];
    values.forEach((value, index) => {
      if (label(names[index] ?? null)) labeled.add(value.id);
    });
  } else if (node.type === 'field' && label(node.childForFieldName('name'))) {
    const value = node.childForFieldName('value');
    if (value) labeled.add(value.id);
  }
  const carry =
    sensitive &&
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

function sqlSecretLabel(node: Node | null): boolean {
  if (!node) return false;
  if (['field', 'object_reference', 'column'].includes(node.type))
    return sqlSecretLabel(node.childForFieldName('name') ?? node.firstNamedChild);
  // This dialect-neutral grammar sometimes calls PostgreSQL quoted identifiers literals.
  if (node.type === 'identifier' || (node.type === 'literal' && node.text.startsWith('"')))
    return SECRET_LABEL_RE.test(node.text.replace(/^"|"$/g, '').replaceAll('""', '"'));
  return false;
}

function redactSqlNode(node: Node, sensitive = false): string {
  if (node.type === 'create_function') {
    const language = node.namedChildren.find((child) => child.type === 'function_language');
    const body = node.namedChildren.find((child) => child.type === 'function_body');
    // Opaque/procedural bodies have no established inner syntax; the caller uses fallback.
    if (
      language?.namedChildren.find((child) => child.type === 'identifier')?.text.toLowerCase() !==
        'sql' ||
      body?.namedChildren.some((child) => child.type === 'literal')
    )
      throw new Error('Opaque SQL function body');
  }
  const original = node.text;
  if (node.type === 'comment') return '--' + scrubPayload(original.slice(2));
  if (node.type === 'marginalia') return '/*' + scrubPayload(original.slice(2, -2)) + '*/';
  if (node.type === 'literal') {
    if (original.startsWith('"')) return original; // PostgreSQL identifier, never a secret value.
    const opening = /^(?:[eEnNbBxX]|[uU]&)?'|^\$[A-Za-z_0-9]*\$/.exec(original)?.[0];
    if (opening) {
      const closing = opening.startsWith('$') ? opening : "'";
      if (!original.endsWith(closing)) throw new Error('Incomplete SQL literal');
      const payload = original.slice(opening.length, -closing.length);
      // Scrub the whole payload on a match: SQL doubled quotes must not leave a secret suffix.
      const redacted = literalPayload(payload, sensitive);
      return opening + (redacted === payload ? payload : redactSecretValue(payload)) + closing;
    }
    if (node.namedChildren.some((child) => child.type.startsWith('keyword_'))) return original;
    if (/^[+\-\d.]/.test(original))
      return sensitive ? "'" + redactSecretValue(original) + "'" : original;
    // shortcut: unrecognized typed literals use fallback until their boundaries are established.
    throw new Error('Unsupported SQL literal');
  }
  const left = node.childForFieldName('left');
  const right = node.childForFieldName('right');
  const labeled = ['assignment', 'binary_expression'].includes(node.type) && sqlSecretLabel(left);
  const columnLabel =
    node.type === 'column_definition' && sqlSecretLabel(node.childForFieldName('name'));
  const argumentLabel =
    node.type === 'function_argument' &&
    sqlSecretLabel(node.namedChildren.find((child) => child.type === 'identifier') ?? null);
  const aliasLabel = node.type === 'term' && sqlSecretLabel(node.childForFieldName('alias'));
  const insert = node.type === 'list' && node.parent?.type === 'insert' ? node.parent : null;
  const columns = insert?.namedChildren.find((child) => child.type === 'list');
  const columnValues =
    columns?.namedChildren.some((child) => child.type === 'column') && columns.id !== node.id
      ? columns.namedChildren.filter((child) => !['comment', 'marginalia'].includes(child.type))
      : [];

  let result = '';
  let offset = node.startIndex;
  let index = 0;
  let previous: Node | null = null;
  for (const child of node.namedChildren) {
    result += original.slice(offset - node.startIndex, child.startIndex - node.startIndex);
    const carry =
      sensitive &&
      ((node.type === 'binary_expression' && node.childForFieldName('operator')?.text === '||') ||
        (node.type === 'cast' &&
          child.id ===
            (
              node.childForFieldName('parameter') ??
              node.namedChildren.find((part) => !['comment', 'marginalia'].includes(part.type))
            )?.id) ||
        ['list', 'array', 'parenthesized_expression'].includes(node.type) ||
        (node.type === 'case' &&
          (previous?.type === 'keyword_then' || previous?.type === 'keyword_else')));
    result += redactSqlNode(
      child,
      carry ||
        (labeled && child.id === right?.id) ||
        (node.type === 'binary_expression' && sqlSecretLabel(right) && child.id === left?.id) ||
        (columnLabel && previous?.type === 'keyword_default') ||
        (argumentLabel && child.type === 'literal') ||
        (aliasLabel && child.id === node.childForFieldName('value')?.id) ||
        child.id === node.childForFieldName('password')?.id ||
        sqlSecretLabel(columnValues[index] ?? null)
    );
    if (!['comment', 'marginalia'].includes(child.type)) {
      previous = child;
      index++;
    }
    offset = child.endIndex;
  }
  return result + original.slice(offset - node.startIndex);
}

function swiftSecretLabel(node: Node | null): boolean {
  if (!node) return false;
  if (node.type.endsWith('string_literal')) {
    const opening = /^(#+)?("""|")/.exec(node.text);
    return Boolean(
      opening && SECRET_LABEL_RE.test(node.text.slice(opening[0].length, -opening[0].length))
    );
  }
  if (['simple_identifier', 'type_identifier'].includes(node.type))
    return SECRET_LABEL_RE.test(node.text.replace(/^`|`$/g, ''));
  return swiftSecretLabel(
    node.childForFieldName('suffix') ??
      node.childForFieldName('bound_identifier') ??
      node.childForFieldName('name') ??
      node.firstNamedChild
  );
}

function redactSwiftNode(node: Node, sensitive = false): string {
  const original = node.text;
  if (node.type === 'comment' || node.type === 'multiline_comment') {
    // Swift permits nested block comments; retain every delimiter from the parsed comment.
    return original
      .split(/(\/\*|\*\/)/)
      .map((part) => (part === '/*' || part === '*/' ? part : scrubPayload(part)))
      .join('');
  }
  if (
    ['line_string_literal', 'multi_line_string_literal', 'raw_string_literal'].includes(node.type)
  ) {
    const opening = /^(#+)?("""|")/.exec(original);
    if (!opening) throw new Error('Swift string delimiter unavailable');
    const closing = opening[2] + (opening[1] ?? '');
    if (!original.endsWith(closing)) throw new Error('Swift string is incomplete');
    const payload = (text: string): string => {
      if (opening[2] !== '"""') return literalPayload(text, sensitive);
      // Keep required opening newlines/closing indentation; scrub multiline secrets together.
      const leading = /^\s*/.exec(text)?.[0] ?? '';
      const body = text.slice(leading.length);
      const trailing = /\s*$/.exec(body)?.[0] ?? '';
      return (
        leading + literalPayload(body.slice(0, body.length - trailing.length), sensitive) + trailing
      );
    };
    let result = opening[0];
    let offset = node.startIndex + opening[0].length;
    for (const child of node.children) {
      if (!['\\(', ')', 'interpolated_expression', 'raw_str_interpolation'].includes(child.type))
        continue;
      result += payload(
        original.slice(offset - node.startIndex, child.startIndex - node.startIndex)
      );
      result += redactSwiftNode(child);
      offset = child.endIndex;
    }
    return result + payload(original.slice(offset - node.startIndex, -closing.length)) + closing;
  }
  if (sensitive && ['integer_literal', 'real_literal'].includes(node.type))
    return '"' + redactSecretValue(original) + '"';

  let labeled =
    node.type === 'assignment'
      ? swiftSecretLabel(node.childForFieldName('target'))
      : node.type === 'value_argument'
        ? swiftSecretLabel(node.childForFieldName('name'))
        : false;
  let result = '';
  let offset = node.startIndex;
  for (const [index, child] of node.children.entries()) {
    const field = node.fieldNameForChild(index);
    if (
      (node.type === 'property_declaration' && field === 'name') ||
      (node.type === 'dictionary_literal' && field === 'key') ||
      child.type === 'parameter'
    )
      labeled = swiftSecretLabel(child);
    const value =
      (field === 'value' &&
        ['property_declaration', 'dictionary_literal', 'value_argument'].includes(node.type)) ||
      (field === 'result' && node.type === 'assignment') ||
      field === 'default_value';
    const carry =
      sensitive &&
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

function redactShellNode(
  root: Node,
  ranges: ReturnType<typeof commandLineCredentialRanges>
): string {
  for (const range of ranges) {
    let literal = root.descendantForIndex(range.start, range.start);
    while (literal && !['word', 'string', 'raw_string', 'ansi_c_string'].includes(literal.type))
      literal = literal.parent;
    // Regex rules can stop at an escaped quote/space; the AST owns the complete literal.
    if (literal) range.end = Math.max(range.end, literal.endIndex);
  }
  let rangeIndex = 0;
  const payload = (text: string, start: number, sensitive: boolean, boundary: number): string => {
    while (rangeIndex < ranges.length) {
      const range = ranges[rangeIndex];
      if (!range || range.end > start) break;
      rangeIndex++;
    }
    let result = '';
    let offset = start;
    for (let i = rangeIndex; i < ranges.length; i++) {
      const range = ranges[i];
      if (!range || range.start >= start + text.length) break;
      if (range.start < boundary) continue;
      const begin = Math.max(offset, range.start);
      const end = Math.min(start + text.length, range.end);
      if (begin >= end) continue;
      result +=
        text.slice(offset - start, begin - start) +
        redactSecretValue(text.slice(begin - start, end - start));
      offset = end;
    }
    return literalPayload(result + text.slice(offset - start), sensitive);
  };
  const visit = (node: Node, sensitive = false, boundary = 0): string => {
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
        if (!range || range.start > node.startIndex) break;
        if (range.start >= boundary && range.end >= node.endIndex) sensitive = true;
      }
      boundary = node.startIndex;
      // Defaults/alternates are value literals; the parameter name remains a reference.
      sensitive = sensitive && /^:?[+=-]$/.test(node.childForFieldName('operator')?.text ?? '');
    }
    if (node.type === 'comment') return '#' + scrubPayload(original.slice(1));
    if (node.type === 'raw_string' || node.type === 'ansi_c_string') {
      const prefix = node.type === 'ansi_c_string' ? 2 : 1;
      return (
        original.slice(0, prefix) +
        payload(original.slice(prefix, -1), node.startIndex + prefix, sensitive, boundary) +
        "'"
      );
    }
    if (node.type === 'word') {
      if (
        node.parent?.type === 'command_name' ||
        node.id === node.parent?.childForFieldName('name')?.id
      )
        return original;
      const redacted = payload(original, node.startIndex, sensitive, boundary);
      return redacted === original ? original : "'" + redacted.replaceAll("'", "'\\''") + "'";
    }
    const isText = node.type === 'string' || node.type === 'heredoc_body';
    const value = node.type === 'variable_assignment' ? node.childForFieldName('value') : null;
    const labeled = value && secretLabel(node.childForFieldName('name'));
    const children = isText
      ? node.namedChildren.filter(
          (child) => !['string_content', 'heredoc_content'].includes(child.type)
        )
      : node.namedChildren;
    let result = node.type === 'string' ? '"' : '';
    let offset = node.startIndex + (node.type === 'string' ? 1 : 0);
    for (const child of children) {
      const gap = original.slice(offset - node.startIndex, child.startIndex - node.startIndex);
      result += isText ? payload(gap, offset, sensitive, boundary) : gap;
      result += visit(
        child,
        (sensitive &&
          (isText ||
            node.type === 'concatenation' ||
            (node.type === 'expansion' && child.type !== 'variable_name'))) ||
          Boolean(labeled && child.id === value?.id),
        boundary
      );
      offset = child.endIndex;
    }
    const end = node.endIndex - (node.type === 'string' ? 1 : 0);
    const tail = original.slice(offset - node.startIndex, end - node.startIndex);
    return (
      result +
      (isText ? payload(tail, offset, sensitive, boundary) : tail) +
      (node.type === 'string' ? '"' : '')
    );
  };
  return visit(root);
}

function secretLabel(node: Node | null): boolean {
  if (!node) return false;
  const property =
    node.childForFieldName('property') ?? node.childForFieldName('attribute') ?? node;
  const name =
    property.type === 'string'
      ? (property.namedChildren.find((child) => child.type === 'string_content')?.text ??
        property.text.slice(1, -1))
      : property.text;
  return SECRET_LABEL_RE.test(name);
}

function literalPayload(text: string, sensitive: boolean): string {
  if (sensitive && /[A-Za-z0-9]/.test(text)) return redactSecretValue(text);
  // Only the entropy backstop needs an opening quote; labeled values must not consume it.
  return redactHighEntropyTokens('"' + scrubPayload(text) + '"').slice(1, -1);
}

function redactNode(node: Node, sensitive = false): string {
  const original = node.text;
  if (node.type === 'comment') {
    if (original.startsWith('#')) return '#' + scrubPayload(original.slice(1));
    return original.startsWith('/*')
      ? '/*' + scrubPayload(original.slice(2, -2)) + '*/'
      : '//' + scrubPayload(original.slice(2));
  }
  const stringStart =
    node.type === 'string' && node.firstNamedChild?.type === 'string_start'
      ? node.firstNamedChild
      : null;
  if (node.type === 'string' && !stringStart) {
    return original[0] + literalPayload(original.slice(1, -1), sensitive) + original.at(-1);
  }
  if (
    node.type === 'property_identifier' &&
    node.parent?.type === 'pair' &&
    node.parent.childForFieldName('key')?.id === node.id
  ) {
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
      if (child.type !== 'template_substitution' && child.type !== 'interpolation') continue;
      result += literalPayload(
        original.slice(offset - node.startIndex, child.startIndex - node.startIndex),
        sensitive
      );
      result += redactNode(child);
      offset = child.endIndex;
    }
    return (
      result +
      literalPayload(
        original.slice(
          offset - node.startIndex,
          (stringEnd?.startIndex ?? node.endIndex - 1) - node.startIndex
        ),
        sensitive
      ) +
      (stringEnd?.text ?? '`')
    );
  }
  if (node.type === 'regex_pattern' || node.type === 'jsx_text') return scrubPayload(original);
  // A bare `token: value` fragment is also a valid JS labeled statement.
  if (node.type === 'labeled_statement' && secretLabel(node.childForFieldName('label'))) {
    const body = node.childForFieldName('body');
    if (body?.firstNamedChild?.type === 'identifier') return scrubPayload(original);
  }

  let value: Node | null = null;
  let key: Node | null = null;
  if (
    [
      'variable_declarator',
      'pair',
      'public_field_definition',
      'assignment_pattern',
      'required_parameter',
      'default_parameter',
      'typed_default_parameter',
      'keyword_argument',
    ].includes(node.type)
  ) {
    key =
      node.childForFieldName('name') ??
      node.childForFieldName('key') ??
      node.childForFieldName('pattern') ??
      node.childForFieldName('left');
    value = node.childForFieldName('value') ?? node.childForFieldName('right');
  } else if (
    ['assignment_expression', 'assignment', 'augmented_assignment', 'named_expression'].includes(
      node.type
    )
  ) {
    key = node.childForFieldName('left');
    value = node.childForFieldName('right');
  } else if (node.type === 'jsx_attribute') {
    [key = null, value = null] = node.namedChildren;
  }
  const labeled = secretLabel(key);
  let result = '';
  let offset = node.startIndex;
  for (const child of node.namedChildren) {
    result += original.slice(offset - node.startIndex, child.startIndex - node.startIndex);
    // Carry labels through value wrappers, never through call arguments or conditions.
    const carry =
      sensitive &&
      (node.type === 'concatenated_string' ||
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
          ['+', '||', '&&', '??', 'or', 'and'].includes(
            node.childForFieldName('operator')?.text ?? ''
          )) ||
        (node.type === 'ternary_expression' &&
          child.id !== node.childForFieldName('condition')?.id));
    result += redactNode(child, carry || (labeled && child.id === value?.id));
    offset = child.endIndex;
  }
  return result + original.slice(offset - node.startIndex);
}
