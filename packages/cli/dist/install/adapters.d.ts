import type { Verified } from '../runtime/store.js';
import type { AdapterDependencies, AdapterWriter, Grant, HostAdapter, HostName, HostPlan, Inspection } from '@mnemonik/shared';
export type { AdapterDependencies, AdapterWriter, FileChange, Grant, HostAdapter, HostName, HostPlan, Inspection, Target, } from '@mnemonik/shared';
export declare const launchHosts: readonly ['claude-code', 'codex', 'cursor'];
export type LaunchHost = (typeof launchHosts)[number];
export declare const hostOrder: readonly ["claude-code", "codex", "cursor"];
export declare const launchHostLabels: {
    readonly 'claude-code': 'Claude Code';
    readonly codex: 'Codex';
    readonly cursor: 'Cursor';
};
export type HostPackageImports = {
    [H in LaunchHost]: (runtime: Verified) => Promise<{
        createHostAdapter(deps?: AdapterDependencies): HostAdapter;
    }>;
};
export declare const hostPackageImports: HostPackageImports;
export declare class SimulatedHostAdapter implements HostAdapter {
    readonly name: HostName;
    readonly declaration: Omit<HostPlan, 'changes'> & {
        path: string;
        content: Buffer;
    };
    readonly supportsRevoke: boolean;
    grant?: Grant;
    authenticatedTools: boolean;
    launches: number;
    revoked: string[];
    revokeAction: string;
    constructor(name: HostName, declaration: Omit<HostPlan, 'changes'> & {
        path: string;
        content: Buffer;
    }, supportsRevoke?: boolean);
    detect(): Promise<{
        supported: boolean;
        version: string;
    }>;
    capabilities(): {
        scopes: string[];
        components: ('hooks' | 'mcp')[];
        nativeConnect: boolean;
        revoke: boolean;
    };
    inspect(): Promise<Inspection>;
    plan(): Promise<{
        staging: 'inactive' | 'additive';
        requestedScope: string;
        effectiveScope: string;
        version: string;
        artifactDigest: string;
        path: string;
        content: Buffer;
        changes: {
            path: string;
            content: Buffer<ArrayBufferLike>;
        }[];
    }>;
    install(writer: AdapterWriter): Promise<void>;
    update(writer: AdapterWriter): Promise<void>;
    repair(writer: AdapterWriter): Promise<void>;
    launch(): Promise<string>;
    verify(): Promise<Inspection>;
    uninstall(writer: AdapterWriter): Promise<void>;
    revoke(grant: Grant): Promise<boolean>;
}
//# sourceMappingURL=adapters.d.ts.map