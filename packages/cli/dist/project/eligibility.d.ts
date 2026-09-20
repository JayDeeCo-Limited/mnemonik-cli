import type { ProjectIdentityResolution, RepositoryRootResult } from '@mnemonik/shared';
export type RootDecision = {
    allowed: true;
    root: string;
    reason: string;
    nonGit: boolean;
} | {
    allowed: false;
    root: string;
    reason: string;
};
/**
 * Repository shape of a candidate root from what is on disk: a `.git` directory
 * or file (a linked worktree) makes it a git repository; anything else is a
 * plain folder. Every root-picking path must use this before evaluateRoot, so
 * that a repository which happens to contain other repositories is never
 * mistaken for a broad workspace parent.
 */
export declare function repositoryAt(candidate: string): Promise<Extract<RepositoryRootResult, {
    kind: 'git' | 'plain';
}>>;
export declare function evaluateRoot(resolution: ProjectIdentityResolution, options: {
    cwd: string;
    home?: string;
    nonGitSelected?: boolean;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
}): Promise<RootDecision>;
//# sourceMappingURL=eligibility.d.ts.map