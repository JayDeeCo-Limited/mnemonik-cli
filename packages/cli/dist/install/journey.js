import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { apiOrigin, remainingReadinessCount, serializeReadiness, } from '@mnemonik/shared';
import { recordPath, stateDirectory } from '@mnemonik/local-setup';
import { nodeVersionHelp, runPreflight } from '../preflight.js';
import { connectedProjectsMessage, createRealProjectRuntime, projectLimitMessage, } from '../project.js';
import { classifyRepository } from '../scanner/discover.js';
import { prepareScanner, restoreScannerInstall } from '../scanner/enable.js';
import { ScannerServiceLimited } from '../scanner/service.js';
import { collectStatusDocument } from '../status.js';
import { devReadiness } from '../runtime/releaseSource.js';
import { completedStep, completedLine, renderCustomize, renderJourney, journeyAnswers, } from '../screens/journey.js';
import { interrupted } from './journal.js';
import { runHosts, hookStatusConditions, } from './hosts.js';
import { compensate, revokeInstallComponent } from './transaction.js';
import * as ownership from './ownership.js';
import { ensureLauncher, launcherPathAction, LauncherError } from '../launcher.js';
const labels = { 'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor', grok: 'Grok' };
const launchHosts = ['claude-code', 'codex', 'cursor', 'grok'];
const notOfferedHosts = ['vscode-copilot'];
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
    const automatic = json || flags.has('non-interactive');
    let components = String(flags.get('components') ?? (flags.has('without-scanner') ? 'hooks,mcp' : 'hooks,mcp,scanner')).split(',');
    if (flags.has('without-scanner'))
        components = components.filter((c) => c !== 'scanner');
    let scanner = components.includes('scanner');
    let names = flags.has('hosts') ? String(flags.get('hosts')).split(',') : [];
    if (components.some((c) => !['hooks', 'mcp', 'scanner'].includes(c)) ||
        names.some((h) => !launchHosts.includes(h))) {
        output.error(`Invalid hosts or components. Launch hosts: ${launchHosts.join(', ')}. Not offered at launch: ${notOfferedHosts.join(', ')}.`);
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
    const stateDir = deps.hostManagement?.stateDir ??
        deps.installStateDir ??
        stateDirectory(process.platform, process.env, home);
    const previous = (await interrupted(stateDir))[0];
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
            return 3;
        }
        cwd = previous.data.hostRequest?.selections[0]?.projectRoot ?? previous.data.roots[0] ?? cwd;
        components = previous.data.components;
        scanner = components.includes('scanner');
        names = [...new Set(previous.data.hostRequest?.selections.map((s) => s.host) ?? [])];
    }
    const preflight = await runPreflight({
        cwd,
        home,
        ...(!scanner && flags.has('components') ? { fetch: async () => new Response('{}') } : {}),
        ...deps.preflight,
    });
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
    if (!names.length)
        names = preflight.hosts
            .filter((h) => h.supported)
            .map((h) => Object.keys(labels).find((key) => labels[key] === h.name) ?? '')
            .filter(Boolean);
    const answers = automatic ? undefined : journeyAnswers(deps.input ?? process.stdin, output);
    const interactive = Boolean((deps.input ?? process.stdin).isTTY);
    const replaceScreen = (lines, replacement) => {
        if (!interactive)
            return;
        output.write(`\u001b[${lines}A\r\u001b[J`);
        if (replacement)
            output.line(replacement);
    };
    const choose = async (title, choices) => {
        output.line(`  ${title}`);
        output.line('  Use the Up/Down arrow keys and Enter.');
        output.line();
        choices.forEach((c, i) => output.line(`  ${i === 0 ? '>' : ' '} ${c}`));
        output.line();
        return answers ? answers.choose(choices) : 'Skip';
    };
    let prepared;
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
        if (previous?.data.joined &&
            (await choose('Previous installation was interrupted.', ['Resume', 'Rollback'])) !== 'Resume') {
            const restored = await runHosts('install', [], {
                stateDir,
                account: previous.data.account,
                afterHosts: async () => { },
                rollbackInstall,
                recovery: async () => 'rollback',
            });
            output.line(`  Local rollback: ${restored.journal.phase}.`);
            for (const report of restored.reports)
                output.line(`  ${report}`);
            return restored.journal.phase === 'rolled_back' ? 130 : 1;
        }
        if (!previous && !automatic && !flags.has('hosts') && !flags.has('components')) {
            for (;;) {
                const recommendedLines = renderJourney('recommended', output, {
                    hosts: names.map((h) => labels[h]),
                    project: root,
                    node: preflight.node.version,
                    os: preflight.os,
                });
                const choice = flags.has('customize')
                    ? 'Customize'
                    : await answers?.choose(['Recommended', 'Customize']);
                if (choice === 'Cancel')
                    return 130;
                if (choice !== 'Customize') {
                    replaceScreen(recommendedLines, completedStep(1, 'Recommended setup selected'));
                    break;
                }
                const items = [
                    ...names.map((name) => ({
                        value: name,
                        label: labels[name],
                        checked: true,
                    })),
                    { value: 'scanner', label: 'Indexing of your projects', checked: scanner },
                ];
                replaceScreen(recommendedLines);
                const customizeLines = renderCustomize(items, output);
                const customized = await answers?.customize(items);
                if (customized === 'Cancel')
                    return 130;
                if (customized === 'Back') {
                    replaceScreen(customizeLines);
                    if (flags.has('customize'))
                        return 130;
                    continue;
                }
                if (customized) {
                    names = customized.selected.filter((item) => item !== 'scanner');
                    scanner = customized.selected.includes('scanner');
                    components = scanner
                        ? [...new Set([...components, 'scanner'])]
                        : components.filter((component) => component !== 'scanner');
                }
                replaceScreen(customizeLines, completedStep(1, 'Custom setup selected'));
                break;
            }
        }
        if (preflight.status !== 'ready') {
            if (!preflight.node.supported)
                for (const line of nodeVersionHelp(preflight.node.version, deps.preflight?.platform ?? process.platform))
                    output.error(line);
            if (!preflight.network.reachable)
                output.error(`Discovery ${preflight.network.discoveryUrl}: ${preflight.network.detail ?? 'unavailable'}`);
            throw new Error('preflight_failed');
        }
        if (!automatic && !flags.has('apply')) {
            renderJourney('account', output);
        }
        for (;;) {
            try {
                await authorize();
                if (!automatic)
                    output.line(completedLine('Signed in'));
                break;
            }
            catch (error) {
                if (automatic || (await choose('Sign-in did not finish.', ['Retry', 'Skip'])) !== 'Retry')
                    throw error;
            }
        }
        const managed = await management();
        reportFinal = async (readiness) => {
            const versions = await ownership
                .readInstallVersions(stateDir, readiness.scanner?.version ?? undefined)
                .catch(() => undefined);
            readiness = { ...readiness, platform: process.platform, ...(versions ? { versions } : {}) };
            try {
                const bearer = await managed.getCliBearer?.();
                if (bearer) {
                    const fetcher = deps.scannerEnable?.fetch ?? deps.grantFetch ?? fetch;
                    const headers = { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' };
                    let session = prepared?.session;
                    if (!session) {
                        const response = await fetcher(`${apiOrigin()}/api/v1/install-sessions/current`, {
                            headers,
                        });
                        if (!response.ok)
                            throw new Error(`install_report_${response.status}`);
                        session = (await response.json());
                    }
                    const response = await fetcher(`${apiOrigin()}/api/v1/install-sessions/${session.id}/complete`, {
                        method: 'POST',
                        headers,
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
            }
            catch (error) {
                const reason = `The final installation status could not be uploaded: ${error.message}`;
                readiness = {
                    ...readiness,
                    installation: {
                        state: readiness.installation.state === 'FAILED' ? 'FAILED' : 'LIMITED',
                        reasons: [...readiness.installation.reasons, reason],
                        actions: [...readiness.installation.actions, 'mnemonik install'],
                    },
                };
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
        if (!automatic)
            output.line(completedStep(3, 'Configure editors'));
        const afterHosts = async (journal, results, refreshHosts) => {
            if (!automatic)
                output.line(completedLine(`${names.length} ${names.length === 1 ? 'editor' : 'editors'} configured`));
            journal.data.components = components;
            journal.data.roots = roots;
            const projectConditions = [];
            const projectReadiness = [];
            const finish = async (scannerPlan) => {
                prepared = scannerPlan;
                let limitMessage;
                if (scannerPlan) {
                    if (!executor) {
                        const runtime = await createRealProjectRuntime({
                            stateDir,
                            getCliBearer: managed.getCliBearer,
                        });
                        executor = runtime.executor;
                        projectTransport ??= runtime.transport;
                    }
                    const connectedRoots = [];
                    for (const [rootIndex, selectedRoot] of scannerPlan.roots.entries()) {
                        const repo = await classifyRepository(selectedRoot);
                        const options = {
                            cwd: repo.path,
                            allowCreate: true,
                            allowNestedInherit: false,
                            ...(repo.nonGitSelected ? { nonGitSelected: true } : {}),
                        };
                        const target = await journal.plan(join(repo.path, '.mnemonik.json'), null, {
                            kind: 'project',
                        });
                        await journal.event('project_stage_intent', repo.path);
                        const staged = await executor.stage(options);
                        if (staged.status !== 'staged') {
                            limitMessage = projectLimitMessage(staged, scannerPlan.roots.slice(rootIndex))?.join('\n');
                            await journal.restore(target);
                            if (limitMessage)
                                break;
                            const condition = {
                                kind: 'project_identity_choice_pending',
                                reason: `project_setup_required: ${repo.path}`,
                                action: `mnemonik project init "${repo.path}"`,
                            };
                            projectConditions.push(condition);
                            projectReadiness.push(...(serializeReadiness({
                                installation: { conditions: [] },
                                projects: [{ identityFile: target.path, summary: { conditions: [condition] } }],
                            }).projects ?? []));
                            continue;
                        }
                        connectedRoots.push(repo.path);
                        if (!journal.data.projects.some((p) => p.root === repo.path))
                            journal.data.projects.push({
                                root: repo.path,
                                nonGitSelected: repo.nonGitSelected,
                            });
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
                    for (;;) {
                        const applyLines = renderJourney('apply', output, {
                            files: [],
                        });
                        const choice = await answers?.choose(['Install and upload', 'Back', 'Cancel']);
                        replaceScreen(applyLines, choice === 'Install and upload' ? completedStep(5, 'Finish') : undefined);
                        if (choice === 'Back') {
                            restart = true;
                            throw new Error('install_back');
                        }
                        if (choice !== 'Install and upload')
                            throw new Error('install_cancelled');
                        break;
                    }
                }
                journal.data.phase = 'applying';
                await journal.event('apply');
                for (const project of journal.data.projects) {
                    const result = await executor?.apply({
                        cwd: project.root,
                        allowCreate: true,
                        allowNestedInherit: false,
                        ...(project.nonGitSelected ? { nonGitSelected: true } : {}),
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
                        scannerDocument = await scannerPlan.apply(journal, scannerPlan.roots);
                        if (!json) {
                            if (scannerPlan.roots.length)
                                output.line(connectedProjectsMessage(scannerPlan.roots));
                            if (limitMessage)
                                for (const line of limitMessage.split('\n'))
                                    output.line(line);
                        }
                    }
                    catch (error) {
                        if (!(error instanceof ScannerServiceLimited))
                            throw error;
                        await scannerPlan.rollback(journal);
                        journal.data.reports.push(`Background indexing was skipped (${error.reason}). Run mnemonik install to try again.`);
                        if (!automatic && preflight.os === 'Windows')
                            renderJourney('windows', output, { reason: error.message });
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
                        action: 'mnemonik install',
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
                                output.line(phase === 'service'
                                    ? '  Waiting for background indexing to start, up to 2 minutes.'
                                    : '  Waiting for indexing to begin, up to 1 minute.');
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
                            await executor?.rollback({
                                cwd: join(target.path, '..'),
                                allowCreate: true,
                                allowNestedInherit: false,
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
                                    action: 'mnemonik install',
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
            answers?.close();
            output.line('  Restored this run. Review your settings again.');
            return joinedInstall(new Map([...flags, ['customize', true]]), deps, output, authorize, management);
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
            if (result.journal.state === 'FAILED') {
                output.line(`  Installation failed. Details: ${logPath}`);
            }
            else if (final.installation.state === 'READY')
                renderJourney('done', output, {
                    total: final.indexing?.total,
                    completed: final.indexing?.completed,
                });
            else
                renderJourney('skipped', output, {
                    remaining: remainingReadinessCount(final.installation),
                    skipped: [...new Set(final.installation.actions)].join('\n') || 'mnemonik status',
                });
            if (launcherError || (launcher && !launcher.onPath))
                output.line(`  ${launcher ? launcherPathAction(launcherOptions) : 'Run npx -y @mnemonik/cli@latest status'}`);
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
            output.line('  Installation cancelled.');
            return 130;
        }
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
            output.error(`Installation stopped. Details: ${logPath}`);
        }
        return 3;
    }
    finally {
        answers?.close();
    }
}
//# sourceMappingURL=journey.js.map