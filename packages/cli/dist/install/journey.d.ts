import { type ReadinessDocument, type ReadinessCondition } from '@mnemonik/shared';
import type { CliDependencies } from '../router.js';
import type { Output } from '../output.js';
import { type HostDependencies, type HostResult } from './hosts.js';
export declare function hostReadinessConditions(results: HostResult[], scanner: boolean): ReadinessCondition[];
export declare function waitForInstallation(check: () => Promise<ReadinessDocument>, timeout: () => Promise<'Retry' | 'Skip'>, clock?: Pick<HostDependencies, 'now' | 'sleep'>): Promise<{
    document?: ReadinessDocument;
    skipped: boolean;
}>;
export declare function joinedInstall(flags: Map<string, string | true>, deps: CliDependencies, output: Output, authorize: () => Promise<string>, management: () => Promise<HostDependencies>): Promise<number>;
//# sourceMappingURL=journey.d.ts.map