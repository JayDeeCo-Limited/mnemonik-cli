import type { AdapterDependencies, FileChange, HostAdapter, Target } from '../hostAdapter.js';
export declare function writeChanges(changes: FileChange[]): Promise<void>;
/** Named, isolated checks that any package test runner can register. No test-framework dependency. */
export declare function hostAdapterConformance(create: (deps?: AdapterDependencies) => HostAdapter, options: {
    name: string;
    config: string;
    mcpConfig?: {
        user: string;
        project: string;
        toml?: boolean;
        type?: string;
    };
    scopes: Target['scope'][];
    flat?: boolean;
    deferred?: boolean;
}): Record<string, () => Promise<void>>;
//# sourceMappingURL=hostAdapterConformance.d.ts.map