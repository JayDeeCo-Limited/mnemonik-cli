import { type ReadinessDocument, type ReadinessCondition } from '@mnemonik/shared';
import type { CliDependencies } from '../router.js';
import type { Output } from '../output.js';
import { type HostDependencies, type HostResult } from './hosts.js';
export declare const EARLIER_INSTALL_REMOVED = "An earlier installation did not finish and was removed.";
export declare const EARLIER_INSTALL_RUNNING = "An earlier installation is still running. Try again when it finishes.";
export declare const EARLIER_INSTALL_KEPT = "An earlier installation did not finish and could not be removed.";
/** How a bounded wait that ran out was answered, for a reader of `--json`. */
export interface WaitAnswer {
    step: 'sign_in' | 'indexing_start' | 'installation_checks';
    answer: 'retry' | 'skip';
}
/** What became of one selected folder at the connect step. */
export interface RepositoryOutcome {
    folder: string;
    outcome: 'connected' | 'not_connected';
    projectId?: string;
    /** Why it was left out, as a state name. */
    reason?: string;
    /** What to do about it, in words. */
    action?: string;
}
/**
 * The answer to a wait that ran out when nobody is at the terminal: `--retry`
 * waits once more for each step, then skips; otherwise the step is skipped.
 */
export declare function automaticWaitAnswer(flags: ReadonlyMap<string, string | true>, step: WaitAnswer['step'], answered: readonly WaitAnswer[]): WaitAnswer['answer'];
export declare function hostReadinessConditions(results: HostResult[], scanner: boolean): ReadinessCondition[];
export declare function waitForInstallation(check: () => Promise<ReadinessDocument>, timeout: () => Promise<'Retry' | 'Skip'>, clock?: Pick<HostDependencies, 'now' | 'sleep'>): Promise<{
    document?: ReadinessDocument;
    skipped: boolean;
}>;
export declare function joinedInstall(flags: Map<string, string | true>, deps: CliDependencies, output: Output, authorize: () => Promise<string>, management: () => Promise<HostDependencies>): Promise<number>;
//# sourceMappingURL=journey.d.ts.map