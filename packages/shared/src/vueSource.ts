import type { SFCDescriptor } from '@vue/compiler-sfc';
import { MAX_AST_PARSE_BYTES } from './ast/astChunker.js';

/** A fallback scrub may repair syntax; it must never become graph evidence. */
export const VUE_FIDELITY_MARKER = '<!-- mnemonik:vue-source-fidelity-unavailable -->';
type TemplateRoot = NonNullable<NonNullable<SFCDescriptor['template']>['ast']>;
export type VueTemplateNode = TemplateRoot | TemplateRoot['children'][number];

/** Official descriptor parsing only: never compile, preprocess or evaluate source. */
type ParsedVueSource = {
  descriptor: SFCDescriptor;
  nodeTypes: typeof import('@vue/compiler-core').NodeTypes;
};
export async function parseVueSource(
  source: string,
  forSanitation = false
): Promise<ParsedVueSource | { reason: string }> {
  // Sanitation still inspects marked bytes; graph extraction must continue to reject them.
  if (!forSanitation && source.includes(VUE_FIDELITY_MARKER))
    return { reason: 'vue_source_fidelity_unavailable' };
  if (Buffer.byteLength(source, 'utf8') > MAX_AST_PARSE_BYTES) return { reason: 'file_too_large' };
  let clearCache: (() => void) | undefined;
  try {
    // Most shared consumers never scan Vue; do not load the compiler on their startup path.
    const [{ parse, parseCache }, { NodeTypes: nodeTypes }] = await Promise.all([
      import('@vue/compiler-sfc'),
      import('@vue/compiler-core'),
    ]);
    clearCache = () => parseCache.clear();
    const { descriptor, errors } = parse(source, { sourceMap: false });
    if (errors.length) return { reason: 'vue_syntax_error' };
    if (descriptor.script && descriptor.scriptSetup)
      return { reason: 'vue_dual_scripts_unsupported' };
    const script = descriptor.scriptSetup ?? descriptor.script;
    if (script?.src || descriptor.template?.src)
      return { reason: 'vue_external_block_unsupported' };
    if (
      (script?.lang && !['ts', 'js'].includes(script.lang)) ||
      (descriptor.template?.lang && descriptor.template.lang !== 'html') ||
      descriptor.customBlocks.length
    )
      return { reason: 'vue_preprocessor_or_custom_block_unsupported' };
    return { descriptor, nodeTypes };
  } catch {
    return { reason: 'vue_parse_failed' };
  } finally {
    // The compiler cache keys contain whole source, including pre-sanitization credentials.
    clearCache?.();
  }
}

/** Walk untransformed template nodes, retaining the parser's original source locations. */
export function walkVueTemplate(
  parsed: ParsedVueSource,
  visit: (node: VueTemplateNode, scoped: boolean) => void
): void {
  const { descriptor, nodeTypes: VueNodeTypes } = parsed;
  const pending: Array<{ node: VueTemplateNode; scoped: boolean }> = descriptor.template?.ast
    ? [{ node: descriptor.template.ast, scoped: false }]
    : [];
  let count = 0;
  while (pending.length) {
    const item = pending.pop();
    if (!item) break;
    if (++count > 200_000) throw new Error('vue_template_work_limit');
    const { node } = item;
    const scoped =
      item.scoped ||
      (node.type === VueNodeTypes.ELEMENT &&
        node.props.some(
          (p) => p.type === VueNodeTypes.DIRECTIVE && ['for', 'slot'].includes(p.name)
        ));
    visit(node, scoped);
    if (node.type === VueNodeTypes.ROOT || node.type === VueNodeTypes.ELEMENT)
      for (const child of node.children) pending.push({ node: child, scoped });
  }
}
