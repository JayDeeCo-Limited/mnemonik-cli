import { readFile } from 'node:fs/promises';
import { saveInstallation } from '../installation.js';
import { devReleaseActive } from '../runtime/releaseSource.js';
import { join } from 'node:path';
import { atomicWrite } from '@mnemonik/local-setup';
import { bytesAt, digest } from './journal.js';
export const ownershipPath = (state) => join(state, 'host-ownership.json');
export async function readOwnership(state) {
    const bytes = await bytesAt(ownershipPath(state));
    if (!bytes)
        return { schemaVersion: 1, generation: 0, targets: [] };
    const record = JSON.parse(bytes.toString());
    if (record.schemaVersion !== 1 ||
        !Number.isSafeInteger(record.generation) ||
        !Array.isArray(record.targets) ||
        record.targets.some((t) => !t.id ||
            !t.profilePath ||
            !['hooks', 'mcp'].includes(t.component) ||
            !Array.isArray(t.files) ||
            t.files.some((file) => file.created !== undefined && file.created !== true)))
        throw new Error('ownership_invalid');
    return record;
}
/** Versions observed by host detection and installed runtimes, for completion receipts. */
export async function readInstallVersions(state, scanner) {
    const ownership = await readOwnership(state);
    const hosts = new Map();
    for (const target of ownership.targets) {
        const version = hosts.get(target.host) ?? { host: target.host };
        if (target.editorVersion)
            version.editor = target.editorVersion;
        if (target.component === 'hooks')
            version.hooks = target.version;
        hosts.set(target.host, version);
    }
    const cli = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    return { cli: cli.version, hosts: [...hosts.values()], ...(scanner ? { scanner } : {}) };
}
export async function assertGeneration(state, journal) {
    await journal.assertOwned?.();
    const owner = JSON.parse((await bytesAt(join(state, 'install-owner.json')))?.toString() ?? '{}');
    if ((await readOwnership(state)).generation > journal.data.generation ||
        owner.generation !== journal.data.generation ||
        owner.runId !== journal.data.runId)
        throw new Error('stale_ownership_generation');
}
export async function saveOwnership(state, journal, run) {
    await assertGeneration(state, journal);
    const record = await readOwnership(state);
    if (record.generation > journal.data.generation)
        throw new Error('stale_ownership_generation');
    const remove = new Set([run.id, ...(run.remove ?? [])]);
    record.targets = record.targets.filter((t) => !remove.has(t.id));
    if (run.candidate) {
        record.targets.push(run.candidate);
        if (run.candidate.grant?.installationId)
            await saveInstallation(state, run.candidate.grant.installationId, {
                account: run.candidate.grant.account,
            });
    }
    record.generation = journal.data.generation;
    if (devReleaseActive())
        record.devReleaseSource = true;
    const bytes = Buffer.from(JSON.stringify(record, null, 2) + '\n');
    if (journal.data.joined) {
        const target = await journal.plan(ownershipPath(state), bytes, {
            kind: 'host',
            host: run.host,
            group: `ownership:${journal.data.targets.length}`,
        });
        await journal.commit(target);
    }
    else
        await atomicWrite(ownershipPath(state), bytes, undefined, journal.assertOwned);
}
/** Validate the entire group before restoring any member; interrupted restore is resumable. */
export async function rollbackHost(state, journal, id) {
    await assertGeneration(state, journal);
    const targets = journal.data.targets.filter((t) => t.group === id);
    for (const target of targets) {
        if (target.status !== 'restored' && digest(await bytesAt(target.backup)) !== target.beforeHash)
            throw new Error('host_backup_invalid');
    }
    for (const target of [...targets].reverse())
        await journal.restore(target);
}
//# sourceMappingURL=ownership.js.map