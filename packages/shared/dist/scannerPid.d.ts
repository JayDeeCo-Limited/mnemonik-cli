import { execFileSync } from 'node:child_process';
export declare function pidIsScanner(pid: number, platform?: NodeJS.Platform, exec?: typeof execFileSync, identity?: {
    binaryPath: string;
    uid: number;
}): boolean;
//# sourceMappingURL=scannerPid.d.ts.map