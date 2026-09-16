import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { RuntimeReader, RuntimeError, hash, safePath, missing, versionName, } from '@mnemonik/shared/hook-runtime';
export { RuntimeError, hash, safePath } from '@mnemonik/shared/hook-runtime';
export class RuntimeStore extends RuntimeReader {
    async withMutationLock(artifact, work) {
        // Keep this import here: public CLI packaging redirects it to the bundled adapter.
        const { withLock } = await import('@mnemonik/local-setup');
        return withLock(join(dirname(this.pointerPath(artifact)), 'mutation'), 5000, work);
    }
    async installRuntime(artifact, version, source) {
        const base = dirname(this.pointerPath(artifact));
        versionName(version);
        if (source.manifest.version !== version || source.manifest.artifact !== artifact)
            throw new RuntimeError('digest_mismatch');
        const manifest = Buffer.from(JSON.stringify(source.manifest));
        const ref = { version, manifestSha256: hash(manifest) };
        const pointer = await this.pointer(artifact);
        const installed = pointer?.current;
        // Reusing previous still has to select it; only current is a read-only install.
        if (installed?.version === version && installed.manifestSha256 === ref.manifestSha256)
            return this.verifyAt(artifact, installed, join(base, installed.version));
        // First npm execution is trusted; subsequent callers import this only from a verified runtime.
        const { atomicWrite, withLock, windowsCurrentUserAcl } = await import('@mnemonik/local-setup');
        await this.inspect(base, true, true);
        const created = [];
        if (process.platform === 'win32')
            for (const path of [this.state, dirname(base), base])
                await lstat(path).catch((error) => {
                    if (!missing(error))
                        throw error;
                    created.push(path);
                });
        await mkdir(base, { recursive: true, mode: 0o700 });
        // inspect already proved existing directories private; regranting changes descendant ctimes.
        for (const path of created) {
            await windowsCurrentUserAcl(path, true);
            await this.recordAclWrite(path);
        }
        await this.inspect(base, true);
        return withLock(join(base, 'mutation'), 5000, async (assertOwned) => {
            const previous = await this.pointer(artifact);
            if (previous)
                await this.verifyRuntime(artifact);
            const stage = await mkdtemp(join(base, '.stage-'));
            const target = join(base, version);
            try {
                for (const [name, bytes] of Object.entries(source.files)) {
                    const path = join(stage, safePath(name));
                    if (name === 'manifest.json')
                        throw new RuntimeError('permission');
                    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
                    const fd = await open(path, 'wx', source.manifest.files[name]?.executable ? 0o700 : 0o600);
                    try {
                        await fd.writeFile(bytes);
                        await fd.sync();
                    }
                    finally {
                        await fd.close();
                    }
                }
                await atomicWrite(join(stage, 'manifest.json'), manifest, undefined, assertOwned);
                await this.verifyAt(artifact, ref, stage);
                const known = [previous?.current, previous?.previous].find((r) => r?.version === version);
                if (known) {
                    const existing = await this.verifyAt(artifact, known, target);
                    if (JSON.stringify(existing.manifest.files) !== JSON.stringify(source.manifest.files) ||
                        existing.manifest.entry !== source.manifest.entry)
                        throw new RuntimeError('digest_mismatch');
                    ref.manifestSha256 = known.manifestSha256;
                }
                if (process.platform !== 'win32') {
                    const sync = async (dir) => {
                        for (const entry of await readdir(dir, { withFileTypes: true }))
                            if (entry.isDirectory())
                                await sync(join(dir, entry.name));
                        const fd = await open(dir, 'r');
                        try {
                            await fd.sync();
                        }
                        finally {
                            await fd.close();
                        }
                    };
                    await sync(stage);
                }
                await assertOwned();
                try {
                    await lstat(target);
                    await this.verifyAt(artifact, ref, target);
                }
                catch (e) {
                    if (!missing(e))
                        throw e;
                    await rename(stage, target);
                }
                await this.verifyAt(artifact, ref, target);
                if (previous?.current.version !== version)
                    await atomicWrite(this.pointerPath(artifact), Buffer.from(JSON.stringify({ current: ref, previous: previous?.current })), undefined, assertOwned);
                return this.verifyRuntime(artifact);
            }
            finally {
                await rm(stage, { recursive: true, force: true });
            }
        });
    }
    async rollbackRuntime(artifact, expectedCurrent) {
        await this.inspect(dirname(this.pointerPath(artifact)), true);
        const { atomicWrite, withLock } = await import('@mnemonik/local-setup');
        return withLock(join(dirname(this.pointerPath(artifact)), 'mutation'), 5000, async (assertOwned) => {
            const p = await this.pointer(artifact);
            if (!p?.previous)
                throw new RuntimeError('manifest_missing');
            if (expectedCurrent && p.current.manifestSha256 !== expectedCurrent.manifestSha256)
                throw new RuntimeError('digest_mismatch');
            await this.verifyAt(artifact, p.previous, join(dirname(this.pointerPath(artifact)), p.previous.version));
            await atomicWrite(this.pointerPath(artifact), Buffer.from(JSON.stringify({ current: p.previous, previous: p.current })), undefined, assertOwned);
            return this.verifyRuntime(artifact);
        });
    }
}
export async function updateRuntime(update) {
    const source = await update.source();
    const { artifact, version } = source.manifest;
    const before = await update.store.verifyRuntime(artifact);
    const installed = await update.store.installRuntime(artifact, version, source);
    try {
        await update.restartManagedServices(update.store.pointerPath(artifact));
    }
    catch (e) {
        if (before.reference.version !== version)
            await update.store.rollbackRuntime(artifact, installed.reference);
        await update.restartManagedServices(update.store.pointerPath(artifact));
        throw e;
    }
    return installed;
}
export async function hostNpmSource(host, pin, fetcher = fetch) {
    const { releaseBytes } = await import('./releaseSource.js');
    const { unpack } = await import('./bootstrap.js');
    if (pin.package !== `@mnemonik/${host}-hooks` ||
        !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pin.version) ||
        !pin.closure.length ||
        pin.closure.length > 100 ||
        pin.closure[0]?.name !== pin.package ||
        pin.closure[0]?.version !== pin.version)
        throw new RuntimeError('unsigned');
    const files = {};
    const packages = [];
    const seen = new Set();
    const exactBytes = async (address, name, version) => {
        try {
            return await releaseBytes(address, fetcher);
        }
        catch (error) {
            if (error instanceof RuntimeError && error.reason === 'manifest_missing')
                error.message = `manifest_missing: ${name}@${version}`;
            throw error;
        }
    };
    for (const expected of pin.closure) {
        const { name, version, integrity } = expected;
        if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name) ||
            !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version) ||
            seen.has(name))
            throw new RuntimeError('unsigned');
        seen.add(name);
        const metadata = JSON.parse((await exactBytes(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`, name, version)).toString());
        if (metadata.name !== name || metadata.version !== version)
            throw new RuntimeError('unsigned');
        if (metadata.dist.integrity !== integrity)
            throw new RuntimeError('digest_mismatch');
        const tarball = await exactBytes(metadata.dist.tarball, name, version);
        const match = /^(sha512|sha256)-([A-Za-z0-9+/=]+)$/.exec(integrity);
        if (!match ||
            createHash(match[1] ?? 'sha512')
                .update(tarball)
                .digest('base64') !== match[2])
            throw new RuntimeError('digest_mismatch');
        const contents = unpack(tarball);
        const pkg = JSON.parse(contents['package.json']?.toString() ?? '{}');
        if (pkg.name !== name ||
            pkg.version !== version ||
            ['preinstall', 'install', 'postinstall', 'prepare'].some((k) => pkg.scripts?.[k]) ||
            Object.keys(pkg.optionalDependencies ?? {}).length)
            throw new RuntimeError('unsigned');
        const prefix = `node_modules/${name}/`;
        for (const [path, bytes] of Object.entries(contents))
            files[prefix + path] = bytes;
        packages.push({
            name,
            version: pkg.version,
            integrity,
            tarball: metadata.dist.tarball,
            tarballSha256: hash(tarball),
        });
    }
    return {
        files,
        manifest: {
            schemaVersion: 1,
            artifact: host,
            version: pin.version,
            entry: `node_modules/${pin.package}/dist/hook.js`,
            files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [
                name,
                { sha256: hash(bytes), size: bytes.length, executable: false },
            ])),
            totalSize: Object.values(files).reduce((sum, bytes) => sum + bytes.length, 0),
            source: { kind: 'npm', packages, launchedFrom: '@mnemonik/cli' },
        },
    };
}
//# sourceMappingURL=store.js.map