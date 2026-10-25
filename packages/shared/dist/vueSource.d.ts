import type { SFCDescriptor } from '@vue/compiler-sfc';
/** A fallback scrub may repair syntax; it must never become graph evidence. */
export declare const VUE_FIDELITY_MARKER = "<!-- mnemonik:vue-source-fidelity-unavailable -->";
type TemplateRoot = NonNullable<NonNullable<SFCDescriptor['template']>['ast']>;
export type VueTemplateNode = TemplateRoot | TemplateRoot['children'][number];
/** Official descriptor parsing only: never compile, preprocess or evaluate source. */
type ParsedVueSource = {
    descriptor: SFCDescriptor;
    nodeTypes: typeof import('@vue/compiler-core').NodeTypes;
    /** Set on the sanitation path only; the template walk throws past it. */
    templateNodeLimit?: number;
};
export declare function parseVueSource(source: string, forSanitation?: boolean): Promise<ParsedVueSource | {
    reason: string;
}>;
/** Walk untransformed template nodes, retaining the parser's original source locations. */
export declare function walkVueTemplate(parsed: ParsedVueSource, visit: (node: VueTemplateNode, scoped: boolean) => void): void;
export {};
//# sourceMappingURL=vueSource.d.ts.map