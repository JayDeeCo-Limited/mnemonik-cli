import type { AdapterDependencies } from './hostAdapter.js';
export interface WindowsBinary {
    locations: [environmentVariable: string, relativePath: string][];
    extensions: string[];
    productVersion?: boolean;
}
/** Native locations shared by preflight discovery and verified host adapters. */
export declare function hostBinaryDescriptor(host: 'claude-code' | 'codex' | 'cursor', deps?: Pick<AdapterDependencies, 'env' | 'platform'>): {
    binary: string;
    windowsBinary: WindowsBinary;
    desktopPaths?: string[];
};
export declare class HostBinaryNotFoundError extends Error {
    readonly searchedLocations: string[];
    constructor(searchedLocations: string[]);
}
/** cmd parses shell syntax even with execFile's shell:false. Only fixed, safe arguments.
 * Parentheses are ordinary inside a quoted token, and a profile path may carry
 * them (`C:\\Users\\Jane (Admin)\\...`). */
export declare function quoteHostArgument(value: string): string;
export declare function createHostBinary(deps: AdapterDependencies, name: string, windows: WindowsBinary, run: NonNullable<AdapterDependencies['execFile']>, desktopPaths?: string[]): {
    resolve: () => Promise<string>;
    findOnDisk(): Promise<string | undefined>;
    execute(args: string[], cwd?: string): Promise<{
        stdout: string;
        stderr: string;
    }>;
};
//# sourceMappingURL=hostBinary.d.ts.map