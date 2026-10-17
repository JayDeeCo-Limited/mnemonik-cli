import { extname } from 'node:path';
import { Parser, type Node, type Tree } from 'web-tree-sitter';
import { loadGrammar } from './ast/grammars.js';
import { MAX_AST_PARSE_BYTES } from './ast/astChunker.js';
import { redactCredentials } from './redactCredentials.js';
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
    return text.slice(0, root.startIndex) + redactNode(root) + text.slice(root.endIndex);
  } catch {
    return scrubPayload(text);
  } finally {
    tree?.delete();
    parser?.delete();
  }
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
