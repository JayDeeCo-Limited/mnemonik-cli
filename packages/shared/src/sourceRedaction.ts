import { parseVueSource, walkVueTemplate, VUE_FIDELITY_MARKER } from './vueSource.js';
import { basename, extname } from 'node:path';
import { Parser, type Node, type Tree } from 'web-tree-sitter';
import { loadGrammar, objcppSyntaxIssue } from './ast/grammars.js';
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
  if (extension === '.vue') return scrubVueSource(text);
  const language =
    extension === '.cmake' || basename(filePath) === 'CMakeLists.txt'
      ? 'cmake'
      : ['.ts', '.mts', '.cts'].includes(extension)
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
                        : extension === '.nix'
                          ? 'nix'
                          : extension === '.tf'
                            ? 'terraform'
                            : ['.m', '.mm'].includes(extension)
                              ? 'objcpp'
                              : extension === '.c'
                                ? 'c'
                                : ['.h', '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx'].includes(
                                      extension
                                    )
                                  ? 'cpp'
                                  : ['.groovy', '.gradle'].includes(extension)
                                    ? 'groovy'
                                    : ['.ps1', '.psm1'].includes(extension)
                                      ? 'powershell'
                                      : null;
  const fallback = (): string => {
    const clean = scrubPayload(text);
    if (!text) return clean;
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
    const marker =
      language === 'nix'
        ? '/* mnemonik:nix-source-fidelity-unavailable */'
        : '/* mnemonik:terraform-source-fidelity-unavailable */';
    return (language === 'terraform' || language === 'nix') && !clean.startsWith(marker)
      ? marker + clean
      : clean;
  };
  if (!text || !language || Buffer.byteLength(text, 'utf8') > MAX_AST_PARSE_BYTES) {
    return fallback();
  }
  let parser: Parser | undefined;
  let tree: Tree | null = null;
  try {
    const grammar = await loadGrammar(language);
    if ('unavailable' in grammar) return fallback();
    parser = new Parser();
    parser.setLanguage(grammar.ok.language);
    tree = parser.parse(text);
    if (!tree || tree.rootNode.hasError) return fallback();
    const root = tree.rootNode;
    if (language === 'objcpp' && objcppSyntaxIssue(root)) return fallback();

    const redacted =
      language === 'cmake'
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
    return text.slice(0, root.startIndex) + redacted + text.slice(root.endIndex);
  } catch {
    return fallback();
  } finally {
    tree?.delete();
    parser?.delete();
  }
}

