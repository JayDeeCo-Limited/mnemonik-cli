import { RuntimeStore, type RuntimeSource } from './store.js';
interface Package {
    name: string;
    version: string;
    dependencies?: Record<string, string>;
    scripts?: Record<string, string>;
}
interface LockEntry {
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
export declare function guardNpmLaunch(entry: string): Promise<NpmLaunch>;
/** Restricted npm tar reader: regular files/directories only; no links, extensions or path escapes. */
export declare function unpack(tarball: Buffer): Record<string, Buffer>;
export declare function npmSource(launch: NpmLaunch): Promise<RuntimeSource>;
export declare function installBootstrap(store: RuntimeStore, source: RuntimeSource): Promise<string>;
/** Compare the exact release versions without adding a channel or filtering dist-tags. */
export declare function newerVersion(candidate: string, current: string): boolean;
export declare function bootstrap(args: string[], entry?: string): Promise<number>;
export declare function launchChild(file: string, args: string[]): Promise<number>;
export {};
//# sourceMappingURL=bootstrap.d.ts.map