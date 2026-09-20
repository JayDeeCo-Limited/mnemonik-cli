import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { stateDirectory } from '@mnemonik/local-setup';
import { RELEASE_MINISIGN_PUBLIC_KEY, verifyMinisign } from '@mnemonik/shared/hook-runtime';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { unpack } from './bootstrap.js';
import { hash, RuntimeError, safePath, } from './store.js';
export const releasePackageNames = [
    '@mnemonik/cli',
    '@mnemonik/claude-code-hooks',
    '@mnemonik/codex-hooks',
    '@mnemonik/copilot-hooks',
    '@mnemonik/cursor-hooks',
    '@mnemonik/grok-hooks',
];
const releaseRoot = 'https://github.com/JayDeeCo-Limited/mnemonik-cli/releases/download/';
const redirects = new Set([
    'release-assets.githubusercontent.com',
    'objects.githubusercontent.com',
]);
function permitted(url) {
    return (url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.port &&
        !url.hash &&
        ((url.origin === 'https://github.com' && url.href.startsWith(releaseRoot)) ||
            url.origin === 'https://registry.npmjs.org' ||
            url.origin === 'https://api.mnemonik.dev'));
}
/** Development sources retain all digest/signature checks and never accept an arbitrary URL. */
export function devReleaseActive() {
    if (process.env.MNEMONIK_DEV_RELEASE_DIR)
        return true;
    try {
        return (JSON.parse(readFileSync(join(stateDirectory(), 'host-ownership.json'), 'utf8'))
            .devReleaseSource === true);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return false;
        throw error;
    }
}
export function devReadiness(document) {
    if (!devReleaseActive())
        return document;
    return {
        ...document,
        devReleaseSource: true,
        installation: {
            ...document.installation,
            state: document.installation.state === 'READY' ? 'LIMITED' : document.installation.state,
            reasons: [...new Set([...document.installation.reasons, 'dev_release_source'])],
        },
    };
}
async function devBytes(url) {
    const directory = process.env.MNEMONIK_DEV_RELEASE_DIR;
    if (!directory)
        return undefined;
    const local = async (name) => {
        if (!/^[a-zA-Z0-9._-]+$/.test(name))
            throw new RuntimeError('permission');
        const root = await realpath(resolve(directory));
        const path = join(root, name);
        if ((await realpath(path)) !== path)
            throw new RuntimeError('permission');
        return readFile(path);
    };
    if (url.href.startsWith(releaseRoot))
        return local(url.pathname.split('/').at(-1) ?? '');
    if (url.origin !== 'https://registry.npmjs.org')
        return undefined;
    const parts = url.pathname.slice(1).split('/').map(decodeURIComponent);
    if (parts[0] === '@mnemonik' && parts[1] === '-')
        return local(parts[2] ?? '');
    const index = JSON.parse((await local('index.json').catch((error) => {
        if (error.code === 'ENOENT')
            return Buffer.from('{}');
        throw error;
    })).toString());
    const pinned = index[parts[0] ?? ''];
    if (pinned) {
        if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pinned.version))
            throw new RuntimeError('permission');
        await local(pinned.tarball); // Check directory containment before issuing local metadata.
        return Buffer.from(JSON.stringify({
            name: parts[0],
            version: pinned.version,
            dist: {
                integrity: pinned.integrity,
                tarball: `https://registry.npmjs.org/@mnemonik/-/${pinned.tarball}`,
            },
        }));
    }
    if (!parts[0]?.startsWith('@mnemonik/'))
        return undefined;
    const [name, version] = parts;
    if (!/^@mnemonik\/[a-z0-9-]+$/.test(name) || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version ?? ''))
        throw new RuntimeError('permission');
    const filename = `${name.slice(1).replace('/', '-')}-${version}.tgz`;
    const bytes = await local(filename);
    return Buffer.from(JSON.stringify({
        name,
        version,
        dist: {
            integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
            tarball: `https://registry.npmjs.org/@mnemonik/-/${filename}`,
        },
    }));
}
/** Validate before each request; only GitHub release downloads get one pinned CDN hop. */
export async function releaseBytes(address, fetcher = fetch) {
    const url = new URL(address);
    if (!permitted(url))
        throw new RuntimeError('permission');
    const development = await devBytes(url);
    if (development)
        return development;
    const options = { redirect: 'manual', signal: AbortSignal.timeout(60_000) };
    let response = await fetcher(url, options);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        const next = location ? new URL(location, url) : undefined;
        if (!url.href.startsWith(releaseRoot) ||
            !next ||
            next.protocol !== 'https:' ||
            next.username ||
            next.password ||
            next.port ||
            next.hash ||
            !redirects.has(next.hostname))
            throw new RuntimeError('permission');
        response = await fetcher(next, options);
    }
    if (response.status >= 300 && response.status < 400)
        throw new RuntimeError('permission');
    if (!response.ok)
        throw new RuntimeError(response.status === 404 ? 'manifest_missing' : 'permission');
    return Buffer.from(await response.arrayBuffer());
}
export async function signedReleaseManifest(version, fetcher = fetch, identity = RELEASE_MINISIGN_PUBLIC_KEY) {
    if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version))
        throw new RuntimeError('unsigned');
    const base = `${releaseRoot}scanner-v${version}/release-manifest.json`;
    let bytes;
    try {
        bytes = await releaseBytes(base, fetcher);
    }
    catch (error) {
        if ((error instanceof RuntimeError && error.reason === 'manifest_missing') ||
            (error.code === 'ENOENT' && process.env.MNEMONIK_DEV_RELEASE_DIR))
            throw new RuntimeError('unsigned');
        throw error;
    }
    let signature;
    try {
        signature = await releaseBytes(base + '.minisig', fetcher);
        verifyMinisign(bytes, signature.toString(), identity);
    }
    catch {
        throw new RuntimeError('unsigned');
    }
    let manifest;
    try {
        manifest = JSON.parse(bytes.toString());
    }
    catch {
        throw new RuntimeError('unsigned');
    }
    if (!manifest ||
        typeof manifest !== 'object' ||
        Array.isArray(manifest) ||
        !manifest.packages ||
        typeof manifest.packages !== 'object' ||
        Array.isArray(manifest.packages))
        throw new RuntimeError('unsigned');
    const names = Object.keys(manifest.packages).sort();
    if (manifest.schemaVersion !== 1 ||
        manifest.version !== version ||
        names.join() !== [...releasePackageNames].sort().join() ||
        names.some((name) => {
            const entry = manifest.packages[name];
            return (!entry ||
                !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(entry.version) ||
                !/^(sha512|sha256)-[A-Za-z0-9+/=]+$/.test(entry.integrity));
        }) ||
        manifest.packages['@mnemonik/cli']?.version !== version)
        throw new RuntimeError('unsigned');
    return manifest;
}
export async function scannerReleaseSource(trusted, fetcher = fetch, platform = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`) {
    if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(trusted.version))
        throw new RuntimeError('permission');
    const manifest = trusted.platforms[platform];
    const base = `${releaseRoot}scanner-v${trusted.version}/`;
    if (!manifest ||
        manifest.artifact !== 'scanner' ||
        manifest.version !== trusted.version ||
        manifest.source.kind !== 'release' ||
        manifest.source.url !== base)
        throw new RuntimeError('manifest_missing');
    const bytes = await releaseBytes(base + 'digests.json', fetcher);
    if (hash(bytes) !== trusted.digestsSha256)
        throw new RuntimeError('digest_mismatch');
    const index = JSON.parse(bytes.toString());
    const files = {};
    for (const [name, expected] of Object.entries(manifest.files)) {
        safePath(name);
        const indexed = index.files[name];
        if (!indexed || indexed.sha256 !== expected.sha256 || indexed.size !== expected.size)
            throw new RuntimeError('digest_mismatch');
        const content = await releaseBytes(base + name, fetcher);
        if (hash(content) !== expected.sha256 || content.length !== expected.size)
            throw new RuntimeError('digest_mismatch');
        files[name] = content;
    }
    // RuntimeStore performs platform signature verification before installing/executing these bytes.
    return { manifest, files };
}
export async function npmReleaseSource(fetcher = fetch, view = async () => {
    // Invoke npm's JS entry using Node on Windows too; never run a shell command built from metadata.
    const args = [
        'view',
        '@mnemonik/cli@latest',
        'version',
        'dist.integrity',
        'dist.tarball',
        '--json',
        '--registry=https://registry.npmjs.org',
        '--@mnemonik:registry=https://registry.npmjs.org',
        '--proxy=null',
        '--https-proxy=null',
    ];
    const windowsNpm = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const { stdout } = await promisify(execFile)(process.platform === 'win32' ? process.execPath : 'npm', process.platform === 'win32' ? [windowsNpm, ...args] : args, { env: { ...process.env, NPM_CONFIG_IGNORE_SCRIPTS: 'true' } });
    return JSON.parse(stdout);
}) {
    const dist = await view();
    const tarball = await releaseBytes(dist['dist.tarball'], fetcher);
    const match = /^(sha512|sha256)-([A-Za-z0-9+/=]+)$/.exec(dist['dist.integrity']);
    if (!match ||
        createHash(match[1] ?? 'sha512')
            .update(tarball)
            .digest('base64') !== match[2])
        throw new RuntimeError('digest_mismatch');
    const contents = unpack(tarball);
    const pkg = JSON.parse(contents['package.json']?.toString() ?? '{}');
    // The public build bundles the complete runtime. Reject packages that need an unverified fetch.
    if (pkg.name !== '@mnemonik/cli' ||
        pkg.version !== dist.version ||
        Object.keys(pkg.dependencies ?? {}).length ||
        ['preinstall', 'install', 'postinstall', 'prepare'].some((key) => Object.hasOwn(pkg.scripts ?? {}, key)))
        throw new RuntimeError('unsigned');
    const prefix = 'node_modules/@mnemonik/cli/';
    const files = Object.fromEntries(Object.entries(contents).map(([name, bytes]) => [prefix + name, bytes]));
    return {
        files,
        manifest: {
            schemaVersion: 1,
            artifact: 'cli',
            version: pkg.version,
            entry: prefix + 'dist/router.js',
            totalSize: tarballFilesSize(files),
            files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [
                name,
                { sha256: hash(bytes), size: bytes.length, executable: false },
            ])),
            source: {
                kind: 'npm',
                launchedFrom: '@mnemonik/cli@latest',
                packages: [
                    {
                        name: pkg.name,
                        version: pkg.version,
                        integrity: dist['dist.integrity'],
                        tarball: dist['dist.tarball'],
                        tarballSha256: hash(tarball),
                    },
                ],
            },
        },
    };
}
const tarballFilesSize = (files) => Object.values(files).reduce((sum, b) => sum + b.length, 0);
/** Supply this as runtimeUpdate.source; the update path restarts managed services. */
export async function releaseSource(artifact) {
    if (artifact === 'cli')
        return npmReleaseSource();
    const trusted = JSON.parse(await readFile(process.env.MNEMONIK_DEV_RELEASE_DIR
        ? join(process.env.MNEMONIK_DEV_RELEASE_DIR, 'scanner-release.json')
        : new URL('../scanner-release.json', import.meta.url), 'utf8'));
    return scannerReleaseSource(trusted);
}
//# sourceMappingURL=releaseSource.js.map