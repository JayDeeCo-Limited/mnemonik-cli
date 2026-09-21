import { type AdapterDependencies, resolveProjectIdentity, type ProjectIdentityResolution } from '@mnemonik/shared';
import type { Output } from './output.js';
import { launchHostLabels, launchHosts } from './install/adapters.js';
export type HostName = (typeof launchHostLabels)[(typeof launchHosts)[number]];
export interface DetectedHost {
    name: HostName;
    supported: boolean;
    path: string;
}
export interface PreflightResult {
    status: 'ready' | 'action_required';
    node: {
        version: string;
        supported: boolean;
    };
    os: string;
    hosts: DetectedHost[];
    project: {
        root?: string;
        resolution: ProjectIdentityResolution['kind'];
    };
    network: {
        reachable: boolean;
        discoveryUrl: string;
        detail?: string;
        skipped?: true;
    };
}
export interface PreflightDependencies {
    cwd?: string;
    home?: string;
    platform?: NodeJS.Platform;
    nodeVersion?: string;
    fetch?: typeof globalThis.fetch;
    resolveIdentity?: typeof resolveProjectIdentity;
    pathExists?: (path: string) => Promise<boolean>;
    discoveryUrl?: string;
    resource?: string;
    skipNetworkWithoutHosts?: boolean;
    /** Retained for injected callers; editor discovery no longer executes binaries. */
    execFile?: AdapterDependencies['execFile'];
    binaryExists?: AdapterDependencies['binaryExists'];
    env?: NodeJS.ProcessEnv;
}
export declare function nodeVersionHelp(version: string, platform: NodeJS.Platform): [string, string];
export declare function runPreflight(deps?: PreflightDependencies): Promise<PreflightResult>;
export declare function renderPreflight(result: PreflightResult, output: Output): void;
//# sourceMappingURL=preflight.d.ts.map