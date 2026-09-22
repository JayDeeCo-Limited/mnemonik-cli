/** Native removal also works when the installed scanner or its unit file is damaged. */
export declare function uninstallSystemdUnit(unitPath: string, run: (file: string, args: string[]) => Promise<string>, options?: {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    recordedPid?: number | null;
}): Promise<void>;
//# sourceMappingURL=systemdControl.d.ts.map