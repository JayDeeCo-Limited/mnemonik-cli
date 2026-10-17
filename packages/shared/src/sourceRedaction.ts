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
        : redactNode(root);
    return text.slice(0, root.startIndex) + redacted + text.slice(root.endIndex);
  } catch {
    return scrubPayload(text);
  } finally {
    tree?.delete();
    parser?.delete();
  }
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
