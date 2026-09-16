import type { ReadinessVersions } from '@mnemonik/shared';
import type { Grant, Target as AdapterTarget } from './adapters.js';
import type { HostArtifact } from '../runtime/store.js';
import { type Journal } from './journal.js';
export interface OwnedSet {
    version: string;
    artifactDigest: string;
    files: Array<{
        path: string;
        hash: string | null;
        created?: true;
        original?: {
            backup: string;
            hash: string | null;
        };
    }>;
    runtimePointer: string;
}
export interface OwnedTarget extends OwnedSet {
    editorVersion?: string;
    id: string;
    host: HostArtifact;
    component: 'hooks' | 'mcp';
    scope: AdapterTarget['scope'];
    profilePath: string;
    home: string;
    projectRoot?: string;
    previous?: OwnedSet;
    grant?: Grant;
    credentialFamily?: string;
}
export interface Ownership {
    devReleaseSource?: true;
    schemaVersion: 1;
    generation: number;
    targets: OwnedTarget[];
}
export interface HostRun {
    id: string;
    elapsedMs?: number;
    host: HostArtifact;
    status: 'pending' | 'verified' | 'complete' | 'rolled_back';
    candidate?: OwnedTarget;
    remove?: string[];
    reason?: string;
}
export declare const ownershipPath: (state: string) => string;
export declare function readOwnership(state: string): Promise<Ownership>;
/** Versions observed by host detection and installed runtimes, for completion receipts. */
export declare function readInstallVersions(state: string, scanner?: string): Promise<ReadinessVersions>;
export declare function assertGeneration(state: string, journal: Journal): Promise<void>;
export declare function saveOwnership(state: string, journal: Journal, run: HostRun): Promise<void>;
/** Validate the entire group before restoring any member; interrupted restore is resumable. */
export declare function rollbackHost(state: string, journal: Journal, id: string): Promise<void>;
//# sourceMappingURL=ownership.d.ts.map