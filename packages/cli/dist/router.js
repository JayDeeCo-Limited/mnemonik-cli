import { humanReason, humanReport, humanIdentityState } from './humanReason.js';
import { enableScanner, updateScannerRoots } from './scanner/enable.js';
import { controlScanner, scannerReceipt } from './scanner/control.js';
import { updateScanner } from './scanner/update.js';
import { deleteScannerIndex } from './scanner/data.js';
import { devReadiness } from './runtime/releaseSource.js';
import { scannerService, ScannerServiceLimited, } from './scanner/service.js';
import { stateDirectory } from '@mnemonik/local-setup';
import { isCredentialSessionUnavailableError } from '@mnemonik/credentials';
import { runHosts, hostSource, codexTrustConditions, logoutHost, selectOwned, } from './install/hosts.js';
import { hostOrder, launchHostLabels } from './install/adapters.js';
import { readInstallVersions } from './install/ownership.js';
import { ensureLauncher, removeLauncher, LauncherError } from './launcher.js';
import { readFile, realpath } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { RuntimeStore, updateRuntime } from './runtime/store.js';
import { updateCli, cliUpdateHint } from './runtime/selfUpdate.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Output } from './output.js';
import { SCANNER_RESTART_MESSAGE } from './scanner/service.js';
import { SCANNER_FAILURE_MESSAGE, SCANNER_RETRY_MESSAGE } from './screens/journey.js';
import { renderPreflight, runPreflight } from './preflight.js';
import { postCurrentReadiness } from './installSession.js';
import { createRealProjectRuntime, ensureProjectRoot, ensureProjectForAgent, folderRefusalMessage, projectLimitMessage, runProjectCommand, } from './project.js';
import { evaluateRoot } from './project/eligibility.js';
import { apiOrigin, describeReadiness, serializeReadiness as baseReadiness, } from '@mnemonik/shared';
import { grantTransport, grantHost } from './auth/status.js';
import { createCliAuth } from './auth/index.js';
import { currentInstallSession, ensureInstallSession } from './auth/installSession.js';
import { runIdentityMigration } from './identity/migrate.js';
import { renderScannerStatus } from './scanner/picker.js';
import { abandonInterrupted, interrupted } from './install/journal.js';
import { installFailureReason, runInstall, } from './install/transaction.js';
import { chooseHostProfile, simulatedInstall, terminalInstallUI } from './install/ui.js';
import { CODEX_TRUST_MESSAGE, collectStatusDocument, localEditorStatus, localInstallationConditions, mcpTurnOnAction, renderStatusSummaries, statusExitCode, } from './status.js';
import { editorAuthorizationRows } from './screens/journey.js';
import { DiagnosticsError, previewDiagnostics, sendDiagnostics, } from './diagnostics.js';
export const connectFolderPrompt = (name) => `Connect ${name} to Mnemonik? [Y/n]`;
export const removeFolderPrompt = (name) => `Stop indexing ${name}? Its memories stay in your account. [y/N]`;
export const connectedFolderLine = (name) => `  ✓ Connected ${name}.`;
export const removedFolderLine = (name) => `  ✓ ${name} is no longer connected.`;
export function maintenanceExitCode(results) {
    if (results.some((result) => result.status === 'FAILED'))
        return 1;
    return results.every((result) => result.status === 'READY') ? 0 : 3;
}
async function retryUpdateOnce(update, failed = () => false) {
    try {
        const result = await update();
        return failed(result) ? update() : result;
    }
    catch {
        return update();
    }
}
function hostUpdateFailed(result) {
    return result.results.some((target) => target.status !== 'READY' && target.reason !== 'codex_trust_pending');
}
const updateFailureMessage = 'Mnemonik could not update. It will try again automatically tomorrow.';
const booleans = new Set([
    'json',
    'non-interactive',
    'agent',
    'accept-scanner',
    'accept-indexing',
    'accept-limited',
    'apply',
    'confirm',
    'without-scanner',
    'non-git',
    'confirm-mismatch',
    'replace',
    'no-browser',
    'report',
    'backup',
    'verify',
    'dry-run',
    'reopen-install',
    'automatic',
]);
const values = new Set([
    'components',
    'hosts',
    'scan-roots',
    'host',
    'scope',
    'component',
    'owner',
    'rollback',
    'out',
    'project',
    'exclusions',
]);
export const help = `Usage: mnemonik <command> [options]

Commands:
  install
  status
  connect <${hostOrder.join('|')}>
  project <init|setup|status|link|ensure>
  add <folder>
  remove <folder>
  data delete --project <id>
  diagnostics <preview|send>
  doctor
  repair
  update
  uninstall
  auth login
  auth status
  auth logout [--host <host>] [--confirm]
  logout

Global options: --json --non-interactive --no-browser --help --version
Install consent: --accept-indexing --accept-limited --apply`;
function parse(args) {
    const positionals = [];
    const flags = new Map();
    for (let index = 0; index < args.length; index++) {
        const argument = args[index] ?? '';
        if (!argument.startsWith('--')) {
            positionals.push(argument);
            continue;
        }
        const [rawName, inline] = argument.slice(2).split('=', 2);
        const name = rawName ?? '';
        if (name === 'help' || name === 'version') {
            flags.set(name, true);
            continue;
        }
        if (booleans.has(name)) {
            if (inline !== undefined)
                return { positionals, flags, error: `Unknown flag: ${argument}` };
            flags.set(name === 'accept-scanner' ? 'accept-indexing' : name, true);
            continue;
        }
        if (values.has(name)) {
            const value = inline ?? args[++index];
            if (!value || value.startsWith('--'))
                return { positionals, flags, error: `Missing value for flag: --${name}` };
            flags.set(name, value);
            continue;
        }
        return { positionals, flags, error: `Unknown flag: ${argument}` };
    }
    return { positionals, flags };
}
function allowed(parsed, names) {
    const permitted = new Set(['json', 'non-interactive', 'no-browser', 'help', ...names]);
    for (const name of parsed.flags.keys())
        if (!permitted.has(name))
            return `Unknown flag: --${name}`;
    return undefined;
}
function actionRequired(output, json, message, flag) {
    if (json)
        output.json({
            status: 'action_required',
            reason: 'consent_required',
            ...(flag ? { flag } : {}),
            action: message,
        });
    else
        output.error(flag
            ? `Missing required consent flag: ${flag}`
            : /^[a-z][a-z0-9_]*$/u.test(message)
                ? humanReason(message)
                : message);
    return 3;
}
function requireConsent(parsed, output, required) {
    for (const flag of required) {
        if (!parsed.flags.has(flag))
            return actionRequired(output, parsed.flags.has('json'), `Rerun with --${flag}`, `--${flag}`);
    }
    return undefined;
}
function placeholder(output, json, command, owner) {
    const result = { status: 'not_implemented', command, owner };
    if (json)
        output.json(result);
    else
        output.line(`${command}: not available in this build (${owner}).`);
    return 3;
}
function auth(deps, output, noBrowser) {
    return (deps.cliAuth ??
        createCliAuth({
            stateDir: deps.installStateDir,
            noBrowser,
            print: (line) => output.line(line),
        }));
}
async function ensureCliAuth(deps, output, noBrowser, showIdentity = true) {
    const cliAuth = auth(deps, output, noBrowser);
    let bearer = await cliAuth.getCliBearer().catch((error) => {
        if (isCredentialSessionUnavailableError(error))
            return { status: 'ACTION_REQUIRED', reason: error.reason };
        throw error;
    });
    if (typeof bearer !== 'string') {
        await cliAuth.signIn();
        bearer = await cliAuth.getCliBearer();
    }
    if (typeof bearer !== 'string')
        throw new Error(bearer.reason);
    if (showIdentity && cliAuth.accountEmail)
        output.signedIn(await cliAuth.accountEmail(bearer));
    return bearer;
}
async function hostDependencies(deps, output, state) {
    if (deps.hostManagement)
        return deps.hostManagement;
    const cliAuth = auth(deps, output, false);
    const grants = grantTransport(async () => {
        const bearer = await cliAuth.getCliBearer();
        if (typeof bearer !== 'string')
            throw new Error(bearer.reason);
        return bearer;
    }, deps.grantFetch);
    const bearer = await cliAuth.getCliBearer();
    if (typeof bearer !== 'string')
        throw new Error(bearer.reason);
    if (!cliAuth.accountEmail)
        throw new Error('account_identity_failed');
    const email = await cliAuth.accountEmail(bearer);
    const installation = JSON.parse(await readFile(join(state, 'installation.json'), 'utf8').catch(() => '{}'));
    return {
        stateDir: state,
        account: typeof installation.account === 'string' ? installation.account : email,
        grants,
        getCliBearer: async () => {
            const bearer = await cliAuth.getCliBearer();
            if (typeof bearer !== 'string')
                throw new Error(bearer.reason);
            return bearer;
        },
        credentialFetch: deps.grantFetch,
    };
}
async function updateHostDependencies(deps, state) {
    if (deps.hostManagement)
        return { ...deps.hostManagement, stateDir: state };
    const installation = JSON.parse(await readFile(join(state, 'installation.json'), 'utf8').catch(() => '{}'));
    return {
        stateDir: state,
        account: typeof installation.account === 'string' ? installation.account : '',
    };
}
async function packageVersion() {
    const contents = await readFile(new URL('../package.json', import.meta.url), 'utf8');
    return JSON.parse(contents).version;
}
async function runHostCommand(command, parsed, deps, output, scannerSelected = false) {
    const json = parsed.flags.has('json');
    const state = deps.hostManagement?.stateDir ??
        deps.installStateDir ??
        stateDirectory(process.platform, process.env, deps.home);
    const scope = command === 'install' ? undefined : parsed.flags.get('scope');
    const host = parsed.flags.get('host');
    const component = parsed.flags.get('component');
    const fullUninstall = command === 'uninstall' && !host && !scope && !component;
    if ((scope && !['user', 'project'].includes(String(scope))) ||
        (host && !hostOrder.includes(host)) ||
        (component && !['hooks', 'mcp'].includes(String(component))))
        return (output.error('Invalid host, scope or component'), 2);
    if (command === 'uninstall')
        await abandonInterrupted(state);
    let selections;
    if (command === 'install') {
        const names = String(parsed.flags.get('hosts') ?? hostOrder.join(',')).split(',');
        if (names.some((name) => !hostOrder.includes(name)))
            return (output.error('Invalid hosts'), 2);
        const components = String(parsed.flags.get('components') ?? 'hooks,mcp').split(',');
        if (components.some((c) => !['hooks', 'mcp'].includes(c)))
            return placeholder(output, json, 'install scanner', 'scanner setup');
        const missing = requireConsent(parsed, output, [
            ...(scannerSelected ? [] : ['accept-limited']),
            'apply',
        ]);
        if (missing !== undefined)
            return missing;
        await ensureCliAuth(deps, output, parsed.flags.has('no-browser'), false);
        selections = [...new Set(names)].flatMap((name) => [...new Set(components)].map((component) => ({
            component: component,
            host: name,
            scope: 'user',
            home: deps.home ?? homedir(),
            projectRoot: deps.cwd ?? process.cwd(),
        })));
    }
    else {
        const resolved = await selectOwned(state, host ? String(host) : undefined, scope ? String(scope) : undefined, component ? String(component) : undefined);
        resolved.selected = resolved.selected.filter((target) => hostOrder.includes(target.host));
        resolved.ambiguous = resolved.ambiguous.filter((profile) => resolved.selected.some((target) => target.profilePath === profile));
        if (command === 'update')
            resolved.selected = resolved.selected.filter((target) => target.component === 'hooks');
        if (resolved.ambiguous.length && !json && !parsed.flags.has('non-interactive')) {
            const profile = await chooseHostProfile(deps.input ?? process.stdin, output, resolved.ambiguous);
            if (!profile)
                return actionRequired(output, false, 'Select one recorded host profile.');
            resolved.selected = resolved.selected.filter((t) => t.profilePath === profile);
        }
        else if (resolved.ambiguous.length) {
            if (json)
                output.json({
                    status: 'ACTION_REQUIRED',
                    reason: 'ambiguous_profile',
                    profiles: resolved.ambiguous,
                });
            else
                output.line(`ACTION_REQUIRED: ambiguous profiles: ${resolved.ambiguous.join(', ')}`);
            return 3;
        }
        selections = resolved.selected;
        if ((host || scope || component) && !selections.length && !(await interrupted(state)).length) {
            if (json)
                output.json({
                    status: 'ACTION_REQUIRED',
                    reason: 'no_recorded_targets',
                    targets: [],
                });
            else
                output.line('No recorded host targets.');
            return 3;
        }
    }
    try {
        const launcherOptions = { ...deps.launcher, home: deps.home, stateDir: state };
        if (command === 'update')
            await retryUpdateOnce(() => ensureLauncher(launcherOptions));
        else if (command === 'repair')
            await ensureLauncher(launcherOptions);
        const all = command === 'update' && !host && !component;
        const store = new RuntimeStore(state);
        const cli = all
            ? await retryUpdateOnce(() => updateCli(store), (result) => result.status === 'FAILED')
            : undefined;
        const updatedCli = selections.length && (cli?.status === 'UPDATED' || cli?.status === 'UP_TO_DATE')
            ? await retryUpdateOnce(() => store.verifyRuntime('cli'))
            : undefined;
        const managed = selections.length || (await interrupted(state)).length
            ? command === 'update'
                ? await retryUpdateOnce(() => updateHostDependencies(deps, state))
                : await hostDependencies(deps, output, state)
            : undefined;
        const maintainHosts = (dependencies) => runHosts(command, selections, {
            ...dependencies,
            noBrowser: parsed.flags.has('no-browser'),
            source: dependencies.source ??
                (updatedCli
                    ? (host) => hostSource(host, join(updatedCli.directory, 'node_modules/@mnemonik/cli/package.json'))
                    : undefined),
            instruction: json ? undefined : (text) => output.line(text),
            apply: parsed.flags.has('apply'),
        }, false);
        const result = managed
            ? command === 'update'
                ? await retryUpdateOnce(() => maintainHosts(managed), hostUpdateFailed)
                : await maintainHosts(managed)
            : { journal: { state: 'READY' }, results: [], reports: [] };
        let scanner;
        let launcher;
        let scannerRecovery;
        if (all &&
            (await readFile(`${state}/scanner/state.json`).then(() => true, () => false))) {
            try {
                const before = await store.verifyRuntime('scanner').catch(() => undefined);
                const runtime = await retryUpdateOnce(() => updateScanner({
                    stateDir: state,
                    ...deps.scannerService,
                    onScannerRestartRequested: () => {
                        if (!json)
                            output.line(SCANNER_RESTART_MESSAGE);
                    },
                }, deps.scannerEnable?.source));
                scanner = {
                    status: before?.reference.version === runtime.reference.version ? 'UP_TO_DATE' : 'UPDATED',
                    version: runtime.manifest.version,
                };
            }
            catch (error) {
                scanner = { status: 'FAILED', reason: error.message };
                if (!json)
                    scannerRecovery = await scannerRecoveryAction(error, {
                        stateDir: state,
                        ...deps.scannerService,
                    });
            }
        }
        let failed = scanner?.status === 'FAILED' || cli?.status === 'FAILED';
        const hostExit = maintenanceExitCode(result.results);
        const remaining = command === 'repair' ? await collectCurrentInstallation(deps, output) : undefined;
        const remainingExit = remaining?.installation.state === 'FAILED'
            ? 1
            : remaining?.installation.state === 'READY' || !remaining
                ? 0
                : 3;
        const hostsFailed = hostUpdateFailed(result);
        const codexTrustPending = result.results.some((target) => target.reason === 'codex_trust_pending');
        if (fullUninstall && hostExit === 0) {
            // A damaged install can lose the runtime pointer and still leave a service
            // registered, so the saved scanner state also counts as one to remove. A
            // machine that never had a scanner must not be asked about one.
            const installed = await Promise.all([new RuntimeStore(state).pointerPath('scanner'), `${state}/scanner/state.json`].map((path) => readFile(path).then(() => true, () => false)));
            if (installed.some(Boolean)) {
                try {
                    await scannerService({ stateDir: state, ...deps.scannerService }).uninstall();
                    scanner = {
                        status: 'uninstalled',
                        verbs: ['stop collection', 'remove local software'],
                        retained: ['credentials', 'cloud data', 'consent'],
                    };
                }
                catch (error) {
                    const failure = scannerFailure(error) ??
                        new ScannerServiceLimited('scanner_service_unavailable', error.message);
                    scanner = {
                        status: 'failed',
                        reason: error.message,
                        action: failure.action,
                        summary: failure.summary,
                    };
                    failed = true;
                }
            }
            else
                scanner = { status: 'not_installed' };
            if (!failed) {
                const removed = await removeLauncher({
                    ...launcherOptions,
                    instruction: json ? undefined : (text) => output.line(text),
                });
                launcher = { status: removed ? 'removed' : 'not_installed' };
            }
            else
                launcher = { status: 'retained' };
        }
        if (json)
            output.json({
                status: failed || remainingExit === 1
                    ? 'FAILED'
                    : remainingExit === 3
                        ? 'ACTION_REQUIRED'
                        : scanner?.status === 'uninstalled'
                            ? 'uninstalled'
                            : result.journal.state,
                targets: result.results,
                reports: result.reports,
                ...(scanner ? { scanner } : {}),
                ...(launcher ? { launcher } : {}),
                ...(cli ? { cli } : {}),
                ...(remaining ? { remaining } : {}),
            });
        else if (command === 'update') {
            if (failed || hostsFailed)
                output.error(updateFailureMessage);
            else if (codexTrustPending) {
                output.line('Mnemonik updated.');
                output.line(CODEX_TRUST_MESSAGE.sentence);
                output.line(CODEX_TRUST_MESSAGE.nextStep);
            }
            else if (cli?.status === 'UPDATED' ||
                result.reports.length > 0 ||
                scanner?.status === 'UPDATED')
                output.line('Mnemonik updated.');
            else
                output.line('Mnemonik is up to date.');
            if (scannerRecovery) {
                output.error(scannerRecovery.message);
                if (scannerRecovery.action)
                    output.error(scannerRecovery.action);
            }
        }
        else {
            for (const target of result.results)
                output.line(target.status === 'READY' ? 'Done.' : humanReason(target.reason));
            for (const report of result.reports)
                output.line(humanReport(report));
            if (remaining)
                renderStatusSummaries(remaining, output);
            if (!selections.length && !fullUninstall && !remaining)
                output.line('No recorded host targets.');
            if (fullUninstall && !failed && hostExit === 0)
                output.line('Stopped collection; removed local software. Credentials, cloud data and consent retained.');
            // A failure is said once, as an error below, never also as a line here.
            else if (scanner && scanner.status !== 'failed')
                output.line(scanner.reason
                    ? humanReason(scanner.reason)
                    : scanner.status === 'not_installed'
                        ? 'The scanner is not installed.'
                        : 'The scanner was uninstalled.');
        }
        if (scanner?.status === 'failed') {
            // Machine output keeps the reason on stderr; stdout stays pure JSON.
            if (json)
                output.error(scanner.reason ?? 'scanner_uninstall_failed', false);
            else {
                output.error(scanner.summary ?? SCANNER_FAILURE_MESSAGE);
                if (scanner.action)
                    output.error(scanner.action);
            }
        }
        if (failed || remainingExit === 1)
            return 1;
        return hostExit || remainingExit;
    }
    catch (error) {
        if (command === 'update' && !json) {
            output.error(updateFailureMessage);
            return error instanceof LauncherError ? 3 : 1;
        }
        if (error instanceof LauncherError) {
            if (json)
                output.json({ status: error.status, reason: error.message, launcher: error.launcher });
            else
                output.error(humanReason(error.message));
            return 3;
        }
        const reason = installFailureReason(error);
        if (reason === 'lock_held') {
            if (json)
                output.json({ status: 'FAILED', reason });
            else
                output.error('Another mnemonik command holds the state lock; retry in a moment.');
        }
        else
            output.error(humanReason(reason));
        return 1;
    }
}
async function hostCommand(command, parsed, deps, output, scannerSelected = false) {
    const code = await runHostCommand(command, parsed, deps, output, scannerSelected);
    if (command === 'repair' || command === 'update')
        await reportCurrentInstallation(deps, output);
    return code;
}
function scannerFailure(error) {
    if (error instanceof ScannerServiceLimited)
        return error;
    if (error instanceof Error && error.message === 'scanner_stop_failed')
        return new ScannerServiceLimited('scanner_stop_failed');
    return undefined;
}
async function scannerRecoveryAction(error, options) {
    const failure = scannerFailure(error);
    if (failure?.reason !== 'scanner_replacement_rolled_back' &&
        !failure?.reason.startsWith('mac_authorization_') &&
        (await scannerService(options)
            .status()
            .catch(() => undefined))?.running)
        return undefined;
    return {
        message: failure?.summary ?? SCANNER_FAILURE_MESSAGE,
        action: failure?.action ?? SCANNER_RETRY_MESSAGE,
    };
}
async function enableCommand(parsed, deps, output) {
    const json = parsed.flags.has('json');
    if (parsed.flags.has('non-interactive') || json) {
        const missing = requireConsent(parsed, output, ['accept-indexing', 'apply']);
        if (missing !== undefined)
            return missing;
        if (!parsed.flags.has('scan-roots'))
            return actionRequired(output, json, 'Supply --scan-roots with approved roots', '--scan-roots');
    }
    try {
        const roots = parsed.flags.get('scan-roots');
        const exclusions = parsed.flags.get('exclusions');
        const result = await enableScanner({
            stateDir: deps.installStateDir ?? stateDirectory(process.platform, process.env, deps.home),
            cwd: deps.cwd ?? process.cwd(),
            home: deps.home,
            input: deps.input ?? process.stdin,
            output,
            nonInteractive: parsed.flags.has('non-interactive') || json,
            noBrowser: parsed.flags.has('no-browser'),
            ...(typeof roots === 'string' ? { roots: roots.split(',').filter(Boolean) } : {}),
            ...(typeof exclusions === 'string'
                ? { exclusions: exclusions.split(',').filter(Boolean) }
                : {}),
            ...deps.scannerService,
            ...deps.scannerEnable,
            projectExecutor: deps.projectExecutor,
            projectStateDir: deps.projectStateDir,
        });
        if (json)
            output.json(result);
        else
            renderStatusSummaries(result, output);
        return result.installation.state === 'READY' ? 0 : 3;
    }
    catch (error) {
        const failure = scannerFailure(error) ??
            new ScannerServiceLimited('scanner_service_unavailable', error.message);
        const result = {
            status: 'ACTION_REQUIRED',
            reason: error.message,
            action: failure.action,
        };
        if (json)
            output.json(result);
        else {
            output.error(failure.summary);
            if (failure.action)
                output.error(failure.action);
        }
        return 3;
    }
}
async function installCommand(parsed, deps, output) {
    const invalid = allowed(parsed, [
        'components',
        'hosts',
        'scan-roots',
        'exclusions',
        'accept-indexing',
        'accept-limited',
        'without-scanner',
        'apply',
        'no-browser',
        'dry-run',
    ]);
    if (invalid)
        return (output.error(invalid), 2);
    if (!deps.install && !parsed.flags.has('dry-run')) {
        const { joinedInstall } = await import('./install/journey.js');
        const state = deps.hostManagement?.stateDir ??
            deps.installStateDir ??
            stateDirectory(process.platform, process.env, deps.home);
        return joinedInstall(parsed.flags, deps, output, () => ensureCliAuth(deps, output, parsed.flags.has('no-browser'), false), () => hostDependencies(deps, output, state));
    }
    const simulation = parsed.flags.has('dry-run')
        ? simulatedInstall(deps.installStateDir)
        : undefined;
    if (parsed.flags.has('non-interactive') || parsed.flags.has('json'))
        return actionRequired(output, parsed.flags.has('json'), 'Run interactively to review the install transaction');
    if (!simulation) {
        try {
            await ensureCliAuth(deps, output, parsed.flags.has('no-browser'));
        }
        catch (error) {
            output.error(humanReason(installFailureReason(error)));
            return 1;
        }
    }
    if (simulation)
        output.line('Simulated dry run: declarations are isolated under the state directory; host sign-ins, projects and uploads are simulated.');
    const terminal = simulation
        ? terminalInstallUI(deps.input ?? process.stdin, output, simulation.roots)
        : undefined;
    const install = simulation && terminal
        ? { ...simulation, ui: terminal.ui, signal: terminal.signal }
        : deps.install;
    if (!install)
        return actionRequired(output, false, 'Install adapters are unavailable');
    try {
        // A stale install journal is recovered here, not abandoned: runInstall
        // offers Resume or Rollback. Only uninstall abandons one.
        const pending = await interrupted(install.stateDir);
        const result = await runInstall(install, pending[0]);
        output.line(`${result.state}: install ${result.runId}`);
        for (const report of result.reports)
            output.line(humanReport(report));
        return result.phase === 'rolled_back'
            ? 130
            : result.state === 'FAILED'
                ? 1
                : result.state === 'READY'
                    ? 0
                    : 3;
    }
    catch (error) {
        output.error(humanReason(installFailureReason(error)));
        return 1;
    }
    finally {
        terminal?.close();
    }
}
async function doctorCommand(parsed, deps, output) {
    const invalid = allowed(parsed, []);
    if (invalid)
        return (output.error(invalid), 2);
    const result = await runPreflight({ cwd: deps.cwd, home: deps.home, ...deps.preflight });
    output.setContext({ home: deps.home ?? homedir(), projectRoot: result.project.root });
    const document = await collectStatusDocument({
        preflight: result,
        cwd: deps.cwd ?? process.cwd(),
        home: deps.home,
        input: deps.input ?? process.stdin,
        executor: deps.projectExecutor,
        resolver: deps.projectResolver ??
            (deps.preflight?.resolveIdentity
                ? { resolveProjectIdentity: deps.preflight.resolveIdentity }
                : undefined),
        stateDir: deps.projectStateDir ?? deps.installStateDir,
        getCliBearer: deps.getCliBearer,
        transport: deps.projectTransport,
        scannerStatus: deps.scannerStatus,
        installationConditions: deps.installationConditions,
        projectHookConditions: deps.projectHookConditions,
        configuredHosts: deps.configuredHosts ?? deps.install?.input.hosts,
        details: deps.statusDetails,
        generatedAt: deps.statusGeneratedAt,
        launcher: {
            ...deps.launcher,
            stateDir: deps.hostManagement?.stateDir ?? deps.installStateDir,
            home: deps.home,
        },
    });
    if (parsed.flags.has('json'))
        output.json(document);
    else {
        renderPreflight(result, output);
        renderStatusSummaries(document, output, { diagnostics: true });
    }
    return document.installation.state === 'READY'
        ? 0
        : document.installation.state === 'FAILED'
            ? 1
            : 3;
}
async function collectCurrentInstallation(deps, output) {
    const result = await runPreflight({
        cwd: deps.cwd,
        home: deps.home,
        ...deps.preflight,
        fetch: async () => new Response(null, { status: 204 }),
    });
    output.setContext({ home: deps.home ?? homedir(), projectRoot: result.project.root });
    const hostStateDir = deps.hostManagement?.stateDir ??
        deps.installStateDir ??
        stateDirectory(process.platform, process.env, deps.home);
    const localConditions = deps.projectHookConditions
        ? []
        : [
            ...(await localInstallationConditions(deps.home ?? homedir(), hostStateDir, deps.launcher)),
            // Installed Codex hooks that Codex has not trusted cannot run.
            ...(await (deps.codexTrustConditions ??
                (() => codexTrustConditions({
                    stateDir: hostStateDir,
                    env: deps.hostManagement?.env,
                    imports: deps.hostManagement?.imports,
                })))()),
        ];
    const document = await collectStatusDocument({
        preflight: result,
        cwd: deps.cwd ?? process.cwd(),
        home: deps.home,
        input: deps.input ?? process.stdin,
        executor: deps.projectExecutor,
        resolver: deps.projectResolver ??
            (deps.preflight?.resolveIdentity
                ? { resolveProjectIdentity: deps.preflight.resolveIdentity }
                : undefined),
        stateDir: deps.projectStateDir ?? deps.installStateDir,
        // The project section reports project access, as doctor and the console
        // route do. Local evidence still decides the installation verdict.
        getCliBearer: deps.getCliBearer,
        transport: deps.projectTransport,
        scannerStatus: deps.scannerStatus,
        installationConditions: [...(deps.installationConditions ?? []), ...localConditions],
        projectHookConditions: deps.projectHookConditions ?? [],
        configuredHosts: deps.configuredHosts ?? deps.install?.input.hosts,
        details: deps.statusDetails,
        generatedAt: deps.statusGeneratedAt,
        launcher: { ...deps.launcher, stateDir: hostStateDir, home: deps.home },
    });
    const versions = await readInstallVersions(hostStateDir, document.scanner?.version ?? undefined);
    const installedCli = await new RuntimeStore(hostStateDir)
        .verifyRuntime('cli')
        .catch(() => undefined);
    if (installedCli)
        versions.cli = installedCli.reference.version;
    return { ...document, versions };
}
/**
 * The web console's devices page reads the row this writes. Local evidence has
 * already decided the verdict and the exit code, so the upload is best effort:
 * it is bounded like the update hint and changes nothing a person sees.
 */
