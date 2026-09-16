import type { ProjectIdentityResolution } from '@mnemonik/shared';
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
export declare function evaluateRoot(resolution: ProjectIdentityResolution, options: {
    cwd: string;
    home?: string;
    nonGitSelected?: boolean;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
}): Promise<RootDecision>;
//# sourceMappingURL=eligibility.d.ts.map