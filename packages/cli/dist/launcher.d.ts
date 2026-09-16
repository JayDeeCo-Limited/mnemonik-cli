import { spawn as nodeSpawn } from 'node:child_process';
import { type WindowsPathOptions } from '@mnemonik/local-setup';
export interface LauncherOptions extends WindowsPathOptions {
    stateDir?: string;
    home?: string;
    platform?: NodeJS.Platform;
    spawn?: typeof nodeSpawn;
    instruction?: (text: string) => void;
}
export interface LauncherStatus {
    path: string;
    directory: string;
    ownership: 'ours' | 'not_ours' | 'missing';
    onPath: boolean;
    action: string;
}
export declare function launcherPathAction(options?: LauncherOptions): string;
export declare function launcherStatus(options?: LauncherOptions): Promise<LauncherStatus>;
export declare class LauncherError extends Error {
    readonly launcher: LauncherStatus;
    readonly status = "ACTION_REQUIRED";
    constructor(launcher: LauncherStatus, reason?: string);
}
/** A write-ahead record keeps PATH recovery independent of host/scanner journals. */
export declare function ensureLauncher(options?: LauncherOptions): Promise<LauncherStatus>;
export declare function removeLauncher(options?: LauncherOptions): Promise<boolean>;
//# sourceMappingURL=launcher.d.ts.map