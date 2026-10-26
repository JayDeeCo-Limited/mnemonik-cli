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
/**
 * The latest published CLI version, for the status hint only (update reads and
 * verifies the release itself). It reads `dist-tags.latest` from npm's compact
 * install metadata, which npm's CDN serves in under 0.1 s; the `/latest`
 * document is built per request and took 3 to 5 s after a publish (26 Oct
 * 2026), longer than the hint may wait.
 */
export declare function latestCliVersion(fetcher?: typeof fetch, timeoutMs?: number): Promise<string>;
/** Status alone caches successes and failures; update always reads the release afresh. */
export declare function cliUpdateHint(store: RuntimeStore, current: string, options?: {
    fetcher?: typeof fetch;
}): Promise<string | undefined>;
//# sourceMappingURL=selfUpdate.d.ts.map