import { createCliCredentials } from '../auth/credentials.js';
import { apiOrigin } from '@mnemonik/shared';
import { scannerService, ScannerServiceLimited, } from '../scanner/service.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { recordPath } from '@mnemonik/local-setup';
import { reviewScannerProjects } from '../scanner/picker.js';
import { hostOrder } from './adapters.js';
import { bytesAt, withInstall, } from './journal.js';
/** Uses the credential package's locked refresh/revocation path; never journals tokens. */
export const componentRevoker = (adapter, transport) => async (reference) => (await adapter.revokeFamily(reference, transport)).status === 'revoked';
export async function revokeInstallComponent(stateDir, reference, fetcher = fetch) {
    const credentials = createCliCredentials({ stateDir });
    if (!(await credentials.readFamily(reference)))
        return true;
    return componentRevoker(credentials, {
        rotateFamily: async () => {
            throw new Error('rotation_not_requested');
        },
        revokeFamily: async (id, token) => {
            const response = await fetcher(`${apiOrigin()}/api/v1/component-credentials/${encodeURIComponent(id)}/revoke`, {
                method: 'POST',
                headers: { authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(10000),
            });
            return response.status === 200
                ? { status: 200, body: {} }
                : { status: response.status, body: { error: `revoke_${response.status}` } };
        },
    })(reference);
}
export const consentMatches = (a, b) => a !== undefined &&
    a.account === b.account &&
    a.disclosureVersion === b.disclosureVersion &&
    JSON.stringify([...a.roots].sort()) === JSON.stringify([...b.roots].sort()) &&
    JSON.stringify([...a.exclusions].sort()) === JSON.stringify([...b.exclusions].sort());
const projectOptions = (project) => ({
    cwd: project.root,
    allowCreate: true,
    allowNestedInherit: false,
});
const report = (journal, text) => {
    if (!journal.data.reports.includes(text))
        journal.data.reports.push(text);
};
const required = (value) => {
    if (value === undefined)
        throw new Error('Incomplete install journal');
    return value;
};
const adapterFor = (deps, host) => {
    const adapter = deps.adapters.find((a) => a.name === host);
    if (!adapter)
        throw new Error(`Host adapter unavailable: ${host}`);
    return adapter;
};
export function installFailureReason(error) {
    const code = error.code;
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS')
        return 'permission_denied';
    const message = error instanceof Error ? error.message : String(error);
    return message.split(':', 1)[0] || 'installation_interrupted';
}
async function retainProjects(journal, deps) {
    for (const project of journal.data.projects) {
        // Executor persists the remote UUID before returning stage(), including crashes.
        const bytes = await bytesAt(recordPath(project.root, deps.projectStateDir ?? deps.stateDir));
        if (bytes) {
            const record = JSON.parse(bytes.toString());
            project.uuid ??= record.remote?.projectId;
            if (record.steps.remote.outcome !== 'linked')
                project.effect ??= record.steps.remote.outcome;
        }
        if (project.uuid) {
            project.empty = await deps.projectEmpty?.(project.uuid);
            report(journal, `Remote project ${project.uuid} retained${project.effect === 'restored' ? ' active; explicitly re-archive it in the console' : project.effect === 'created' && project.empty === true ? '; empty: you may explicitly archive it in the console' : '; no archive action offered'}.`);
        }
    }
    await journal.save();
}
export async function compensate(journal, deps, keepCli = false) {
    journal.data.phase = 'rolling_back';
    await journal.save();
    let localOK = true;
    for (const service of [...journal.data.services].reverse()) {
        if (service.managed)
            continue;
        try {
            if (service.started) {
                if (!deps.services)
                    throw new Error('service adapter unavailable');
                await deps.services.restore(service.id, service.before);
                service.started = false;
                await journal.event('service_restored', service.id);
            }
        }
        catch {
            localOK = false;
            report(journal, `Service ${service.id} could not be restored to ${service.before}.`);
        }
    }
    for (const project of [...journal.data.projects].reverse()) {
        try {
            // The joined journal owns this run's exact identity backup. Keep the executor's
            // remote receipt resumable; undoing that older operation can erase a prior identity.
            if (journal.data.joined)
                continue;
            const result = await deps.executor.rollback(projectOptions(project));
            if (result.status !== 'rolled_back' &&
                !(result.status === 'ACTION_REQUIRED' && result.state === 'record_missing'))
                throw new Error('project rollback incomplete');
            if (result.status === 'rolled_back')
                project.uuid ??= result.retainedRemoteUUID;
            await journal.event('project_restored', project.root);
        }
        catch {
            localOK = false;
            report(journal, `Project ${project.root} rollback needs attention.`);
        }
    }
    if (!(await journal.restoreFiles()))
        localOK = false;
    if (localOK) {
        for (const credential of journal.data.credentials) {
            if (credential.revoked ||
                (keepCli && credential.kind === 'cli') ||
                (credential.component === 'scanner' &&
                    journal.data.services.some((service) => service.id === 'scanner' && service.managed)))
                continue;
            try {
                if (credential.kind === 'cli')
                    await deps.revokeCli();
                else if (!(await deps.revokeComponent(credential.reference)))
                    throw new Error('revoke refused');
                credential.revoked = true;
                await journal.event('credential_revoked', credential.reference);
            }
            catch {
                report(journal, `Credential ${credential.reference} retained; revoke it in Devices and grants.`);
            }
        }
    }
    else
        report(journal, 'Credentials retained until local rollback succeeds; retry rollback.');
    await retainProjects(journal, deps);
    if (journal.data.mutations.some((m) => m.event === 'upload_intent'))
        report(journal, `Uploaded data is retained. ${deps.upload?.deletionAction ?? 'Delete the cloud index separately in the console.'}`);
    journal.data.phase = localOK ? 'rolled_back' : 'rolling_back';
    journal.data.state = localOK ? 'LIMITED' : 'FAILED';
    await journal.event('compensation_finished');
}
export async function reconcile(journal, deps) {
    const states = await journal.reconcile();
    for (const { target, state } of states)
        if (state === 'conflict')
            report(journal, `Conflict: ${target.path} matches neither recorded hash; resolve before resume/rollback.`);
    await retainProjects(journal, deps);
    await journal.event('reconciled');
    return !states.some((s) => s.state === 'conflict');
}
export async function runInstall(deps, resume) {
    if (!deps.services && deps.input.components.includes('scanner'))
        deps = {
            ...deps,
            services: scannerService({
                stateDir: deps.stateDir,
                now: deps.now,
                sleep: deps.sleep,
                waiting: (phase) => deps.ui.waiting(`scanner ${phase}`),
                timeout: async (phase) => (await deps.ui.timeout(`scanner ${phase}`)) === 'retry' ? 'retry' : 'skip',
                ...deps.scannerService,
            }),
        };
    return withInstall(deps.stateDir, deps.input, resume, async (journal) => {
        const event = (name, target) => journal.event(name, target);
        const cancelled = () => {
            if (deps.signal?.aborted)
                throw new Error('install_cancelled');
        };
        const cancel = async () => {
            await compensate(journal, deps, (await deps.ui.cancel()) === 'keep-cli');
            return journal.data;
        };
        if (resume) {
            const clean = await reconcile(journal, deps);
            if ((await deps.ui.recovery(journal.data.reports)) === 'rollback')
                return cancel();
            if (!clean || journal.data.phase === 'rolling_back')
                return journal.data;
        }
        try {
            cancelled();
            for (const host of hostOrder.filter((h) => journal.data.hosts.includes(h))) {
                const adapter = adapterFor(deps, host);
                const detected = await adapter.detect();
                if (!detected.supported) {
                    report(journal, `${host}: ${detected.reason ?? 'upgrade to a supported version and retry'}.`);
                    journal.data.hosts = journal.data.hosts.filter((candidate) => candidate !== host);
                    journal.data.state = 'LIMITED';
                    await journal.save();
                    continue;
                }
                const hostTarget = deps.targets?.[host];
                const plan = await adapter.plan(hostTarget);
                if (!adapter.capabilities().scopes.includes(plan.effectiveScope))
                    throw new Error('Unsupported scope');
                journal.data.scopes[host] = {
                    requested: plan.requestedScope,
                    effective: plan.effectiveScope,
                };
                for (const change of plan.changes) {
                    await journal.plan(change.path, change.content, {
                        kind: 'host',
                        host,
                        staging: plan.staging,
                        version: plan.version,
                        artifactDigest: plan.artifactDigest,
                    });
                }
                // Stage the captured plan, without invoking a second read/plan cycle.
                for (const change of plan.changes)
                    await journal.stage(change);
            }
            while (true) {
                cancelled();
                const { picked, account, disclosureVersion } = await deps.ui.roots();
                const consent = {
                    account,
                    disclosureVersion,
                    roots: picked.roots,
                    exclusions: picked.exclusions,
                };
                journal.data.roots = picked.roots;
                await event('roots_confirmed');
                if (!consentMatches(journal.data.consent, consent)) {
                    delete journal.data.consent;
                    await journal.save();
                    if (!(await deps.ui.consent(consent)))
                        return cancel();
                    journal.data.consent = consent;
                    await event('consent_recorded');
                }
                if (account !== deps.input.account) {
                    journal.data.state = 'ACTION_REQUIRED';
                    report(journal, 'Account switched: restart host validation for the new account.');
                    await journal.save();
                    return journal.data;
                }
                journal.data.phase = 'review';
                for (const project of journal.data.projects) {
                    project.selected = picked.repositories.some((r) => r.selected && r.path === project.root);
                    if (!project.selected) {
                        if ((await deps.executor.rollback(projectOptions(project))).status !== 'rolled_back')
                            throw new Error('Deselected project rollback needs attention');
                        await journal.restore(required(journal.data.targets.find((t) => t.path === join(project.root, '.mnemonik.json'))));
                    }
                }
                for (const repository of picked.repositories.filter((r) => r.selected)) {
                    if (!journal.data.projects.some((p) => p.root === repository.path))
                        journal.data.projects.push({ root: repository.path });
                    await journal.plan(join(repository.path, '.mnemonik.json'), null, { kind: 'project' });
                }
                await event('project_stage_intent');
                const handoff = await reviewScannerProjects(picked, deps.executor);
                for (const entry of handoff.staged) {
                    const project = required(journal.data.projects.find((p) => p.root === entry.path));
                    if ('projectId' in entry.result && typeof entry.result.projectId === 'string')
                        project.uuid = entry.result.projectId;
                    const saved = await bytesAt(recordPath(entry.path, deps.projectStateDir ?? deps.stateDir));
                    const record = saved ? JSON.parse(saved.toString()) : undefined;
                    const target = required(journal.data.targets.find((t) => t.path === join(entry.path, '.mnemonik.json')));
                    if (record?.staged)
                        await journal.propose(target, Buffer.from(record.staged.content));
                    await journal.stage(target);
                    await event('project_staged', entry.path);
                }
                await retainProjects(journal, deps);
                await event('projects_staged');
                if (handoff.actionRequired.length) {
                    journal.data.state = 'ACTION_REQUIRED';
                    report(journal, 'Resolve project setup choices before Apply.');
                    await journal.save();
                    return journal.data;
                }
                await deps.prepare?.(journal);
                if (deps.services && !journal.data.services.length)
                    journal.data.services = await deps.services.inspect();
                await event('final_review');
                const choice = await deps.ui.review(journal);
                if (choice === 'cancel')
                    return cancel();
                if (choice === 'back')
                    continue;
                cancelled();
                break;
            }
            journal.data.phase = 'applying';
            await event('apply');
            for (const target of journal.data.targets.filter((t) => t.kind !== 'project'))
                await journal.commit(target);
            for (const project of journal.data.projects.filter((p) => p.selected !== false)) {
                const result = await deps.executor.apply(projectOptions(project));
                if (result.status !== 'done')
                    throw new Error('Project Apply needs attention');
                const target = required(journal.data.targets.find((t) => t.path === join(project.root, '.mnemonik.json')));
                target.status = 'committed';
                await event('committed', target.id);
            }
            journal.data.phase = 'committed';
            await event('local_commit');
            if (deps.services) {
                for (const service of journal.data.services) {
                    if (journal.data.mutations.some((m) => m.event === 'service_started' && m.target === service.id))
                        continue;
                    service.started = true;
                    await event('service_start_intent', service.id);
                    try {
                        await deps.services.start(service.id);
                        await event('service_started', service.id);
                    }
                    catch (error) {
                        if (!(error instanceof ScannerServiceLimited))
                            throw error;
                        journal.data.state = 'LIMITED';
                        report(journal, `${error.summary} ${error.action}`.trim());
                    }
                }
            }
            if (deps.upload &&
                journal.data.components.includes('scanner') &&
                deps.services?.verified &&
                journal.data.consent) {
                journal.data.phase = 'uploading';
                if (!journal.data.mutations.some((mutation) => mutation.event === 'upload_finished')) {
                    let operationId = journal.data.mutations.find((mutation) => mutation.event === 'upload_intent' && mutation.target)?.target;
                    if (!operationId) {
                        operationId = randomUUID();
                        await event('upload_intent', operationId);
                    }
                    await deps.upload.start(operationId);
                    await event('upload_finished', operationId);
                }
            }
            if (journal.data.components.includes('scanner') && !deps.services?.verified)
                report(journal, 'scanner_not_verified');
            if (journal.data.hosts.length)
                report(journal, 'hook_not_verified');
            journal.data.phase = 'complete';
            journal.data.state =
                !journal.data.hosts.length && !journal.data.components.includes('scanner')
                    ? 'FAILED'
                    : journal.data.state === 'LIMITED' ||
                        !journal.data.components.includes('scanner') ||
                        journal.data.reports.includes('scanner_not_verified') ||
                        journal.data.reports.includes('hook_not_verified')
                        ? 'LIMITED'
                        : 'READY';
            await event('complete');
        }
        catch (error) {
            if (deps.signal?.aborted &&
                !['committed', 'uploading', 'complete'].includes(journal.data.phase))
                return cancel();
            journal.data.state = 'FAILED';
            if (journal.data.phase === 'uploading')
                report(journal, `Upload failed; remote data is retained. ${required(deps.upload).deletionAction}`);
            else
                report(journal, `Installation interrupted (${installFailureReason(error)}); resume or roll back the recorded changes.`);
            await journal.save();
            if (deps.fault)
                throw error;
        }
        return journal.data;
    }, deps.fault);
}
//# sourceMappingURL=transaction.js.map