/** CMake substitutions remain source expressions; only AST argument/comment payloads are scrubbed. */
function redactCmakeNode(node: Node, sensitive = false): string {
  const original = node.text;
  const type = node.type;
  const payload = (value: string): string =>
    sensitive && value.trim() ? redactSecretValue(value) : literalPayload(value, false);
  if (type === 'line_comment') return '#' + scrubPayload(original.slice(1));
  if (type === 'bracket_comment' || type === 'bracket_argument') {
    const payload = node.namedChildren.find((n) => n.type.endsWith('_content'));
    if (!payload) return original;
    const clean =
      type === 'bracket_comment'
        ? scrubPayload(payload.text)
        : sensitive
          ? redactSecretValue(payload.text)
          : literalPayload(payload.text, false);
    return (
      original.slice(0, payload.startIndex - node.startIndex) +
      clean +
      original.slice(payload.endIndex - node.startIndex)
    );
  }
  if (type === 'variable_ref') return original;
  if (type === 'escape_sequence') return sensitive ? redactSecretValue(original) : original;
  if (type === 'quoted_element' || type === 'unquoted_argument') {
    // Generator expressions have no inner AST in this grammar; withhold fidelity instead of rewriting them.
    if (original.includes('$<')) throw new Error('Opaque CMake generator expression');
    let result = '';
    let offset = node.startIndex;
    for (const child of node.namedChildren) {
      result += payload(
        original.slice(offset - node.startIndex, child.startIndex - node.startIndex)
      );
      result += redactCmakeNode(child, sensitive);
      offset = child.endIndex;
    }
    result += payload(original.slice(offset - node.startIndex));
    return type === 'unquoted_argument' && result !== original ? '"' + result + '"' : result;
  }
  const args =
    type === 'argument_list' ? node.namedChildren.filter((n) => n.type === 'argument') : [];
  const set =
    node.parent?.namedChildren.find((n) => n.type === 'identifier')?.text.toLowerCase() === 'set';
  const key = set ? args[0] : null;
  const label = key?.firstNamedChild;
  const literalKey =
    label?.type === 'unquoted_argument' && !label.namedChildCount
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
function redactPowershellNode(node: Node, sensitive = false): string {
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
    const payload = (text: string): string =>
      text
        // Retain quote/dollar/control escapes and physical continuation boundaries verbatim.
        .split(/(`(?:\r\n|[0abefnrtv`"'$\r\n])|''|\r\n|[\r\n])/g)
        .map((part, index) =>
          index % 2
            ? part
            : sensitive && part
              ? redactSecretValue(part)
              : literalPayload(part, false)
        )
        .join('');
    let result = original.slice(0, prefix);
    let offset = node.startIndex + prefix;
    for (const child of substitutions) {
      result += payload(
        original.slice(offset - node.startIndex, child.startIndex - node.startIndex)
      );
      result += redactPowershellNode(child); // Runtime references/subexpressions are not credential values.
      offset = child.endIndex;
    }
    return (
      result + payload(original.slice(offset - node.startIndex, -prefix)) + original.slice(-prefix)
    );
  }
  if (sensitive && type === 'generic_token') return literalPayload(original, true);
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
    else break;
  }
  if (label?.type === 'member_access')
    label = label.lastNamedChild?.firstNamedChild ?? label.lastNamedChild;
  const labelText = label?.type === 'string_literal' ? label.text.slice(1, -1) : label?.text;
  const labeled =
    !!labelText &&
    SECRET_LABEL_RE.test(
      labelText
        .replace(/^\$\{?|}$/g, '')
        .split(':')
        .at(-1) ?? ''
    );
  const valueWrapper =
    sensitive &&
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
    const argument =
      type === 'command_elements' &&
      !['command_parameter', 'command_argument_sep'].includes(child.type);
    result += redactPowershellNode(
      child,
      valueWrapper ||
        ((labeled || (sensitive && type === 'hash_entry')) && child.id === value?.id) ||
        (argument && argumentSensitive)
    );
    if (argument) argumentSensitive = false;
    offset = child.endIndex;
  }
  return result + original.slice(offset - node.startIndex);
}