async function reportCurrentInstallation(deps, output, document) {
    const bearer = await auth(deps, output, false)
        .getCliBearer()
        .catch(() => undefined);
    if (typeof bearer !== 'string')
        return;
    const send = deps.grantFetch ?? globalThis.fetch;
    await postCurrentReadiness(bearer, baseReadiness(document ?? (await collectCurrentInstallation(deps, output))), (url, options) => send(url, { ...options, signal: AbortSignal.timeout(2500) })).catch(() => {
        /* An unreachable server says nothing about this machine. */
    });
}
export async function runCli(args, deps = {}) {
    const parsed = parse(args);
    const silent = parsed.flags.has('automatic');
    const discard = { write: () => { } };
    const stdout = silent ? discard : (deps.stdout ?? process.stdout);
    const stderr = silent ? discard : (deps.stderr ?? process.stderr);
    const output = new Output(stdout, stderr, {
        home: deps.home ?? homedir(),
    });
    if (process.env.MNEMONIK_DEV_RELEASE_DIR && !silent)
        stderr.write('WARNING: MNEMONIK_DEV_RELEASE_DIR uses development artifacts; readiness remains LIMITED.\n');
    if (parsed.error)
        return (output.error(parsed.error), 2);
    if (parsed.flags.has('version')) {
        if (parsed.positionals.length || parsed.flags.size !== 1)
            return (output.error('Unknown flag combination: --version'), 2);
        output.line(await packageVersion());
        return 0;
    }
    if (parsed.flags.has('help') || !parsed.positionals.length) {
        if (parsed.positionals.length && !parsed.flags.has('help'))
            return (output.error(`Unknown command: ${parsed.positionals[0]}`), 2);
        output.line(help);
        return 0;
    }
    const [command, subcommand, ...rest] = parsed.positionals;
    if (command === 'install') {
        if (subcommand)
            return (output.error(`Unexpected argument: ${subcommand}`), 2);
        return installCommand(parsed, deps, output);
    }
    if (command === 'roots' || command === 'add' || command === 'remove') {
        const action = command === 'roots' ? subcommand : command;
        const actionArguments = command === 'roots' ? rest : [subcommand, ...rest].filter(Boolean);
        // `--non-git` is accepted and ignored: a folder is a project with or without Git.
        const invalid = allowed(parsed, ['accept-indexing', 'apply', 'no-browser', 'non-git']);
        if (invalid ||
            !['add', 'remove', 'list'].includes(action ?? '') ||
            actionArguments.length !== (action === 'list' ? 0 : 1))
            return (output.error(invalid ?? 'Usage: mnemonik add <folder> or mnemonik remove <folder>'),
                2);
        const stateDir = deps.installStateDir ?? stateDirectory(process.platform, process.env, deps.home);
        const saved = JSON.parse(await readFile(`${stateDir}/scanner/state.json`, 'utf8').catch(() => 'null'));
        if (!saved)
            return actionRequired(output, parsed.flags.has('json'), 'mnemonik install');
        if (action === 'list') {
            if (parsed.flags.has('json'))
                output.json(saved.config.roots);
            else
                for (const root of saved.config.roots)
                    output.line(root);
            return 0;
        }
        if (action === 'add' &&
            (parsed.flags.has('non-interactive') || parsed.flags.has('json')) &&
            !parsed.flags.has('apply'))
            return actionRequired(output, parsed.flags.has('json'), 'Rerun with --apply', '--apply');
        const pathArgument = actionArguments[0] ?? '';
        const requested = action === 'add'
            ? await realpath(pathArgument)
            : (saved.config.roots.find((root) => root === pathArgument) ?? pathArgument);
        const name = requested.split(/[\\/]/u).filter(Boolean).at(-1) ?? requested;
        if (!parsed.flags.has('non-interactive') && !parsed.flags.has('json')) {
            output.line(action === 'add' ? connectFolderPrompt(name) : removeFolderPrompt(name));
            const readline = createInterface({ input: deps.input ?? process.stdin, terminal: false });
            const answer = String((await readline[Symbol.asyncIterator]().next()).value ?? '').trim();
            readline.close();
            if ((action === 'add' && /^(?:n|no)$/iu.test(answer)) ||
                (action === 'remove' && !/^(?:y|yes)$/iu.test(answer)))
                return 130;
        }
        const bearer = await ensureCliAuth(deps, output, parsed.flags.has('no-browser'), false);
        if (action === 'add') {
            let executor = deps.projectExecutor;
            if (!executor)
                executor = (await createRealProjectRuntime({
                    stateDir: deps.projectStateDir ?? stateDir,
                    getCliBearer: async () => bearer,
                    fetch: deps.grantFetch,
                })).executor;
            const resolution = await executor.resolveProjectIdentity(requested);
            const decision = await evaluateRoot(resolution, { cwd: requested, home: deps.home });
            if (!decision.allowed) {
                if (parsed.flags.has('json'))
                    return actionRequired(output, true, decision.reason);
                for (const line of folderRefusalMessage(decision.reason, decision.root))
                    output.line(line);
                return 3;
            }
            const project = await ensureProjectRoot(requested, executor);
            const limit = projectLimitMessage(project, requested);
            if (limit) {
                if (parsed.flags.has('json'))
                    output.json({
                        status: 'ACTION_REQUIRED',
                        state: 'project_limit_reached',
                        message: limit.join(' '),
                    });
                else
                    for (const line of limit)
                        output.line(line);
                return 3;
            }
            if (project.status !== 'done') {
                const state = 'state' in project ? String(project.state) : project.status;
                if (parsed.flags.has('json'))
                    output.json({ status: 'ACTION_REQUIRED', state });
                else
                    for (const line of folderRefusalMessage(state, requested))
                        output.line(line);
                return 3;
            }
        }
        const updated = await updateScannerRoots({
            stateDir,
            bearer,
            add: action === 'add' ? [requested] : [],
            remove: action === 'remove' ? [requested] : [],
            fetch: deps.grantFetch,
        });
        if (updated.status === 'updated') {
            if (parsed.flags.has('json'))
                output.json(updated.state.config.roots);
            else
                output.line(action === 'add' ? connectedFolderLine(name) : removedFolderLine(name));
            return 0;
        }
        const roots = action === 'add'
            ? [...new Set([...saved.config.roots, requested])]
            : saved.config.roots.filter((root) => root !== requested);
        parsed.flags.set('scan-roots', roots.join(','));
        parsed.flags.set('exclusions', (saved.config.exclusions ?? []).join(','));
        return enableCommand(parsed, deps, output);
    }
    if (command === 'auth' &&
        subcommand === 'logout' &&
        parsed.flags.get('component') === 'scanner') {
        const invalid = allowed(parsed, ['component']);
        if (invalid || rest.length)
            return (output.error(invalid ?? 'Unexpected argument'), 2);
        try {
            const stateDir = deps.installStateDir ?? stateDirectory(process.platform, process.env, deps.home);
            const saved = JSON.parse(await readFile(`${stateDir}/scanner/state.json`, 'utf8'));
            const bearer = await ensureCliAuth(deps, output, false);
            const response = await (deps.grantFetch ?? fetch)(`${apiOrigin()}/api/v1/component-credentials/${encodeURIComponent(saved.config.credentialFamilyId)}/revoke`, { method: 'POST', headers: { Authorization: `Bearer ${bearer}` } });
            if (!response.ok)
                throw new Error(`revoke_failed_${response.status}`);
            const result = {
                status: 'revoked',
                verbs: ['revoke access'],
                retained: ['local software', 'cloud data'],
                action: 'mnemonik scanner enable',
            };
            if (parsed.flags.has('json'))
                output.json(result);
            else
                output.line('Revoked scanner access. Collection stops on the next rejected upload. Local software and cloud data retained.');
            return 0;
        }
        catch (error) {
            output.error(humanReason(error.message));
            return 3;
        }
    }
    if (command === 'data') {
        const invalid = allowed(parsed, ['project']);
        const project = parsed.flags.get('project');
        if (invalid || subcommand !== 'delete' || rest.length || typeof project !== 'string')
            return (output.error(invalid ?? 'Usage: mnemonik data delete --project <id>'), 2);
        try {
            const bearer = await ensureCliAuth(deps, output, false);
            const result = await deleteScannerIndex(project, bearer, deps.grantFetch);
            if (parsed.flags.has('json'))
                output.json(result);
            else
                output.line(`Deleted uploaded cloud data: ${result.deletedChunks} chunks; verified count 0. Local software, credentials, durable memories and tasks retained.`);
            return 0;
        }
        catch (error) {
            output.error(humanReason(error.message));
            return 3;
        }
    }
    if ((command === 'update' || command === 'uninstall') &&
        parsed.flags.get('component') === 'scanner') {
        const invalid = allowed(parsed, ['component', 'confirm']);
        if (invalid || subcommand)
            return (output.error(invalid ?? 'Unexpected argument'), 2);
        try {
            const options = {
                stateDir: deps.installStateDir ?? stateDirectory(process.platform, process.env, deps.home),
                ...deps.scannerService,
            };
            if (command === 'update') {
                const store = new RuntimeStore(options.stateDir);
                const before = await store.verifyRuntime('scanner').catch(() => undefined);
                const runtime = await retryUpdateOnce(() => updateScanner({
                    ...options,
                    onScannerRestartRequested: () => {
                        if (!parsed.flags.has('json'))
                            output.line(SCANNER_RESTART_MESSAGE);
                    },
                }, deps.scannerEnable?.source));
                const result = {
                    status: before?.reference.version === runtime.reference.version ? 'up_to_date' : 'updated',
                    version: runtime.manifest.version,
                    cli: { status: 'NOT_SELECTED' },
                    ...(process.env.MNEMONIK_DEV_RELEASE_DIR
                        ? { status: 'LIMITED', reason: 'dev_release_source' }
                        : {}),
                };
                if (parsed.flags.has('json'))
                    output.json(result);
                else
                    output.line(result.status === 'updated' ? 'Mnemonik updated.' : 'Mnemonik is up to date.');
            }
            else {
                await scannerService(options).uninstall();
                const result = {
                    status: 'uninstalled',
                    verbs: ['stop collection', 'remove local software'],
                    retained: ['credentials', 'cloud data', 'consent'],
                };
                if (parsed.flags.has('json'))
                    output.json(result);
                else
                    output.line('Stopped collection; removed local software. Credentials, cloud data and consent retained.');
            }
            return 0;
        }
        catch (error) {
            const failure = scannerFailure(error);
            if (command === 'uninstall' && parsed.flags.has('json'))
                output.json({
                    status: 'FAILED',
                    reason: failure?.reason ?? error.message,
                    action: failure?.action,
                });
            else
                output.error(command === 'update'
                    ? updateFailureMessage
                    : (failure?.summary ?? humanReason(error.message)));
            // A failure that leaves nothing to do says so on one line, not a blank one.
            if (command === 'uninstall' && !parsed.flags.has('json') && failure?.action)
                output.error(failure.action);
            if (command === 'update' && !parsed.flags.has('json')) {
                const action = await scannerRecoveryAction(error, {
                    stateDir: deps.installStateDir ?? stateDirectory(process.platform, process.env, deps.home),
                    ...deps.scannerService,
                });
                if (action) {
                    output.error(action.message);
                    if (action.action)
                        output.error(action.action);
                }
            }
            return 3;
        }
    }
    if (command === 'repair' || command === 'update' || command === 'uninstall') {
        const invalid = allowed(parsed, [
            'host',
            'scope',
            'component',
            'confirm',
            'apply',
            ...(command === 'update' ? ['automatic'] : []),
        ]);
        if (invalid || subcommand)
            return (output.error(invalid ?? `Unexpected argument: ${subcommand}`), 2);
        if (command === 'uninstall' && parsed.flags.has('non-interactive')) {
            const missing = requireConsent(parsed, output, ['confirm']);
            if (missing !== undefined)
                return missing;
        }
        if (!deps.runtimeUpdate || command !== 'update')
            return hostCommand(command, parsed, deps, output);
    }
    if (command === 'update') {
        const invalid = allowed(parsed, ['automatic']);
        if (invalid || subcommand)
            return (output.error(invalid ?? `Unexpected argument: ${subcommand}`), 2);
        const runtimeUpdate = deps.runtimeUpdate;
        if (!runtimeUpdate)
            return placeholder(output, parsed.flags.has('json'), 'update', 'runtime release and service restart');
        let runtime;
        try {
            runtime = await retryUpdateOnce(() => updateRuntime(runtimeUpdate));
        }
        catch {
            output.error(updateFailureMessage);
            return 3;
        }
        if (parsed.flags.has('json'))
            output.json({
                status: 'updated',
                artifact: runtime.manifest.artifact,
                version: runtime.manifest.version,
            });
        else
            output.line('Mnemonik updated.');
        return 0;
    }
    if (command === 'doctor') {
        if (subcommand)
            return (output.error(`Unexpected argument: ${subcommand}`), 2);
        return doctorCommand(parsed, deps, output);
    }
    if (command === 'diagnostics') {
        const invalid = allowed(parsed, subcommand === 'preview' ? ['out'] : []);
        const bundleId = rest[0];
        if (invalid ||
            !['preview', 'send'].includes(subcommand ?? '') ||
            (subcommand === 'preview' && rest.length) ||
            (subcommand === 'send' && (rest.length !== 1 || !bundleId)))
            return (output.error(invalid ?? 'Usage: mnemonik diagnostics preview [--out <file>] | send <bundle-id>'),
                2);
        try {
            const result = subcommand === 'preview'
                ? await previewDiagnostics(parsed.flags.get('out'), deps.diagnostics)
                : await sendDiagnostics(bundleId, deps.diagnostics);
            const stream = deps.stdout ?? process.stdout;
            if (parsed.flags.has('json'))
                stream.write(`${JSON.stringify(result)}\n`);
            else if (subcommand === 'preview') {
                const preview = result;
                stream.write(`${JSON.stringify(preview.manifest, null, 2)}\nSHA-256: ${preview.sha256}\nPreview: ${preview.path}\n`);
            }
            else {
                stream.write(`Sent diagnostics bundle ${bundleId}.\n`);
            }
            return 0;
        }
        catch (error) {
            const nativeCode = error.code;
            const code = error instanceof DiagnosticsError
                ? error.code
                : typeof nativeCode === 'string'
                    ? nativeCode
                    : 'diagnostics_failed';
            if (parsed.flags.has('json'))
                output.json({ status: 'error', error: code });
            else if (/^(?:bundle_id_invalid|bundle_hash_mismatch|diagnostics_preview_invalid|ENOENT)$/u.test(code))
                output.error('Saved diagnostics could not be used.\nRun mnemonik diagnostics preview, then try again.');
            else
                output.error(subcommand === 'preview'
                    ? 'Diagnostics could not be created.\nRun mnemonik install to try again.'
                    : 'Diagnostics could not be sent.\nCheck your internet connection, then try again.');
            return 1;
        }
    }
    if (command === 'status') {
        const invalid = allowed(parsed, []);
        if (invalid || subcommand)
            return (output.error(invalid ?? `Unexpected argument: ${subcommand}`), 2);
        const document = await collectCurrentInstallation(deps, output);
        const version = await packageVersion();
        const store = new RuntimeStore(deps.installStateDir ?? stateDirectory(process.platform, process.env, deps.home));
        if (!parsed.flags.has('json')) {
            renderStatusSummaries(document, output);
        }
        const hint = await cliUpdateHint(store, version);
        if (parsed.flags.has('json'))
            output.json({ ...document, cli: { version, ...(hint ? { updateAvailable: hint } : {}) } });
        else if (hint)
            output.line(hint);
        await reportCurrentInstallation(deps, output, document);
        return statusExitCode(document);
    }
    if (command === 'connect') {
        const invalid = allowed(parsed, ['scope']);
        if (invalid)
            return (output.error(invalid), 2);
        if (!subcommand || rest.length || !hostOrder.includes(subcommand))
            return (output.error(`Usage: mnemonik connect <${hostOrder.join('|')}>`), 2);
        const host = subcommand;
        const editor = (await localEditorStatus(deps.home ?? homedir())).find((candidate) => candidate.host === host);
        const reason = editor?.mcp === 'disabled'
            ? `${editor.name} connection is turned off.`
            : editor?.mcp === 'ready'
                ? 'Finish signing in to Mnemonik in the editor.'
                : `${launchHostLabels[host]} connection is missing.`;
        const actions = editor?.mcp === 'ready'
            ? editorAuthorizationRows([host])
            : [
                editor?.mcp === 'disabled'
                    ? mcpTurnOnAction[host]
                    : 'Run mnemonik install to set it up again.',
            ];
        if (parsed.flags.has('json'))
            output.json({ status: 'ACTION_REQUIRED', reason, actions });
        else {
            output.line(reason);
            for (const action of actions)
                output.line(action);
        }
        return 3;
    }
    if (command === 'project') {
        if (!subcommand || !['init', 'setup', 'status', 'link', 'ensure'].includes(subcommand))
            return (output.error('Usage: mnemonik project <init|setup|status|link|ensure>'), 2);
        const invalid = allowed(parsed, subcommand === 'ensure'
            ? ['agent']
            : subcommand === 'status'
                ? []
                : subcommand === 'link'
                    ? ['apply', 'non-git', 'confirm-mismatch', 'replace', 'owner']
                    : ['apply', 'non-git', 'owner']);
        if (invalid)
            return (output.error(invalid), 2);
        if (subcommand === 'ensure') {
            if (rest.length || !parsed.flags.has('agent') || !parsed.flags.has('json'))
                return (output.error('Usage: mnemonik project ensure --agent --json'), 2);
            return ensureProjectForAgent({
                output,
                cwd: deps.cwd ?? process.cwd(),
                executor: deps.projectExecutor,
                input: deps.input ?? process.stdin,
            });
        }
        if (subcommand !== 'status' && subcommand !== 'setup' && parsed.flags.has('non-interactive')) {
            const missing = requireConsent(parsed, output, ['apply']);
            if (missing !== undefined)
                return missing;
        }
        if ((subcommand === 'link' && (rest.length < 1 || rest.length > 2)) ||
            (subcommand !== 'link' && rest.length > 1))
            return (output.error(`Usage: mnemonik project ${subcommand}${subcommand === 'link' ? ' <project-id> [path]' : ' [path]'}`),
                2);
        return runProjectCommand({
            command: subcommand,
            ...(subcommand === 'link' ? { projectId: rest[0], path: rest[1] } : { path: rest[0] }),
            json: parsed.flags.has('json'),
            nonInteractive: parsed.flags.has('non-interactive'),
            apply: parsed.flags.has('apply'),
            confirmMismatch: parsed.flags.has('confirm-mismatch'),
            replace: parsed.flags.has('replace'),
            owner: typeof parsed.flags.get('owner') === 'string'
                ? parsed.flags.get('owner')
                : undefined,
        }, {
            output,
            input: deps.input ?? process.stdin,
            cwd: deps.cwd ?? process.cwd(),
            home: deps.home,
            executor: deps.projectExecutor,
            resolver: deps.projectResolver,
            stateDir: deps.projectStateDir ?? deps.installStateDir,
            getCliBearer: deps.getCliBearer,
            transport: deps.projectTransport,
        });
    }
    if (command === 'identity') {
        if (subcommand !== 'migrate')
            return (output.error('Usage: mnemonik identity migrate [paths] [--report|--backup]\n' +
                '       mnemonik identity migrate [--apply|--verify|--rollback <run-id>]'),
                2);
        const invalid = allowed(parsed, ['report', 'backup', 'apply', 'verify', 'rollback']);
        if (invalid)
            return (output.error(invalid), 2);
        const selected = ['report', 'backup', 'apply', 'verify', 'rollback'].filter((flag) => parsed.flags.has(flag));
        if (selected.length > 1)
            return (output.error('Choose one migration phase: --report, --backup, --apply, --verify, or --rollback'),
                2);
        const mode = (selected[0] ?? 'report');
        if (rest.length && mode !== 'report' && mode !== 'backup')
            return (output.error('Paths are only accepted by --report and --backup'), 2);
        let result;
        try {
            result = await runIdentityMigration({
                mode,
                paths: rest,
                runId: typeof parsed.flags.get('rollback') === 'string'
                    ? parsed.flags.get('rollback')
                    : undefined,
                home: deps.home,
                cwd: deps.cwd,
                stateDir: deps.identityStateDir,
            });
        }
        catch (error) {
            output.error(humanReason(error.message));
            return 1;
        }
        if (parsed.flags.has('json'))
            output.json(result);
        else if ('report' in result) {
            for (const entry of result.report.entries)
                output.line(`${entry.path}: ${humanIdentityState(entry.state)}`);
            output.line(`Checked ${result.report.entries.length} project identity files.`);
            if (result.status === 'backed_up')
                output.line(`Backup run: ${result.runId} (${result.count} file(s))`);
        }
        else {
            output.line(`Identity migration: ${result.passed} passed; ${result.failed} failed.`);
            for (const failure of result.failures)
                output.error(humanReason(failure));
        }
        return 'failed' in result && result.failed > 0 ? 1 : 0;
    }
    if (command === 'scanner') {
        if (!subcommand ||
            rest.length ||
            ![
                'enable',
                'start',
                'stop',
                'pause',
                'resume',
                'export-preview',
                'uninstall',
                'status',
            ].includes(subcommand))
            return (output.error('Usage: mnemonik scanner <enable|start|stop|uninstall|status>'), 2);
        const invalid = allowed(parsed, subcommand === 'enable'
            ? ['accept-indexing', 'apply', 'scan-roots', 'exclusions', 'no-browser']
            : subcommand === 'export-preview'
                ? ['out']
                : []);
        if (invalid)
            return (output.error(invalid), 2);
        if (subcommand === 'enable')
            return enableCommand(parsed, deps, output);
        if (subcommand === 'status' && deps.scannerStatus) {
            const status = await deps.scannerStatus();
            const omitted = status.repositories
                .filter((repository) => !repository.selected)
                .map((repository) => ({
                kind: 'scanner_omitted',
                component: repository.path,
                reason: `${repository.path} was omitted from scanner coverage.`,
                action: 'Run mnemonik scanner enable to change coverage.',
            }));
            const projects = status.repositories.map((repository) => {
                const conditions = !repository.selected
                    ? [
                        {
                            kind: 'scanner_omitted',
                            reason: 'Scanner coverage was deliberately omitted.',
                            action: 'Run mnemonik scanner enable to add this project.',
                        },
                    ]
                    : repository.state === 'not_set_up' || repository.state === 'action_required'
                        ? [
                            {
                                kind: 'project_identity_choice_pending',
                                reason: 'Project setup is not complete.',
                                action: `Run mnemonik project init ${repository.path}.`,
                            },
                        ]
                        : [];
                return {
                    displayName: repository.path,
                    repositoryMatch: repository.state,
                    summary: { conditions },
                    action: conditions[0]?.action ?? null,
                };
            });
            const document = serializeReadiness({
                installation: { conditions: omitted },
                projects,
                scanner: {
                    roots: status.roots,
                    heartbeatAt: null,
                    version: null,
                    readiness: null,
                    acceptedDisclosureVersion: null,
                },
                limitedMode: omitted.length
                    ? {
                        acknowledgement: 'Scanner coverage was deliberately limited.',
                        enableScannerAction: 'npx -y @mnemonik/cli@latest scanner enable',
                    }
                    : null,
            });
            if (parsed.flags.has('json'))
                output.json(document);
            else {
                renderScannerStatus(status, output);
                output.line(describeReadiness(document.installation));
            }
            return document.projects?.some((project) => project.summary.state === 'FAILED')
                ? 1
                : document.projects?.some((project) => project.summary.state !== 'READY')
                    ? 3
                    : 0;
        }
        const json = parsed.flags.has('json');
        const service = scannerService({
            stateDir: deps.installStateDir ?? stateDirectory(process.platform, process.env, deps.home),
            waiting: json
                ? undefined
                : (phase, ms) => output.line(`Waiting for scanner ${phase} (up to ${ms / 1000} seconds).`),
            timeout: json || parsed.flags.has('non-interactive')
                ? undefined
                : async (phase) => (await chooseHostProfile(deps.input ?? process.stdin, output, [
                    `Retry scanner ${phase}`,
                    'Skip scanner',
                ]))?.startsWith('Retry')
                    ? 'retry'
                    : 'skip',
            ...deps.scannerService,
        });
        try {
            const options = {
                stateDir: deps.installStateDir ?? stateDirectory(process.platform, process.env, deps.home),
                ...deps.scannerService,
            };
            if (subcommand === 'pause' || subcommand === 'resume')
                await controlScanner(subcommand, options);
            else if (subcommand === 'export-preview') {
                const out = parsed.flags.get('out');
                if (typeof out !== 'string')
                    return actionRequired(output, json, 'Supply --out for a local payload preview');
                const result = await service.exportPreview(out);
                output.line(result.stdout.trim());
                return 0;
            }
            else if (subcommand === 'start') {
                const supervisor = await service.status();
                if (supervisor.running) {
                    if (json)
                        output.json({
                            status: 'ACTION_REQUIRED',
                            reason: 'instance_running',
                            pid: supervisor.pid,
                        });
                    else
                        output.line(`Scanner is already running (PID ${supervisor.pid}).`);
                    return 3;
                }
                await service.start();
            }
            else if (subcommand === 'stop') {
                await service.stop();
                // The boot registration stays, so say what stopping does and does not do.
                if ((deps.scannerService?.platform ?? process.platform) === 'darwin')
                    output.line('Background indexing will start again when this Mac restarts.');
            }
            else if (subcommand === 'uninstall')
                await service.uninstall();
            const includesStatus = ['status', 'pause', 'resume'].includes(subcommand);
            const supervisor = includesStatus ? await service.status() : undefined;
            const receipt = includesStatus ? await scannerReceipt(options.stateDir) : undefined;
            const result = {
                status: service.verified ? 'READY' : 'ok',
                ...(supervisor
                    ? {
                        supervisor,
                        receipt: receipt
                            ? { ...receipt, snapshot: { ...receipt.snapshot, supervisor } }
                            : receipt,
                    }
                    : {}),
            };
            if (json)
                output.json(result);
            else {
                output.line(subcommand === 'status' && supervisor
                    ? supervisor.installed
                        ? `Scanner status: ${result.status} (service: ${supervisor.kind}, ${supervisor.running ? 'running' : 'stopped'})`
                        : `Scanner status: ${result.status} (service not registered; run mnemonik scanner start)`
                    : `Scanner ${subcommand}: ${result.status}`);
            }
            return 0;
        }
        catch (error) {
            const failure = scannerFailure(error) ??
                new ScannerServiceLimited('scanner_service_unavailable', error.message);
            const result = {
                status: 'LIMITED',
                reason: failure.reason,
                detail: failure.message,
                action: failure.action,
                choices: ['retry', 'skip'],
            };
            if (json)
                output.json(result);
            else {
                output.line(failure.summary);
                if (failure.action)
                    output.line(failure.action);
            }
            return 3;
        }
    }
    if (command === 'auth') {
        const invalid = allowed(parsed, ['host', 'confirm', 'no-browser', 'reopen-install']);
        if (invalid ||
            rest.length ||
            !['login', 'status', 'logout'].includes(subcommand ?? '') ||
            (parsed.flags.has('reopen-install') && subcommand !== 'login'))
            return (output.error(invalid ?? 'Usage: mnemonik auth <login|status|logout> [--host <host>]'),
                2);
        const host = parsed.flags.get('host');
        if (host && !hostOrder.includes(host))
            return (output.error('Invalid host'), 2);
        if (subcommand === 'login') {
            if (host)
                return (output.error('Use mnemonik connect <host> for a host login'), 2);
            const noBrowser = parsed.flags.has('no-browser');
            const bearer = await ensureCliAuth(deps, output, noBrowser);
            if (parsed.flags.has('reopen-install')) {
                const current = await currentInstallSession(bearer, deps.grantFetch);
                if (current) {
                    if (typeof current.expires_at !== 'string')
                        throw new Error('invalid_install_session');
                    output.line(`An install session is already open until ${current.expires_at}; run the install again`);
                    return 0;
                }
                const installation = (await grantTransport(async () => bearer, deps.grantFetch).list())
                    .deviceInstallationId;
                if (!installation)
                    throw new Error('installation_required');
                const sessionAuth = deps.cliAuth ??
                    createCliAuth({
                        stateDir: deps.installStateDir,
                        deviceInstallationId: installation,
                        noBrowser,
                        print: (line) => output.line(line),
                    });
                await ensureInstallSession({
                    bearer,
                    deviceInstallationId: installation,
                    currentSession: null,
                    authorize: async () => {
                        await sessionAuth.signIn();
                        const reopened = await sessionAuth.getCliBearer();
                        if (typeof reopened !== 'string')
                            throw new Error(reopened.reason);
                        return reopened;
                    },
                });
            }
            return 0;
        }
        if (subcommand === 'logout' && !host) {
            await auth(deps, output, false).logout();
            if (parsed.flags.has('json'))
                output.json({ status: 'logged_out' });
            else
                output.line('Logged out.');
            return 0;
        }
        const state = deps.hostManagement?.stateDir ??
            deps.installStateDir ??
            stateDirectory(process.platform, process.env, deps.home);
        let managed;
        try {
            managed = await hostDependencies(deps, output, state);
        }
        catch (error) {
            if (!isCredentialSessionUnavailableError(error))
                throw error;
            if (parsed.flags.has('json'))
                output.json({ status: 'ACTION_REQUIRED', reason: error.reason, detail: error.message });
            else
                output.line(error.message);
            return 3;
        }
        if (!managed.grants)
            return actionRequired(output, parsed.flags.has('json'), 'host_grant_unverified');
        if (subcommand === 'status') {
            const status = await managed.grants.list();
            if (status.account !== managed.account)
                return actionRequired(output, parsed.flags.has('json'), 'host_account_mismatch');
            const grants = status.grants
                .filter((g) => {
                const grantHostName = grantHost(g);
                return ((!grantHostName || hostOrder.includes(grantHostName)) &&
                    (!host || grantHostName === host));
            })
                .map((g) => ({ ...g, host: grantHost(g) ?? g.clientName ?? g.clientId }));
            if (parsed.flags.has('json'))
                output.json({ account: status.account, grants });
            else
                for (const g of grants)
                    output.line(`${g.host}: ${g.id}; created ${g.createdAt}; last used ${g.lastUsedAt ?? 'never'}; scopes ${g.scopes.join(', ')}`);
            return 0;
        }
        const confirmed = parsed.flags.has('confirm') ||
            (await managed.offerRevoke?.(host)) ||
            (!parsed.flags.has('json') &&
                !parsed.flags.has('non-interactive') &&
                (await chooseHostProfile(deps.input ?? process.stdin, output, [
                    'Keep grant',
                    `Revoke ${host} grant`,
                ]))?.startsWith('Revoke'));
        if (!confirmed)
            return actionRequired(output, parsed.flags.has('json'), `Confirm revocation with mnemonik auth logout --host ${host} --confirm`);
        const revoked = await logoutHost(host, {
            ...managed,
            instruction: (text) => {
                if (!parsed.flags.has('json'))
                    output.line(text);
            },
        });
        if (parsed.flags.has('json'))
            output.json({ status: 'revoked', host, grants: revoked });
        else
            output.line(`Revoked ${revoked.length} ${host} grant(s).`);
        return 0;
    }
    if (command === 'logout') {
        if (subcommand)
            return (output.error(`Unexpected argument: ${subcommand}`), 2);
        const invalid = allowed(parsed, []);
        if (invalid)
            return (output.error(invalid), 2);
        await auth(deps, output, false).logout();
        if (parsed.flags.has('json'))
            output.json({ status: 'logged_out' });
        else
            output.line('Logged out.');
        return 0;
    }
    output.error(`Unknown command: ${command}`);
    return 2;
}
const serializeReadiness = (input) => devReadiness(baseReadiness(input));
//# sourceMappingURL=router.js.map