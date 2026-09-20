type DetachedSpawn = (file: string, args: string[], options: {
    detached: true;
    stdio: 'ignore';
    windowsHide: true;
    windowsVerbatimArguments?: true;
}) => {
    once(event: 'error', listener: () => void): unknown;
    unref(): void;
};
type FileStat = {
    isFile(): boolean;
    mtimeMs: number;
};
export interface AutomaticUpdateOptions {
    stateDir?: string;
    home?: string;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    now?: () => number;
    spawn?: DetachedSpawn;
    stat?: (path: string) => Promise<FileStat>;
}
export declare function cliLauncherPath(options?: AutomaticUpdateOptions): string;
export declare function maybeStartAutomaticUpdate(options?: AutomaticUpdateOptions): Promise<boolean>;
export declare function startAutomaticUpdateForSession(start?: () => Promise<unknown>, timeoutMs?: number): Promise<void>;
export {};
//# sourceMappingURL=automaticUpdate.d.ts.map