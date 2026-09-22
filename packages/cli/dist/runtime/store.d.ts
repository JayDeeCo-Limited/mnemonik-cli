import { RuntimeReader, type Reference, type Artifact, type RuntimeSource, type Verified, type HostArtifact } from '@mnemonik/shared/hook-runtime';
export { RuntimeError, hash, safePath } from '@mnemonik/shared/hook-runtime';
export type { Artifact, HostArtifact, Reason, Manifest, NpmReceipt, RuntimeSource, Verified, } from '@mnemonik/shared/hook-runtime';
export declare class RuntimeStore extends RuntimeReader {
    withMutationLock<T>(artifact: Artifact, work: (assertOwned: () => Promise<void>) => Promise<T>): Promise<T>;
    stageRuntime(artifact: Artifact, version: string, source: RuntimeSource): Promise<Verified>;
    installRuntime(artifact: Artifact, version: string, source: RuntimeSource, activate?: boolean): Promise<Verified>;
    rollbackRuntime(artifact: Artifact, expectedCurrent?: Reference): Promise<Verified>;
}
/** Updating restarts managed services; obtaining a release source does not execute it. */
export interface RuntimeUpdate {
    store: RuntimeStore;
    source(): Promise<RuntimeSource>;
    restartManagedServices(pointer: string): Promise<void>;
}
export declare function updateRuntime(update: RuntimeUpdate): Promise<Verified>;
export interface HostPackagePin {
    package: string;
    version: string;
    releaseVersion?: string;
    closure: Array<{
        name: string;
        version: string;
        integrity: string;
    }>;
}
/** Release hosts may supply the same RuntimeSource from their platform map. */
export interface HostReleaseMap {
    hosts: Record<HostArtifact, HostPackagePin>;
}
export declare function hostNpmSource(host: HostArtifact, pin: HostPackagePin, fetcher?: typeof fetch, releaseKey?: string): Promise<RuntimeSource>;
//# sourceMappingURL=store.d.ts.map