import { MAX_SCANNED_FILE_BYTES } from './codeScanner.js';
/** A fallback scrub may repair syntax; it must never become graph evidence. */
export const VUE_FIDELITY_MARKER = '<!-- mnemonik:vue-source-fidelity-unavailable -->';
export async function parseVueSource(source, forSanitation = false) {
    // Sanitation still inspects marked bytes; graph extraction must continue to reject them.
    if (!forSanitation && source.includes(VUE_FIDELITY_MARKER))
        return { reason: 'vue_source_fidelity_unavailable' };
    // One ceiling for sanitation and connected code: the product's 10 MB scan
    // ceiling. Sanitation no longer stops at 2 MiB: its edits are applied in one
    // pass (sourceRedaction.ts applySpanEdits), and on the API server components
    // are scrubbed in a redaction child, off the event loop (sourceRedactionServer.ts).
    if (Buffer.byteLength(source, 'utf8') > MAX_SCANNED_FILE_BYTES)
        return { reason: 'file_too_large' };
    let clearCache;
    try {
        // Most shared consumers never scan Vue; do not load the compiler on their startup path.
        const [{ parse, parseCache }, { NodeTypes: nodeTypes }] = await Promise.all([
            import('@vue/compiler-sfc'),
            import('@vue/compiler-core'),
        ]);
        clearCache = () => parseCache.clear();
        const { descriptor, errors } = parse(source, { sourceMap: false });
        if (errors.length)
            return { reason: 'vue_syntax_error' };
        if (descriptor.script && descriptor.scriptSetup)
            return { reason: 'vue_dual_scripts_unsupported' };
        const script = descriptor.scriptSetup ?? descriptor.script;
        if (script?.src || descriptor.template?.src)
            return { reason: 'vue_external_block_unsupported' };
        if ((script?.lang && !['ts', 'js'].includes(script.lang)) ||
            (descriptor.template?.lang && descriptor.template.lang !== 'html') ||
            descriptor.customBlocks.length)
            return { reason: 'vue_preprocessor_or_custom_block_unsupported' };
        return { descriptor, nodeTypes };
    }
    catch {
        return { reason: 'vue_parse_failed' };
    }
    finally {
        // The compiler cache keys contain whole source, including pre-sanitization credentials.
        clearCache?.();
    }
}
/** Walk untransformed template nodes, retaining the parser's original source locations. */
export function walkVueTemplate(parsed, visit) {
    const { descriptor, nodeTypes: VueNodeTypes } = parsed;
    const pending = descriptor.template?.ast
        ? [{ node: descriptor.template.ast, scoped: false }]
        : [];
    // Iterative and linear in the template's nodes, with no count limit: the
    // 200,000-node bound guarded a scrubber that copied the file per edit.
    while (pending.length) {
        const item = pending.pop();
        if (!item)
            break;
        const { node } = item;
        const scoped = item.scoped ||
            (node.type === VueNodeTypes.ELEMENT &&
                node.props.some((p) => p.type === VueNodeTypes.DIRECTIVE && ['for', 'slot'].includes(p.name)));
        visit(node, scoped);
        if (node.type === VueNodeTypes.ROOT || node.type === VueNodeTypes.ELEMENT)
            for (const child of node.children)
                pending.push({ node: child, scoped });
    }
}
//# sourceMappingURL=vueSource.js.map