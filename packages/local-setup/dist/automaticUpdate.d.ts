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
type HelperSpawn = (file: string, args: string[], options: {
    detached: true;
    stdio: 'ignore';
    windowsHide: true;
}) => {
    once(event: 'error', listener: () => void): unknown;
    unref(): void;
};
export interface SessionUpdateOptions extends Omit<AutomaticUpdateOptions, 'spawn'> {
    /** Starts the detached helper that claims the day and launches the updater. */
    spawnHelper?: HelperSpawn;
}
/**
 * Session start's share of the daily update is one stat. When a day has passed,
 * the claim and the updater launch go to a detached helper process: the claim
 * takes tens of milliseconds of locking and syncing, a hook that answers its
 * editor exits at once, and an exit in the middle of a claim used to spend the
 * day without starting an update. The hook never waits on update work.
 */
export declare function startAutomaticUpdateForSession(options?: SessionUpdateOptions): Promise<void>;
export {};
//# sourceMappingURL=automaticUpdate.d.ts.map