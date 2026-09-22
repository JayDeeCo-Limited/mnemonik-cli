import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile, } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, posix, resolve, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { hash, RuntimeError, RuntimeStore, safePath, } from './store.js';
/**
 * The stdlib-only bootstrap is part of the accepted initial npm trust root.
 * Same-user replacement of the bootstrap is outside the digest-only threat model
 * until release artifacts carry OS-level signatures. The path guard proves layout, lock and tarball
 * agreement, not that npm itself ran; it is not provenance.
 */
const official = '@mnemonik/cli';
const cliKey = 'node_modules/@mnemonik/cli';
const bootstrapFrames = ['|', '/', '-', '\\'];
export function bootstrapProgress(stream = process.stdout, interactive = Boolean(process.stdout.isTTY), inherited = false) {
    if (!interactive) {
        if (!inherited)
            stream.write('Preparing the installer\n');
        return { stop: () => undefined };
    }
    let frame = 0;
    let active = true;
    const render = () => {
        if (!active)
            return;
        stream.write(`\r\u001b[2K${bootstrapFrames[frame]} Preparing the installer`);
        frame = (frame + 1) % bootstrapFrames.length;
    };
    const timer = setInterval(render, 80);
    timer.unref();
    render();
    return {
        stop: () => {
            if (!active)
                return;
            active = false;
            clearInterval(timer);
            stream.write('\r\u001b[2K');
        },
    };
}
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
function bootstrapStateDirectory(platform = process.platform, env = process.env, home = homedir()) {
    if (env.MNEMONIK_STATE_DIR)
        return env.MNEMONIK_STATE_DIR;
    if (platform === 'win32')
        return win32.join(env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local'), 'Mnemonik');
    if (platform === 'darwin')
        return posix.join(home, 'Library', 'Application Support', 'Mnemonik');
    return posix.join(env.XDG_STATE_HOME || posix.join(home, '.local', 'state'), 'mnemonik');
}
export async function guardNpmLaunch(entry) {
    const absolute = resolve(entry);
    const root = dirname(dirname(absolute));
    if (!root.replaceAll('\\', '/').endsWith('/' + cliKey) ||
        absolute !== join(root, 'dist', 'bin.js') ||
        (await realpath(root)) !== root ||
        (await realpath(absolute)) !== absolute)
        throw new RuntimeError('permission');
    const prefix = dirname(dirname(dirname(root)));
    // A symlinked workspace, checkout, loose temp entry, or npm link is not an installed release.
    const pkg = await json(join(root, 'package.json'));
    const lock = await json(join(prefix, 'node_modules', '.package-lock.json'));
    const pinned = lock.packages[cliKey];
    if (pkg.name !== official ||
        pinned?.link ||
        pinned?.version !== pkg.version ||
        !pinned?.integrity ||
        !pinned.resolved)
        throw new RuntimeError('permission');
    return { root, prefix, pkg, packages: lock.packages, entry: absolute };
}
/** Restricted npm tar reader: regular files/directories only; no links, extensions or path escapes. */
export function unpack(tarball) {
    const tar = gunzipSync(tarball, { maxOutputLength: 256 * 1024 * 1024 });
    const files = Object.create(null);
    for (let offset = 0; offset + 512 <= tar.length;) {
        const header = tar.subarray(offset, offset + 512);
        if (header.every((byte) => byte === 0))
            break;
        const field = (start, length) => header
            .subarray(start, start + length)
            .toString()
            .replace(/\0.*$/s, '');
        const checksum = [...header].reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
        const size = parseInt(field(124, 12).trim(), 8);
        if (checksum !== parseInt(field(148, 8).trim(), 8) ||
            !Number.isSafeInteger(size) ||
            size < 0 ||
            offset + 512 + size > tar.length)
            throw new RuntimeError('digest_mismatch');
        const name = (field(345, 155) ? field(345, 155) + '/' : '') + field(0, 100);
        const kind = field(156, 1);
        if (!name.startsWith('package/') || !['', '0', '5'].includes(kind))
            throw new RuntimeError('permission');
        if (kind !== '5') {
            const key = safePath(name.slice(8));
            if (Object.hasOwn(files, key))
                throw new RuntimeError('permission');
            files[key] = tar.subarray(offset + 512, offset + 512 + size);
        }
        offset += 512 + Math.ceil(size / 512) * 512;
    }
    return files;
}
async function tarballBytes(entry, prefix) {
    let bytes;
    if (entry.resolved.startsWith('file:'))
        bytes = await readFile(fileURLToPath(new URL(entry.resolved.slice(5), pathToFileURL(prefix + '/'))));
    else {
        if (!entry.resolved.startsWith('https://'))
            throw new RuntimeError('unsigned');
        const response = await fetch(entry.resolved, {
            redirect: 'error',
            signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok)
            throw new RuntimeError('manifest_missing');
        bytes = Buffer.from(await response.arrayBuffer());
    }
    const match = /^(sha512|sha256)-([A-Za-z0-9+/=]+)$/.exec(entry.integrity);
    if (!match?.[1] || createHash(match[1]).update(bytes).digest('base64') !== match[2])
        throw new RuntimeError('digest_mismatch');
    return bytes;
}
export async function npmSource(launch) {
    const files = Object.create(null);
    const packages = [];
    const queue = [cliKey];
    const seen = new Set();
    while (queue.length) {
        const key = queue.shift();
        if (!key)
            break;
        if (seen.has(key))
            continue;
        seen.add(key);
        const pinned = launch.packages[key];
        if (!pinned || pinned.link)
            throw new RuntimeError('unsigned');
        const tarball = await tarballBytes(pinned, launch.prefix);
        const contents = unpack(tarball);
        const packageBytes = contents['package.json'];
        if (!packageBytes)
            throw new RuntimeError('manifest_missing');
        const pkg = JSON.parse(packageBytes.toString());
        if (pkg.version !== pinned.version ||
            key.split('node_modules/').at(-1) !== pkg.name ||
            ['preinstall', 'install', 'postinstall'].some((s) => pkg.scripts?.[s]))
            throw new RuntimeError('unsigned');
        packages.push({
            name: pkg.name,
            version: pkg.version,
            integrity: pinned.integrity,
            tarball: pinned.resolved,
            tarballSha256: hash(tarball),
        });
        for (const [name, bytes] of Object.entries(contents)) {
            files[key + '/' + name] = bytes;
            const path = join(launch.prefix, key, name);
            if (!(await lstat(path)).isFile() || (await realpath(path)) !== path)
                throw new RuntimeError('permission');
            if (!bytes.equals(await readFile(path)))
                throw new RuntimeError('digest_mismatch');
        }
        for (const dependency of Object.keys(pkg.dependencies ?? {})) {
            let parent = key;
            while (!launch.packages[(parent ? parent + '/' : '') + 'node_modules/' + dependency]) {
                if (!parent)
                    throw new RuntimeError('manifest_missing');
                parent = posix.dirname(parent);
                if (parent === '.')
                    parent = '';
            }
            queue.push((parent ? parent + '/' : '') + 'node_modules/' + dependency);
        }
    }
    return {
        files,
        manifest: {
            schemaVersion: 1,
            artifact: 'cli',
            version: launch.pkg.version,
            entry: cliKey + '/dist/router.js',
            totalSize: Object.values(files).reduce((sum, b) => sum + b.length, 0),
            files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [
                name,
                { sha256: hash(bytes), size: bytes.length, executable: false },
            ])),
            source: { kind: 'npm', packages, launchedFrom: launch.entry },
        },
    };
}
export async function installBootstrap(store, source) {
    const root = join(store.state, 'runtimes', 'bootstrap');
    const bin = join(root, 'dist', 'bin.js');
    const previous = root + '.previous';
    const installed = async () => {
        try {
            await store.inspect(bin);
        }
        catch (e) {
            if (e.code !== 'ENOENT')
                throw e;
            return undefined;
        }
        return json(join(root, 'bootstrap-digests.json'));
    };
    let current = await installed();
    const files = {};
    for (const name of [
        'bin.js',
        'help.js',
        'humanReason.js',
        'runtime/bootstrap.js',
        'runtime/store.js',
        'runtime/signers.js',
    ]) {
        const bytes = source.files[cliKey + '/dist/' + name];
        if (!bytes)
            throw new RuntimeError('manifest_missing');
        files['dist/' + name] = bytes;
    }
    for (const name of ['runtimeReader.js', 'runtimeSigners.js']) {
        const bytes = source.files[`node_modules/@mnemonik/shared/dist/${name}`] ??
            source.files[`${cliKey}/dist/vendor/shared/${name}`];
        if (!bytes)
            throw new RuntimeError('manifest_missing');
        files[`node_modules/@mnemonik/shared/dist/${name}`] = bytes;
    }
    files['node_modules/@mnemonik/shared/package.json'] = Buffer.from(JSON.stringify({
        type: 'module',
        name: '@mnemonik/shared',
        exports: { './hook-runtime': './dist/runtimeReader.js' },
    }));
    files['package.json'] = Buffer.from(JSON.stringify({ type: 'module', name: '@mnemonik/runtime-bootstrap' }));
    const bootstrapFiles = Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, hash(bytes)]));
    const matches = (digests) => !!digests &&
        Object.keys(digests).length === Object.keys(bootstrapFiles).length &&
        Object.entries(bootstrapFiles).every(([name, digest]) => digests[name] === digest);
    const verifyFiles = async (directory, digests) => {
        for (const [name, digest] of Object.entries(digests))
            if (hash(await store.bytes(join(directory, name))) !== digest)
                throw new RuntimeError('digest_mismatch');
    };
    const accepts = async (digests) => {
        if (!matches(digests))
            return false;
        await verifyFiles(root, bootstrapFiles);
        return true;
    };
    const verifyPrevious = async () => {
        await store.inspect(previous, true);
        const digests = await json(join(previous, 'bootstrap-digests.json'));
        // A previous release can omit the newly added copy and help modules. No
        // unrelated entries may be removed, even inside an otherwise valid bootstrap.
        const optional = new Set(['dist/humanReason.js', 'dist/help.js']);
        const names = Object.keys(bootstrapFiles).filter((name) => !optional.has(name));
        if (!digests ||
            names.some((name) => !digests[name]) ||
            Object.keys(digests).some((name) => !Object.hasOwn(bootstrapFiles, name)) ||
            digests['package.json'] !== bootstrapFiles['package.json'])
            throw new RuntimeError('manifest_missing');
        const entries = new Set(['bootstrap-digests.json']);
        for (const name of Object.keys(digests)) {
            entries.add(name);
            for (let parent = posix.dirname(name); parent !== '.'; parent = posix.dirname(parent))
                entries.add(parent);
        }
        const actual = await readdir(previous, { recursive: true });
        if (actual.length !== entries.size ||
            actual.some((name) => !entries.has(name.replaceAll('\\', '/'))))
            throw new RuntimeError('manifest_missing');
        await verifyFiles(previous, digests);
    };
    if (await accepts(current))
        return bin;
    return store.withMutationLock('cli', async (assertOwned) => {
        current = await installed();
        if (!current) {
            // Recover a crash between moving the old bootstrap aside and publishing the stage.
            try {
                await verifyPrevious();
                await assertOwned();
                await rename(previous, root);
            }
            catch (e) {
                if (e.code !== 'ENOENT')
                    throw e;
            }
            current = await installed();
        }
        if (await accepts(current))
            return bin;
        let stage;
        try {
            stage = await mkdtemp(join(dirname(root), '.bootstrap-'));
            for (const [name, bytes] of Object.entries(files)) {
                const path = join(stage, name);
                await mkdir(dirname(path), { recursive: true, mode: 0o700 });
                await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
            }
            await writeFile(join(stage, 'bootstrap-digests.json'), JSON.stringify(bootstrapFiles), {
                mode: 0o600,
                flag: 'wx',
            });
            const staged = JSON.parse((await store.bytes(join(stage, 'bootstrap-digests.json'))).toString());
            if (!matches(staged))
                throw new RuntimeError('digest_mismatch');
            for (const [name, digest] of Object.entries(bootstrapFiles))
                if (hash(await store.bytes(join(stage, name))) !== digest)
                    throw new RuntimeError('digest_mismatch');
            await assertOwned();
            if (current) {
                const exists = await lstat(previous).catch((error) => {
                    if (error.code !== 'ENOENT')
                        throw error;
                    return undefined;
                });
                if (exists) {
                    await verifyPrevious();
                    await assertOwned();
                    await rm(previous, { recursive: true });
                }
                await assertOwned();
                await rename(root, previous);
            }
            try {
                await rename(stage, root);
            }
            catch (e) {
                if (current)
                    await rename(previous, root);
                throw e;
            }
        }
        catch (e) {
            // Never execute an unverified old bootstrap after a failed refresh.
            if (!(await accepts(await installed())))
                throw e;
        }
        finally {
            if (stage)
                await rm(stage, { recursive: true, force: true });
        }
        return bin;
    });
}
/** Compare the exact release versions without adding a channel or filtering dist-tags. */
export function newerVersion(candidate, current) {
    const parts = (value) => {
        const [core, ...pre] = value.split('-');
        return [...(core ?? '').split('.'), ...(pre.length ? pre.join('-').split('.') : [])];
    };
    const a = parts(candidate), b = parts(current);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const left = a[i], right = b[i];
        if (left === right)
            continue;
        if (left === undefined)
            return i === 3;
        if (right === undefined)
            return i !== 3;
        const numericLeft = /^\d+$/.test(left), numericRight = /^\d+$/.test(right);
        if (numericLeft && numericRight)
            return Number(left) > Number(right);
        if (numericLeft !== numericRight)
            return !numericLeft;
        return left > right;
    }
    return false;
}
export async function bootstrap(args, entry = process.argv[1] ?? '') {
    const inheritedProgress = process.env.MNEMONIK_BOOTSTRAP_PROGRESS === '1';
    delete process.env.MNEMONIK_BOOTSTRAP_PROGRESS;
    const progress = args[0] === 'install'
        ? bootstrapProgress(process.stdout, undefined, inheritedProgress)
        : undefined;
    return bootstrapWithProgress(args, entry, progress).catch((error) => {
        progress?.stop();
        throw error;
    });
}
async function bootstrapWithProgress(args, entry, progress) {
    const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/[\\/]$/, '');
    if ((await json(join(root, 'package.json'))).name === '@mnemonik/runtime-bootstrap') {
        const store = new RuntimeStore(dirname(dirname(root)));
        if (root !== join(store.state, 'runtimes', 'bootstrap'))
            throw new RuntimeError('permission');
        await store.inspect(join(root, 'dist', 'bin.js'));
        if (args[0] === '--runtime-pointer') {
            if (args[1] !== store.pointerPath('scanner'))
                throw new RuntimeError('permission');
            const scanner = await store.verifyRuntime('scanner');
            return launchChild(scanner.entry, args.slice(2));
        }
        const verified = await store.verifyRuntime('cli');
        const { runCli } = (await import(pathToFileURL(verified.entry).href));
        progress?.stop();
        return runCli(args);
    }
    // A runtime bin is callable only while the verified current pointer selects it.
    const versionDirectory = dirname(dirname(dirname(root)));
    const artifactDirectory = dirname(versionDirectory);
    if (root === join(versionDirectory, cliKey) &&
        artifactDirectory.endsWith(join('runtimes', 'cli'))) {
        const store = new RuntimeStore(dirname(dirname(artifactDirectory)));
        const verified = await store.verifyRuntime('cli');
        if (resolve(entry) !== join(dirname(verified.entry), 'bin.js') ||
            (await realpath(entry)) !== resolve(entry))
            throw new RuntimeError('permission');
        const { runCli } = (await import(pathToFileURL(verified.entry).href));
        progress?.stop();
        return runCli(args);
    }
    const launch = await guardNpmLaunch(entry);
    if (launch.root !== root)
        throw new RuntimeError('permission');
    const source = await npmSource(launch);
    const store = new RuntimeStore(bootstrapStateDirectory());
    const current = await readFile(store.pointerPath('cli')).then(() => store.verifyRuntime('cli'), (error) => {
        if (error.code !== 'ENOENT')
            throw error;
        return undefined;
    });
    if (!current ||
        args[0] === 'install' ||
        newerVersion(launch.pkg.version, current.reference.version))
        await store.installRuntime('cli', launch.pkg.version, source);
    const launcher = await installBootstrap(store, source);
    progress?.stop();
    return launchChild(process.execPath, [launcher, ...args], progress ? { MNEMONIK_BOOTSTRAP_PROGRESS: '1' } : undefined);
}
const children = new Set();
const interruptChildren = () => {
    for (const child of children)
        child.kill('SIGINT');
};
const terminateChildren = () => {
    for (const child of children)
        child.kill('SIGTERM');
};
const hangupChildren = () => {
    for (const child of children)
        child.kill('SIGHUP');
};
function trackChild(child) {
    if (children.size === 0) {
        process.on('SIGINT', interruptChildren);
        process.on('SIGTERM', terminateChildren);
        process.on('SIGHUP', hangupChildren);
    }
    children.add(child);
    return () => {
        children.delete(child);
        if (children.size === 0) {
            process.off('SIGINT', interruptChildren);
            process.off('SIGTERM', terminateChildren);
            process.off('SIGHUP', hangupChildren);
        }
    };
}
export function launchChild(file, args, envOverrides = {}) {
    // Do not inherit Node preload hooks or external module lookup paths into the durable child.
    const env = { ...process.env, ...envOverrides };
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    return new Promise((resolve, reject) => {
        const processChild = spawn(file, args, { stdio: 'inherit', env });
        const untrack = trackChild(processChild);
        processChild.once('error', (error) => {
            untrack();
            reject(error);
        });
        processChild.once('close', (code) => {
            untrack();
            resolve(code ?? 1);
        });
    });
}
//# sourceMappingURL=bootstrap.js.map