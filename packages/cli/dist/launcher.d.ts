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
/**
 * The Node executable the launcher pins. Homebrew keeps each version in its own
 * folder (<prefix>/Cellar/<formula>/<version>/bin/node) behind a stable link
 * (<prefix>/opt/<formula>/bin/node), and deletes the versioned folder on every
 * upgrade, even a rebuild of the same version: on 2026-10-13 node@24 24.21.0
 * became 24.21.0_2 and every launcher pinned to the old folder stopped working.
 * So pin the stable link when it leads to the same executable, and the real
 * path otherwise.
 */
export declare function stableNodePath(execPath?: string, resolveReal?: (path: string) => Promise<string>): Promise<string>;
/** A write-ahead record keeps PATH recovery independent of host/scanner journals. */
export declare function ensureLauncher(options?: LauncherOptions): Promise<LauncherStatus>;
export declare function removeLauncher(options?: LauncherOptions): Promise<boolean>;
//# sourceMappingURL=launcher.d.ts.map