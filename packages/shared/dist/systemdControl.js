import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { processesAlive } from './launchdControl.js';
import { SCANNER_STOP_BUDGET_MS } from './scannerSupervisor.js';
/** Native removal also works when the installed scanner or its unit file is damaged. */
export async function uninstallSystemdUnit(unitPath, run, options = {}) {
    try {
        const unit = basename(unitPath);
        if (!/^mnemonik-scanner(?:-test-[0-9]+)?\.service$/.test(unit))
            throw new Error('invalid_test_unit');
        const command = (args) => run('systemctl', ['--user', ...args]);
        const inspect = async () => {
            const output = await command([
                'show',
                unit,
                '--property=LoadState,ActiveState,MainPID,UnitFileState',
            ]);
            const state = Object.fromEntries(output
                .trim()
                .split('\n')
                .map((line) => {
                const split = line.indexOf('=');
                return [line.slice(0, split), line.slice(split + 1)];
            }));
            if (!state.LoadState ||
                !state.ActiveState ||
                !/^\d+$/.test(state.MainPID) ||
                state.UnitFileState === undefined)
                throw new Error('systemd_inspection_failed');
            return state;
        };
        const before = await inspect();
        const pids = new Set();
        if (Number(before.MainPID))
            pids.add(Number(before.MainPID));
        const recordedPid = options.recordedPid;
        if (typeof recordedPid === 'number' && Number.isInteger(recordedPid) && recordedPid > 0)
            pids.add(recordedPid);
        if (before.LoadState !== 'not-found' ||
            before.ActiveState !== 'inactive' ||
            Number(before.MainPID))
            await command(['stop', unit]);
        try {
            await command(['disable', '--now', unit]);
        }
        catch (error) {
            // Missing backing files can make disable fail before removing its enable link.
            if (existsSync(unitPath) ||
                !new RegExp(`Unit file ${unit.replaceAll('.', '\\.')} does not exist\\.?\\s*$`).test(error.message))
                throw error;
            await rm(join(dirname(unitPath), 'default.target.wants', unit), { force: true });
            await command(['daemon-reload']);
        }
        if ((await inspect()).ActiveState === 'failed')
            await command(['reset-failed', unit]);
        const now = options.now ?? Date.now;
        const wait = async (removed) => {
            const deadline = now() + SCANNER_STOP_BUDGET_MS;
            do {
                const state = await inspect();
                if (Number(state.MainPID))
                    pids.add(Number(state.MainPID));
                const alive = await processesAlive(pids, run);
                if (state.ActiveState === 'inactive' &&
                    Number(state.MainPID) === 0 &&
                    !alive &&
                    ['', 'disabled', 'static', 'indirect', 'not-found'].includes(state.UnitFileState) &&
                    (!removed || state.LoadState === 'not-found'))
                    return;
                await (options.sleep ?? delay)(100);
            } while (now() <= deadline);
            throw new Error('systemd_stop_unverified');
        };
        await wait(false);
        await rm(unitPath, { force: true });
        await command(['daemon-reload']);
        await wait(true);
    }
    catch (cause) {
        throw new Error('scanner_stop_failed', { cause });
    }
}
//# sourceMappingURL=systemdControl.js.map