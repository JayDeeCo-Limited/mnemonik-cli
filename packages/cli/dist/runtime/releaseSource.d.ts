import type { ReadinessDocument } from '@mnemonik/shared';
import { type Artifact, type Manifest, type RuntimeSource } from './store.js';
export interface ReleaseManifest {
    version: string;
    digestsSha256: string;
    platforms: Record<string, Manifest>;
}
type Fetch = typeof fetch;
/** Development sources retain all digest/signature checks and never accept an arbitrary URL. */
export declare function devReleaseActive(): boolean;
export declare function devReadiness(document: ReadinessDocument): ReadinessDocument & {
    devReleaseSource?: true;
};
/** Validate before each request; only GitHub release downloads get one pinned CDN hop. */
export declare function releaseBytes(address: string, fetcher?: Fetch): Promise<Buffer>;
export declare function scannerReleaseSource(trusted: ReleaseManifest, fetcher?: Fetch, platform?: string): Promise<RuntimeSource>;
interface NpmDist {
    version: string;
    'dist.integrity': string;
    'dist.tarball': string;
}
export declare function npmReleaseSource(fetcher?: Fetch, view?: () => Promise<NpmDist>): Promise<RuntimeSource>;
/** Supply this as runtimeUpdate.source; the update path restarts managed services. */
export declare function releaseSource(artifact: Artifact): Promise<RuntimeSource>;
export {};
//# sourceMappingURL=releaseSource.d.ts.map