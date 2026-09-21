import { windowsCurrentAccountSync } from '@mnemonik/shared/hook-runtime';
import { createHash, randomUUID } from 'node:crypto';
import { execFile as nodeExecFile } from 'node:child_process';
import fs from 'node:fs';
import { open, rename, readFile, mkdir, lstat, chmod, writeFile, unlink, rmdir, } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, win32, posix } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RuntimeError } from '@mnemonik/shared/hook-runtime';
const lockfileKey = Symbol.for('mnemonik.proper-lockfile');
function sharedLockfile() {
    const shared = globalThis;
    return (shared[lockfileKey] ??= import('proper-lockfile').then((module) => module.default));
}
export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const codeIs = (error, code) => error.code === code;
export function stateDirectory(platform = process.platform, env = process.env, home = homedir()) {
    if (env.MNEMONIK_STATE_DIR)
        return env.MNEMONIK_STATE_DIR;
    if (platform === 'win32')
        return win32.join(env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local'), 'Mnemonik');
    if (platform === 'darwin')
        return posix.join(home, 'Library', 'Application Support', 'Mnemonik');
    return posix.join(env.XDG_STATE_HOME || posix.join(home, '.local', 'state'), 'mnemonik');
}
export const recordPath = (root, state = stateDirectory()) => join(state, 'project-setup', `${hash(root)}.json`);
export async function readBytes(path) {
    try {
        if (!(await lstat(path)).isFile())
            throw new Error('setup_requires_regular_file');
        return await readFile(path);
    }
    catch (error) {
        if (codeIs(error, 'ENOENT'))
            return null;
        throw error;
    }
}
export async function syncDirectory(path) {
    // Windows does not expose directory fsync through Node. File fsync still runs.
    if (process.platform === 'win32')
        return;
    const fd = await open(path, 'r');
    try {
        await fd.sync();
    }
    finally {
        await fd.close();
    }
}
/** Resolve the process token: OpenSSH can advertise WORKGROUP as USERDOMAIN. */
export const windowsCurrentAccount = windowsCurrentAccountSync;
/** Only a path this process just created may have privileged grants stripped;
 *  a pre-existing one must be refused by validation rather than repaired. */
export async function windowsCurrentUserAcl(path, directory = false, options = {}, created = false) {
    const username = options.username ?? `*${windowsCurrentAccount().sid}`;
    const grant = `${username}:${directory ? '(OI)(CI)F' : 'F'}`;
    const execFile = options.execFile ?? nodeExecFile;
    await new Promise((resolve, reject) => {
        execFile('icacls.exe', [
            path,
            '/inheritance:r',
            '/grant:r',
            grant,
            ...(created ? ['/remove:g', '*S-1-5-32-544', '*S-1-5-18'] : []),
        ], (error) => {
            if (error)
                reject(error);
            else
                resolve();
        });
    });
}
export async function protectStateFile(path, platform = process.platform, aclOptions) {
    if (platform === 'win32')
        await windowsCurrentUserAcl(path, false, aclOptions);
    else
        await chmod(path, 0o600);
    return 'private';
}
export async function atomicWrite(path, bytes, fault, assertOwned) {
    await assertOwned?.();
    const temp = `${path}.${randomUUID()}.tmp`;
    const fd = await open(temp, 'wx', 0o600);
    let permissionStatus;
    try {
        permissionStatus = await protectStateFile(temp);
        const split = Math.ceil(bytes.length / 2);
        await fd.writeFile(bytes.subarray(0, split));
        await fault?.('mid_write');
        await assertOwned?.();
        await fd.writeFile(bytes.subarray(split));
        await fd.sync();
    }
    finally {
        await fd.close();
    }
    await assertOwned?.();
    await rename(temp, path);
    await syncDirectory(dirname(path));
    return permissionStatus;
}
/** Cooperative mkdir lease: all consumers must use these same stale/update values. */
export async function withLock(path, waitMs, work) {
    const lockfile = await sharedLockfile();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const generation = randomUUID();
    const owner = join(`${path}.lock`, 'owner');
    let compromised = false;
    let acquired = false;
    const assertOwned = async () => {
        if (compromised || (await readBytes(owner).catch(() => null))?.toString() !== generation) {
            compromised = true;
            throw new Error('lock_lost');
        }
    };
    // Install the owner before proper-lockfile probes mtime; a later directory write
    // would otherwise invalidate its heartbeat. Reclamation removes the owner too.
    const leaseFs = {
        ...fs,
        mkdir: (dir, callback) => {
            void mkdir(dir)
                .then(() => writeFile(owner, generation, { mode: 0o600, flag: 'wx' }))
                .then(() => callback(), callback);
        },
        rmdir: (dir, callback) => {
            void unlink(join(dir, 'owner'))
                .catch((error) => {
                if (!codeIs(error, 'ENOENT'))
                    throw error;
            })
                .then(() => rmdir(dir))
                .then(() => callback(), callback);
        },
        rmdirSync: (dir) => {
            try {
                fs.unlinkSync(join(dir, 'owner'));
            }
            catch (error) {
                if (!codeIs(error, 'ENOENT'))
                    throw error;
            }
            fs.rmdirSync(dir);
        },
        stat: (file, callback) => {
            // A superseded holder must also stop heartbeating the replacement lease.
            void (acquired ? assertOwned() : Promise.resolve()).then(() => fs.stat(file, callback), () => callback(Object.assign(new Error('lock_lost'), { code: 'ENOENT' })));
        },
    };
    const deadline = performance.now() + waitMs;
    let release;
    while (!release) {
        try {
            release = await lockfile.lock(path, {
                realpath: false,
                stale: 30_000,
                update: 5_000,
                retries: 0,
                fs: leaseFs,
                onCompromised: () => {
                    compromised = true;
                },
            });
        }
        catch (error) {
            if (!codeIs(error, 'ELOCKED'))
                throw error;
            if (performance.now() >= deadline)
                throw new RuntimeError('lock_held');
            await delay(Math.min(100, Math.max(1, deadline - performance.now())));
        }
    }
    acquired = true;
    try {
        return await work(assertOwned);
    }
    finally {
        // Never release a successor's lease. A lost holder's heartbeat observes the
        // generation check above and stops through onCompromised.
        if (await assertOwned().then(() => true, () => false))
            await release();
    }
}
//# sourceMappingURL=storage.js.map