import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { apiOrigin, remainingReadinessCount, serializeReadiness, } from '@mnemonik/shared';
import { atomicWrite, recordPath, stateDirectory } from '@mnemonik/local-setup';
import { nodeVersionHelp, runPreflight } from '../preflight.js';
import { createRealProjectRuntime, folderRefusalMessage, projectLimitMessage, repositoryFingerprint, } from '../project.js';
import { classifyRepository } from '../scanner/discover.js';
import { prepareScanner, restoreScannerInstall } from '../scanner/enable.js';
import { ScannerServiceLimited } from '../scanner/service.js';
import { collectStatusDocument } from '../status.js';
import { devReadiness } from '../runtime/releaseSource.js';
import { completedStep, completedLine, ADD_ANOTHER_FOLDER, renderSetup, renderInterrupted, renderJourney, renderNoSupportedEditors, renderRollbackResult, journeyAnswers, INSTALLATION_STOPPED, stepProgress, } from '../screens/journey.js';
import { interrupted } from './journal.js';
import { runHosts, hookStatusConditions, } from './hosts.js';
import { compensate, revokeInstallComponent } from './transaction.js';
import * as ownership from './ownership.js';
import { ensureLauncher, launcherPathAction, LauncherError } from '../launcher.js';
import { launchHostLabels as labels, launchHosts } from './adapters.js';
const FINAL_REPORT_TIMEOUT_MS = 3_000;
export function hostReadinessConditions(results, scanner) {
    return results
        .filter((r) => r.status !== 'READY')
        .map((r) => {
        return {
            kind: scanner ? 'host_skipped' : 'host_trust_pending',
            reason: scanner ? `${r.target}: ${r.reason}` : r.reason,
            action: r.action,
        };
    });
}
export async function waitForInstallation(check, timeout, clock = {}) {
    const now = clock.now ?? Date.now;
    const sleep = clock.sleep ?? delay;
    let document;
    for (;;) {
        const deadline = now() + 120000;
        do {
            let timer;
            try {
                const result = await Promise.race([
                    check(),
                    new Promise((resolve) => {
                        timer = setTimeout(() => resolve(undefined), Math.max(0, deadline - now()));
                    }),
                ]);
                if (result)
                    document = result;
                if (result && now() <= deadline && result.installation.state !== 'ACTION_REQUIRED')
                    return { document: result, skipped: false };
                if (!result || now() >= deadline)
                    break;
            }
            finally {
                clearTimeout(timer);
            }
            await sleep(Math.min(1000, Math.max(0, deadline - now())));
        } while (now() < deadline);
        if ((await timeout()) !== 'Retry')
            return { document, skipped: true };
    }
}
export async function joinedInstall(flags, deps, output, authorize, management) {
    if (flags.has('accept-scanner'))
        flags.set('accept-indexing', true);
    const json = flags.has('json');
    const input = deps.input ?? process.stdin;
    const interactive = Boolean(input.isTTY);
    const ownsTerminal = interactive && typeof input.setRawMode === 'function';
    const automatic = json || flags.has('non-interactive') || !interactive;
    let components = String(flags.get('components') ?? (flags.has('without-scanner') ? 'hooks,mcp' : 'hooks,mcp,scanner')).split(',');
    if (flags.has('without-scanner'))
        components = components.filter((c) => c !== 'scanner');
    let scanner = components.includes('scanner');
    let names = flags.has('hosts') ? String(flags.get('hosts')).split(',') : [];
    let editorChoiceOffered = false;
    if (components.some((c) => !['hooks', 'mcp', 'scanner'].includes(c)) ||
        names.some((h) => !launchHosts.includes(h))) {
        output.error(`Invalid hosts or components. Launch hosts: ${launchHosts.join(', ')}.`);
        return 2;
    }
    if (automatic || flags.has('hosts') || flags.has('components')) {
        const required = [
            scanner ? 'accept-indexing' : 'accept-limited',
            'apply',
            ...(automatic && scanner ? ['scan-roots'] : []),
        ];
        for (const flag of required)
            if (!flags.has(flag)) {
                if (json)
                    output.json({
                        status: 'action_required',
                        reason: 'consent_required',
                        flag: `--${flag}`,
                        action: `Rerun with --${flag}`,
                    });
                else
                    output.error(`Missing required consent flag: --${flag}`);
                return 3;
            }
    }
    const home = deps.home ?? homedir();
    let cwd = deps.cwd ?? process.cwd();
    let answers;
    let stopped = false;
    const interrupt = (signal) => {
        if (stopped)
            return;
        stopped = true;
        output.line(INSTALLATION_STOPPED);
        answers?.close();
        const repeat = globalThis.setImmediate(() => process.kill(process.pid, signal));
        repeat.unref();
    };
    const interruptBySigint = () => interrupt('SIGINT');
    const interruptByHangup = () => interrupt('SIGHUP');
    let automaticSignals = false;
    const closeInteraction = () => {
        answers?.close();
        answers = undefined;
        if (automaticSignals) {
            process.off('SIGINT', interruptBySigint);
            process.off('SIGHUP', interruptByHangup);
            automaticSignals = false;
        }
    };
    let activeProgress;
    const startProgress = (text) => {
        activeProgress?.stop();
        activeProgress = json ? undefined : stepProgress(output, interactive, text);
    };
    const completeProgress = (text) => {
        activeProgress?.complete(completedLine(text));
        activeProgress = undefined;
    };
    const stateDir = deps.hostManagement?.stateDir ??
        deps.installStateDir ??
        stateDirectory(process.platform, process.env, home);
    const openInteraction = () => {
        if (answers || automaticSignals)
            return;
        if (!automatic)
            answers = journeyAnswers(input, output, { interrupt });
        else {
            process.on('SIGINT', interruptBySigint);
            process.on('SIGHUP', interruptByHangup);
            automaticSignals = true;
        }
    };
    openInteraction();
    if (!automatic)
        output.beginInstallation();
    let previous;
    try {
        previous = (await interrupted(stateDir))[0];
    }
    catch (error) {
        closeInteraction();
        throw error;
    }
    if (previous?.data.joined) {
        if (automatic) {
            if (json)
                output.json({
                    status: 'ACTION_REQUIRED',
                    reason: 'interrupted_install',
                    action: 'Run mnemonik install interactively to resume or roll back.',
                });
            else
                output.error('Previous installation was interrupted. Run mnemonik install interactively to resume or roll back.');
            closeInteraction();
            return 3;
        }
        cwd = previous.data.hostRequest?.selections[0]?.projectRoot ?? previous.data.roots[0] ?? cwd;
        components = previous.data.components;
        scanner = components.includes('scanner');
        names = [...new Set(previous.data.hostRequest?.selections.map((s) => s.host) ?? [])];
    }
    const indexingSkippedPath = join(stateDir, 'indexing-skipped');
    const hasLaunchHost = (await ownership.readOwnership(stateDir)).targets.some((target) => launchHosts.includes(target.host));
    const indexingOnly = Boolean(!previous &&
        !automatic &&
        !flags.has('hosts') &&
        !flags.has('components') &&
        hasLaunchHost &&
        !(await readFile(join(stateDir, 'scanner/state.json')).then(() => true, () => false)));
    if (indexingOnly) {
        components = ['scanner'];
        scanner = true;
        names = [];
    }
    const needsDetectedEditor = !previous && !automatic && !flags.has('hosts') && !flags.has('components') && !indexingOnly;
    startProgress('Checking this computer');
    let preflight;
    try {
        preflight = await runPreflight({
            cwd,
            home,
            ...(!scanner && flags.has('components') ? { fetch: async () => new Response('{}') } : {}),
            ...(needsDetectedEditor ? { skipNetworkWithoutHosts: true } : {}),
            ...deps.preflight,
        });
        completeProgress('Computer checked');
    }
    catch (error) {
        activeProgress?.stop();
        activeProgress = undefined;
        closeInteraction();
        throw error;
    }
    if (needsDetectedEditor && !preflight.hosts.length) {
        output.installSection();
        renderNoSupportedEditors(output);
        closeInteraction();
        return 130;
    }
    const root = preflight.project.root ?? cwd;
    const logPath = join(stateDir, 'install.log');
    const log = async (detail) => {
        await mkdir(stateDir, { recursive: true, mode: 0o700 });
        await appendFile(logPath, `${JSON.stringify({ at: new Date().toISOString(), detail })}\n`, {
            mode: 0o600,
        });
    };
    let roots = String(flags.get('scan-roots') ?? previous?.data.roots.join(',') ?? '')
        .split(',')
        .filter(Boolean);
    output.setContext({ home, projectRoot: root });
    if (!names.length && !indexingOnly)
        names = preflight.hosts
            .filter((h) => h.supported)
            .map((h) => Object.keys(labels).find((key) => labels[key] === h.name) ?? '')
            .filter(Boolean);
    const replaceScreen = (lines, replacement) => {
        if (!interactive)
            return;
        output.write(`\u001b[${lines}A\r\u001b[J`);
        if (replacement)
            output.line(replacement);
    };
    const choose = async (title, choices) => {
        if (ownsTerminal)
            openInteraction();
        output.line(`  ${title}`);
        output.line('  Use the Up/Down arrow keys and Enter.');
        output.line();
        choices.forEach((c, i) => output.line(`  ${i === 0 ? '>' : ' '} ${c}`));
        output.line();
        return answers ? answers.choose(choices) : 'Skip';
    };
    let prepared;
    let scannerInstallFailed = false;
    let scannerFailureRendered = false;
    let scannerFailureAction;
    let scannerFailureMessage;
    let executor = deps.projectExecutor;
    let projectTransport = deps.projectTransport;
    let document;
    let reportFinal = async (readiness) => readiness;
    const rollbackInstall = async (journal) => {
        let scannerRestored = true;
        try {
            if (prepared)
                await prepared.rollback(journal);
            else
                await restoreScannerInstall(journal, {
                    ...deps.scannerService,
                    ...deps.scannerEnable,
                    stateDir,
                });
        }
        catch (error) {
            scannerRestored = false;
            journal.data.reports.push(`Scanner rollback needs attention: ${error.message}`);
        }
        await compensate(journal, {
            stateDir,
            projectStateDir: deps.projectStateDir ?? stateDir,
            executor: executor ?? {
                stage: async () => {
                    throw new Error('no_project');
                },
                apply: async () => {
                    throw new Error('no_project');
                },
                rollback: async () => ({
                    status: 'ACTION_REQUIRED',
                    state: 'record_missing',
                    allowedActions: [],
                }),
            },
            adapters: [],
            input: {
                account: journal.data.account,
                hosts: [],
                components,
                scopes: {},
                roots,
                credentials: [],
            },
            ui: {},
            revokeCli: async () => { },
            revokeComponent: (reference) => revokeInstallComponent(stateDir, reference, deps.scannerEnable?.fetch ?? deps.grantFetch),
        }, true);
        if (!scannerRestored) {
            journal.data.phase = 'rolling_back';
            journal.data.state = 'FAILED';
            await journal.save();
        }
    };
    let restart = false;
    try {
        if (previous?.data.joined)
            renderInterrupted(output);
        if (previous?.data.joined && (await answers?.choose(['Resume', 'Rollback'])) !== 'Resume') {
            const restored = await runHosts('install', [], {
                stateDir,
                account: previous.data.account,
                afterHosts: async () => { },
                rollbackInstall,
                recovery: async () => 'rollback',
            });
            renderRollbackResult(restored.journal.phase === 'rolled_back', output);
            return restored.journal.phase === 'rolled_back' ? 130 : 1;
        }
        if (indexingOnly) {
            const indexingLines = renderJourney('indexing', output);
            const choice = await answers?.choose(['Set up indexing', 'Cancel']);
            replaceScreen(indexingLines, choice === 'Set up indexing' ? 'Set up indexing' : undefined);
            if (choice !== 'Set up indexing')
                return 130;
        }
        else if (!previous && !automatic && !flags.has('hosts') && !flags.has('components')) {
            editorChoiceOffered = true;
            const items = [
                ...names.map((name) => ({
                    value: name,
                    label: labels[name],
                    checked: true,
                })),
                { value: 'scanner', label: 'Automatic project indexing', checked: true },
            ];
            const setupLines = renderSetup(items, output);
            const selected = await answers?.checklist(items);
            if (selected === 'Cancel' || selected === 'Back')
                return 130;
            if (selected) {
                names = selected.selected.filter((item) => item !== 'scanner');
                scanner = selected.selected.includes('scanner');
                components = scanner
                    ? [...new Set([...components, 'scanner'])]
                    : components.filter((component) => component !== 'scanner');
            }
            replaceScreen(setupLines, completedStep(1, 'Choose what to set up'));
            const chosen = [
                ...names.map((name) => labels[name]),
                ...(scanner ? ['automatic project indexing'] : []),
            ];
            if (chosen.length)
                output.line(completedLine(chosen.join(', ')));
        }
        if (preflight.status !== 'ready') {
            if (!preflight.node.supported)
                for (const line of nodeVersionHelp(preflight.node.version, deps.preflight?.platform ?? process.platform))
                    output.error(line);
            if (!preflight.network.reachable) {
                output.error('Discovery could not be reached.');
                output.error(preflight.network.discoveryUrl);
                output.error(preflight.network.detail ?? 'unavailable');
            }
            throw new Error('preflight_failed');
        }
        if (!automatic && !flags.has('apply') && !indexingOnly) {
            renderJourney('account', output);
        }
        for (;;) {
            startProgress(indexingOnly ? 'Checking your account' : 'Signing in');
            try {
                await authorize();
                completeProgress(indexingOnly ? 'Account checked' : 'Signed in');
                break;
            }
            catch (error) {
                activeProgress?.stop();
                activeProgress = undefined;
                if (automatic || (await choose('Sign-in did not finish.', ['Retry', 'Skip'])) !== 'Retry')
                    throw error;
            }
        }
        if (!automatic && !indexingOnly)
            output.line(completedStep(3, 'Configure editors'));
        startProgress(indexingOnly ? 'Getting ready' : 'Configuring your editors');
        const managed = await management();
        reportFinal = async (readiness) => {
            const versions = await ownership
                .readInstallVersions(stateDir, readiness.scanner?.version ?? undefined)
                .catch(() => undefined);
            readiness = { ...readiness, platform: process.platform, ...(versions ? { versions } : {}) };
            const controller = new AbortController();
            let timer;
            try {
                await Promise.race([
                    (async () => {
                        const bearer = await managed.getCliBearer?.();
                        if (bearer) {
                            const fetcher = deps.scannerEnable?.fetch ?? deps.grantFetch ?? fetch;
                            const headers = {
                                authorization: `Bearer ${bearer}`,
                                'content-type': 'application/json',
                            };
                            let session = prepared?.session;
                            if (!session) {
                                const response = await fetcher(`${apiOrigin()}/api/v1/install-sessions/current`, {
                                    headers,
                                    signal: controller.signal,
                                });
                                if (!response.ok)
                                    throw new Error(`install_report_${response.status}`);
                                session = (await response.json());
                            }
                            const response = await fetcher(`${apiOrigin()}/api/v1/install-sessions/${session.id}/complete`, {
                                method: 'POST',
                                headers,
                                signal: controller.signal,
                                body: JSON.stringify({
                                    readiness: serializeReadiness(readiness),
                                    platform: process.platform,
                                    ...(versions ? { versions } : {}),
                                }),
                            });
                            if (!response.ok)
                                throw new Error(`install_report_${response.status}`);
                        }
                        else if (prepared)
                            await prepared.complete(serializeReadiness(readiness));
                    })(),
                    new Promise((_, reject) => {
                        timer = setTimeout(() => {
                            controller.abort();
                            reject(new Error('install_report_timeout'));
                        }, FINAL_REPORT_TIMEOUT_MS);
                    }),
                ]);
            }
            catch {
                // Final status is best effort and must not change the local result.
            }
            finally {
                clearTimeout(timer);
            }
            return readiness;
        };
        const selections = names.flatMap((host) => components
            .filter((c) => c !== 'scanner')
            .sort((a, b) => (a === b ? 0 : a === 'hooks' ? -1 : 1))
            .map((component) => ({
            host: host,
            component: component,
            scope: 'user',
            home,
            projectRoot: root,
        })));
        const afterHosts = async (journal, results, refreshHosts) => {
            completeProgress(indexingOnly
                ? 'Ready'
                : `${names.length} ${names.length === 1 ? 'editor' : 'editors'} configured`);
            journal.data.components = components;
            journal.data.roots = roots;
            const projectConditions = [];
            const projectReadiness = [];
            const linkIntents = new Map();
            const leaveProjectForPerson = (root, identityFile, state, connectedRoot) => {
                let action;
                if (state === 'duplicate_project_id' && connectedRoot)
                    action = `${basename(root)} was not connected. It belongs to the same project as ${basename(connectedRoot)}, which is already connected.`;
                else if (state === 'fingerprint_mismatch')
                    action = `${basename(root)} was not connected. Its Git remote does not match the repository this project was set up with.`;
                else
                    action = folderRefusalMessage(state, root).join(' ');
                const condition = {
                    kind: 'project_identity_choice_pending',
                    reason: `project_setup_required: ${state}: ${root}`,
                    action,
                };
                projectConditions.push(condition);
                projectReadiness.push(...(serializeReadiness({
                    installation: { conditions: [] },
                    projects: [{ identityFile, summary: { conditions: [condition] } }],
                }).projects ?? []));
            };
            const finish = async (scannerPlan) => {
                prepared = scannerPlan;
                let limitMessage;
                if (scannerPlan) {
                    startProgress('Connecting your repositories');
                    if (!executor) {
                        const runtime = await createRealProjectRuntime({
                            selectedRoots: true,
                            stateDir,
                            getCliBearer: managed.getCliBearer,
                        });
                        executor = runtime.executor;
                        projectTransport ??= runtime.transport;
                    }
                    const projectExecutor = executor;
                    if (!projectExecutor)
                        throw new Error('no_project');
                    const connectedRoots = [];
                    const limitedRoots = [];
                    const selectedRepositories = await Promise.all(scannerPlan.roots.map(async (selectedRoot) => {
                        const repo = await classifyRepository(selectedRoot);
                        const resolution = repo.state === 'existing_project'
                            ? await projectExecutor.resolveProjectIdentity(repo.path)
                            : undefined;
                        return {
                            repo,
                            resolution,
                            linkProjectId: resolution?.kind === 'ok' ? resolution.identity.projectId : undefined,
                        };
                    }));
                    const stagedRootByProject = new Map();
                    const candidateOrder = new Map();
                    const rootsByProject = new Map();
                    for (const selected of selectedRepositories) {
                        if (!selected.linkProjectId)
                            continue;
                        const roots = rootsByProject.get(selected.linkProjectId) ?? [];
                        roots.push(selected);
                        rootsByProject.set(selected.linkProjectId, roots);
                    }
                    for (const candidates of rootsByProject.values()) {
                        if (candidates.length === 1)
                            continue;
                        const ranked = await Promise.all(candidates.map(async (candidate) => {
                            const resolution = candidate.resolution;
                            const git = resolution?.kind === 'ok' && resolution.repository.kind === 'git';
                            const stored = resolution?.kind === 'ok' ? resolution.identity.repositoryFingerprint : undefined;
                            const current = git ? await repositoryFingerprint(candidate.repo.path) : null;
                            return {
                                ...candidate,
                                git,
                                fingerprintMatches: !!stored &&
                                    !!current &&
                                    stored.algorithmVersion === current.algorithmVersion &&
                                    stored.hash === current.hash,
                            };
                        }));
                        ranked.sort((left, right) => Number(right.fingerprintMatches) - Number(left.fingerprintMatches) ||
                            Number(right.git) - Number(left.git) ||
                            left.repo.path.length - right.repo.path.length ||
                            (left.repo.path < right.repo.path ? -1 : left.repo.path > right.repo.path ? 1 : 0));
                        ranked.forEach((candidate, index) => candidateOrder.set(candidate.repo.path, index));
                    }
                    // Local evidence only orders attempts. A server-validated stage reserves the UUID.
                    selectedRepositories.sort((left, right) => (candidateOrder.get(left.repo.path) ?? 0) - (candidateOrder.get(right.repo.path) ?? 0));
                    for (const { repo, linkProjectId } of selectedRepositories) {
                        const connectedRoot = linkProjectId
                            ? stagedRootByProject.get(linkProjectId)
                            : undefined;
                        if (connectedRoot) {
                            leaveProjectForPerson(repo.path, join(repo.path, '.mnemonik.json'), 'duplicate_project_id', connectedRoot);
                            continue;
                        }
                        if (linkProjectId)
                            linkIntents.set(repo.path, linkProjectId);
                        const options = {
                            cwd: repo.path,
                            allowCreate: true,
                            allowNestedInherit: false,
                            ...(linkProjectId
                                ? { intent: { action: 'link', projectId: linkProjectId } }
                                : {}),
                        };
                        const target = await journal.plan(join(repo.path, '.mnemonik.json'), null, {
                            kind: 'project',
                        });
                        await journal.event('project_stage_intent', repo.path);
                        const staged = await projectExecutor.stage(options);
                        if (staged.status !== 'staged') {
                            const message = projectLimitMessage(staged, [...limitedRoots, repo.path]);
                            await journal.restore(target);
                            if (message) {
                                limitedRoots.push(repo.path);
                                limitMessage = message.join('\n');
                                continue;
                            }
                            leaveProjectForPerson(repo.path, target.path, 'state' in staged ? staged.state : staged.status);
                            continue;
                        }
                        if (linkProjectId)
                            stagedRootByProject.set(linkProjectId, repo.path);
                        connectedRoots.push(repo.path);
                        if (!journal.data.projects.some((p) => p.root === repo.path))
                            journal.data.projects.push({ root: repo.path });
                        const record = JSON.parse(await readFile(recordPath(repo.path, deps.projectStateDir ?? stateDir), 'utf8'));
                        if (record.staged)
                            await journal.propose(target, Buffer.from(record.staged.content));
                        await journal.stage(target);
                    }
                    scannerPlan.roots.splice(0, scannerPlan.roots.length, ...connectedRoots);
                    roots = scannerPlan.roots;
                    journal.data.roots = roots;
                }
                if (!automatic && !flags.has('apply')) {
                    activeProgress?.stop();
                    activeProgress = undefined;
                    for (;;) {
                        const applyLines = renderJourney('apply', output);
                        const choice = await answers?.choose(['Install and upload', 'Back', 'Cancel']);
                        replaceScreen(applyLines);
                        if (choice === 'Back') {
                            restart = true;
                            throw new Error('install_back');
                        }
                        if (choice !== 'Install and upload')
                            throw new Error('install_cancelled');
                        break;
                    }
                    if (scannerPlan)
                        startProgress('Connecting your repositories');
                }
                journal.data.phase = 'applying';
                if (automatic)
                    startProgress('Finishing installation');
                await journal.event('apply');
                for (const project of journal.data.projects) {
                    const linkProjectId = linkIntents.get(project.root);
                    const result = await executor?.apply({
                        cwd: project.root,
                        allowCreate: true,
                        allowNestedInherit: false,
                        ...(linkProjectId
                            ? { intent: { action: 'link', projectId: linkProjectId } }
                            : {}),
                    });
                    if (result?.status !== 'done')
                        throw new Error('project_apply_failed');
                    project.uuid = result.projectId;
                    const target = journal.data.targets.find((t) => t.path === join(project.root, '.mnemonik.json'));
                    if (target) {
                        target.status = 'committed';
                        await journal.event('committed', target.id);
                    }
                }
                let scannerDocument;
                if (scannerPlan) {
                    try {
                        // sudo must own a cooked, unread terminal, including Ctrl+C.
                        // Keep buffered non-TTY fixture/input readers intact.
                        if (ownsTerminal) {
                            activeProgress?.stop();
                            closeInteraction();
                        }
                        try {
                            scannerDocument = await scannerPlan.apply(journal, scannerPlan.roots);
                        }
                        finally {
                            if (ownsTerminal)
                                openInteraction();
                        }
                        await rm(indexingSkippedPath, { force: true });
                        if (!json) {
                            if (scannerPlan.roots.length) {
                                completeProgress(`Connected ${scannerPlan.roots.length} ${scannerPlan.roots.length === 1 ? 'repository' : 'repositories'}.`);
                                output.line(`  ${ADD_ANOTHER_FOLDER}`);
                            }
                            if (limitMessage)
                                for (const line of limitMessage.split('\n'))
                                    output.line(line);
                        }
                        if (automatic)
                            startProgress('Finishing installation');
                    }
                    catch (error) {
                        if (!(error instanceof ScannerServiceLimited))
                            throw error;
                        scannerInstallFailed = true;
                        scannerFailureMessage = error.summary;
                        scannerFailureAction = error.action;
                        activeProgress?.stop();
                        activeProgress = undefined;
                        await scannerPlan.rollback(journal);
                        journal.data.reports.push(`Background indexing was skipped (${error.reason}). Run mnemonik install to try again.`);
                        if (!automatic && preflight.os === 'Windows') {
                            renderJourney('windows', output, { reason: error.message });
                            scannerFailureRendered = true;
                        }
                    }
                }
                await refreshHosts();
                if (!scannerPlan) {
                    document = devReadiness(serializeReadiness({
                        installation: {
                            conditions: [
                                ...hostReadinessConditions(results, false),
                                {
                                    kind: 'scanner_omitted',
                                    reason: 'Background indexing was omitted.',
                                    action: 'mnemonik install',
                                },
                            ],
                        },
                    }));
                    return;
                }
                const conditions = [...hostReadinessConditions(results, true), ...projectConditions];
                if (!scannerDocument)
                    conditions.push({
                        kind: 'scanner_omitted',
                        reason: 'Background indexing was skipped.',
                        action: scannerFailureAction ?? 'mnemonik install',
                    });
                const check = async () => collectStatusDocument({
                    preflight: {
                        ...preflight,
                        project: scannerPlan ? preflight.project : { resolution: 'absent' },
                    },
                    cwd: root,
                    home,
                    input: deps.input ?? process.stdin,
                    stateDir,
                    executor,
                    getCliBearer: managed.getCliBearer,
                    transport: projectTransport,
                    configuredHosts: names,
                    projectHookConditions: await hookStatusConditions(managed, components.includes('hooks')
                        ? names.filter((h) => results.some((r) => r.status === 'READY' && r.target.startsWith(`${h}:hooks:`)))
                        : []),
                    installationConditions: conditions,
                    details: deps.statusDetails,
                });
                const checked = projectConditions.length
                    ? { document: await check(), skipped: false }
                    : await waitForInstallation(check, async () => (await choose('Installation checks did not finish.', ['Retry', 'Skip'])) === 'Retry'
                        ? 'Retry'
                        : 'Skip', managed);
                document = checked.document ?? serializeReadiness({ installation: { conditions: [] } });
                if (checked.skipped)
                    document = {
                        ...document,
                        installation: {
                            state: 'LIMITED',
                            reasons: [...document.installation.reasons, 'Installation checks were skipped.'],
                            actions: [...document.installation.actions, 'mnemonik doctor'],
                        },
                    };
                document = devReadiness({
                    ...document,
                    ...(scannerDocument?.scanner ? { scanner: scannerDocument.scanner } : {}),
                    projects: [...(document.projects ?? []), ...projectReadiness],
                });
                if (document.installation.state === 'FAILED')
                    throw new Error(`installation_checks_failed: ${document.installation.reasons.join(', ')}`);
                journal.data.state = document.installation.state;
            };
            if (scanner) {
                if (!automatic)
                    renderJourney('scanner', output);
                try {
                    await prepareScanner({
                        stateDir,
                        cwd: root,
                        input: deps.input ?? process.stdin,
                        readAnswer: answers
                            ? async () => {
                                if (ownsTerminal)
                                    openInteraction();
                                return answers?.text();
                            }
                            : undefined,
                        output,
                        nonInteractive: automatic,
                        ...(roots.length ? { roots } : {}),
                        home,
                        noBrowser: flags.has('no-browser'),
                        approvalAnnounced: true,
                        exclusions: String(flags.get('exclusions') ?? '')
                            .split(',')
                            .filter(Boolean),
                        ...deps.scannerService,
                        ...deps.scannerEnable,
                        projectExecutor: executor,
                        projectStateDir: deps.projectStateDir ?? stateDir,
                        journal,
                        waiting: (phase) => {
                            if (!automatic)
                                startProgress(phase === 'service'
                                    ? 'Waiting for background indexing to start, up to 2 minutes.'
                                    : 'Waiting for indexing to begin, up to 1 minute.');
                        },
                        timeout: async () => (await choose('Background indexing did not start.', ['Retry', 'Skip'])) === 'Retry'
                            ? 'retry'
                            : 'skip',
                    }, finish);
                }
                catch (error) {
                    if (error instanceof Error &&
                        ['install_back', 'install_cancelled'].includes(error.message))
                        throw error;
                    const reason = error instanceof Error ? error.message : 'scanner_install_failed';
                    scannerInstallFailed = true;
                    if (error instanceof ScannerServiceLimited) {
                        scannerFailureMessage = error.summary;
                        scannerFailureAction = error.action;
                    }
                    activeProgress?.stop();
                    activeProgress = undefined;
                    journal.data.reports.push(`Scanner could not be installed: ${reason}`);
                    try {
                        if (prepared)
                            await prepared.rollback(journal);
                        else
                            await restoreScannerInstall(journal, {
                                ...deps.scannerService,
                                ...deps.scannerEnable,
                                stateDir,
                            });
                        for (const target of journal.data.targets.filter((t) => t.kind === 'project' && t.status !== 'committed' && t.status !== 'restored')) {
                            const projectRoot = join(target.path, '..');
                            const linkProjectId = linkIntents.get(projectRoot);
                            await executor?.rollback({
                                cwd: projectRoot,
                                allowCreate: true,
                                allowNestedInherit: false,
                                ...(linkProjectId
                                    ? { intent: { action: 'link', projectId: linkProjectId } }
                                    : {}),
                            });
                            await journal.restore(target);
                        }
                    }
                    catch (restoreError) {
                        journal.data.reports.push(`Scanner rollback needs attention: ${restoreError.message}`);
                    }
                    await refreshHosts();
                    document = devReadiness(serializeReadiness({
                        installation: {
                            conditions: [
                                ...hostReadinessConditions(results, true),
                                ...projectConditions,
                                {
                                    kind: 'scanner_not_verified',
                                    reason: `Background indexing could not be started: ${reason}`,
                                    action: scannerFailureAction ?? 'mnemonik install',
                                },
                            ],
                        },
                        projects: projectReadiness,
                    }));
                    journal.data.state = document.installation.state;
                }
            }
            else
                await finish();
            if (!automatic) {
                output.line(completedStep(5, 'Finish'));
                if (!scannerInstallFailed)
                    startProgress('Finishing installation');
            }
        };
        const result = await runHosts('install', selections, {
            ...managed,
            noBrowser: flags.has('no-browser'),
            apply: true,
            afterHosts,
            rollbackInstall,
            installPlan: { components, roots },
            recovery: async () => 'resume',
            instruction: automatic ? undefined : (text) => output.line(text),
        }, false);
        if (restart && result.journal.phase === 'rolled_back') {
            activeProgress?.stop();
            activeProgress = undefined;
            answers?.close();
            output.line('  Restored this run. Review your settings again.');
            return joinedInstall(flags, deps, output, authorize, management);
        }
        const launcherOptions = { ...deps.launcher, home, stateDir };
        let launcherError;
        const launcher = result.journal.phase === 'complete' && result.journal.state !== 'FAILED'
            ? await ensureLauncher(launcherOptions).catch((error) => {
                if (!(error instanceof LauncherError))
                    throw error;
                launcherError = error;
                return error.launcher;
            })
            : undefined;
        let final = document ??
            devReadiness(serializeReadiness({
                installation: { state: result.journal.state, reasons: result.reports, actions: [] },
            }));
        if (result.journal.state === 'FAILED')
            final.installation = {
                state: 'FAILED',
                reasons: result.reports,
                actions: ['mnemonik install'],
            };
        if (launcherError)
            final.installation = {
                state: 'ACTION_REQUIRED',
                reasons: [...final.installation.reasons, launcherError.message],
                actions: [...final.installation.actions, launcherError.launcher.action],
            };
        final = await reportFinal({ ...final, ...(launcher ? { launcher } : {}) });
        await log({ preflight, journal: result.journal, targets: result.results, readiness: final });
        if (!scanner && result.journal.state !== 'FAILED')
            await atomicWrite(indexingSkippedPath, Buffer.from('indexing was skipped\n'));
        completeProgress('Installation finished');
        const configuredTargets = indexingOnly || editorChoiceOffered || names.length
            ? []
            : (await ownership.readOwnership(stateDir)).targets;
        const selectedHosts = names.filter((name) => launchHosts.includes(name));
        const authorizationHosts = indexingOnly
            ? []
            : selectedHosts.length
                ? selectedHosts
                : launchHosts.filter((host) => configuredTargets.some((target) => target.host === host));
        if (json)
            output.json({
                ...final,
                status: launcherError ? 'ACTION_REQUIRED' : result.journal.state,
                targets: result.results,
                reports: result.reports,
                runId: result.journal.runId,
                phase: result.journal.phase,
            });
        else {
            output.installSection();
            if (result.journal.state === 'FAILED') {
                output.line(`  Installation failed. Details: ${logPath}`);
            }
            else if (!scanner) {
                renderJourney('indexing_skipped', output, { hosts: authorizationHosts });
                for (const action of new Set(final.installation.actions))
                    if (action !== 'mnemonik install' && action !== launcherError?.launcher.action)
                        output.line(`  ${action}`);
            }
            else if (scannerInstallFailed) {
                if (!scannerFailureRendered)
                    renderJourney('scanner_failed', output, {
                        hosts: authorizationHosts,
                        action: scannerFailureAction,
                        scannerFailureMessage,
                    });
                else
                    renderJourney('authorization', output, { hosts: authorizationHosts });
            }
            else if (final.installation.state === 'READY')
                renderJourney(indexingOnly ? 'indexing_done' : 'done', output, {
                    total: final.indexing?.total,
                    completed: final.indexing?.completed,
                    hosts: authorizationHosts,
                });
            else
                renderJourney('skipped', output, {
                    remaining: remainingReadinessCount(final.installation),
                    skipped: [...new Set(final.installation.actions)].join('\n') || 'mnemonik status',
                    hosts: authorizationHosts,
                });
            if (launcherError)
                output.line(`  ${launcherError.launcher.action}`);
            else if (launcher && !launcher.onPath)
                output.line(`  ${launcherPathAction(launcherOptions)}`);
        }
        return result.journal.state === 'FAILED'
            ? 1
            : result.journal.phase === 'rolled_back'
                ? 130
                : final.installation.state === 'READY'
                    ? 0
                    : 3;
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : 'install_failed';
        if (reason === 'install_cancelled') {
            activeProgress?.stop();
            activeProgress = undefined;
            output.line('  Installation cancelled.');
            return 130;
        }
        if (!activeProgress)
            startProgress('Finishing installation');
        await reportFinal(serializeReadiness({
            installation: {
                state: 'ACTION_REQUIRED',
                reasons: [reason],
                actions: ['mnemonik install'],
            },
        }));
        if (json)
            output.json({
                status: 'ACTION_REQUIRED',
                reason,
                ...(error instanceof LauncherError ? { launcher: error.launcher } : {}),
            });
        else {
            await log({ error: reason }).catch(() => undefined);
            activeProgress?.stop();
            activeProgress = undefined;
            if (!automatic)
                output.installSection();
            output.error(`Installation stopped. Details: ${logPath}`);
        }
        return 3;
    }
    finally {
        activeProgress?.stop();
        closeInteraction();
    }
}
//# sourceMappingURL=journey.js.map