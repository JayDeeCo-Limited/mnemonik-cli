/** Who owns a path and what it is, without following a final symlink. */
export type RuntimeOwner = (path: string) => {
    uid: number;
    type: 'directory' | 'socket' | 'other';
} | undefined;
export declare const runtimeOwner: RuntimeOwner;
/**
 * The environment a `systemctl --user` child needs to reach this user's
 * manager, or undefined to leave the child's environment exactly as it is.
 * systemctl finds the manager through XDG_RUNTIME_DIR or the session bus. An
 * agent shell, cron, or an SSH session without pam_systemd has neither, even
 * though the manager is running and /run/user/<uid> exists. Each missing
 * variable is named from that directory only when it is a real directory (and,
 * for the bus, a socket) owned by this uid, so another user's runtime
 * directory is never used. A variable already set is never replaced.
 */
export declare function userManagerEnvironment(uid: number | undefined, environment: NodeJS.ProcessEnv, owner: RuntimeOwner | undefined): NodeJS.ProcessEnv | undefined;
/** Native removal also works when the installed scanner or its unit file is damaged. */
export declare function uninstallSystemdUnit(unitPath: string, run: (file: string, args: string[]) => Promise<string>, options?: {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    recordedPid?: number | null;
}): Promise<void>;
//# sourceMappingURL=systemdControl.d.ts.map