import { humanReason, projectActionSentence } from './humanReason.js';
import { createCliCredentials } from './auth/credentials.js';
import { createInterface } from 'node:readline';
import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createProjectSetupExecutor, } from '@mnemonik/local-setup';
import { resolveProjectIdentity, selectRemote, } from '@mnemonik/shared';
import { createServerTransport, ServerActionRequiredError, } from './transport/server.js';
import { evaluateRoot } from './project/eligibility.js';
import { identityHash, ownerLabel, readExecutorState, saveCommandRecord, } from './project/records.js';
export async function ensureProjectRoot(root, executor) {
    return executor.ensureProject({ cwd: root, allowCreate: true, allowNestedInherit: false });
}
const refusalReasons = {
    filesystem_root: 'Mnemonik does not index a whole disk.',
    home_directory: 'Mnemonik does not index your whole home folder.',
    temporary_directory: 'Mnemonik does not index the temporary folder.',
    mnemonik_state_directory: 'That folder holds Mnemonik settings.',
    user_data_directory: 'That folder holds program settings.',
    host_config_directory: 'That folder holds editor settings.',
    broad_workspace_parent: 'It holds several projects, and Mnemonik would index all of them.',
    not_found: 'Its project file names a project this account cannot open.',
    project_access_denied: 'Its project file names a project this account cannot open.',
    archived: 'Its project is archived.',
    blocked: 'Its project belongs to an account that is on hold.',
    deleted: 'Its project was deleted.',
    fingerprint_mismatch: 'Its Git remote does not match the repository this project was set up with.',
    confirmation_required: 'Mnemonik has not seen this folder on this machine before.',
    nested: 'It sits inside another project.',
    conflict: 'It holds project files that disagree.',
    invalid_identity: 'Its project file cannot be read.',
    malformed: 'Its project file cannot be read.',
    unknown_version: 'Its project file was written by a newer version of Mnemonik.',
    identity_too_large: 'Its project file is too large to keep a copy of.',
    identity_changed: 'Its project file changed while Mnemonik was working.',
    operation_context_changed: 'Another Mnemonik command is part-way through connecting it.',
    rollback_in_progress: 'An undo of an earlier setup is still running for that folder.',
    operation_rolled_back: 'An earlier setup of that folder was undone.',
    record_invalid: 'Mnemonik cannot read its own notes about that folder.',
    record_missing: 'Mnemonik has no notes about that folder to finish.',
    not_staged: 'Nothing was prepared for that folder yet.',
    invalid_server_result: 'Mnemonik got an answer it could not use.',
    identity_exists: 'It is already connected to a different project.',
};
const AGAIN = 'Run the command again.';
const CHOOSE_ONE = 'Choose a single project folder and run mnemonik add on that folder.';
const SIGN_IN = 'Sign in to the account that owns that project, then run the command again.';
const FRESH_FILE = 'Delete the .mnemonik.json file in that folder, then run the command again.';
const refusalSteps = {
    filesystem_root: CHOOSE_ONE,
    home_directory: CHOOSE_ONE,
    temporary_directory: CHOOSE_ONE,
    mnemonik_state_directory: CHOOSE_ONE,
    user_data_directory: CHOOSE_ONE,
    host_config_directory: CHOOSE_ONE,
    broad_workspace_parent: CHOOSE_ONE,
    not_found: SIGN_IN,
    project_access_denied: SIGN_IN,
    blocked: SIGN_IN,
    archived: 'Restore the project in the Mnemonik web console, then run the command again.',
    deleted: FRESH_FILE,
    invalid_identity: FRESH_FILE,
    malformed: FRESH_FILE,
    unknown_version: 'Update Mnemonik on this machine, then run the command again.',
    identity_too_large: FRESH_FILE,
    fingerprint_mismatch: 'Run mnemonik project link <project id> --confirm-mismatch in that folder to connect it anyway.',
    confirmation_required: 'Run mnemonik project setup in that folder to confirm it.',
    nested: 'Run mnemonik project setup in that folder and choose which project it belongs to.',
    conflict: 'Run mnemonik project setup in that folder and choose which project it belongs to.',
    identity_changed: AGAIN,
    operation_context_changed: 'Run mnemonik project setup in that folder to finish that command.',
    rollback_in_progress: 'Wait for it to finish, then run the command again.',
    operation_rolled_back: 'Run mnemonik project setup in that folder to set it up again.',
    not_staged: AGAIN,
    invalid_server_result: AGAIN,
    record_invalid: 'Run mnemonik doctor on this machine, then run the command again.',
    record_missing: 'Run mnemonik project setup in that folder.',
    identity_exists: 'Run mnemonik project link <project id> --replace in that folder.',
};
/** Does Mnemonik have plain words for this state? */
export const hasRefusalWords = (reason) => reason in refusalReasons;
/** No bare line: name the folder, say why in plain words, give the one command. */
export function folderRefusalMessage(reason, root) {
    const name = basename(root);
    return [
        `${name} was not connected. ${refusalReasons[reason] ?? 'Mnemonik could not finish connecting it.'}`,
        refusalSteps[reason] ?? `Run mnemonik status in ${name} and follow the first step.`,
    ];
}
export function projectLimitMessage(result, roots) {
    if (!('state' in result) || result.state !== 'project_limit_reached')
        return undefined;
    const details = result;
    const limit = typeof details.limit === 'number' ? details.limit : 1;
    const tier = typeof details.tier === 'string' ? details.tier : limit === 1 ? 'free' : 'plan';
    const plan = tier === 'plan' ? 'current' : `${tier[0]?.toUpperCase()}${tier.slice(1)}`;
    const allowance = limit === 1 ? 'one project' : `${limit} projects`;
    const skipped = (Array.isArray(roots) ? roots : [roots]).map((root) => basename(root));
    const subject = skipped.length === 1 ? skipped[0] : `${skipped[0]} and ${skipped.length - 1} more`;
    return [
        `${subject} ${skipped.length === 1 ? 'was' : 'were'} not connected. The ${plan} plan includes ${allowance}.`,
        'To connect more projects, upgrade your plan via the Mnemonik web console.',
    ];
}
export const connectedProjectsMessage = (roots) => roots.length === 1
    ? `  ✓ Connected ${basename(roots[0] ?? '')}.`
    : `  ✓ Connected ${roots.length} project folders.`;
