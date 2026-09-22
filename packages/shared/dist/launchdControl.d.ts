type Run = (file: string, args: string[]) => Promise<string>;
/** Print one registration, or null when the domain holds none and says so plainly. */
export declare function printLaunchdRegistration(domain: string, label: string, run: Run): Promise<string | null>;
/** Are any of these processes still alive? ps exits 1 when none of them exist. */
export declare function processesAlive(pids: Iterable<number>, run: Run): Promise<boolean>;
export declare const macScannerLauncher = "/Library/Application Support/Mnemonik/scanner-launcher";
export declare const macScannerPlist = "/Library/LaunchDaemons/ai.mnemonik.scanner.plist";
export declare function authorizeMacService(run: Run, env?: NodeJS.ProcessEnv): Promise<void>;
/** Native removal also works when the selected scanner executable is missing or old. */
export declare function removeMacScanner(state: string, home: string, uid: number, run: Run, options?: {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    plist?: string;
    launcher?: string;
    remove?: boolean;
    environment?: NodeJS.ProcessEnv;
}): Promise<void>;
/** Stop every registration and verify its processes exited before callers remove software. */
export declare function stopLaunchdRegistrations(domains: string[], label: string, run: Run, options?: {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    recordedPid?: number | null;
}): Promise<void>;
export {};
//# sourceMappingURL=launchdControl.d.ts.map