import type { ReadinessDocument } from '@mnemonik/shared';
import { type Artifact, type Manifest, type RuntimeSource, type RuntimeStore, type Verified } from './store.js';
export interface ReleaseManifest {
    version: string;
    digestsSha256: string;
    platforms: Record<string, Manifest>;
}
export declare const releasePackageNames: readonly ['@mnemonik/cli', '@mnemonik/claude-code-hooks', '@mnemonik/codex-hooks', '@mnemonik/cursor-hooks'];
export interface SignedReleaseManifest {
    schemaVersion: 1;
    version: string;
    packages: Record<string, {
        version: string;
        integrity: string;
    }>;
}
type Fetch = typeof fetch;
/** Development sources retain all digest/signature checks and never accept an arbitrary URL. */
export declare function devReleaseActive(): boolean;
export declare function devReadiness(document: ReadinessDocument): ReadinessDocument & {
    devReleaseSource?: true;
};
/** Validate before each request; only GitHub release downloads get one pinned CDN hop. */
export declare function releaseBytes(address: string, fetcher?: Fetch, stallTimeoutMs?: number): Promise<Buffer>;
export declare function signedReleaseManifest(version: string, fetcher?: Fetch, identity?: string): Promise<SignedReleaseManifest>;
export declare function scannerReleaseSource(trusted: ReleaseManifest, fetcher?: Fetch, platform?: string): Promise<RuntimeSource>;
interface NpmDist {
    version: string;
    'dist.integrity': string;
    'dist.tarball': string;
}
export declare function npmReleaseSource(fetcher?: Fetch, view?: () => Promise<NpmDist>): Promise<RuntimeSource>;
/**
 * The scanner release bundled with a CLI runtime that was verified on install,
 * so an update that also replaces the CLI installs the scanner of the release
 * the CLI now runs, as the hooks already do. The file is read through the store
 * and must still match the digest the runtime's manifest records for it; that
 * manifest is the file's trust. Undefined when the runtime does not carry one
 * that matches, or a development release source is active (it names its own),
 * and the caller then uses the release this process was built with.
 */
export declare function bundledScannerRelease(store: Pick<RuntimeStore, 'bytes'>, cli: Verified | undefined): Promise<ReleaseManifest | undefined>;
/** Supply this as runtimeUpdate.source; the update path restarts managed services. */
export declare function releaseSource(artifact: Artifact): Promise<RuntimeSource>;
/**
 * The disclosure version the scanner this CLI installs expects its consent to
 * carry, read from the release manifest bundled with the CLI (no download).
 * Undefined when the manifest predates the field or cannot be read.
 */
export declare function expectedScannerDisclosureVersion(platform?: string): Promise<string | undefined>;
export {};
//# sourceMappingURL=releaseSource.d.ts.map