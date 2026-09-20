import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from '@mnemonik/local-setup';
import { RuntimeError } from './store.js';
import { npmReleaseSource, releaseBytes, signedReleaseManifest } from './releaseSource.js';
import { newerVersion } from './bootstrap.js';
const registry = 'https://registry.npmjs.org/%40mnemonik%2Fcli/';
const validVersion = (value) => typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(value);
async function metadata(version = 'latest', fetcher = fetch) {
    const value = JSON.parse((await releaseBytes(registry + version, fetcher)).toString());
    if (value.name !== '@mnemonik/cli' ||
        !validVersion(value.version) ||
        (version !== 'latest' && value.version !== version) ||
        !/^(sha512|sha256)-[A-Za-z0-9+/=]+$/.test(value.dist?.integrity) ||
        typeof value.dist?.tarball !== 'string')
        throw new RuntimeError('unsigned');
    return value;
}
export async function updateCli(store, options = {}) {
    let oldVersion;
    let newVersion;
    const dev = process.env.MNEMONIK_DEV_RELEASE_DIR ? { devReleaseSource: true } : {};
    const fetcher = options.fetcher ?? fetch;
    try {
        // Source checkouts do not have a managed CLI; the public entry always installs one first.
        if (!(await readFile(store.pointerPath('cli')).then(() => true, (error) => {
            if (error.code === 'ENOENT')
                return false;
            throw error;
        })))
            return { status: 'NOT_INSTALLED', ...dev };
        oldVersion = (await store.verifyRuntime('cli')).reference.version;
        const latest = await metadata('latest', fetcher);
        newVersion = latest.version;
        if (oldVersion === newVersion)
            return { status: 'UP_TO_DATE', oldVersion, newVersion, ...dev };
        const exact = await metadata(newVersion, fetcher);
        if (exact.dist.integrity !== latest.dist.integrity)
            throw new RuntimeError('digest_mismatch');
        const release = await signedReleaseManifest(newVersion, fetcher, options.releaseKey);
        const signedCli = release.packages['@mnemonik/cli'];
        if (!signedCli)
            throw new RuntimeError('unsigned');
        if (signedCli.version !== exact.version || signedCli.integrity !== exact.dist.integrity)
            throw new RuntimeError('digest_mismatch');
        const source = await npmReleaseSource(fetcher, async () => ({
            version: exact.version,
            'dist.integrity': signedCli.integrity,
            'dist.tarball': exact.dist.tarball,
        }));
        await store.installRuntime('cli', newVersion, source);
        return { status: 'UPDATED', oldVersion, newVersion, ...dev };
    }
    catch (error) {
        return { status: 'FAILED', oldVersion, newVersion, reason: error.message, ...dev };
    }
}
export function cliUpdateLine(result) {
    if (result.status === 'UPDATED')
        return `CLI updated: ${result.oldVersion} -> ${result.newVersion}. Next invocation uses ${result.newVersion}.`;
    if (result.status === 'UP_TO_DATE')
        return `CLI up to date: ${result.oldVersion}.`;
    if (result.status === 'NOT_INSTALLED')
        return 'CLI runtime is not installed.';
    return `CLI update FAILED: ${result.reason}. CLI remains ${result.oldVersion ?? 'unavailable'}.`;
}
/** Status alone caches successes and failures; update always reads the release afresh. */
export async function cliUpdateHint(store, current) {
    const path = join(store.state, 'cli-update-check.json');
    const devReleaseSource = process.env.MNEMONIK_DEV_RELEASE_DIR ?? '';
    let cached;
    try {
        await store.inspect(path);
        cached = JSON.parse(await readFile(path, 'utf8'));
    }
    catch {
        /* An absent or unreadable hint must not affect status. */
    }
    if (!cached ||
        cached.devReleaseSource !== devReleaseSource ||
        !(Date.now() - cached.checkedAt >= 0 && Date.now() - cached.checkedAt < 3_600_000)) {
        cached = { checkedAt: Date.now(), devReleaseSource };
        try {
            const signal = AbortSignal.timeout(2500);
            cached.version = (await metadata('latest', (url, options) => fetch(url, { ...options, signal }))).version;
        }
        catch {
            /* Offline status stays quiet. */
        }
        try {
            await store.inspect(store.state, true);
            await atomicWrite(path, Buffer.from(JSON.stringify(cached)));
        }
        catch {
            /* Cache persistence is best effort. */
        }
    }
    if (!validVersion(cached.version) || cached.version === current)
        return undefined;
    if (!newerVersion(cached.version, current))
        return undefined;
    return `CLI ${cached.version} is available; run mnemonik update.`;
}
//# sourceMappingURL=selfUpdate.js.map