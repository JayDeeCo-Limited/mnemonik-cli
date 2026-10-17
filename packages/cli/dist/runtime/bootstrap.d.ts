import { RuntimeStore, type RuntimeSource } from './store.js';
interface Package {
    name: string;
    version: string;
    dependencies?: Record<string, string>;
    scripts?: Record<string, string>;
}
export interface LockEntry {
    version: string;
    resolved: string;
    integrity: string;
    link?: boolean;
}
interface NpmLaunch {
    root: string;
    prefix: string;
    pkg: Package;
    packages: Record<string, LockEntry>;
    entry: string;
}
interface BootstrapWritable {
    write(chunk: string): unknown;
}
export declare function bootstrapProgress(stream?: BootstrapWritable, interactive?: boolean, inherited?: boolean): {
    stop(): void;
};
export declare function guardNpmLaunch(entry: string): Promise<NpmLaunch>;
/** Restricted npm tar reader: regular files/directories only; no links, extensions or path escapes. */
export declare function unpack(tarball: Buffer): Record<string, Buffer>;
/**
 * A registry answer that may change in a moment. npm's CDN can answer 404 for a
 * version for a few minutes after it is published, and a registry can be busy
 * or out of reach.
 */
export declare class RegistryBusy extends Error {
    readonly unreachable: boolean;
    /** True when no answer came back at all (offline, DNS, refused, timed out). */
    constructor(unreachable?: boolean);
}
export declare const registryBusyStatus: (status: number) => boolean;
/** Pauses between attempts at one registry fetch. */
export declare const REGISTRY_RETRY_DELAYS_MS: readonly number[];
/**
 * Runs one registry fetch, again after a short pause while the registry is busy,
 * and names a registry that stays busy as temporary rather than as a missing
 * package, so the person is told to try again later. A registry that never
 * answered is named unreachable, so the person is told to check the connection.
 */
export declare function fromRegistry<T>(attempt: () => Promise<T>, delays?: readonly number[]): Promise<T>;
export declare function tarballBytes(entry: LockEntry, prefix: string, delays?: readonly number[]): Promise<Buffer>;
export declare function npmSource(launch: NpmLaunch): Promise<RuntimeSource>;
export declare function installBootstrap(store: RuntimeStore, source: RuntimeSource): Promise<string>;
/** Compare the exact release versions without adding a channel or filtering dist-tags. */
export declare function newerVersion(candidate: string, current: string): boolean;
export declare function bootstrap(args: string[], entry?: string): Promise<number>;
export declare function launchChild(file: string, args: string[], envOverrides?: Record<string, string>): Promise<number>;
export {};
//# sourceMappingURL=bootstrap.d.ts.map