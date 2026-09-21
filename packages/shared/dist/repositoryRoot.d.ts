import { type ProjectIdentityFile } from './projectIdentityFile.js';
export interface RepositoryBoundary {
    path: string;
    kind: 'directory' | 'file';
}
export type RepositoryRootResult = {
    kind: 'git';
    root: string;
    commonDir: string;
    isLinkedWorktree: boolean;
    nested: RepositoryBoundary[];
} | {
    kind: 'plain';
    root: string;
} | {
    kind: 'git_unavailable';
    detail: string;
};
type ResolvedRepository = Exclude<RepositoryRootResult, {
    kind: 'git_unavailable';
}>;
type ResolvedBase = {
    root: string;
    repository: ResolvedRepository;
    nested: RepositoryBoundary[];
};
export type ProjectIdentityResolution = (ResolvedBase & {
    kind: 'ok';
    identity: ProjectIdentityFile;
}) | (ResolvedBase & {
    kind: 'absent';
}) | (ResolvedBase & {
    kind: 'unknown_version';
    version: unknown;
    path: string;
}) | (ResolvedBase & {
    kind: 'malformed';
    detail: string;
    path: string;
}) | (ResolvedBase & {
    kind: 'nested';
    parentIdentity?: ProjectIdentityFile;
}) | (ResolvedBase & {
    kind: 'conflict';
    rootIdentity: ProjectIdentityFile;
    nestedIdentity: ProjectIdentityFile;
}) | {
    kind: 'git_unavailable';
    detail: string;
};
export declare function resolveRepositoryRoot(cwd: string): Promise<RepositoryRootResult>;
export declare function resolveProjectIdentity(cwd: string, options?: {
    allowNestedInherit?: boolean;
    selectedRoot?: boolean;
}): Promise<ProjectIdentityResolution>;
export {};
//# sourceMappingURL=repositoryRoot.d.ts.map