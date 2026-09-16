import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite, withLock } from '@mnemonik/local-setup';
import { bytesAt as readBytes } from './install/journal.js';
import { readOwnership } from './install/ownership.js';
import { RuntimeStore } from './runtime/store.js';
/** Account identities survive credentials and component uninstall. */
export async function saveInstallation(stateDir, deviceInstallationId, account) {
    if (!deviceInstallationId || (account && !account.account))
        throw new Error('installation_invalid');
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await withLock(join(stateDir, 'installation'), 5000, async () => {
        const bytes = await readBytes(join(stateDir, 'installation.json'));
        const existing = bytes ? JSON.parse(bytes.toString()) : undefined;
        let record = { deviceInstallationId };
        if (account) {
            const previous = existing?.accounts && Object.hasOwn(existing.accounts, account.account)
                ? existing.accounts[account.account]
                : undefined;
            if (previous && previous.deviceInstallationId !== deviceInstallationId)
                throw new Error('installation_conflict');
            record = {
                ...existing,
                deviceInstallationId,
                account: account.account,
                ...(!existing?.account && existing?.deviceInstallationId
                    ? { legacyDeviceInstallationId: existing.deviceInstallationId }
                    : {}),
                accounts: {
                    ...existing?.accounts,
                    [account.account]: {
                        ...previous,
                        deviceInstallationId,
                        ...(account.email ? { email: account.email } : {}),
                    },
                },
            };
        }
        else if (existing) {
            if (existing.deviceInstallationId !== deviceInstallationId)
                throw new Error('installation_conflict');
            record = existing;
        }
        await atomicWrite(join(stateDir, 'installation.json'), Buffer.from(JSON.stringify(record) + '\n'));
    });
}
export async function readInstallation(stateDir, account) {
    const bytes = await readBytes(join(stateDir, 'installation.json'));
    if (bytes) {
        const record = JSON.parse(bytes.toString());
        if (typeof record.deviceInstallationId !== 'string' || !record.deviceInstallationId)
            throw new Error('installation_invalid');
        if (!account)
            return record.deviceInstallationId;
        if (record.accounts && Object.hasOwn(record.accounts, account))
            return record.accounts[account]?.deviceInstallationId;
    }
    const owned = new Set((await readOwnership(stateDir)).targets
        .filter((target) => !account || target.grant?.account === account)
        .map((target) => target.grant?.installationId)
        .filter((id) => !!id));
    if (owned.size > 1)
        throw new Error('installation_conflict');
    let installation = owned.values().next().value;
    if (!account &&
        !installation &&
        (await readBytes(new RuntimeStore(stateDir).pointerPath('scanner')))) {
        const saved = await readBytes(join(stateDir, 'scanner/state.json'));
        if (saved)
            installation = JSON.parse(saved.toString()).config?.deviceInstallationId;
    }
    if (installation)
        await saveInstallation(stateDir, installation, account ? { account } : undefined);
    return installation;
}
/** Ordered hints only; the server selects ownership using the browser account. */
export async function readInstallations(stateDir) {
    const current = await readInstallation(stateDir);
    if (!current)
        return [];
    const record = JSON.parse((await readBytes(join(stateDir, 'installation.json')))?.toString() ?? '{}');
    return [
        ...new Set([
            current,
            ...Object.values(record.accounts ?? {})
                .reverse()
                .map((entry) => entry.deviceInstallationId),
            record.legacyDeviceInstallationId,
        ].filter((id) => typeof id === 'string' && !!id)),
    ];
}
//# sourceMappingURL=installation.js.map