export const projectExecutor = (dependencies) => {
    const executor = createProjectSetupExecutor(dependencies);
    return {
        resolveProjectIdentity: (cwd) => dependencies.resolver.resolveProjectIdentity(cwd, { allowNestedInherit: false }),
        ...executor,
    };
};
const gitEnvironment = () => {
    const env = { LC_ALL: 'C' };
    for (const key of ['PATH', 'HOME', 'LANG', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE'])
        if (process.env[key] !== undefined)
            env[key] = process.env[key];
    return env;
};
const git = (cwd, args) => new Promise((resolvePromise, reject) => execFile('git', args, { cwd, timeout: 2_000, encoding: 'utf8', env: gitEnvironment() }, (error, stdout) => (error ? reject(error) : resolvePromise(stdout))));
export async function repositoryFingerprint(root) {
    let names;
    try {
        names = (await git(root, ['remote'])).split(/\r?\n/u).filter(Boolean);
    }
    catch {
        return null;
    }
    const remotes = await Promise.all(names.map(async (name) => {
        const urls = async (push) => {
            try {
                return (await git(root, ['remote', 'get-url', '--all', ...(push ? ['--push'] : []), name]))
                    .split(/\r?\n/u)
                    .filter(Boolean);
            }
            catch {
                return [];
            }
        };
        return { name, fetchUrls: await urls(false), pushUrls: await urls(true) };
    }));
    const selected = selectRemote(remotes);
    return selected.status === 'fingerprint'
        ? {
            algorithmVersion: selected.fingerprint.algorithmVersion,
            hash: selected.fingerprint.hash,
        }
        : null;
}
export async function createRealProjectRuntime(options = {}) {
    const resolveIdentity = (cwd, resolverOptions) => resolveProjectIdentity(cwd, { ...resolverOptions, selectedRoot: options.selectedRoots });
    const credentials = options.credentials ??
        createCliCredentials(options.stateDir ? { stateDir: options.stateDir } : {});
    const contexts = new Map();
    const contextKey = (input) => JSON.stringify([input.deviceRootContext, input.repositoryFingerprint]);
    const transport = createServerTransport({
        apiBase: options.apiBase,
        resource: options.resource,
        fetch: options.fetch,
        credentials,
        getCliBearer: options.getCliBearer,
        requestId: options.requestId,
        issueContext: async (input) => {
            const context = contexts.get(contextKey(input));
            if (!context)
                throw new ServerActionRequiredError({
                    status: 'ACTION_REQUIRED',
                    state: 'operation_context_changed',
                    allowedActions: ['retry', 'cancel'],
                });
            return { ...context, ...(input.projectId ? { requestedProjectId: input.projectId } : {}) };
        },
    });
    const account = await transport.accountContext();
    const bindContext = async (root) => {
        const [binding, fingerprint, resolution] = await Promise.all([
            credentials.hmacRootBinding(1, root),
            repositoryFingerprint(root),
            resolveIdentity(root, { allowNestedInherit: false }),
        ]);
        const evidence = {
            deviceRootContext: {
                algorithmVersion: binding.version,
                hash: Buffer.from(binding.hmac, 'base64url').toString('hex'),
            },
            repositoryFingerprint: fingerprint,
        };
        const context = {
            ...evidence,
            rootKind: resolution.kind !== 'git_unavailable' && resolution.repository.kind === 'plain'
                ? 'selected_non_git'
                : resolution.kind === 'git_unavailable'
                    ? 'ineligible'
                    : 'git',
            identityState: resolution.kind === 'ok' ? 'valid' : resolution.kind === 'absent' ? 'absent' : 'invalid',
            ...(resolution.kind === 'ok' ? { projectId: resolution.identity.projectId } : {}),
        };
        contexts.set(contextKey(evidence), context);
        return evidence;
    };
    return {
        transport,
        getCliBearer: transport.getCliBearer,
        executor: projectExecutor({
            resolver: { resolveProjectIdentity: resolveIdentity },
            transport,
            scopeKey: `${account.userId}:${account.deviceInstallationId}`,
            bindContext,
            stateDir: options.stateDir,
            fault: options.fault,
        }),
    };
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/**
 * Sentences, not a list of internal action names. Cancelling is always available,
 * and an action with no sentence of its own is left out rather than shown raw.
 */
const choiceLines = (actions) => actions.flatMap((action) => {
    const label = projectActionSentence(action);
    return label ? [`  You can ${label.replace(/^[A-Z]/u, (c) => c.toLowerCase())}.`] : [];
});
function actionRequired(output, json, state, details = {}) {
    const { quiet, ...rest } = details;
    const result = { status: 'ACTION_REQUIRED', state, ...rest };
    if (json)
        output.json(result);
    else if (!quiet) {
        output.error(humanReason(state));
        if (Array.isArray(details.allowedActions))
            for (const line of choiceLines(details.allowedActions.map(String)))
                output.line(line);
    }
    return 3;
}
class Prompter {
    input;
    output;
    readline;
    lines;
    constructor(input, output) {
        this.input = input;
        this.output = output;
    }
    async confirm(prompt) {
        this.output.line(`${prompt} [y/N]`);
        this.readline ??= createInterface({
            input: this.input,
            terminal: Boolean(this.input.isTTY),
        });
        this.lines ??= this.readline[Symbol.asyncIterator]();
        const answer = await this.lines.next();
        return /^(?:y|yes)$/i.test(answer.value?.trim() ?? '');
    }
    close() {
        this.readline?.close();
    }
}
function parseOwner(value) {
    if (!value)
        return undefined;
    if (value === 'personal')
        return 'personal';
    if (value.startsWith('team:') && UUID.test(value.slice(5)))
        return { teamId: value.slice(5) };
    return null;
}
async function selectedOwner(explicit, bearer, transport) {
    const parsed = parseOwner(explicit);
    if (parsed === null)
        return null;
    if (parsed)
        return parsed;
    return (await transport?.getDefaultOwner(bearer)) ?? 'personal';
}
function showPlan(output, plan) {
    output.line('Project plan');
    output.line(`  Root: ${plan.root}`);
    output.line(`  Owner: ${ownerLabel(plan.owner)}`);
    output.line(`  Candidates: ${plan.candidates.length ? JSON.stringify(plan.candidates) : 'none'}`);
}
function showResult(output, json, result, root, owner, record) {
    if (json)
        output.json({
            ...record,
            status: result.status,
            ...('state' in result ? { state: result.state } : {}),
            ...('allowedActions' in result ? { allowedActions: result.allowedActions } : {}),
            ...('candidates' in result && Array.isArray(result.candidates)
                ? { candidates: result.candidates }
                : {}),
            ...('manualAction' in result ? { manualAction: result.manualAction } : {}),
            ...('used' in result && 'limit' in result ? { used: result.used, limit: result.limit } : {}),
            root,
            owner: ownerLabel(owner),
        });
    else {
        const state = 'state' in result ? result.state : result.status;
        if (hasRefusalWords(state))
            for (const line of folderRefusalMessage(state, root))
                output.line(line);
        else
            output.error(humanReason(state));
        if ('candidates' in result && Array.isArray(result.candidates))
            for (const candidate of result.candidates)
                output.line(`  ${candidate.displayName} (${candidate.projectId})`);
        if ('used' in result && 'limit' in result)
            output.line(`  Projects: ${result.used} used, limit ${result.limit}`);
        if ('allowedActions' in result)
            for (const line of choiceLines(result.allowedActions))
                output.line(line);
    }
}
async function finish(deps, input, result, root, reason, owner, beforeHash) {
    const afterHash = await identityHash(root);
    const record = {
        resolvedRoot: root,
        decisionReason: result.status === 'done' || !('state' in result) ? reason : result.state,
        chosenOwner: ownerLabel(owner),
        projectId: result.status === 'done'
            ? (result.projectId ?? null)
            : input.projectId && UUID.test(input.projectId)
                ? input.projectId
                : null,
        beforeHash,
        afterHash,
    };
    await saveCommandRecord(record, deps.stateDir);
    if (result.status === 'ignored') {
        if (input.json)
            deps.output.json({ ...record, status: result.status, root, owner: ownerLabel(owner) });
        else
            deps.output.line(`Folder ignored on this machine: ${root}`);
        return 0;
    }
    if (result.status !== 'done') {
        showResult(deps.output, input.json, result, root, owner, record);
        return 3;
    }
    if (input.json)
        deps.output.json(record);
    else {
        deps.output.line(`Project ${result.projectId ?? 'ready'} at ${root}`);
        deps.output.line(`Identity: ${root}/.mnemonik.json`);
    }
    return 0;
}
async function finishRequired(deps, input, root, reason, owner, state, allowedActions, details = {}) {
    const beforeHash = await identityHash(root);
    return finish(deps, input, { status: 'ACTION_REQUIRED', state, allowedActions, ...details }, root, reason, owner, beforeHash);
}
async function statusCommand(input, deps) {
    const cwd = input.path ?? deps.cwd;
    const resolution = await (deps.resolver?.resolveProjectIdentity ?? resolveProjectIdentity)(cwd, {
        allowNestedInherit: false,
    });
    const root = 'root' in resolution ? resolution.root : cwd;
    const projectId = resolution.kind === 'ok' ? resolution.identity.projectId : null;
    const currentHash = await identityHash(root);
    const reachable = await lstat(root).then(() => true, (error) => {
        if (error.code === 'ENOENT')
            return false;
        throw error;
    });
    const bearer = await deps.getCliBearer?.();
    const server = projectId && bearer && deps.transport
        ? await deps.transport.readProjectState(projectId, bearer, await repositoryFingerprint(root))
        : undefined;
    const savedExecutorState = await readExecutorState(root, deps.stateDir);
    const executorState = !reachable && savedExecutorState ? 'unreachable' : savedExecutorState;
    const record = {
        resolvedRoot: root,
        decisionReason: resolution.kind,
        chosenOwner: 'personal',
        projectId,
        beforeHash: currentHash,
        afterHash: currentHash,
        identity: resolution.kind,
        reachability: reachable ? 'reachable' : 'unreachable',
        ...(server ? { server: server.state } : {}),
        ...(executorState ? { executorState } : {}),
    };
    if (input.json)
        deps.output.json(record);
    else {
        deps.output.line(`Root: ${root}`);
        deps.output.line(resolution.kind === 'ok'
            ? 'Project identity is present.'
            : humanReason('project_setup_required'));
        if (!reachable)
            deps.output.line('Reachability: unreachable');
        if (server && server.state !== 'access')
            deps.output.line(humanReason(server.state));
        if (executorState && executorState !== 'done')
            deps.output.line(humanReason(executorState));
    }
    return 0;
}
async function runProjectCommandInner(input, deps, prompts) {
    if (input.command === 'status')
        return statusCommand(input, deps);
    if (!deps.executor)
        return actionRequired(deps.output, input.json, 'not_signed_in', {
            allowedActions: ['mnemonik install'],
        });
    const executor = deps.executor;
    const bearer = await deps.getCliBearer?.();
    if (!bearer)
        return actionRequired(deps.output, input.json, 'not_signed_in', {
            allowedActions: ['mnemonik install'],
        });
    const owner = await selectedOwner(input.owner, bearer, deps.transport);
    if (!owner)
        return actionRequired(deps.output, input.json, 'invalid_owner', {
            allowedActions: ['choose_personal_or_team_owner', 'cancel'],
        });
    const cwd = input.path ?? deps.cwd;
    const resolution = await executor.resolveProjectIdentity(cwd);
    if (resolution.kind === 'nested' || resolution.kind === 'conflict') {
        const identityLocation = join(resolution.root, '.mnemonik.json');
        if (!input.json) {
            deps.output.line(`Root: ${resolution.root}`);
            deps.output.line(`Identity: ${identityLocation}`);
        }
        return finishRequired(deps, input, resolution.root, resolution.kind, owner, resolution.kind, [
            'use_parent_identity',
            'initialize_nested_separately',
            'select_main_or_worktree_identity',
            'cancel',
        ], { identityLocation });
    }
    const decision = await evaluateRoot(resolution, { cwd, home: deps.home });
    if (!decision.allowed) {
        if (!input.json)
            for (const line of folderRefusalMessage(decision.reason, decision.root))
                deps.output.line(line);
        return actionRequired(deps.output, input.json, decision.reason, {
            root: decision.root,
            allowedActions: ['cancel'],
            quiet: true,
        });
    }
    deps.output.setContext({ home: deps.home, projectRoot: decision.root });
    const base = {
        cwd,
        owner,
        allowCreate: input.command !== 'link',
        allowNestedInherit: false,
    };
    if (input.command === 'setup') {
        if ((input.nonInteractive || input.json) && !input.apply) {
            if (!input.json)
                showPlan(deps.output, {
                    root: decision.root,
                    reason: decision.reason,
                    owner,
                    candidates: [],
                });
            return finishRequired(deps, input, decision.root, decision.reason, owner, 'apply_required', ['rerun_with_apply', 'cancel'], { decisionReason: decision.reason, candidates: [] });
        }
        if (!input.nonInteractive && !input.json) {
            const beforeHash = await identityHash(decision.root);
            const preview = await executor.stage({ ...base, allowCreate: false });
            const candidates = 'candidates' in preview && Array.isArray(preview.candidates) ? preview.candidates : [];
            showPlan(deps.output, {
                root: decision.root,
                reason: decision.reason,
                owner,
                candidates,
            });
            const canContinue = preview.status === 'staged' ||
                (preview.status === 'project_setup_required' &&
                    preview.state === 'missing' &&
                    preview.allowedActions.includes('create'));
            if (!canContinue) {
                return finish(deps, input, preview, decision.root, decision.reason, owner, beforeHash);
            }
            if (!(await prompts.confirm('Apply?')))
                return finishRequired(deps, input, decision.root, decision.reason, owner, 'cancelled', [
                    'cancel',
                ]);
            const result = preview.status === 'staged'
                ? await executor.apply(base)
                : await executor
                    .stage(base)
                    .then(async (staged) => (staged.status === 'staged' ? executor.apply(base) : staged));
            return finish(deps, input, result, decision.root, decision.reason, owner, beforeHash);
        }
    }
    if (input.command === 'link') {
        if (!input.projectId || !UUID.test(input.projectId))
            return finishRequired(deps, input, decision.root, decision.reason, owner, 'invalid_project_id', ['provide_project_uuid', 'cancel']);
        if (!deps.transport)
            return finishRequired(deps, input, decision.root, decision.reason, owner, 'status_unavailable', ['retry', 'cancel']);
        const server = await deps.transport.readProjectState(input.projectId, bearer, await repositoryFingerprint(decision.root));
        if (server.state === 'mismatch') {
            if (!input.confirmMismatch &&
                (input.nonInteractive ||
                    input.json ||
                    !(await prompts.confirm("This folder's Git remote differs from the project's. Link anyway?")))) {
                return finishRequired(deps, input, decision.root, decision.reason, owner, 'fingerprint_mismatch', ['confirm_mismatch', 'cancel']);
            }
        }
        else if (server.state !== 'access') {
            return finishRequired(deps, input, decision.root, decision.reason, owner, server.state, server.allowedActions ?? []);
        }
        if (resolution.kind === 'ok' &&
            resolution.identity.projectId !== input.projectId &&
            !input.replace)
            return finishRequired(deps, input, decision.root, decision.reason, owner, 'identity_exists', [
                'replace',
                'cancel',
            ]);
        base.intent = {
            action: 'link',
            projectId: input.projectId,
            ...(input.replace ? { replace: true } : {}),
        };
    }
    const beforeHash = await identityHash(decision.root);
    let result = input.command === 'init'
        ? await executor.ensureProject(base)
        : await executor
            .stage(base)
            .then(async (staged) => (staged.status === 'staged' ? executor.apply(base) : staged));
    if (input.command === 'init' && !input.nonInteractive && !input.json) {
        if (result.status === 'ignored') {
            deps.output.line(`Root: ${decision.root}`);
            deps.output.line(`Identity: ${join(decision.root, '.mnemonik.json')}`);
            if (await prompts.confirm('Stop ignoring this folder and continue?'))
                result = await executor.ensureProject({ ...base, clearIgnore: true });
        }
        else if ('allowedActions' in result &&
            result.allowedActions.includes('ignore') &&
            (await prompts.confirm('Ignore this folder on this machine?')))
            result = await executor.ensureProject({ ...base, ignore: true });
    }
    return finish(deps, input, result, decision.root, decision.reason, owner, beforeHash);
}
export async function runProjectCommand(input, deps) {
    const prompts = new Prompter(deps.input, deps.output);
    try {
        let effective = deps;
        if (!deps.executor && !deps.transport && !deps.getCliBearer) {
            try {
                const runtime = await createRealProjectRuntime({ stateDir: deps.stateDir });
                effective = {
                    ...deps,
                    executor: runtime.executor,
                    transport: runtime.transport,
                    getCliBearer: async () => {
                        const bearer = await runtime.getCliBearer();
                        return typeof bearer === 'string' ? bearer : undefined;
                    },
                };
            }
            catch (error) {
                if (input.command !== 'status') {
                    const state = error instanceof ServerActionRequiredError && error.result.state !== 'family_missing'
                        ? error.result.state
                        : 'not_signed_in';
                    return actionRequired(deps.output, input.json, state, {
                        allowedActions: [state === 'not_signed_in' ? 'mnemonik install' : 'retry', 'cancel'],
                    });
                }
            }
        }
        try {
            return await runProjectCommandInner(input, effective, prompts);
        }
        catch (error) {
            if (error instanceof ServerActionRequiredError)
                return actionRequired(deps.output, input.json, error.result.state, {
                    allowedActions: error.result.allowedActions,
                });
            throw error;
        }
    }
    finally {
        prompts.close();
    }
}
export async function ensureProjectForAgent(options) {
    let executor = options.executor;
    if (!executor)
        try {
            const credentials = createCliCredentials();
            if (!(await credentials.readCliOAuth()))
                throw new ServerActionRequiredError({
                    status: 'ACTION_REQUIRED',
                    state: 'family_missing',
                    allowedActions: ['mnemonik install'],
                });
            let requestId;
            const input = options.input ?? process.stdin;
            if (!input.isTTY) {
                let text = '';
                for await (const chunk of input) {
                    text += String(chunk);
                    if (text.length > 4_096)
                        throw new Error('invalid_request');
                }
                const value = JSON.parse(text);
                if (typeof value.requestId !== 'string')
                    throw new Error('invalid_request');
                requestId = value.requestId;
            }
            executor = (await createRealProjectRuntime({ credentials, requestId })).executor;
        }
        catch (error) {
            const reason = error instanceof ServerActionRequiredError && error.result.state !== 'family_missing'
                ? error.result.state
                : error instanceof Error && error.message === 'invalid_request'
                    ? 'invalid_request'
                    : 'not_signed_in';
            options.output.json({
                status: 'action_required',
                reason,
                action: reason === 'not_signed_in' ? 'mnemonik install' : 'mnemonik auth renew',
            });
            return 3;
        }
    if (!executor) {
        options.output.json({
            status: 'action_required',
            reason: 'not_signed_in',
            action: 'mnemonik install',
        });
        return 3;
    }
    const resolution = await executor.resolveProjectIdentity(options.cwd);
    const decision = await evaluateRoot(resolution, { cwd: options.cwd });
    if (!decision.allowed || (resolution.kind !== 'ok' && resolution.kind !== 'absent')) {
        options.output.json({
            status: 'action_required',
            reason: decision.allowed ? resolution.kind : decision.reason,
            action: 'mnemonik project init <path>',
            root: decision.root,
        });
        return 3;
    }
    const result = await executor.ensureProject({
        cwd: options.cwd,
        allowCreate: true,
        allowNestedInherit: false,
    });
    options.output.json(result);
    return result.status === 'ACTION_REQUIRED' || result.status === 'project_setup_required' ? 3 : 0;
}
export async function rollbackProjectIdentity(options) {
    if (!options.executor)
        return 3;
    const result = await options.executor.rollback({
        cwd: options.cwd,
        allowCreate: false,
        allowNestedInherit: false,
    });
    options.output.json(result);
    return result.status === 'rolled_back' ? 0 : 3;
}
//# sourceMappingURL=project.js.map