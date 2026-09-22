import { revokeInstallComponent } from '../install/transaction.js';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { atomicWrite, withLock } from '@mnemonik/local-setup';
import { apiOrigin, serializeReadiness, } from '@mnemonik/shared';
import { createCliAuth } from '../auth/index.js';
import { REPOSITORY_APPROVAL_INSTRUCTION } from '../auth/device.js';
import { createCliCredentials } from '../auth/credentials.js';
import { postCurrentReadiness } from '../installSession.js';
import { readInstallVersions } from '../install/ownership.js';
import { grantTransport } from '../auth/status.js';
import { readInstallation, saveInstallation } from '../installation.js';
import { RuntimeStore, hash } from '../runtime/store.js';
import { releaseSource, devReadiness } from '../runtime/releaseSource.js';
import { evaluateRoot, repositoryAt } from '../project/eligibility.js';
import { scannerService } from './service.js';
import { controlScanner, scannerReceipt } from './control.js';
import { bytesAt, digest, withInstall } from '../install/journal.js';
import { connectedProjectsMessage, createRealProjectRuntime, ensureProjectRoot, projectLimitMessage, } from '../project.js';
import { consentDraft, runScannerBoundaryPicker } from './picker.js';
export const scannerStateBytes = (state) => Buffer.from(`${JSON.stringify(state, null, 2)}\n`);
export const SCANNER_APPROVAL_WAIT = 'Waiting for approval in your browser, up to 10 minutes.';
export async function updateScannerRoots(options) {
    await mkdir(join(options.stateDir, 'scanner'), { recursive: true, mode: 0o700 });
    return withLock(join(options.stateDir, 'scanner/enable'), 5000, async () => {
        const path = join(options.stateDir, 'scanner/state.json');
        const state = JSON.parse(await readFile(path, 'utf8'));
        const response = await (options.fetch ?? fetch)(`${apiOrigin()}/api/v1/scanner-consent/current`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${options.bearer}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ add: options.add, remove: options.remove }),
        });
        const body = (await response.json().catch(() => ({})));
        if (response.status === 409 && body.code === 'disclosure_required')
            return { status: 'disclosure_required' };
        if (!response.ok || !body.consent || !Array.isArray(body.consent.roots))
            throw new Error(`scanner_request_${response.status}`);
        const removed = new Set(options.remove);
        state.config.roots = state.config.roots.filter((root) => !removed.has(root));
        for (const root of options.add)
            if (!state.config.roots.includes(root))
                state.config.roots.push(root);
        if (!state.config.roots.every((root) => body.consent?.roots.includes(root)))
            throw new Error('scanner_consent_mismatch');
        state.consent = body.consent;
        await atomicWrite(path, scannerStateBytes(state));
        return { status: 'updated', state };
    });
}
export async function enableScanner(options) {
    if (!options.journal) {
        return withInstall(options.stateDir, {
            account: 'scanner',
            joined: true,
            hostRequest: { command: 'install', selections: [], allowMigration: false },
            hosts: [],
            components: ['scanner'],
            scopes: {},
            roots: options.roots ?? [],
            credentials: [],
        }, undefined, async (journal) => {
            try {
                const document = await enableScanner({ ...options, journal });
                journal.data.state = document.installation.state;
                journal.data.phase = 'complete';
                await journal.save();
                return document;
            }
            catch (error) {
                journal.data.phase = 'rolling_back';
                await journal.save();
                await restoreScannerInstall(journal, options);
                journal.data.phase = 'rolled_back';
                await journal.save();
                throw error;
            }
        });
    }
    return prepareScanner(options, async (prepared) => {
        const executor = await prepared.projectExecutor();
        const connected = [];
        let limit;
        for (const root of [...prepared.roots]) {
            const result = await ensureProjectRoot(root, executor);
            if (result.status === 'done')
                connected.push(root);
            else {
                const lines = projectLimitMessage(result, root);
                if (lines) {
                    limit = lines.join('\n');
                    break;
                }
                throw new Error('project_setup_required');
            }
        }
        prepared.roots.splice(0, prepared.roots.length, ...connected);
        const document = await prepared.apply(options.journal, connected);
        if (document.installation.state === 'READY')
            await prepared.complete(document);
        if (!options.nonInteractive) {
            if (connected.length)
                options.output.line(connectedProjectsMessage(connected));
            if (limit)
                for (const line of limit.split('\n'))
                    options.output.line(line);
        }
        return document;
    });
}
/** The scanner lease spans browser review, Apply and compensation. */
export async function prepareScanner(options, work) {
    await mkdir(join(options.stateDir, 'scanner'), { recursive: true, mode: 0o700 });
    return withLock(join(options.stateDir, 'scanner/enable'), 5000, async () => {
        const path = join(options.stateDir, 'scanner/state.json');
        const saved = JSON.parse(await readFile(path, 'utf8').catch(() => 'null'));
        const credentials = options.credentials ?? createCliCredentials({ stateDir: options.stateDir });
        const authorize = options.authorize ??
            (async (selection, installation) => {
                const auth = createCliAuth({
                    credentials: options.credentials ?? createCliCredentials({ stateDir: options.stateDir }),
                    noBrowser: options.noBrowser,
                    scannerRoots: selection ? JSON.stringify(selection) : undefined,
                    credentialOptions: { stateDir: options.stateDir },
                    deviceInstallationId: installation,
                    print: (line) => options.nonInteractive ? options.output.error(line) : options.output.line(line),
                    fetch: options.fetch,
                });
                if (selection)
                    await auth.signIn();
                let token = await auth.getCliBearer();
                if (typeof token !== 'string') {
                    await auth.signIn();
                    token = await auth.getCliBearer();
                }
                if (typeof token !== 'string')
                    throw new Error(token.reason);
                return token;
            });
        let bearer = await authorize();
        const request = async (method, route, body, missing = false) => {
            const response = await (options.fetch ?? fetch)(`${apiOrigin()}${route}`, {
                method,
                headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
                ...(body ? { body: JSON.stringify(body) } : {}),
            });
            if (missing && response.status === 404)
                return null;
            if (!response.ok)
                throw new Error(`scanner_request_${response.status}`);
            return response.json();
        };
        let session = (await request('GET', '/api/v1/install-sessions/current', undefined, true));
        const store = options.store ??
            new RuntimeStore(options.stateDir, undefined, {
                allowUnsigned: !!process.env.MNEMONIK_DEV_RELEASE_DIR,
            });
        options = { ...options, store };
        const service = scannerService({ ...options, captureDefinition: true });
        const before = saved && (await bytesAt(store.pointerPath('scanner')))
            ? (await service.inspect())[0]?.before
            : undefined;
        if (before === 'unknown')
            throw new Error('scanner_service_unavailable');
        const previous = before
            ? JSON.parse(before)
            : null;
        const managedReplacement = (options.platform ?? process.platform) === 'darwin';
        let restore = !managedReplacement && previous?.running && !saved?.paused;
        if (restore && options.journal && before) {
            const journal = options.journal;
            if (!journal.data.services.some((s) => s.id === 'scanner'))
                journal.data.services.push({ id: 'scanner', before, started: true });
            await journal.plan(path, await bytesAt(path), {
                kind: 'runtime',
                group: `scanner:${journal.data.targets.length}`,
            });
            await journal.event('service_start_intent', 'scanner');
        }
        if (restore)
            await controlScanner('pause', options);
        try {
            const picked = options.roots
                ? { roots: options.roots, exclusions: options.exclusions ?? [], repositories: [] }
                : options.nonInteractive
                    ? (() => {
                        throw new Error('scan_roots_required');
                    })()
                    : await runScannerBoundaryPicker({
                        input: options.input,
                        readAnswer: options.readAnswer,
                        output: options.output,
                        currentProject: options.cwd,
                        currentFolder: options.cwd,
                        home: options.home,
                    });
            if ('status' in picked)
                throw new Error('consent_declined');
            if (!picked.roots.length && !picked.candidates?.length)
                throw new Error('scan_roots_required');
            picked.roots = await Promise.all(picked.roots.map((root) => realpath(root)));
            picked.exclusions = await Promise.all(picked.exclusions.map((root) => realpath(root)));
            for (const root of picked.roots) {
                const decision = await evaluateRoot({ kind: 'absent', root, repository: await repositoryAt(root), nested: [] }, { cwd: root });
                if (!decision.allowed) {
                    options.output.error(`${root}: That folder cannot be used. Choose another folder.`);
                    throw new Error(decision.reason);
                }
            }
            let remote = (await request('GET', '/api/v1/scanner-consent/current'));
            // Approved means the account's accepted consent already covers every
            // folder asked for, at the current disclosure. Asking again adds nothing.
            const matches = () => remote.consent?.disclosureVersion === remote.disclosure.version &&
                (picked.candidates
                    ? !!remote.consent?.roots.length &&
                        remote.consent.roots.every((root) => picked.candidates?.some((candidate) => candidate.path === root))
                    : picked.roots.every((root) => remote.consent?.roots.includes(root))) &&
                JSON.stringify(remote.consent?.exclusions) === JSON.stringify(picked.exclusions);
            const unconnectedRoots = remote.consent?.roots.some((root) => !saved?.config.roots.includes(root));
            // A run with no person present reuses the approval it already has. A
            // fresh browser session is only opened when a folder is not approved yet.
            if (!matches() || (!options.nonInteractive && (!session || unconnectedRoots))) {
                const listing = await grantTransport(async () => bearer, options.fetch).list();
                const installation = session?.device_installation_id ??
                    listing.deviceInstallationId ??
                    (await readInstallation(options.stateDir, listing.account));
                if (!installation)
                    throw new Error('scanner_installation_missing');
                // Browser approval reuses this installation's active session. Never cancel the hosts' session.
                if (!options.nonInteractive)
                    options.output.line(options.approvalAnnounced ? REPOSITORY_APPROVAL_INSTRUCTION : SCANNER_APPROVAL_WAIT);
                bearer = await authorize(consentDraft(picked), installation);
                session = (await request('GET', '/api/v1/install-sessions/current'));
                remote = (await request('GET', '/api/v1/scanner-consent/current'));
            }
            const listing = await grantTransport(async () => bearer, options.fetch).list();
            const installationId = session?.device_installation_id ??
                listing.deviceInstallationId ??
                (await readInstallation(options.stateDir, listing.account));
            if (!matches() || !remote.consent || !installationId)
                throw new Error('browser_consent_required');
            await saveInstallation(options.stateDir, installationId, {
                account: listing.account,
            });
            const approvedSession = session;
            const approvedConsent = remote.consent;
            // Connect the folders this run asked for, not every folder the account
            // has ever approved. The browser picker still decides its own list.
            const approvedRoots = picked.candidates
                ? [...approvedConsent.roots]
                : approvedConsent.roots.filter((root) => picked.roots.includes(root));
            if (options.journal?.data.account === 'scanner') {
                options.journal.data.account = listing.account;
                options.journal.data.roots = [...approvedRoots];
                await options.journal.save();
            }
            const pointer = store.pointerPath('scanner');
            return await work({
                roots: approvedRoots,
                exclusions: picked.exclusions,
                files: [path, pointer],
                ...(session ? { session } : {}),
                projectExecutor: async () => options.projectExecutor ??
                    (await createRealProjectRuntime({
                        stateDir: options.projectStateDir ?? options.stateDir,
                        credentials,
                        getCliBearer: async () => bearer,
                        fetch: options.fetch,
                    })).executor,
                complete: async (document) => {
                    // With no browser session to close, the readiness still has to reach
                    // the account, or the devices page keeps yesterday's answer.
                    if (!approvedSession)
                        return postCurrentReadiness(bearer, document, options.fetch ?? fetch);
                    await request('POST', `/api/v1/install-sessions/${approvedSession.id}/complete`, {
                        readiness: document,
                        platform: process.platform,
                    });
                },
                rollback: async (journal) => {
                    await restoreScannerInstall(journal, options);
                },
                apply: async (journal, roots = approvedRoots) => {
                    const put = async (targetPath, content) => {
                        if (!journal)
                            return atomicWrite(targetPath, content);
                        const target = await journal.plan(targetPath, content, {
                            kind: 'runtime',
                            group: `scanner:${journal.data.targets.length}`,
                        });
                        return journal.commit(target);
                    };
                    if (journal && !managedReplacement) {
                        if (!journal.data.services.some((s) => s.id === 'scanner'))
                            journal.data.services.push({
                                id: 'scanner',
                                before: JSON.stringify(previous ?? { installed: false, running: false }),
                                started: true,
                            });
                        const serviceRecord = journal.data.services.find((s) => s.id === 'scanner');
                        if (serviceRecord)
                            serviceRecord.started = true;
                        await journal.event('service_start_intent', 'scanner');
                    }
                    // Stop the old writer before replacing state; refusal above leaves its consent untouched.
                    if (!managedReplacement && previous?.running)
                        await service.stop();
                    if (journal)
                        await observeScannerState(journal, path);
                    restore = false;
                    const state = {
                        schemaVersion: 1,
                        ...(picked.boundary ? { boundary: picked.boundary } : {}),
                        config: {
                            // A failed project reconnection must not remove an existing watch.
                            // Explicit removals in this browser approval still take effect.
                            roots: [
                                ...new Set([
                                    ...roots,
                                    ...(saved?.config.roots ?? []).filter((root) => approvedConsent.roots.includes(root)),
                                ]),
                            ],
                            exclusions: picked.exclusions,
                            serverUrl: apiOrigin(),
                            deviceInstallationId: installationId,
                        },
                        consent: approvedConsent,
                        paused: false,
                        pauseIntervals: saved?.pauseIntervals ?? [],
                        ...(process.env.MNEMONIK_DEV_RELEASE_DIR ? { devReleaseSource: true } : {}),
                    };
                    for (const interval of state.pauseIntervals)
                        if (interval.end === null)
                            interval.end = Date.now();
                    if (!managedReplacement)
                        await put(path, scannerStateBytes(state));
                    const source = await (options.source ?? (() => releaseSource('scanner')))();
                    if (source.manifest.disclosureVersion &&
                        source.manifest.disclosureVersion !== state.consent?.disclosureVersion)
                        throw new Error('release_consent_required');
                    if (process.env.MNEMONIK_DEV_RELEASE_DIR)
                        options.output.error('WARNING: development scanner release; readiness remains LIMITED.');
                    if (managedReplacement) {
                        const runtime = await store.stageRuntime('scanner', source.manifest.version, source);
                        const prior = await bytesAt(pointer);
                        const current = prior
                            ? JSON.parse(prior.toString()).current
                            : undefined;
                        const nextPointer = prior &&
                            current?.version === runtime.reference.version &&
                            current.manifestSha256 === runtime.reference.manifestSha256
                            ? prior.toString()
                            : JSON.stringify({ current: runtime.reference, previous: current });
                        const existingFamily = saved?.config.credentialFamilyId;
                        if (existingFamily) {
                            const family = await credentials.readFamily(existingFamily);
                            if (!family ||
                                family.componentKind !== 'scanner' ||
                                !(Date.parse(family.refreshExpiresAt) > Date.now()) ||
                                !family.scopes.includes('scanner:upload') ||
                                saved.consent?.userId !== approvedConsent.userId ||
                                saved.config.deviceInstallationId !== installationId)
                                throw new Error('scanner_credential_unavailable');
                            state.config.credentialFamilyId = existingFamily;
                        }
                        else {
                            const issued = (await request('POST', '/api/v1/component-credentials', {
                                component_kind: 'scanner',
                            }));
                            await credentials.putFamily('scanner', issued);
                            state.config.credentialFamilyId = issued.id;
                            if (journal) {
                                journal.data.credentials.push({
                                    reference: issued.id,
                                    kind: 'component',
                                    component: 'scanner',
                                });
                                await journal.save();
                            }
                        }
                        const nextState = scannerStateBytes(state);
                        if (journal) {
                            const serviceRecord = journal.data.services.find((record) => record.id === 'scanner');
                            if (serviceRecord)
                                Object.assign(serviceRecord, { started: true, managed: true });
                            else
                                journal.data.services.push({
                                    id: 'scanner',
                                    before: JSON.stringify(previous ?? { installed: false, running: false }),
                                    started: true,
                                    managed: true,
                                });
                            // Ownership is durable before handoff. Even a transport timeout must not
                            // race launchd's replacement or compensation.
                            await journal.event('service_start_intent', 'scanner');
                            await journal.event('upload_intent', 'scanner');
                        }
                        await service.replace(runtime, {
                            pointer: { after: nextPointer },
                            state: {
                                before: (await bytesAt(path))?.toString() ?? null,
                                after: nextState.toString(),
                            },
                        });
                    }
                    else {
                        const prior = await bytesAt(pointer);
                        const pointerTarget = journal
                            ? await journal.plan(pointer, Buffer.from(JSON.stringify({
                                current: {
                                    version: source.manifest.version,
                                    manifestSha256: hash(JSON.stringify(source.manifest)),
                                },
                                previous: prior
                                    ? JSON.parse(prior.toString()).current
                                    : undefined,
                            })), { kind: 'runtime', group: `scanner:${journal.data.targets.length}` })
                            : undefined;
                        await store.installRuntime('scanner', source.manifest.version, source);
                        if (pointerTarget)
                            await journal?.commit(pointerTarget);
                        const issued = (await request('POST', '/api/v1/component-credentials', {
                            component_kind: 'scanner',
                        }));
                        if (journal) {
                            journal.data.credentials.push({
                                reference: issued.id,
                                kind: 'component',
                                component: 'scanner',
                            });
                            await journal.save();
                        }
                        await credentials.putFamily('scanner', issued);
                        state.config.credentialFamilyId = issued.id;
                        await put(path, scannerStateBytes(state));
                        await journal?.event('upload_intent', 'scanner');
                        if (previous?.installed)
                            await service.restart();
                        else
                            await service.start();
                    }
                    const receipt = await scannerReceipt(options.stateDir);
                    const heartbeat = receipt?.snapshot.heartbeat.lastSuccess;
                    if (!managedReplacement && typeof heartbeat !== 'number')
                        throw new Error('scanner_receipt_missing');
                    const document = devReadiness(serializeReadiness({
                        platform: process.platform,
                        versions: await readInstallVersions(options.stateDir, source.manifest.version),
                        installation: {
                            conditions: options.pendingHosts
                                ? [{ kind: 'hook_not_verified', reason: 'Host setup still needs verification.' }]
                                : [],
                        },
                        scanner: {
                            roots: state.config.roots,
                            heartbeatAt: typeof heartbeat === 'number' ? new Date(heartbeat).toISOString() : null,
                            version: source.manifest.version,
                            readiness: null,
                            acceptedDisclosureVersion: approvedConsent.disclosureVersion,
                        },
                    }));
                    return document;
                },
            });
        }
        catch (error) {
            if (restore)
                await controlScanner('resume', options);
            throw error;
        }
    });
}
/** Stop/unregister with the installed runtime, restore bytes, then restore the old definition. */
export async function restoreScannerInstall(journal, options) {
    const record = journal.data.services.find((s) => s.id === 'scanner');
    // A launchd-owned replacement compensates independently, even after this caller dies.
    if (record?.managed)
        return;
    const before = record ? JSON.parse(record.before) : undefined;
    const store = options.store ??
        new RuntimeStore(options.stateDir, undefined, {
            allowUnsigned: !!process.env.MNEMONIK_DEV_RELEASE_DIR,
        });
    const hasRuntime = await bytesAt(store.pointerPath('scanner'));
    const service = scannerService({
        ...options,
        store,
        // The restored older binary may not know how to manage an SSH user service.
        supervisorRuntime: options.supervisorRuntime ??
            (record?.started && hasRuntime ? await store.verifyRuntime('scanner') : undefined),
    });
    if (record?.started && hasRuntime) {
        await service.stop();
        if (!before?.installed)
            await service.restore('scanner', record.before);
    }
    if (record?.started)
        await observeScannerState(journal, join(options.stateDir, 'scanner/state.json'));
    for (const target of [...journal.data.targets]
        .reverse()
        .filter((t) => t.group?.startsWith('scanner:')))
        await journal.restore(target);
    if (record?.started && before?.installed)
        await service.restore('scanner', record.before);
    if (record)
        record.started = false;
    for (const credential of journal.data.credentials.filter((c) => c.component === 'scanner' && !c.revoked)) {
        credential.revoked = await revokeInstallComponent(options.stateDir, credential.reference, options.fetch).catch(() => false);
        if (!credential.revoked)
            journal.data.reports.push(`Credential ${credential.reference} retained; revoke it in Devices and grants.`);
    }
    await journal.save();
}
// Once its writer is stopped, adopt only lifecycle changes to the scanner-owned state.
// Config or consent edits still fail the ordinary journal conflict check.
async function observeScannerState(journal, path) {
    const target = [...journal.data.targets]
        .reverse()
        .find((t) => t.path === path && t.group?.startsWith('scanner:') && t.status !== 'restored');
    if (!target)
        return;
    const current = await bytesAt(path);
    if (!current || digest(current) === target.proposedHash || digest(current) === target.beforeHash)
        return;
    const proposed = await bytesAt(target.proposed);
    if (!proposed)
        return;
    const actual = JSON.parse(current.toString());
    const expected = JSON.parse(proposed.toString());
    if (!isDeepStrictEqual(actual.config, expected.config) ||
        !isDeepStrictEqual(actual.consent, expected.consent) ||
        actual.schemaVersion !== expected.schemaVersion)
        throw new Error(`File changed outside install: ${path}`);
    await atomicWrite(target.proposed, current);
    target.proposedHash = digest(current);
    await journal.save();
}
//# sourceMappingURL=enable.js.map