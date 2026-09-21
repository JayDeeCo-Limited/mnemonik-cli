import { randomUUID } from 'node:crypto';
import { isCanonicalUuid } from '@mnemonik/shared';
import { realpath, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { actionRequired, } from './contracts.js';
import { atomicWrite, hash, readBytes, recordPath, syncDirectory, withLock, } from './storage.js';
export * from './contracts.js';
export * from './windowsPath.js';
export * from './automaticUpdate.js';
export { stateDirectory, recordPath, protectStateFile, windowsCurrentUserAcl, windowsCurrentAccount, atomicWrite, withLock, } from './storage.js';
const MAX_ORIGINAL_BYTES = 64 * 1024;
const validDisplayName = (value) => typeof value === 'string' && value.length <= 200 && !/[\p{C}\p{Zl}\p{Zp}@]/u.test(value);
const digest = (bytes) => (bytes === null ? null : hash(bytes));
const accessResponseHash = (response) => hash(JSON.stringify({
    status: response.status,
    state: response.state,
    allowedActions: [...response.allowedActions].sort(),
    candidates: response.candidates,
}));
const step = (beforeHash) => ({
    complete: false,
    beforeHash,
    afterHash: null,
});
const nonGitSelectionRequired = () => ({
    status: 'ACTION_REQUIRED',
    state: 'non_git_selection_required',
    allowedActions: ['select_non_git', 'cancel'],
    manualAction: 'mnemonik project init <path>',
});
const recordedCandidate = (remote, root, state) => ({
    status: 'project_setup_required',
    state,
    allowedActions: ['link', 'cancel'],
    candidates: [
        {
            projectId: remote.projectId,
            displayName: remote.displayName ?? basename(root),
        },
    ],
});
export function createProjectSetupExecutor(deps) {
    async function execute(options, mode) {
        let resolution = await deps.resolver.resolveProjectIdentity(options.cwd, options);
        if (resolution.kind !== 'ok' && resolution.kind !== 'absent')
            return actionRequired(resolution.kind);
        const root = await realpath(resolution.root);
        const path = recordPath(root, deps.stateDir);
        if (resolution.repository.kind === 'plain' && !options.nonGitSelected) {
            const prior = await readBytes(path);
            if (!prior)
                return nonGitSelectionRequired();
            try {
                if (JSON.parse(prior.toString()).nonGitSelected !== true)
                    return nonGitSelectionRequired();
            }
            catch {
                return actionRequired('record_invalid');
            }
        }
        return withLock(path, deps.waitMs ?? 60_000, async (assertOwned) => {
            // The lock was acquired after resolving. Detect a changed identity/root before using it.
            const fresh = await deps.resolver.resolveProjectIdentity(options.cwd, options);
            if (fresh.kind !== 'ok' && fresh.kind !== 'absent')
                return actionRequired(fresh.kind);
            if ((await realpath(fresh.root)) !== root)
                return actionRequired('identity_changed');
            resolution = fresh;
            const file = join(root, '.mnemonik.json');
            const bytes = await readBytes(file);
            const diskHash = digest(bytes);
            const saved = await readBytes(path);
            const freshRecord = () => ({
                schemaVersion: 1,
                operationId: randomUUID(),
                root,
                scopeKey: hash(deps.scopeKey),
                owner: options.owner,
                ...(resolution.kind !== 'git_unavailable' &&
                    resolution.repository.kind === 'plain' &&
                    options.nonGitSelected
                    ? { nonGitSelected: true }
                    : {}),
                ...(options.intent ? { intent: options.intent } : {}),
                before: {
                    base64: bytes && bytes.length <= MAX_ORIGINAL_BYTES ? bytes.toString('base64') : null,
                    hash: diskHash,
                },
                steps: { remote: step(diskHash), identity: step(diskHash), rollback: step(diskHash) },
            });
            let record;
            let recordIsNew = !saved;
            if (saved) {
                try {
                    record = JSON.parse(saved.toString());
                }
                catch {
                    return actionRequired('record_invalid');
                }
                if (!record ||
                    record.schemaVersion !== 1 ||
                    record.root !== root ||
                    !record.operationId ||
                    !record.before ||
                    (record.before.base64 !== null && typeof record.before.base64 !== 'string') ||
                    (record.staged && typeof record.staged.content !== 'string') ||
                    !record.steps?.identity ||
                    !record.steps?.remote ||
                    !record.steps?.rollback ||
                    (record.ignored !== undefined &&
                        (!record.ignored ||
                            typeof record.ignored !== 'object' ||
                            (record.ignored.identityHash !== null &&
                                typeof record.ignored.identityHash !== 'string') ||
                            typeof record.ignored.responseHash !== 'string')) ||
                    (record.nonGitSelected !== undefined && record.nonGitSelected !== true) ||
                    (record.intent !== undefined &&
                        (record.intent.action !== 'link' ||
                            typeof record.intent.projectId !== 'string' ||
                            (record.intent.replace !== undefined && record.intent.replace !== true))))
                    return actionRequired('record_invalid');
                if ((record.before.base64 !== null &&
                    record.before.hash !== hash(Buffer.from(record.before.base64, 'base64'))) ||
                    (record.before.base64 !== null &&
                        Buffer.from(record.before.base64, 'base64').length > MAX_ORIGINAL_BYTES) ||
                    (record.staged && hash(record.staged.content) !== record.staged.hash) ||
                    (record.remote && hash(JSON.stringify(record.remote)) !== record.steps.remote.afterHash))
                    return actionRequired('record_invalid');
                if (record.scopeKey !== hash(deps.scopeKey) ||
                    (options.owner !== undefined &&
                        JSON.stringify(record.owner) !== JSON.stringify(options.owner)) ||
                    JSON.stringify(record.intent) !== JSON.stringify(options.intent)) {
                    const replaceable = !record.remote &&
                        !record.staged &&
                        !record.steps.remote.started &&
                        !record.steps.identity.started &&
                        !record.steps.rollback.started &&
                        diskHash === record.before.hash;
                    if (replaceable) {
                        record = freshRecord();
                        recordIsNew = true;
                    }
                    else {
                        if (record.ignored) {
                            delete record.ignored;
                            await atomicWrite(path, Buffer.from(JSON.stringify(record, null, 2) + '\n'), undefined, assertOwned);
                        }
                        return actionRequired('operation_context_changed');
                    }
                }
            }
            else {
                if (mode === 'apply' || mode === 'rollback')
                    return actionRequired('record_missing');
                record = freshRecord();
            }
            if (resolution.repository.kind === 'plain' && record.nonGitSelected !== true) {
                return nonGitSelectionRequired();
            }
            if (options.intent &&
                resolution.kind === 'ok' &&
                resolution.identity.projectId !== options.intent.projectId &&
                !options.intent.replace)
                return {
                    status: 'ACTION_REQUIRED',
                    state: 'identity_exists',
                    allowedActions: ['replace', 'cancel'],
                };
            let permissionStatus = 'private';
            const save = async () => {
                permissionStatus = await atomicWrite(path, Buffer.from(JSON.stringify(record, null, 2) + '\n'), undefined, assertOwned);
            };
            const result = (status) => ({
                status,
                operationId: record.operationId,
                root,
                permissionStatus,
                projectId: record.remote?.projectId,
                ...(status === 'rolled_back' ? { retainedRemoteUUID: record.remote?.projectId } : {}),
            });
            const clearIgnore = async () => {
                if (!record.ignored)
                    return;
                delete record.ignored;
                await save();
            };
            const handleAccessResponse = async (response) => {
                const responseHash = accessResponseHash(response);
                if (options.ignore && response.allowedActions.includes('ignore')) {
                    record.ignored = { identityHash: diskHash, responseHash };
                    await save();
                    return result('ignored');
                }
                if (!record.ignored)
                    return response;
                if (!options.clearIgnore &&
                    record.ignored.identityHash === diskHash &&
                    record.ignored.responseHash === responseHash)
                    return result('ignored');
                await clearIgnore();
                return response;
            };
            if ((bytes && bytes.length > MAX_ORIGINAL_BYTES) ||
                (record.before.base64 === null && record.before.hash !== null)) {
                if (recordIsNew)
                    await save();
                return actionRequired('identity_too_large');
            }
            if (record.ignored && record.ignored.identityHash !== diskHash) {
                await clearIgnore();
                return actionRequired('identity_changed');
            }
            if (diskHash !== record.before.hash && diskHash !== record.staged?.hash)
                return actionRequired('identity_changed');
            if (mode === 'rollback') {
                // Durable undo intent precedes a write or removal, including crash recovery of undo.
                record.steps.rollback.started = true;
                record.steps.rollback.beforeHash = record.staged?.hash ?? record.before.hash;
                record.steps.rollback.afterHash = record.before.hash;
                await save();
                if (diskHash !== record.before.hash) {
                    if (record.before.base64 === null) {
                        await assertOwned();
                        await unlink(file);
                        await syncDirectory(dirname(file));
                    }
                    else
                        await atomicWrite(file, Buffer.from(record.before.base64, 'base64'), deps.fault, assertOwned);
                }
                record.steps.rollback.complete = true;
                record.steps.identity.complete = false;
                await save();
                return result('rolled_back');
            }
            if (record.steps.rollback.started)
                return actionRequired(record.steps.rollback.complete ? 'operation_rolled_back' : 'rollback_in_progress');
            const evidence = await deps.bindContext(root);
            // A path-keyed journal can survive deletion of the repository it described.
            // When the identity file is gone, only a matching usable fingerprint may
            // authorize automatic reuse; otherwise the old UUID is display-only.
            const remote = record.remote;
            const resumingWithoutIdentity = !!remote && diskHash === record.before.hash && diskHash !== record.staged?.hash;
            if (mode !== 'apply' && remote && resumingWithoutIdentity) {
                const previousFingerprint = record.evidence?.repositoryFingerprint ?? null;
                const currentFingerprint = evidence.repositoryFingerprint;
                if (!previousFingerprint ||
                    !currentFingerprint ||
                    previousFingerprint.algorithmVersion !== currentFingerprint.algorithmVersion ||
                    previousFingerprint.hash !== currentFingerprint.hash) {
                    return recordedCandidate(remote, root, previousFingerprint && currentFingerprint
                        ? 'fingerprint_mismatch'
                        : 'confirmation_required');
                }
            }
            if (!resumingWithoutIdentity &&
                record.steps.identity.complete &&
                diskHash !== record.staged?.hash)
                return actionRequired('identity_changed');
            if (recordIsNew)
                await save(); // Operation ID and before-state MUST be durable before any remote request.
            if (record.evidence && JSON.stringify(record.evidence) !== JSON.stringify(evidence))
                return actionRequired('operation_context_changed');
            if (record.steps.identity.complete && mode === 'ensure' && record.remote) {
                const validated = await deps.transport.issueSetupRequest({
                    ...evidence,
                    projectId: record.remote.projectId,
                });
                if (validated.status !== 'complete')
                    return handleAccessResponse(validated);
                await clearIgnore();
                if (validated.projectId !== record.remote.projectId)
                    return actionRequired('identity_changed');
            }
            if (!record.remote) {
                if (mode === 'apply')
                    return actionRequired('not_staged');
                record.evidence = evidence;
                await save();
                const identity = resolution.kind === 'ok' ? resolution.identity : null;
                const issued = await deps.transport.issueSetupRequest({
                    ...evidence,
                    ...(options.intent
                        ? { projectId: options.intent.projectId }
                        : identity
                            ? { projectId: identity.projectId }
                            : {}),
                });
                if (issued.status !== 'complete') {
                    const handled = await handleAccessResponse(issued);
                    if (handled.status === 'ignored' || issued.status === 'ACTION_REQUIRED')
                        return handled;
                }
                else
                    await clearIgnore();
                let remote;
                let outcome = 'linked';
                if (issued.status === 'complete')
                    remote = issued;
                else if (options.intent &&
                    issued.state === 'confirmation_required' &&
                    issued.requestId &&
                    issued.allowedActions.includes('link')) {
                    remote = await deps.transport.consumeSetupRequest({
                        ...evidence,
                        requestId: issued.requestId,
                        action: 'link',
                        projectId: options.intent.projectId,
                    });
                    if (remote.status === 'ACTION_REQUIRED')
                        return remote;
                }
                else {
                    // Candidate/archived/conflict/etc. decisions remain with the person and server.
                    if (issued.state !== 'missing' ||
                        issued.candidates?.length ||
                        !issued.requestId ||
                        resolution.kind !== 'absent' ||
                        !options.allowCreate ||
                        !issued.allowedActions.includes('create'))
                        return issued;
                    remote = await deps.transport.consumeSetupRequest({
                        ...evidence,
                        requestId: issued.requestId,
                        action: 'create',
                        operationId: record.operationId,
                        displayName: basename(root),
                        owner: record.owner,
                    });
                    if (remote.status === 'ACTION_REQUIRED')
                        return remote;
                    outcome = 'created';
                }
                await deps.fault?.('after_remote_response');
                if (!isCanonicalUuid(remote.projectId))
                    return actionRequired('invalid_server_result');
                record.remote = {
                    projectId: remote.projectId,
                    ...(validDisplayName(remote.displayName) ? { displayName: remote.displayName } : {}),
                };
                record.steps.remote = {
                    complete: true,
                    outcome,
                    beforeHash: record.before.hash,
                    afterHash: hash(JSON.stringify(record.remote)),
                };
                await save();
                await deps.fault?.('after_remote_record');
            }
            if (!record.staged) {
                const content = JSON.stringify({
                    schemaVersion: 1,
                    projectId: record.remote.projectId,
                    projectName: record.remote.displayName,
                    ...(record.evidence?.repositoryFingerprint
                        ? { repositoryFingerprint: record.evidence.repositoryFingerprint }
                        : {}),
                }, null, 2) + '\n';
                record.staged = { content, hash: hash(content) };
                record.steps.identity.afterHash = record.staged.hash;
                await save();
            }
            const current = digest(await readBytes(file));
            if (current === record.staged.hash && !record.steps.identity.complete) {
                record.steps.identity.complete = true;
                await save();
            }
            if (mode === 'stage')
                return result('staged');
            if (current !== record.staged.hash) {
                if (current !== record.before.hash)
                    return actionRequired('identity_changed');
                await atomicWrite(file, Buffer.from(record.staged.content), deps.fault, assertOwned);
                await deps.fault?.('after_identity_rename');
            }
            record.steps.identity.complete = true;
            await save();
            return result('done');
        });
    }
    return {
        ensureProject: (options) => execute(options, 'ensure'),
        stage: (options) => execute(options, 'stage'),
        apply: (options) => execute(options, 'apply'),
        rollback: (options) => execute(options, 'rollback'),
    };
}
//# sourceMappingURL=index.js.map