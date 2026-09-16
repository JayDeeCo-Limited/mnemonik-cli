import { access, readFile } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { apiOrigin, remainingReadinessCount, serializeReadiness, } from '@mnemonik/shared';
import { recordPath, stateDirectory } from '@mnemonik/local-setup';
import { runPreflight } from '../preflight.js';
import { createRealProjectRuntime } from '../project.js';
import { discoverRepositories } from '../scanner/discover.js';
import { prepareScanner, restoreScannerInstall } from '../scanner/enable.js';
import { ScannerServiceLimited } from '../scanner/service.js';
import { collectStatusDocument, renderStatusSummaries } from '../status.js';
import { devReadiness } from '../runtime/releaseSource.js';
import { renderJourney, journeyAnswers } from '../screens/journey.js';
import { interrupted } from './journal.js';
import { runHosts, hostNotConnectedCondition, hookStatusConditions, } from './hosts.js';
import { compensate, revokeInstallComponent } from './transaction.js';
import * as ownership from './ownership.js';
import { ensureLauncher, launcherPathAction, LauncherError } from '../launcher.js';
const labels = { 'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor', grok: 'Grok' };
const launchHosts = ['claude-code', 'codex', 'cursor'];
const notOfferedHosts = ['grok', 'vscode-copilot'];
export function hostReadinessConditions(results, scanner) {
    return results
        .filter((r) => r.status !== 'READY')
        .map((r) => {
        const host = r.target.split(':')[0];
        const notConnected = hostNotConnectedCondition(host);
        if (r.reason === notConnected.reason)
            return notConnected;
        if (r.reason === 'login_pending') {
            return {
                kind: 'login_pending',
                reason: `${labels[host]} is still connecting. Finish the sign-in in the app, then run mnemonik status.`,
                action: 'mnemonik status',
            };
        }
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
    const json = flags.has('json');
    const automatic = json || flags.has('non-interactive');
    let components = String(flags.get('components') ?? (flags.has('without-scanner') ? 'hooks,mcp' : 'hooks,mcp,scanner')).split(',');
    if (flags.has('without-scanner'))
        components = components.filter((c) => c !== 'scanner');
    let scanner = components.includes('scanner');
    let scope = String(flags.get('integration-scope') ?? 'user');
    let names = flags.has('hosts') ? String(flags.get('hosts')).split(',') : [];
    if (components.some((c) => !['hooks', 'mcp', 'scanner'].includes(c)) ||
        names.some((h) => !launchHosts.includes(h)) ||
        !['user', 'project'].includes(scope)) {
        output.error(`Invalid hosts, scope or components. Launch hosts: ${launchHosts.join(', ')}. Not offered at launch: ${notOfferedHosts.join(', ')}.`);
        return 2;
    }
    if (automatic || flags.has('hosts') || flags.has('components')) {
        const required = [
            scanner ? 'accept-scanner' : 'accept-limited',
            'apply',
            ...(automatic && scanner ? ['scan-roots'] : []),
            ...(names.length ? ['integration-scope'] : []),
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
        scope = previous.data.hostRequest?.selections[0]?.scope ?? scope;
    }
    const preflight = await runPreflight({
        cwd,
        home,
        ...(!scanner && flags.has('components') ? { fetch: async () => new Response('{}') } : {}),
        ...deps.preflight,
    });
    const root = preflight.project.root ?? cwd;
    let roots = String(flags.get('scan-roots') ?? (previous?.data.roots.join(',') || root))
        .split(',')
        .filter(Boolean);
    output.setContext({ home, projectRoot: root });
    if (!names.length)
        names = preflight.hosts
            .filter((h) => h.supported && h.name !== 'Grok')
            .map((h) => Object.keys(labels).find((key) => labels[key] === h.name) ?? '')
            .filter(Boolean);
    const answers = automatic ? undefined : journeyAnswers(deps.input ?? process.stdin);
    const choose = async (title, choices) => {
        output.line(`  ${title}`);
        choices.forEach((c, i) => output.line(`  ${i === 0 ? '>' : ' '} ${c}`));
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
            renderJourney('recommended', output, {
                hosts: names.map((h) => labels[h]),
                project: root,
                node: preflight.node.version,
                os: preflight.os,
            });
            for (const host of preflight.hosts.filter((h) => !h.supported || h.name === 'Grok'))
                output.line(`  ${host.name} (not offered at launch)`);
            if (!deps.preflight &&
                (await access(join(home, '.vscode')).then(() => true, () => false)))
                output.line('  VS Code Copilot (not offered at launch)');
            const choice = flags.has('customize')
                ? 'Customize'
                : await answers?.choose(['Recommended', 'Customize']);
            if (choice === 'Cancel')
                return 130;
            if (choice === 'Customize') {
                output.line('  Customize settings (press Enter to keep each value)');
                output.line(`  Components: ${components.join(',')}`);
                components = ((await answers?.text()) || components.join(',')).split(',');
                output.line(`  Editors: ${names.join(',')}`);
                names = ((await answers?.text()) || names.join(',')).split(',');
                output.line(`  Scope: ${scope} (user or project)`);
                scope = (await answers?.text()) || scope;
                output.line(`  Roots: ${roots.join(',')}`);
                roots = ((await answers?.text()) || roots.join(',')).split(',');
                if (components.some((c) => !['hooks', 'mcp', 'scanner'].includes(c)) ||
                    names.some((h) => !launchHosts.includes(h)) ||
                    !['user', 'project'].includes(scope))
                    throw new Error('invalid_settings');
                scanner = components.includes('scanner');
            }
        }
        if (preflight.status !== 'ready') {
            if (!preflight.node.supported)
                output.error(`Node ${preflight.node.version} found; Node 24 or newer is required.`);
            if (!preflight.network.reachable)
                output.error(`Discovery ${preflight.network.discoveryUrl}: ${preflight.network.detail ?? 'unavailable'}`);
            throw new Error('preflight_failed');
        }
        if (!automatic && !flags.has('apply')) {
            renderJourney('account', output);
            renderJourney('cli_approval', output);
        }
        for (;;) {
            try {
                await authorize();
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
            scope: scope,
            home,
            projectRoot: root,
        })));
        if (!previous && !automatic && !flags.has('apply') && selections.length) {
            renderJourney('host_approvals', output, {
                hosts: names.map((h) => labels[h]),
            });
            if ((await answers?.choose(['Connect them', 'Cancel'])) !== 'Connect them')
                return 130;
        }
        const afterHosts = async (journal, results, refreshHosts) => {
            journal.data.components = components;
            journal.data.roots = roots;
            const projectConditions = [];
            const projectReadiness = [];
            const finish = async (scannerPlan) => {
                prepared = scannerPlan;
                if (scannerPlan) {
                    if (!executor) {
                        const runtime = await createRealProjectRuntime({
                            stateDir,
                            getCliBearer: managed.getCliBearer,
                        });
                        executor = runtime.executor;
                        projectTransport ??= runtime.transport;
                    }
                    for (const selectedRoot of scannerPlan.roots) {
                        const discovered = await discoverRepositories(selectedRoot);
                        for (const repo of discovered.repositories.filter((r) => !scannerPlan.exclusions.some((e) => r.path === e ||
                            (!relative(e, r.path).startsWith('..') && !isAbsolute(relative(e, r.path)))))) {
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
                                await journal.restore(target);
                                continue;
                            }
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
                    }
                }
                if (!automatic && !flags.has('apply')) {
                    for (;;) {
                        renderJourney('apply', output, {
                            connected: results.every((r) => r.status === 'READY'),
                            files: [
                                ...new Set(journal.data.targets.filter((t) => t.status !== 'restored').map((t) => t.path)),
                                ...(scannerPlan?.files ?? []),
                            ],
                        });
                        const choice = await answers?.choose(['Install and upload', 'Back', 'Cancel']);
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
                        scannerDocument = await scannerPlan.apply(journal);
                        if (!automatic)
                            output.line('  ✓ Scanner connected');
                    }
                    catch (error) {
                        if (!(error instanceof ScannerServiceLimited))
                            throw error;
                        await scannerPlan.rollback(journal);
                        journal.data.reports.push(`Scanner was skipped (${error.reason}). Run mnemonik scanner enable to try again.`);
                        if (!automatic && process.platform === 'win32')
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
                                    reason: 'Scanner was omitted.',
                                    action: 'mnemonik scanner enable',
                                },
                            ],
                        },
                    }));
                    return;
                }
                if (!automatic)
                    output.line('  Checking your installation, up to 2 minutes.');
                const conditions = [...hostReadinessConditions(results, true), ...projectConditions];
                if (!scannerDocument)
                    conditions.push({
                        kind: 'scanner_omitted',
                        reason: 'Scanner was skipped.',
                        action: 'mnemonik scanner enable',
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
                    grants: managed.grants,
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
                if (!automatic && document.installation.state === 'READY')
                    output.line('  ✓ Checks passed');
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
                        roots,
                        noBrowser: flags.has('no-browser'),
                        exclusions: String(flags.get('exclusions') ?? '')
                            .split(',')
                            .filter(Boolean),
                        ...deps.scannerService,
                        ...deps.scannerEnable,
                        journal,
                        waiting: (phase) => {
                            if (!automatic)
                                output.line(phase === 'service'
                                    ? '  Waiting for the scanner service to start, up to 2 minutes.'
                                    : '  Waiting for the first scanner heartbeat, up to 1 minute.');
                        },
                        timeout: async () => (await choose('Scanner did not connect.', ['Retry', 'Skip'])) === 'Retry'
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
                                    reason: `Scanner could not be installed: ${reason}`,
                                    action: 'mnemonik scanner enable',
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
            approveHost: managed.approveHost ?? (async () => true),
            apply: true,
            afterHosts,
            rollbackInstall,
            installPlan: { components, roots },
            recovery: async () => 'resume',
            instruction: automatic ? undefined : (text) => output.line(text),
            timeout: managed.timeout ??
                (automatic
                    ? undefined
                    : async (host) => (await choose(`${host} has not connected yet.`, ['Retry', 'Skip'])) === 'Retry'
                        ? 'retry'
                        : 'skip'),
        }, flags.has('integration-scope'));
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
            renderStatusSummaries(final, output);
            for (const target of result.results)
                output.line(`${target.target}: ${target.status} (${target.reason}${target.detail ? `: ${target.detail}` : ''})`);
            if (result.journal.state === 'FAILED') {
                output.line(`  Installation failed. Local rollback: ${result.journal.phase}.`);
                for (const line of result.reports)
                    output.line(`  ${line}`);
            }
            else if (final.installation.state === 'READY')
                renderJourney('done', output, {
                    total: final.indexing?.total,
                    completed: final.indexing?.completed,
                });
            else
                renderJourney('skipped', output, {
                    remaining: remainingReadinessCount(final.installation),
                    skipped: [...final.installation.reasons, ...final.installation.actions].join(' '),
                });
            output.line(`  Status and devices: ${apiOrigin().replace('://api.mnemonik.dev', '://app.mnemonik.ai').replace('://mnemonik-api.', '://mnemonik-app.')}/settings/devices`);
            if (!launcherError && launcher?.onPath)
                output.line('  On this machine: mnemonik status');
            else {
                if (launcher && !launcher.onPath)
                    output.line(`  ${launcherPathAction(launcherOptions)}`);
                output.line('  In this terminal: npx -y @mnemonik/cli@latest status');
            }
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
        else
            output.error(reason);
        return 3;
    }
    finally {
        answers?.close();
    }
}
//# sourceMappingURL=journey.js.map