/** Nix literal payloads have spans; lambda bodies and application arguments remain runtime code. */
function redactNixNode(node: Node, sensitive = false): string {
  const type = node.type;
  const original = node.text;
  if (type === 'comment') return redactNode(node);
  if (type === 'string_fragment')
    return sensitive ? redactSecretValue(original) : literalPayload(original, false);
  if (type === 'escape_sequence' || type === 'dollar_escape') return original;
  if (
    (type === 'integer_expression' ||
      type === 'float_expression' ||
      (type === 'unary_expression' &&
        ['integer_expression', 'float_expression'].includes(
          node.childForFieldName('argument')?.type ?? ''
        ))) &&
    sensitive
  )
    return '"' + redactSecretValue(original) + '"';
  if (type === 'uri_expression') {
    const clean = literalPayload(original, sensitive);
    return clean === original ? original : JSON.stringify(clean);
  }
  if (
    ['path_expression', 'hpath_expression', 'spath_expression'].includes(type) &&
    (sensitive || scrubPayload(original) !== original)
  )
    throw new Error('Nix path fidelity unavailable');
  const key = type === 'binding' ? node.childForFieldName('attrpath') : null;
  const name = key?.lastNamedChild ?? (type === 'formal' ? node.childForFieldName('name') : null);
  const labeled =
    name?.type === 'identifier'
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
    const carry =
      sensitive &&
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
    const structural =
      child.id === key?.id ||
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
function redactTerraformNode(node: Node, sensitive = false): string {
  const original = node.text;
  const type = node.type;
  if (type === 'comment') return redactNode(node);
  // Resource labels and object keys are identifiers, even when the AST calls them strings.
  if (type === 'block') sensitive = false;
  if (type === 'template_literal') {
    if (!sensitive) return literalPayload(original, false);
    // Escape tokens remain literal; scrubbing must not turn $${ into an interpolation.
    return original
      .split(/(\\["\\nrt]|\$\$\{|%%\{|[{}])/g)
      .map((part, index) => (index % 2 ? part : literalPayload(part, sensitive)))
      .join('');
  }
  if (type === 'numeric_lit' && sensitive) return '"' + redactSecretValue(original) + '"';
  const key = type === 'attribute' ? node.firstNamedChild : node.childForFieldName('key');
  const value = type === 'attribute' ? node.namedChildren[1] : node.childForFieldName('val');
  const keyName = key?.type === 'expression' ? key.firstNamedChild : key;
  const literalKey = keyName?.type === 'literal_value' ? keyName.firstNamedChild : keyName;
  const container = type === 'attribute' ? node.parent?.parent : null;
  const containerName = container?.namedChildren[1];
  const secretDefault =
    container?.type === 'block' &&
    ((container.firstNamedChild?.text === 'variable' && key?.text === 'default') ||
      (container.firstNamedChild?.text === 'output' && key?.text === 'value')) &&
    containerName?.type === 'string_lit' &&
    SECRET_LABEL_RE.test(containerName.text.slice(1, -1));
  const labeled =
    secretDefault ||
    (literalKey?.type === 'string_lit'
      ? SECRET_LABEL_RE.test(literalKey.text.slice(1, -1))
      : secretLabel(literalKey ?? null));
  let result = '';
  let offset = node.startIndex;
  for (const child of node.namedChildren) {
    result += original.slice(offset - node.startIndex, child.startIndex - node.startIndex);
    const carry =
      sensitive &&
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
function redactGroovyNode(node: Node, sensitive = false): string {
  const original = node.text;
  const type = node.type;
  if (type === 'line_comment') return '//' + scrubPayload(original.slice(2));
  if (type === 'block_comment') return '/*' + scrubPayload(original.slice(2, -2)) + '*/';
  const operand = type === 'unary_expression' ? node.childForFieldName('operand') : null;
  const numeric = (kind: string): boolean =>
    kind.endsWith('_integer_literal') || kind.endsWith('_floating_point_literal');
  if (sensitive && (numeric(type) || (operand && numeric(operand.type))))
    return '"' + redactSecretValue(original) + '"';
  if (type === 'character_literal' || type === 'string_literal') {
    const delimiter = type === 'character_literal' ? "'" : node.firstChild?.text;
    if (!delimiter) throw new Error('Incomplete Groovy string');
    // The inherited Java rule leaves Groovy GString expressions opaque, not AST substitutions.
    if (delimiter.startsWith('"') && original.includes('$'))
      throw new Error('Opaque Groovy GString interpolation');
    return (
      delimiter +
      literalPayload(original.slice(delimiter.length, -delimiter.length), sensitive) +
      delimiter
    );
  }
  const key =
    type === 'variable_declarator'
      ? node.childForFieldName('name')
      : type === 'assignment_expression'
        ? node.childForFieldName('left')
        : type === 'map_item'
          ? node.childForFieldName('key')
          : null;
  const value = node.childForFieldName(type === 'assignment_expression' ? 'right' : 'value');
  const field = key?.childForFieldName('field') ?? key;
  const name =
    field && ['character_literal', 'string_literal'].includes(field.type)
      ? field.text.slice(1, -1)
      : field?.text;
  const labeled = !!name && SECRET_LABEL_RE.test(name);
  let result = '';
  let offset = node.startIndex;
  for (const child of node.namedChildren) {
    result += original.slice(offset - node.startIndex, child.startIndex - node.startIndex);
    const carry =
      sensitive &&
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
function redactCFamilyNode(node: Node, sensitive = false): string {
  const original = node.text;
  const type = node.type;
  if (
    sensitive &&
    (type === 'number_literal' ||
      (type === 'unary_expression' &&
        node.childForFieldName('argument')?.type === 'number_literal'))
  )
    return '"' + redactSecretValue(original) + '"';
  if (type === 'comment')
    return original.startsWith('/*')
      ? '/*' + scrubPayload(original.slice(2, -2)) + '*/'
      : '//' + scrubPayload(original.slice(2));
  // Unknown macro arguments have no literal/expression boundaries to preserve.
  if (type === 'objc_macro_argument_text') throw new Error('Opaque Objective-C++ macro arguments');
  if (type === 'preproc_arg') return scrubPayload(original);
  if (type === 'raw_string_literal') {
    const content = node.namedChildren.find((child) => child.type === 'raw_string_content');
    if (!content) return original;
    return (
      original.slice(0, content.startIndex - node.startIndex) +
      literalPayload(content.text, sensitive) +
      original.slice(content.endIndex - node.startIndex)
    );
  }
  if (type === 'string_literal' || type === 'char_literal') {
    const quote = type === 'char_literal' ? "'" : '"';
    const start = original.indexOf(quote) + 1;
    const end = original.lastIndexOf(quote);
    return (
      original.slice(0, start) +
      literalPayload(original.slice(start, end), sensitive) +
      original.slice(end)
    );
  }
  const label = (key: Node | null): boolean => {
    if (!key) return false;
    let current: Node = key;
    while (current.type.endsWith('_declarator') || current.type === 'objc_string_literal') {
      const inner: Node | null =
        current.childForFieldName('declarator') ??
        current.childForFieldName('value') ??
        current.firstNamedChild;
      if (!inner) return false;
      current = inner;
    }
    const field =
      current.childForFieldName('field') ??
      (current.type === 'field_designator' ? current.firstNamedChild : null) ??
      current;
    const content = field.namedChildren.find((child) => child.type === 'string_content');
    return SECRET_LABEL_RE.test(content?.text ?? field.text);
  };
  const key =
    type === 'init_declarator'
      ? node.childForFieldName('declarator')
      : type === 'assignment_expression'
        ? node.childForFieldName('left')
        : type === 'objc_dictionary_entry'
          ? node.childForFieldName('key')
          : null;
  const sensitiveValue =
    type === 'initializer_pair' ? node.childrenForFieldName('designator').some(label) : label(key);
  const value = node.childForFieldName(type === 'assignment_expression' ? 'right' : 'value');
  let result = '';
  let offset = node.startIndex;
  for (const child of node.namedChildren) {
    result += original.slice(offset - node.startIndex, child.startIndex - node.startIndex);
    const carry =
      sensitive &&
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

/** Sanitize parser-owned payload spans; no SFC boundary is inferred from text matching. */
async function scrubVueSource(text: string): Promise<string> {
  if (!text) return text;
  const parsed = await parseVueSource(text, true);
  const fallback = (): string =>
    (text.startsWith(VUE_FIDELITY_MARKER) ? '' : VUE_FIDELITY_MARKER) + scrubPayload(text);
  if ('reason' in parsed) return fallback();
  const { descriptor, nodeTypes: VueNodeTypes } = parsed;
  const edits: Array<{ start: number; end: number; clean: string }> = [];
  let faithful = true;
  const script = descriptor.scriptSetup ?? descriptor.script;
  // Reuse exactly the JS/TS AST literal/comment rules, with their existing credential engine.
  const grammar = await loadGrammar(script?.lang === 'ts' ? 'typescript' : 'javascript');
  if ('unavailable' in grammar) return fallback();
  const parser = new Parser();
  parser.setLanguage(grammar.ok.language);
  const syntaxPayload = (
    source: string,
    sensitive = false,
    expression = false,
    decoded = source
  ): string => {
    if (decoded !== source) {
      const clean = syntaxPayload(decoded, sensitive, expression);
      if (clean === decoded) return source;
      faithful = false;
      // Entity decoding has no raw literal-span proof. Keep valid HTML and withhold graph facts.
      if (
        JSON.stringify(clean.match(/\r\n|\r|\n/g)) !== JSON.stringify(source.match(/\r\n|\r|\n/g))
      )
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
        if (!expression || sensitive || clean !== source) faithful = false;
        return clean;
      }
      const clean =
        full.slice(0, tree.rootNode.startIndex) +
        redactNode(tree.rootNode) +
        full.slice(tree.rootNode.endIndex);
      return clean.slice(prefix.length, clean.length - suffix.length);
    } finally {
      tree?.delete();
    }
  };
  const edit = (start: number, end: number, clean: string): void => {
    edits.push({ start, end, clean });
  };
  try {
    if (script) edit(script.loc.start.offset, script.loc.end.offset, syntaxPayload(script.content));
    walkVueTemplate(parsed, (node) => {
      if (node.type === VueNodeTypes.TEXT)
        edit(node.loc.start.offset, node.loc.end.offset, literalPayload(node.loc.source, false));
      if (node.type === VueNodeTypes.COMMENT)
        edit(
          node.loc.start.offset,
          node.loc.end.offset,
          '<!--' + scrubPayload(node.loc.source.slice(4, -3)) + '-->'
        );
      if (
        node.type === VueNodeTypes.INTERPOLATION &&
        node.content.type === VueNodeTypes.SIMPLE_EXPRESSION
      )
        edit(
          node.content.loc.start.offset,
          node.content.loc.end.offset,
          syntaxPayload(node.content.loc.source, false, true, node.content.content)
        );
      if (node.type !== VueNodeTypes.ELEMENT) return;
      for (const prop of node.props) {
        if (prop.type === VueNodeTypes.ATTRIBUTE && prop.value) {
          const raw = prop.value.loc.source;
          const quoted = raw.startsWith('"') || raw.startsWith("'");
          edit(
            prop.value.loc.start.offset,
            prop.value.loc.end.offset,
            quoted
              ? raw.slice(0, 1) +
                  literalPayload(raw.slice(1, -1), SECRET_LABEL_RE.test(prop.name)) +
                  raw.slice(-1)
              : literalPayload(raw, SECRET_LABEL_RE.test(prop.name))
          );
        }
        if (prop.type !== VueNodeTypes.DIRECTIVE) continue;
        if (prop.exp?.type === VueNodeTypes.SIMPLE_EXPRESSION)
          edit(
            prop.exp.loc.start.offset,
            prop.exp.loc.end.offset,
            syntaxPayload(
              prop.exp.loc.source,
              prop.arg?.type === VueNodeTypes.SIMPLE_EXPRESSION &&
                prop.arg.isStatic &&
                SECRET_LABEL_RE.test(prop.arg.content),
              true,
              prop.exp.content
            )
          );
        if (prop.arg?.type === VueNodeTypes.SIMPLE_EXPRESSION && !prop.arg.isStatic)
          edit(
            prop.arg.loc.start.offset,
            prop.arg.loc.end.offset,
            syntaxPayload(prop.arg.loc.source, false, true, prop.arg.content)
          );
      }
    });
    for (const style of descriptor.styles) {
      const clean = scrubPayload(style.content);
      // No CSS/preprocessor AST proof is claimed. Changed opaque content blocks graph publication.
      if (clean !== style.content) faithful = false;
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
      if (clean !== gap) faithful = false;
      edit(gapStart, block.loc.start.offset, clean);
      gapStart = block.loc.end.offset;
    }
    const tail = text.slice(gapStart);
    const cleanTail = scrubPayload(tail);
    if (cleanTail !== tail) faithful = false;
    edit(gapStart, text.length, cleanTail);
    edits.sort((a, b) => b.start - a.start);
    let clean = text;
    let boundary = text.length;
    for (const e of edits) {
      if (e.end > boundary) return fallback();
      clean = clean.slice(0, e.start) + e.clean + clean.slice(e.end);
      boundary = e.start;
    }
    if ('reason' in (await parseVueSource(clean))) faithful = false;
    return faithful || clean.startsWith(VUE_FIDELITY_MARKER) ? clean : VUE_FIDELITY_MARKER + clean;
  } catch {
    return fallback();
  } finally {
    parser.delete();
  }
}
