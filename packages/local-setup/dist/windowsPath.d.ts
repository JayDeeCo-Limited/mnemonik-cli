import type { ExecFile } from './storage.js';
/** Raw HKCU value: preserve expansion tokens, empty/absent values and registry type. */
export type WindowsPathValue = {
    value: string;
    kind: 'String' | 'ExpandString';
} | null;
export interface WindowsPathOptions {
    execFile?: ExecFile;
    env?: NodeJS.ProcessEnv;
}
export declare function windowsPathIncludes(path: string, directory: string, env?: NodeJS.ProcessEnv): boolean;
export declare function removeWindowsPathEntry(path: string, directory: string, preferredIndex: number, env?: NodeJS.ProcessEnv): string;
export declare function appendWindowsPath(before: WindowsPathValue, directory: string, env?: NodeJS.ProcessEnv): WindowsPathValue;
export declare function readWindowsUserPath(options?: WindowsPathOptions): Promise<WindowsPathValue>;
/** Compare-and-set in the same process; never overwrite a separately edited PATH. */
export declare function writeWindowsUserPath(before: WindowsPathValue, after: WindowsPathValue, options?: WindowsPathOptions): Promise<void>;
//# sourceMappingURL=windowsPath.d.ts.map