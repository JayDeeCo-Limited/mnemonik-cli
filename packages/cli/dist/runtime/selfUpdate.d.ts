import { RuntimeStore } from './store.js';
export declare function updateCli(store: RuntimeStore, options?: {
    fetcher?: typeof fetch;
    releaseKey?: string;
}): Promise<{
    status: 'NOT_INSTALLED' | 'UP_TO_DATE' | 'UPDATED' | 'FAILED';
    oldVersion?: string;
    newVersion?: string;
    reason?: string;
    devReleaseSource?: boolean;
}>;
export declare function cliUpdateLine(result: Awaited<ReturnType<typeof updateCli>>): string;
/** Status alone caches successes and failures; update always reads the release afresh. */
export declare function cliUpdateHint(store: RuntimeStore, current: string): Promise<string | undefined>;
//# sourceMappingURL=selfUpdate.d.ts.map