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
}) | {
    kind: 'git_unavailable';
    detail: string;
};
export declare function resolveRepositoryRoot(cwd: string): Promise<RepositoryRootResult>;
/**
 * The project a working folder belongs to: the nearest `.mnemonik.json` above
 * it. Git repositories are not project boundaries; a clone, submodule,
 * subsystem or subproject inside a project belongs to that project unless it
 * has its own identity file. Git has one part in identity: a linked worktree
 * (and anything inside it without an identity file of its own below the
 * worktree's top, nested clones and submodules included) belongs to the
 * project of its main checkout; the worktree's own top-level copy of the
 * identity file does not count.
 */
export declare function resolveNearestProjectIdentity(cwd: string): Promise<ProjectIdentityResolution>;
/**
 * Which project a folder is in. By default this is the rule every reader
 * shares with the hooks (resolveNearestProjectIdentity). `namedRoot` and
 * `selectedRoot` read exactly the folder given instead, for commands that make
 * that folder a project on purpose; `selectedRoot` (folders ticked during
 * install) also treats a configuration-only file as no identity, as the
 * nearest-file walk always does.
 */
export declare function resolveProjectIdentity(cwd: string, options?: {
    selectedRoot?: boolean;
    namedRoot?: boolean;
}): Promise<ProjectIdentityResolution>;
export {};
//# sourceMappingURL=repositoryRoot.d.ts.map