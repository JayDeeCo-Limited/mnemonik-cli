import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
/**
 * PID-reuse guard shared by the CLI lock paths (index.ts) and doctor.
 *
 * `process.kill(pid, 0)` only proves that *some* process is alive at that
 * PID, not that it is ours. After a reboot or plain PID recycling the number
 * in daemon.pid can belong to an unrelated process, SIGTERMing it from
 * `stop`, or refusing to `start` because of it, would be wrong. So a live PID
 * only counts as the scanner when its command line matches the daemon's
 * signature (same pattern doctor uses to find daemon processes via `ps`).
 */
const SCANNER_CMD_PATTERN = /(mnemonik-scanner|scanner[\\/]dist[\\/]index\.js)/;
const capture = {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000,
};
function processCmdline(pid, platform, exec = execFileSync) {
    if (!Number.isSafeInteger(pid) || pid <= 0)
        return null;
    if (platform === 'win32') {
        try {
            return exec('powershell.exe', [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
            ], capture).trim();
        }
        catch {
            return null;
        }
    }
    // Linux: /proc/<pid>/cmdline is NUL-separated argv, cheap and exact.
    if (platform === 'linux') {
        try {
            return readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replace(/\0/g, ' ').trim();
        }
        catch {
            // /proc unavailable or unreadable, fall back to ps below.
        }
    }
    try {
        return exec('ps', ['-o', 'args=', '-p', String(pid)], capture).trim();
    }
    catch {
        return null; // No such process, or ps unavailable, cannot confirm identity.
    }
}
export function pidIsScanner(pid, platform = process.platform, exec = execFileSync, identity) {
    const cmdline = processCmdline(pid, platform, exec);
    if (cmdline === null)
        return false;
    if (!identity)
        return SCANNER_CMD_PATTERN.test(cmdline);
    // Recovery may signal only the exact verified runtime, running as this owner.
    if (cmdline !== `${identity.binaryPath} start`)
        return false;
    try {
        return exec('ps', ['-o', 'uid=', '-p', String(pid)], capture).trim() === String(identity.uid);
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=scannerPid.js.map