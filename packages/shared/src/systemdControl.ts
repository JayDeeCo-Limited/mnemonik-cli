import { existsSync, lstatSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { processesAlive } from './launchdControl.js';
import { SCANNER_STOP_BUDGET_MS } from './scannerSupervisor.js';

/** Who owns a path and what it is, without following a final symlink. */
export type RuntimeOwner = (
  path: string
) => { uid: number; type: 'directory' | 'socket' | 'other' } | undefined;
export const runtimeOwner: RuntimeOwner = (path) => {
  try {
    const entry = lstatSync(path);
    return {
      uid: entry.uid,
      type: entry.isDirectory() ? 'directory' : entry.isSocket() ? 'socket' : 'other',
    };
  } catch {
    return undefined;
  }
};
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
export function userManagerEnvironment(
  uid: number | undefined,
  environment: NodeJS.ProcessEnv,
  owner: RuntimeOwner | undefined
): NodeJS.ProcessEnv | undefined {
  const missingRuntime = !environment.XDG_RUNTIME_DIR;
  const missingBus = !environment.DBUS_SESSION_BUS_ADDRESS;
  if (!missingRuntime && !missingBus) return undefined;
  if (!owner || uid === undefined || !Number.isInteger(uid) || uid < 0) return undefined;
  const directory = `/run/user/${uid}`;
  const owned = (path: string, type: 'directory' | 'socket') => {
    const entry = owner(path);
    return entry?.type === type && entry.uid === uid;
  };
  if (!owned(directory, 'directory')) return undefined;
  const added: NodeJS.ProcessEnv = {};
  if (missingRuntime) added.XDG_RUNTIME_DIR = directory;
  if (missingBus && owned(`${directory}/bus`, 'socket'))
    added.DBUS_SESSION_BUS_ADDRESS = `unix:path=${directory}/bus`;
  return Object.keys(added).length ? { ...environment, ...added } : undefined;
}

/** Native removal also works when the installed scanner or its unit file is damaged. */
export async function uninstallSystemdUnit(
  unitPath: string,
  run: (file: string, args: string[]) => Promise<string>,
  options: {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    recordedPid?: number | null;
  } = {}
): Promise<void> {
  try {
    const unit = basename(unitPath);
    if (!/^mnemonik-scanner(?:-test-[0-9]+)?\.service$/.test(unit))
      throw new Error('invalid_test_unit');
    const command = (args: string[]) => run('systemctl', ['--user', ...args]);
    const inspect = async () => {
      const output = await command([
        'show',
        unit,
        '--property=LoadState,ActiveState,MainPID,UnitFileState',
      ]);
      const state = Object.fromEntries(
        output
          .trim()
          .split('\n')
          .map((line) => {
            const split = line.indexOf('=');
            return [line.slice(0, split), line.slice(split + 1)];
          })
      );
      if (
        !state.LoadState ||
        !state.ActiveState ||
        !/^\d+$/.test(state.MainPID) ||
        state.UnitFileState === undefined
      )
        throw new Error('systemd_inspection_failed');
      return state;
    };
    const before = await inspect();
    const pids = new Set<number>();
    if (Number(before.MainPID)) pids.add(Number(before.MainPID));
    const recordedPid = options.recordedPid;
    if (typeof recordedPid === 'number' && Number.isInteger(recordedPid) && recordedPid > 0)
      pids.add(recordedPid);
    if (
      before.LoadState !== 'not-found' ||
      before.ActiveState !== 'inactive' ||
      Number(before.MainPID)
    )
      await command(['stop', unit]);
    try {
      await command(['disable', '--now', unit]);
    } catch (error) {
      // Missing backing files can make disable fail before removing its enable link.
      if (
        existsSync(unitPath) ||
        !new RegExp(`Unit file ${unit.replaceAll('.', '\\.')} does not exist\\.?\\s*$`).test(
          (error as Error).message
        )
      )
        throw error;
      await rm(join(dirname(unitPath), 'default.target.wants', unit), { force: true });
      await command(['daemon-reload']);
    }
    if ((await inspect()).ActiveState === 'failed') await command(['reset-failed', unit]);
    const now = options.now ?? Date.now;
    const wait = async (removed: boolean) => {
      const deadline = now() + SCANNER_STOP_BUDGET_MS;
      do {
        const state = await inspect();
        if (Number(state.MainPID)) pids.add(Number(state.MainPID));
        const alive = await processesAlive(pids, run);
        if (
          state.ActiveState === 'inactive' &&
          Number(state.MainPID) === 0 &&
          !alive &&
          ['', 'disabled', 'static', 'indirect', 'not-found'].includes(state.UnitFileState) &&
          (!removed || state.LoadState === 'not-found')
        )
          return;
        await (options.sleep ?? delay)(100);
      } while (now() <= deadline);
      throw new Error('systemd_stop_unverified');
    };
    await wait(false);
    await rm(unitPath, { force: true });
    await command(['daemon-reload']);
    await wait(true);
  } catch (cause) {
    throw new Error('scanner_stop_failed', { cause });
  }
}
