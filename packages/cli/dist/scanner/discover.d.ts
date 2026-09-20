import type { Dirent } from 'node:fs';
import { resolveProjectIdentity, type ProjectIdentityResolution, type RepositoryFingerprint, type RepositoryRemote } from '@mnemonik/shared';
export declare const DIRECTORY_LIMIT = 10000;
export declare const DISCOVERY_DEPTH = 3;
export declare const REPOSITORY_LIMIT = 200;
export type RepositoryState = 'existing_project' | 'remote_setup' | 'not_set_up' | 'action_required';
export interface DiscoveredRepository {
    path: string;
    state: RepositoryState;
    nonGitSelected?: true;
    fingerprint?: RepositoryFingerprint;
    reason?: Exclude<ProjectIdentityResolution['kind'], 'ok' | 'absent'>;
}
export interface ScannerCandidate {
    path: string;
    name: string;
    kind: 'git' | 'folder';
}
export type DiscoveryResult = {
    status: 'complete' | 'list_truncated';
    displayRoot: string;
    root: string;
    directoriesVisited: number;
    repositories: DiscoveredRepository[];
    truncated: boolean;
};
interface DiscoveryOptions {
    directoryLimit?: number;
    maxDepth?: number;
    canonicalizePath?: (path: string) => Promise<string>;
    resolveIdentity?: typeof resolveProjectIdentity;
    readDirectory?: (path: string) => Promise<Dirent[]>;
    readRemotes?: (path: string) => Promise<RepositoryRemote[]>;
}
export declare function classifyRepository(path: string, options?: Pick<DiscoveryOptions, 'canonicalizePath' | 'resolveIdentity' | 'readRemotes'>): Promise<DiscoveredRepository>;
export declare function discoverRepositories(parentPath: string, options?: DiscoveryOptions): Promise<DiscoveryResult>;
export declare function scannerCandidates(boundary: string): Promise<{
    boundary: string;
    candidates: ScannerCandidate[];
    repositories: DiscoveredRepository[];
}>;
export declare function guessDiscoveryBoundary(cwd: string, home: string): Promise<string>;
export declare const repositoryName: (root: string, path: string) => string;
export declare const repositoryStateLabel: (state: RepositoryState) => string;
export {};
//# sourceMappingURL=discover.d.ts.map