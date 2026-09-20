import { enableScanner, type EnableOptions } from './scanner/enable.js';
import { controlScanner, scannerReceipt } from './scanner/control.js';
import { updateScanner } from './scanner/update.js';
import { deleteScannerIndex } from './scanner/data.js';
import { devReadiness } from './runtime/releaseSource.js';
import {
  scannerService,
  ScannerServiceLimited,
  type ScannerServiceOptions,
} from './scanner/service.js';
import { stateDirectory } from '@mnemonik/local-setup';
import { isCredentialSessionUnavailableError } from '@mnemonik/credentials';
import {
  runHosts,
  hostSource,
  codexTrustConditions,
  connectHost,
  logoutHost,
  selectOwned,
  type HostDependencies,
  type HostCommand,
  type HostResult,
  type HostSelection,
} from './install/hosts.js';
import { hostOrder } from './install/adapters.js';
import { readInstallVersions } from './install/ownership.js';
import { ensureLauncher, removeLauncher, LauncherError, type LauncherOptions } from './launcher.js';
import { readFile } from 'node:fs/promises';
import { RuntimeStore, updateRuntime, type RuntimeUpdate } from './runtime/store.js';
import { updateCli, cliUpdateLine, cliUpdateHint } from './runtime/selfUpdate.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { Output, type Writable } from './output.js';
import { renderPreflight, runPreflight, type PreflightDependencies } from './preflight.js';
import { postCurrentReadiness, type InstallSessionTransport } from './installSession.js';
import {
  ensureProjectForAgent,
  runProjectCommand,
  type ProjectExecutor,
  type ProjectReadTransport,
} from './project.js';
import {
  apiOrigin,
  describeReadiness,
  serializeReadiness as baseReadiness,
  type ProjectReadinessInput,
  type ReadinessCondition,
  type resolveProjectIdentity,
} from '@mnemonik/shared';
import { grantTransport, grantHost } from './auth/status.js';
import { createCliAuth } from './auth/index.js';
import { currentInstallSession, ensureInstallSession } from './auth/installSession.js';
import { runIdentityMigration } from './identity/migrate.js';
import { renderScannerStatus, type ScannerPickerResult } from './scanner/picker.js';
import { interrupted } from './install/journal.js';
import {
  installFailureReason,
  runInstall,
  type InstallDependencies,
} from './install/transaction.js';
import { chooseHostProfile, simulatedInstall, terminalInstallUI } from './install/ui.js';
import {
  collectStatusDocument,
  renderStatusSummaries,
  statusExitCode,
  type StatusDocumentInput,
} from './status.js';
import {
  DiagnosticsError,
  previewDiagnostics,
  sendDiagnostics,
  type DiagnosticsDependencies,
} from './diagnostics.js';

const supportedHosts = ['claude-code', 'codex', 'cursor', 'grok'] as const;

export function maintenanceExitCode(results: readonly Pick<HostResult, 'status'>[]): number {
  if (results.some((result) => result.status === 'FAILED')) return 1;
  return results.every((result) => result.status === 'READY') ? 0 : 3;
}
const booleans = new Set([
  'json',
  'non-interactive',
  'agent',
  'accept-scanner',
  'accept-limited',
  'apply',
  'approve-host',
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
]);
const values = new Set([
  'components',
  'hosts',
  'integration-scope',
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
  connect <claude-code|codex|cursor|grok>
  project <init|setup|status|link|ensure>
  scanner <enable|start|stop|pause|resume|status|export-preview>
  roots <add|remove|list>
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
Install consent: --accept-scanner --without-scanner --accept-limited --apply`;

interface Parsed {
  positionals: string[];
  flags: Map<string, string | true>;
  error?: string;
}

function parse(args: string[]): Parsed {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
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
      if (inline !== undefined) return { positionals, flags, error: `Unknown flag: ${argument}` };
      flags.set(name, true);
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

function allowed(parsed: Parsed, names: string[]): string | undefined {
  const permitted = new Set(['json', 'non-interactive', 'no-browser', 'help', ...names]);
  for (const name of parsed.flags.keys())
    if (!permitted.has(name)) return `Unknown flag: --${name}`;
  return undefined;
}

function actionRequired(output: Output, json: boolean, message: string, flag?: string): number {
  if (json)
    output.json({
      status: 'action_required',
      reason: 'consent_required',
      ...(flag ? { flag } : {}),
      action: message,
    });
  else output.error(flag ? `Missing required consent flag: ${flag}` : message);
  return 3;
}

function requireConsent(parsed: Parsed, output: Output, required: string[]): number | undefined {
  for (const flag of required) {
    if (!parsed.flags.has(flag))
      return actionRequired(output, parsed.flags.has('json'), `Rerun with --${flag}`, `--${flag}`);
  }
  return undefined;
}

function placeholder(output: Output, json: boolean, command: string, owner: string): number {
  const result = { status: 'not_implemented', command, owner };
  if (json) output.json(result);
  else output.line(`${command}: not available in this build (${owner}).`);
  return 3;
}

export interface CliDependencies {
  launcher?: LauncherOptions;
  install?: InstallDependencies;
  hostManagement?: HostDependencies;
  installStateDir?: string;
  runtimeUpdate?: RuntimeUpdate;
  input?: Readable;
  stdout?: Writable;
  stderr?: Writable;
  cwd?: string;
  home?: string;
  width?: number;
  preflight?: PreflightDependencies;
  projectExecutor?: ProjectExecutor;
  projectResolver?: { resolveProjectIdentity: typeof resolveProjectIdentity };
  projectStateDir?: string;
  getCliBearer?: () => Promise<string | undefined>;
  projectTransport?: ProjectReadTransport;
  interruptedProjectSetup?: boolean;
  installSession?: InstallSessionTransport;
  grantFetch?: typeof fetch;
  cliAuth?: {
    signIn(): Promise<unknown>;
    getCliBearer(): Promise<string | { status: string; reason: string }>;
    accountEmail?(bearer: string): Promise<string>;
    logout(): Promise<void>;
  };
  identityStateDir?: string;
  scannerService?: ScannerServiceOptions;
  scannerEnable?: Partial<EnableOptions>;
  scannerStatus?: () => Promise<ScannerPickerResult>;
  installationConditions?: readonly ReadinessCondition[];
  projectHookConditions?: readonly ReadinessCondition[];
  configuredHosts?: readonly string[];
  statusGeneratedAt?: string;
  statusDetails?: StatusDocumentInput['details'];
  codexTrustConditions?: () => Promise<readonly ReadinessCondition[]>;
  diagnostics?: DiagnosticsDependencies;
}

function auth(deps: CliDependencies, output: Output, noBrowser: boolean) {
  return (
    deps.cliAuth ??
    createCliAuth({
      stateDir: deps.installStateDir,
      noBrowser,
      print: (line) => output.line(line),
    })
  );
}

async function ensureCliAuth(
  deps: CliDependencies,
  output: Output,
  noBrowser: boolean,
  showIdentity = true
) {
  const cliAuth = auth(deps, output, noBrowser);
  let bearer = await cliAuth.getCliBearer().catch((error: unknown) => {
    if (isCredentialSessionUnavailableError(error))
      return { status: 'ACTION_REQUIRED', reason: error.reason };
    throw error;
  });
  if (typeof bearer !== 'string') {
    await cliAuth.signIn();
    bearer = await cliAuth.getCliBearer();
  }
  if (typeof bearer !== 'string') throw new Error(bearer.reason);
  if (showIdentity && cliAuth.accountEmail) output.signedIn(await cliAuth.accountEmail(bearer));
  return bearer;
}

async function hostDependencies(
  deps: CliDependencies,
  output: Output,
  state: string
): Promise<HostDependencies> {
  if (deps.hostManagement) return deps.hostManagement;
  const cliAuth = auth(deps, output, false);
  const grants = grantTransport(async () => {
    const bearer = await cliAuth.getCliBearer();
    if (typeof bearer !== 'string') throw new Error(bearer.reason);
    return bearer;
  }, deps.grantFetch);
  return {
    stateDir: state,
    account: (await grants.list()).account,
    grants,
    getCliBearer: async () => {
      const bearer = await cliAuth.getCliBearer();
      if (typeof bearer !== 'string') throw new Error(bearer.reason);
      return bearer;
    },
    credentialFetch: deps.grantFetch,
  };
}

async function packageVersion(): Promise<string> {
  const contents = await readFile(new URL('../package.json', import.meta.url), 'utf8');
  return (JSON.parse(contents) as { version: string }).version;
}

async function runHostCommand(
  command: HostCommand,
  parsed: Parsed,
  deps: CliDependencies,
  output: Output,
  scannerSelected = false
): Promise<number> {
  const json = parsed.flags.has('json');
  const state =
    deps.hostManagement?.stateDir ??
    deps.installStateDir ??
    stateDirectory(process.platform, process.env, deps.home);
  const scope = parsed.flags.get(command === 'install' ? 'integration-scope' : 'scope');
  const host = parsed.flags.get('host');
  const component = parsed.flags.get('component');
  const fullUninstall = command === 'uninstall' && !host && !scope && !component;
  if (
    (scope && !['user', 'project'].includes(String(scope))) ||
    (host && !hostOrder.includes(host as never)) ||
    (component && !['hooks', 'mcp'].includes(String(component)))
  )
    return (output.error('Invalid host, scope or component'), 2);
  let selections: HostSelection[];
  if (command === 'install') {
    const names = String(parsed.flags.get('hosts') ?? hostOrder.join(',')).split(',');
    if (names.some((name) => !hostOrder.includes(name as never)))
      return (output.error('Invalid hosts'), 2);
    const components = String(parsed.flags.get('components') ?? 'hooks,mcp').split(',');
    if (components.some((c) => !['hooks', 'mcp'].includes(c)))
      return placeholder(output, json, 'install scanner', 'scanner setup');
    const missing = requireConsent(parsed, output, [
      'integration-scope',
      ...(scannerSelected ? [] : ['accept-limited']),
      'apply',
    ]);
    if (missing !== undefined) return missing;
    await ensureCliAuth(deps, output, parsed.flags.has('no-browser'), false);
    selections = [...new Set(names)].flatMap((name) =>
      [...new Set(components)].map((component) => ({
        component: component as 'hooks' | 'mcp',
        host: name as HostSelection['host'],
        scope: scope as HostSelection['scope'],
        home: deps.home ?? homedir(),
        projectRoot: deps.cwd ?? process.cwd(),
      }))
    );
  } else {
    const resolved = await selectOwned(
      state,
      host ? String(host) : undefined,
      scope ? String(scope) : undefined,
      component ? String(component) : undefined
    );
    if (resolved.ambiguous.length && !json && !parsed.flags.has('non-interactive')) {
      const profile = await chooseHostProfile(
        deps.input ?? process.stdin,
        output,
        resolved.ambiguous
      );
      if (!profile) return actionRequired(output, false, 'Select one recorded host profile.');
      resolved.selected = resolved.selected.filter((t) => t.profilePath === profile);
    } else if (resolved.ambiguous.length) {
      if (json)
        output.json({
          status: 'ACTION_REQUIRED',
          reason: 'ambiguous_profile',
          profiles: resolved.ambiguous,
        });
      else output.line(`ACTION_REQUIRED: ambiguous profiles: ${resolved.ambiguous.join(', ')}`);
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
      else output.line('No recorded host targets.');
      return 3;
    }
  }
  try {
    const launcherOptions = { ...deps.launcher, home: deps.home, stateDir: state };
    if (command === 'update' || command === 'repair') await ensureLauncher(launcherOptions);
    const all = command === 'update' && !host && !component;
    const store = new RuntimeStore(state);
    const cli = all ? await updateCli(store) : undefined;
    const updatedCli =
      selections.length && (cli?.status === 'UPDATED' || cli?.status === 'UP_TO_DATE')
        ? await store.verifyRuntime('cli')
        : undefined;
    const managed =
      selections.length || (await interrupted(state)).length
        ? await hostDependencies(deps, output, state)
        : undefined;
    const result = managed
      ? await runHosts(
          command,
          selections,
          {
            ...managed,
            noBrowser: parsed.flags.has('no-browser'),
            source:
              managed.source ??
              (updatedCli
                ? (host) =>
                    hostSource(
                      host,
                      join(updatedCli.directory, 'node_modules/@mnemonik/cli/package.json')
                    )
                : undefined),
            instruction: json ? undefined : (text) => output.line(text),
            timeout:
              managed.timeout ??
              (json || parsed.flags.has('non-interactive')
                ? undefined
                : async (host) =>
                    (
                      await chooseHostProfile(deps.input ?? process.stdin, output, [
                        `Retry ${host}`,
                        `Skip ${host}`,
                      ])
                    )?.startsWith('Retry')
                      ? 'retry'
                      : 'skip'),
            apply: parsed.flags.has('apply'),
            offerRevoke:
              managed.offerRevoke ??
              (json || parsed.flags.has('non-interactive')
                ? undefined
                : async (host) =>
                    (
                      await chooseHostProfile(deps.input ?? process.stdin, output, [
                        `Keep ${host} grant`,
                        `Revoke ${host} grant`,
                      ])
                    )?.startsWith('Revoke') ?? false),
          },
          parsed.flags.has('integration-scope')
        )
      : { journal: { state: 'READY' }, results: [], reports: [] };
    let scanner:
      | {
          status: string;
          version?: string;
          reason?: string;
          verbs?: string[];
          retained?: string[];
        }
      | undefined;
    let launcher: { status: 'removed' | 'not_installed' | 'retained' } | undefined;
    if (
      all &&
      (await readFile(`${state}/scanner/state.json`).then(
        () => true,
        () => false
      ))
    ) {
      try {
        const runtime = await updateScanner(
          { stateDir: state, ...deps.scannerService },
          deps.scannerEnable?.source
        );
        scanner = { status: 'UPDATED', version: runtime.manifest.version };
      } catch (error) {
        scanner = { status: 'FAILED', reason: (error as Error).message };
      }
    }
    let failed = scanner?.status === 'FAILED' || cli?.status === 'FAILED';
    const hostExit = maintenanceExitCode(result.results);
    if (fullUninstall && hostExit === 0) {
      const scannerPointer = await readFile(new RuntimeStore(state).pointerPath('scanner')).then(
        () => true,
        () => false
      );
      if (scannerPointer) {
        try {
          await scannerService({ stateDir: state, ...deps.scannerService }).uninstall();
          scanner = {
            status: 'uninstalled',
            verbs: ['stop collection', 'remove local software'],
            retained: ['credentials', 'cloud data', 'consent'],
          };
        } catch (error) {
          scanner = { status: 'failed', reason: (error as Error).message };
          failed = true;
        }
      } else scanner = { status: 'not_installed' };
      if (!failed) {
        const removed = await removeLauncher({
          ...launcherOptions,
          instruction: json ? undefined : (text) => output.line(text),
        });
        launcher = { status: removed ? 'removed' : 'not_installed' };
      } else launcher = { status: 'retained' };
    }
    if (json)
      output.json({
        status: failed
          ? 'FAILED'
          : scanner?.status === 'uninstalled'
            ? 'uninstalled'
            : result.journal.state,
        targets: result.results,
        reports: result.reports,
        ...(scanner ? { scanner } : {}),
        ...(launcher ? { launcher } : {}),
        ...(cli ? { cli } : {}),
      });
    else {
      for (const target of result.results)
        output.line(
          `${target.target}: ${target.status} (${target.reason}${target.detail ? `: ${target.detail}` : ''})`
        );
      for (const report of result.reports) output.line(report);
      if (!selections.length && !fullUninstall) output.line('No recorded host targets.');
      if (fullUninstall && !failed && hostExit === 0)
        output.line(
          'Stopped collection; removed local software. Credentials, cloud data and consent retained.'
        );
      else if (scanner)
        output.line(`Scanner ${scanner.status}: ${scanner.version ?? scanner.reason}.`);
      if (cli) output.line(cliUpdateLine(cli));
    }
    if (scanner?.status === 'failed') output.error(scanner.reason ?? 'scanner_uninstall_failed');
    return failed ? 1 : hostExit;
  } catch (error) {
    if (error instanceof LauncherError) {
      if (json)
        output.json({ status: error.status, reason: error.message, launcher: error.launcher });
      else output.error(error.message);
      return 3;
    }
    const reason = installFailureReason(error);
    if (reason === 'lock_held') {
      if (json) output.json({ status: 'FAILED', reason });
      else output.error('Another mnemonik command holds the state lock; retry in a moment.');
    } else output.error(reason);
    return 1;
  }
}

async function hostCommand(
  command: HostCommand,
  parsed: Parsed,
  deps: CliDependencies,
  output: Output,
  scannerSelected = false
): Promise<number> {
  const code = await runHostCommand(command, parsed, deps, output, scannerSelected);
  if (command === 'update' || command === 'repair') await reportCurrentInstallation(deps, output);
  return code;
}

async function enableCommand(
  parsed: Parsed,
  deps: CliDependencies,
  output: Output
): Promise<number> {
  const json = parsed.flags.has('json');
  if (parsed.flags.has('non-interactive') || json) {
    const missing = requireConsent(parsed, output, ['accept-scanner', 'apply']);
    if (missing !== undefined) return missing;
    if (!parsed.flags.has('scan-roots'))
      return actionRequired(
        output,
        json,
        'Supply --scan-roots with approved roots',
        '--scan-roots'
      );
  }
  try {
    const roots = parsed.flags.get('scan-roots');
    const exclusions = parsed.flags.get('exclusions');
    const result = await enableScanner({
      stateDir: deps.installStateDir ?? stateDirectory(process.platform, process.env, deps.home),
      cwd: deps.cwd ?? process.cwd(),
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
    });
    if (json) output.json(result);
    else renderStatusSummaries(result, output);
    return result.installation.state === 'READY' ? 0 : 3;
  } catch (error) {
    const result = {
      status: 'ACTION_REQUIRED',
      reason: (error as Error).message,
      action: 'mnemonik scanner enable',
    };
    if (json) output.json(result);
    else output.error(`${result.reason}: ${result.action}`);
    return 3;
  }
}

async function installCommand(
  parsed: Parsed,
  deps: CliDependencies,
  output: Output
): Promise<number> {
  const invalid = allowed(parsed, [
    'components',
    'hosts',
    'integration-scope',
    'scan-roots',
    'exclusions',
    'accept-scanner',
    'accept-limited',
    'without-scanner',
    'apply',
    'no-browser',
    'dry-run',
  ]);
  if (invalid) return (output.error(invalid), 2);
  if (!deps.install && !parsed.flags.has('dry-run')) {
    const { joinedInstall } = await import('./install/journey.js');
    const state =
      deps.hostManagement?.stateDir ??
      deps.installStateDir ??
      stateDirectory(process.platform, process.env, deps.home);
    return joinedInstall(
      parsed.flags,
      deps,
      output,
      () => ensureCliAuth(deps, output, parsed.flags.has('no-browser'), !parsed.flags.has('json')),
      () => hostDependencies(deps, output, state)
    );
  }
  const simulation = parsed.flags.has('dry-run')
    ? simulatedInstall(deps.installStateDir)
    : undefined;
  if (parsed.flags.has('non-interactive') || parsed.flags.has('json'))
    return actionRequired(
      output,
      parsed.flags.has('json'),
      'Run interactively to review the install transaction'
    );
  if (!simulation) {
    try {
      await ensureCliAuth(deps, output, parsed.flags.has('no-browser'));
    } catch (error) {
      output.error(`Sign-in refused: ${installFailureReason(error)}`);
      return 1;
    }
  }
  if (simulation)
    output.line(
      'Simulated dry run: declarations are isolated under the state directory; host sign-ins, projects and uploads are simulated.'
    );
  const terminal = simulation
    ? terminalInstallUI(deps.input ?? process.stdin, output, simulation.roots)
    : undefined;
  const install =
    simulation && terminal
      ? { ...simulation, ui: terminal.ui, signal: terminal.signal }
      : deps.install;
  if (!install) return actionRequired(output, false, 'Install adapters are unavailable');
  try {
    const pending = await interrupted(install.stateDir);
    const result = await runInstall(install, pending[0]);
    output.line(`${result.state}: install ${result.runId}`);
    for (const report of result.reports) output.line(report);
    return result.phase === 'rolled_back'
      ? 130
      : result.state === 'FAILED'
        ? 1
        : result.state === 'READY'
          ? 0
          : 3;
  } catch (error) {
    output.error(`Install failed: ${installFailureReason(error)}`);
    return 1;
  } finally {
    terminal?.close();
  }
}

async function doctorCommand(
  parsed: Parsed,
  deps: CliDependencies,
  output: Output
): Promise<number> {
  const invalid = allowed(parsed, []);
  if (invalid) return (output.error(invalid), 2);
  const result = await runPreflight({ cwd: deps.cwd, home: deps.home, ...deps.preflight });
  output.setContext({ home: deps.home ?? homedir(), projectRoot: result.project.root });
  const document = await collectStatusDocument({
    preflight: result,
    cwd: deps.cwd ?? process.cwd(),
    home: deps.home,
    input: deps.input ?? process.stdin,
    executor: deps.projectExecutor,
    resolver:
      deps.projectResolver ??
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
  if (parsed.flags.has('json')) output.json(document);
  else {
    renderPreflight(result, output);
    renderStatusSummaries(document, output);
  }
  return document.installation.state === 'READY'
    ? 0
    : document.installation.state === 'FAILED'
      ? 1
      : 3;
}

async function collectCurrentInstallation(
  deps: CliDependencies,
  output: Output
): Promise<Awaited<ReturnType<typeof collectStatusDocument>>> {
  const result = await runPreflight({ cwd: deps.cwd, home: deps.home, ...deps.preflight });
  output.setContext({ home: deps.home ?? homedir(), projectRoot: result.project.root });
  const hostStateDir =
    deps.hostManagement?.stateDir ??
    deps.installStateDir ??
    stateDirectory(process.platform, process.env, deps.home);
  const trustConditions = await (
    deps.codexTrustConditions ??
    (() =>
      codexTrustConditions({
        stateDir: hostStateDir,
        env: deps.hostManagement?.env,
        imports: deps.hostManagement?.imports,
      }))
  )();
  const document = await collectStatusDocument({
    preflight: result,
    cwd: deps.cwd ?? process.cwd(),
    home: deps.home,
    input: deps.input ?? process.stdin,
    executor: deps.projectExecutor,
    resolver:
      deps.projectResolver ??
      (deps.preflight?.resolveIdentity
        ? { resolveProjectIdentity: deps.preflight.resolveIdentity }
        : undefined),
    stateDir: deps.projectStateDir ?? deps.installStateDir,
    getCliBearer: deps.getCliBearer,
    transport: deps.projectTransport,
    scannerStatus: deps.scannerStatus,
    installationConditions: [...(deps.installationConditions ?? []), ...trustConditions],
    projectHookConditions: deps.projectHookConditions,
    configuredHosts: deps.configuredHosts ?? deps.install?.input.hosts,
    details: deps.statusDetails,
    grants:
      deps.hostManagement?.grants ??
      grantTransport(async () => {
        const bearer = await auth(deps, output, false).getCliBearer();
        if (typeof bearer !== 'string') throw new Error(bearer.reason);
        return bearer;
      }, deps.grantFetch),
    generatedAt: deps.statusGeneratedAt,
    launcher: { ...deps.launcher, stateDir: hostStateDir, home: deps.home },
  });
  const versions = await readInstallVersions(hostStateDir, document.scanner?.version ?? undefined);
  const installedCli = await new RuntimeStore(hostStateDir)
    .verifyRuntime('cli')
    .catch(() => undefined);
  if (installedCli) versions.cli = installedCli.reference.version;
  return { ...document, versions };
}

async function reportCurrentInstallation(
  deps: CliDependencies,
  output: Output,
  document?: Awaited<ReturnType<typeof collectStatusDocument>>
): Promise<void> {
  const bearer = await auth(deps, output, false)
    .getCliBearer()
    .catch(() => undefined);
  if (typeof bearer !== 'string') return;
  try {
    await postCurrentReadiness(
      bearer,
      baseReadiness(document ?? (await collectCurrentInstallation(deps, output))),
      deps.grantFetch
    );
  } catch {
    output.error('The final installation status could not be uploaded.');
  }
}

export async function runCli(args: string[], deps: CliDependencies = {}): Promise<number> {
  const output = new Output(deps.stdout ?? process.stdout, deps.stderr ?? process.stderr, {
    home: deps.home ?? homedir(),
  });
  if (process.env.MNEMONIK_DEV_RELEASE_DIR)
    (deps.stderr ?? process.stderr).write(
      'WARNING: MNEMONIK_DEV_RELEASE_DIR uses development artifacts; readiness remains LIMITED (dev_release_source).\n'
    );
  const parsed = parse(args);
  if (parsed.error) return (output.error(parsed.error), 2);
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
    if (subcommand) return (output.error(`Unexpected argument: ${subcommand}`), 2);
    return installCommand(parsed, deps, output);
  }
  if (command === 'roots') {
    const invalid = allowed(parsed, ['accept-scanner', 'apply', 'no-browser']);
    if (
      invalid ||
      !['add', 'remove', 'list'].includes(subcommand ?? '') ||
      rest.length !== (subcommand === 'list' ? 0 : 1)
    )
      return (
        output.error(invalid ?? 'Usage: mnemonik roots <add|remove> <path>, or roots list'),
        2
      );
    const stateDir =
      deps.installStateDir ?? stateDirectory(process.platform, process.env, deps.home);
    const saved = JSON.parse(
      await readFile(`${stateDir}/scanner/state.json`, 'utf8').catch(() => 'null')
    ) as { config: { roots: string[]; exclusions?: string[] } } | null;
    if (!saved) return actionRequired(output, parsed.flags.has('json'), 'mnemonik scanner enable');
    if (subcommand === 'list') {
      if (parsed.flags.has('json')) output.json(saved.config.roots);
      else for (const root of saved.config.roots) output.line(root);
      return 0;
    }
    const roots =
      subcommand === 'add'
        ? [...new Set([...saved.config.roots, rest[0] ?? ''])]
        : saved.config.roots.filter((root) => root !== rest[0]);
    parsed.flags.set('scan-roots', roots.join(','));
    parsed.flags.set('exclusions', (saved.config.exclusions ?? []).join(','));
    return enableCommand(parsed, deps, output);
  }
  if (
    command === 'auth' &&
    subcommand === 'logout' &&
    parsed.flags.get('component') === 'scanner'
  ) {
    const invalid = allowed(parsed, ['component']);
    if (invalid || rest.length) return (output.error(invalid ?? 'Unexpected argument'), 2);
    try {
      const stateDir =
        deps.installStateDir ?? stateDirectory(process.platform, process.env, deps.home);
      const saved = JSON.parse(await readFile(`${stateDir}/scanner/state.json`, 'utf8')) as {
        config: { credentialFamilyId: string };
      };
      const bearer = await ensureCliAuth(deps, output, false);
      const response = await (deps.grantFetch ?? fetch)(
        `${apiOrigin()}/api/v1/component-credentials/${encodeURIComponent(saved.config.credentialFamilyId)}/revoke`,
        { method: 'POST', headers: { Authorization: `Bearer ${bearer}` } }
      );
      if (!response.ok) throw new Error(`revoke_failed_${response.status}`);
      const result = {
        status: 'revoked',
        verbs: ['revoke access'],
        retained: ['local software', 'cloud data'],
        action: 'mnemonik scanner enable',
      };
      if (parsed.flags.has('json')) output.json(result);
      else
        output.line(
          'Revoked scanner access. Collection stops on the next rejected upload. Local software and cloud data retained.'
        );
      return 0;
    } catch (error) {
      output.error((error as Error).message);
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
      if (parsed.flags.has('json')) output.json(result);
      else
        output.line(
          `Deleted uploaded cloud data: ${result.deletedChunks} chunks; verified count 0. Local software, credentials, durable memories and tasks retained.`
        );
      return 0;
    } catch (error) {
      output.error((error as Error).message);
      return 3;
    }
  }
  if (
    (command === 'update' || command === 'uninstall') &&
    parsed.flags.get('component') === 'scanner'
  ) {
    const invalid = allowed(parsed, ['component', 'confirm']);
    if (invalid || subcommand) return (output.error(invalid ?? 'Unexpected argument'), 2);
    try {
      const options = {
        stateDir: deps.installStateDir ?? stateDirectory(process.platform, process.env, deps.home),
        ...deps.scannerService,
      };
      if (command === 'update') {
        const runtime = await updateScanner(options, deps.scannerEnable?.source);
        const result = {
          status: 'updated',
          version: runtime.manifest.version,
          cli: { status: 'NOT_SELECTED' },
          ...(process.env.MNEMONIK_DEV_RELEASE_DIR
            ? { status: 'LIMITED', reason: 'dev_release_source' }
            : {}),
        };
        if (parsed.flags.has('json')) output.json(result);
        else output.line(`Scanner ${result.status}: ${result.version}.`);
      } else {
        await scannerService(options).uninstall();
        const result = {
          status: 'uninstalled',
          verbs: ['stop collection', 'remove local software'],
          retained: ['credentials', 'cloud data', 'consent'],
        };
        if (parsed.flags.has('json')) output.json(result);
        else
          output.line(
            'Stopped collection; removed local software. Credentials, cloud data and consent retained.'
          );
      }
      if (command === 'update') await reportCurrentInstallation(deps, output);
      return 0;
    } catch (error) {
      output.error((error as Error).message);
      if (command === 'update') await reportCurrentInstallation(deps, output);
      return 3;
    }
  }
  if (command === 'repair' || command === 'update' || command === 'uninstall') {
    const invalid = allowed(parsed, ['host', 'scope', 'component', 'confirm', 'apply']);
    if (invalid || subcommand)
      return (output.error(invalid ?? `Unexpected argument: ${subcommand}`), 2);
    if (command === 'uninstall' && parsed.flags.has('non-interactive')) {
      const missing = requireConsent(parsed, output, ['confirm']);
      if (missing !== undefined) return missing;
    }
    if (!deps.runtimeUpdate || command !== 'update')
      return hostCommand(command, parsed, deps, output);
  }
  if (command === 'update') {
    const invalid = allowed(parsed, []);
    if (invalid || subcommand)
      return (output.error(invalid ?? `Unexpected argument: ${subcommand}`), 2);
    if (!deps.runtimeUpdate)
      return placeholder(
        output,
        parsed.flags.has('json'),
        'update',
        'runtime release and service restart'
      );
    const runtime = await updateRuntime(deps.runtimeUpdate);
    if (parsed.flags.has('json'))
      output.json({
        status: 'updated',
        artifact: runtime.manifest.artifact,
        version: runtime.manifest.version,
      });
    else output.line(`Updated ${runtime.manifest.artifact} to ${runtime.manifest.version}.`);
    await reportCurrentInstallation(deps, output);
    return 0;
  }
  if (command === 'doctor') {
    if (subcommand) return (output.error(`Unexpected argument: ${subcommand}`), 2);
    return doctorCommand(parsed, deps, output);
  }
  if (command === 'diagnostics') {
    const invalid = allowed(parsed, subcommand === 'preview' ? ['out'] : []);
    const bundleId = rest[0];
    if (
      invalid ||
      !['preview', 'send'].includes(subcommand ?? '') ||
      (subcommand === 'preview' && rest.length) ||
      (subcommand === 'send' && (rest.length !== 1 || !bundleId))
    )
      return (
        output.error(
          invalid ?? 'Usage: mnemonik diagnostics preview [--out <file>] | send <bundle-id>'
        ),
        2
      );
    try {
      const result =
        subcommand === 'preview'
          ? await previewDiagnostics(
              parsed.flags.get('out') as string | undefined,
              deps.diagnostics
            )
          : await sendDiagnostics(bundleId as string, deps.diagnostics);
      const stream = deps.stdout ?? process.stdout;
      if (parsed.flags.has('json')) stream.write(`${JSON.stringify(result)}\n`);
      else if (subcommand === 'preview') {
        const preview = result as Awaited<ReturnType<typeof previewDiagnostics>>;
        stream.write(
          `${JSON.stringify(preview.manifest, null, 2)}\nSHA-256: ${preview.sha256}\nPreview: ${preview.path}\n`
        );
      } else {
        stream.write(`Sent diagnostics bundle ${bundleId}.\n`);
      }
      return 0;
    } catch (error) {
      const code = error instanceof DiagnosticsError ? error.code : 'diagnostics_failed';
      if (parsed.flags.has('json')) output.json({ status: 'error', error: code });
      else output.error(code);
      return 1;
    }
  }
  if (command === 'status') {
    const invalid = allowed(parsed, []);
    if (invalid || subcommand)
      return (output.error(invalid ?? `Unexpected argument: ${subcommand}`), 2);
    const document = await collectCurrentInstallation(deps, output);
    const version = await packageVersion();
    const store = new RuntimeStore(
      deps.installStateDir ?? stateDirectory(process.platform, process.env, deps.home)
    );
    if (!parsed.flags.has('json')) {
      output.line(`CLI ${version}.`);
      renderStatusSummaries(document, output);
    }
    const hint = await cliUpdateHint(store, version);
    if (parsed.flags.has('json'))
      output.json({ ...document, cli: { version, ...(hint ? { updateAvailable: hint } : {}) } });
    else if (hint) output.line(hint);
    await reportCurrentInstallation(deps, output, document);
    return statusExitCode(document);
  }
  if (command === 'connect') {
    const invalid = allowed(parsed, ['approve-host', 'no-browser', 'scope']);
    if (invalid) return (output.error(invalid), 2);
    if (
      !subcommand ||
      rest.length ||
      !supportedHosts.includes(subcommand as (typeof supportedHosts)[number])
    )
      return (output.error('Usage: mnemonik connect <claude-code|codex|cursor|grok>'), 2);
    if (parsed.flags.has('non-interactive') || parsed.flags.has('json')) {
      const missing = requireConsent(parsed, output, ['approve-host']);
      if (missing !== undefined) return missing;
    }
    await ensureCliAuth(deps, output, parsed.flags.has('no-browser'), false);
    const state =
      deps.hostManagement?.stateDir ??
      deps.installStateDir ??
      stateDirectory(process.platform, process.env, deps.home);
    const owned = await selectOwned(
      state,
      subcommand,
      parsed.flags.get('scope') as string | undefined,
      'mcp'
    );
    if (owned.selected.length !== 1)
      return actionRequired(
        output,
        parsed.flags.has('json'),
        owned.selected.length ? 'ambiguous_profile' : 'no_recorded_targets'
      );
    const managed = await hostDependencies(deps, output, state);
    const selected = owned.selected[0];
    if (!selected) throw new Error('no_recorded_targets');
    let approval: boolean | undefined = parsed.flags.has('approve-host') ? true : undefined;
    const result = await connectHost(selected, {
      ...managed,
      noBrowser: parsed.flags.has('no-browser'),
      approveHost: async () =>
        (approval ??=
          (
            await chooseHostProfile(deps.input ?? process.stdin, output, [
              `Approve ${subcommand} for account ${managed.account} on this machine`,
              'Cancel',
            ])
          )?.startsWith('Approve') ?? false),
      instruction: (text) => {
        if (!parsed.flags.has('json')) output.line(text);
      },
      timeout:
        managed.timeout ??
        (parsed.flags.has('json') || parsed.flags.has('non-interactive')
          ? undefined
          : async (host) =>
              (
                await chooseHostProfile(deps.input ?? process.stdin, output, [
                  `Retry ${host}`,
                  `Skip ${host}`,
                ])
              )?.startsWith('Retry')
                ? 'retry'
                : 'skip'),
    });
    if (parsed.flags.has('json')) output.json(result);
    else
      output.line(`${result.status}: ${result.reason}${result.action ? `. ${result.action}` : ''}`);
    return result.status === 'READY' ? 0 : 3;
  }
  if (command === 'project') {
    if (!subcommand || !['init', 'setup', 'status', 'link', 'ensure'].includes(subcommand))
      return (output.error('Usage: mnemonik project <init|setup|status|link|ensure>'), 2);
    const invalid = allowed(
      parsed,
      subcommand === 'ensure'
        ? ['agent']
        : subcommand === 'status'
          ? []
          : subcommand === 'link'
            ? ['apply', 'non-git', 'confirm-mismatch', 'replace', 'owner']
            : ['apply', 'non-git', 'owner']
    );
    if (invalid) return (output.error(invalid), 2);
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
      if (missing !== undefined) return missing;
    }
    if (
      (subcommand === 'link' && (rest.length < 1 || rest.length > 2)) ||
      (subcommand !== 'link' && rest.length > 1)
    )
      return (
        output.error(
          `Usage: mnemonik project ${subcommand}${subcommand === 'link' ? ' <project-id> [path]' : ' [path]'}`
        ),
        2
      );
    return runProjectCommand(
      {
        command: subcommand as 'init' | 'setup' | 'status' | 'link',
        ...(subcommand === 'link' ? { projectId: rest[0], path: rest[1] } : { path: rest[0] }),
        json: parsed.flags.has('json'),
        nonInteractive: parsed.flags.has('non-interactive'),
        apply: parsed.flags.has('apply'),
        nonGit: parsed.flags.has('non-git'),
        confirmMismatch: parsed.flags.has('confirm-mismatch'),
        replace: parsed.flags.has('replace'),
        owner:
          typeof parsed.flags.get('owner') === 'string'
            ? (parsed.flags.get('owner') as string)
            : undefined,
      },
      {
        output,
        input: deps.input ?? process.stdin,
        cwd: deps.cwd ?? process.cwd(),
        home: deps.home,
        executor: deps.projectExecutor,
        resolver: deps.projectResolver,
        stateDir: deps.projectStateDir ?? deps.installStateDir,
        getCliBearer: deps.getCliBearer,
        transport: deps.projectTransport,
      }
    );
  }
  if (command === 'identity') {
    if (subcommand !== 'migrate')
      return (
        output.error(
          'Usage: mnemonik identity migrate [paths] [--report|--backup]\n' +
            '       mnemonik identity migrate [--apply|--verify|--rollback <run-id>]'
        ),
        2
      );
    const invalid = allowed(parsed, ['report', 'backup', 'apply', 'verify', 'rollback']);
    if (invalid) return (output.error(invalid), 2);
    const selected = ['report', 'backup', 'apply', 'verify', 'rollback'].filter((flag) =>
      parsed.flags.has(flag)
    );
    if (selected.length > 1)
      return (
        output.error(
          'Choose one migration phase: --report, --backup, --apply, --verify, or --rollback'
        ),
        2
      );
    const mode = (selected[0] ?? 'report') as 'report' | 'backup' | 'apply' | 'verify' | 'rollback';
    if (rest.length && mode !== 'report' && mode !== 'backup')
      return (output.error('Paths are only accepted by --report and --backup'), 2);
    let result: Awaited<ReturnType<typeof runIdentityMigration>>;
    try {
      result = await runIdentityMigration({
        mode,
        paths: rest,
        runId:
          typeof parsed.flags.get('rollback') === 'string'
            ? (parsed.flags.get('rollback') as string)
            : undefined,
        home: deps.home,
        cwd: deps.cwd,
        stateDir: deps.identityStateDir,
      });
    } catch (error) {
      output.error(`Identity migration failed: ${(error as Error).message}`);
      return 1;
    }
    if (parsed.flags.has('json')) output.json(result);
    else if ('report' in result) {
      for (const entry of result.report.entries)
        output.line(
          `${entry.state.padEnd(16)} ${entry.path}${entry.actionRequired ? ' - ACTION REQUIRED' : ''}${entry.detail ? ` - ${entry.detail}` : ''}`
        );
      output.line(
        `Summary: ${Object.entries(result.report.summary)
          .map(([state, count]) => `${state}=${count}`)
          .join(' ')}`
      );
      if (result.status === 'backed_up')
        output.line(`Backup run: ${result.runId} (${result.count} file(s))`);
    } else {
      output.line(
        `${result.status}: run ${result.runId}; passed=${result.passed}; failed=${result.failed}`
      );
      for (const failure of result.failures) output.error(failure);
    }
    return 'failed' in result && result.failed > 0 ? 1 : 0;
  }
  if (command === 'scanner') {
    if (
      !subcommand ||
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
      ].includes(subcommand)
    )
      return (output.error('Usage: mnemonik scanner <enable|start|stop|uninstall|status>'), 2);
    const invalid = allowed(
      parsed,
      subcommand === 'enable'
        ? ['accept-scanner', 'apply', 'scan-roots', 'exclusions', 'no-browser']
        : subcommand === 'export-preview'
          ? ['out']
          : []
    );
    if (invalid) return (output.error(invalid), 2);
    if (subcommand === 'enable') return enableCommand(parsed, deps, output);
    if (subcommand === 'status' && deps.scannerStatus) {
      const status = await deps.scannerStatus();
      const omitted: ReadinessCondition[] = status.repositories
        .filter((repository) => !repository.selected)
        .map((repository) => ({
          kind: 'scanner_omitted',
          component: repository.path,
          reason: `${repository.path} was omitted from scanner coverage.`,
          action: 'Run mnemonik scanner enable to change coverage.',
        }));
      const projects: ProjectReadinessInput[] = status.repositories.map((repository) => {
        const conditions: ReadinessCondition[] = !repository.selected
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
      if (parsed.flags.has('json')) output.json(document);
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
      timeout:
        json || parsed.flags.has('non-interactive')
          ? undefined
          : async (phase) =>
              (
                await chooseHostProfile(deps.input ?? process.stdin, output, [
                  `Retry scanner ${phase}`,
                  'Skip scanner',
                ])
              )?.startsWith('Retry')
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
      } else if (subcommand === 'start') {
        const supervisor = await service.status();
        if (supervisor.running) {
          if (json)
            output.json({
              status: 'ACTION_REQUIRED',
              reason: 'instance_running',
              pid: supervisor.pid,
            });
          else output.line(`Scanner is already running (PID ${supervisor.pid}).`);
          return 3;
        }
        await service.start();
      } else if (subcommand === 'stop') await service.stop();
      else if (subcommand === 'uninstall') await service.uninstall();
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
      if (json) output.json(result);
      else {
        output.line(
          subcommand === 'status' && supervisor
            ? supervisor.installed
              ? `Scanner status: ${result.status} (service: ${supervisor.kind}, ${supervisor.running ? 'running' : 'stopped'})`
              : `Scanner status: ${result.status} (service not registered; run mnemonik scanner start)`
            : `Scanner ${subcommand}: ${result.status}`
        );
        if ('receipt' in result && result.receipt)
          output.line(JSON.stringify(result.receipt.snapshot));
      }
      return 0;
    } catch (error) {
      const result = {
        status: 'LIMITED',
        reason:
          error instanceof ScannerServiceLimited ? error.reason : 'scanner_service_unavailable',
        detail: (error as Error).message,
        action: 'mnemonik scanner enable',
        choices: ['retry', 'skip'],
      };
      if (json) output.json(result);
      else
        output.line(
          `LIMITED: ${result.reason}: ${result.detail}. Retry: ${result.action}, or skip.`
        );
      return 3;
    }
  }
  if (command === 'auth') {
    const invalid = allowed(parsed, ['host', 'confirm', 'no-browser', 'reopen-install']);
    if (
      invalid ||
      rest.length ||
      !['login', 'status', 'logout'].includes(subcommand ?? '') ||
      (parsed.flags.has('reopen-install') && subcommand !== 'login')
    )
      return (
        output.error(invalid ?? 'Usage: mnemonik auth <login|status|logout> [--host <host>]'),
        2
      );
    const host = parsed.flags.get('host');
    if (host && !hostOrder.includes(host as never)) return (output.error('Invalid host'), 2);
    if (subcommand === 'login') {
      if (host) return (output.error('Use mnemonik connect <host> for a host login'), 2);
      const noBrowser = parsed.flags.has('no-browser');
      const bearer = await ensureCliAuth(deps, output, noBrowser);
      if (parsed.flags.has('reopen-install')) {
        const current = await currentInstallSession(bearer, deps.grantFetch);
        if (current) {
          if (typeof current.expires_at !== 'string') throw new Error('invalid_install_session');
          output.line(
            `An install session is already open until ${current.expires_at}; run the install again`
          );
          return 0;
        }
        const installation = (await grantTransport(async () => bearer, deps.grantFetch).list())
          .deviceInstallationId;
        if (!installation) throw new Error('installation_required');
        const sessionAuth =
          deps.cliAuth ??
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
            if (typeof reopened !== 'string') throw new Error(reopened.reason);
            return reopened;
          },
        });
      }
      return 0;
    }
    if (subcommand === 'logout' && !host) {
      await auth(deps, output, false).logout();
      if (parsed.flags.has('json')) output.json({ status: 'logged_out' });
      else output.line('Logged out.');
      return 0;
    }
    const state =
      deps.hostManagement?.stateDir ??
      deps.installStateDir ??
      stateDirectory(process.platform, process.env, deps.home);
    let managed: HostDependencies;
    try {
      managed = await hostDependencies(deps, output, state);
    } catch (error) {
      if (!isCredentialSessionUnavailableError(error)) throw error;
      if (parsed.flags.has('json'))
        output.json({ status: 'ACTION_REQUIRED', reason: error.reason, detail: error.message });
      else output.line(error.message);
      return 3;
    }
    if (!managed.grants)
      return actionRequired(output, parsed.flags.has('json'), 'host_grant_unverified');
    if (subcommand === 'status') {
      const status = await managed.grants.list();
      if (status.account !== managed.account)
        return actionRequired(output, parsed.flags.has('json'), 'host_account_mismatch');
      const grants = status.grants
        .filter((g) => !host || grantHost(g) === host)
        .map((g) => ({ ...g, host: grantHost(g) ?? g.clientName ?? g.clientId }));
      if (parsed.flags.has('json')) output.json({ account: status.account, grants });
      else
        for (const g of grants)
          output.line(
            `${g.host}: ${g.id}; created ${g.createdAt}; last used ${g.lastUsedAt ?? 'never'}; scopes ${g.scopes.join(', ')}`
          );
      return 0;
    }
    const confirmed =
      parsed.flags.has('confirm') ||
      (await managed.offerRevoke?.(host as HostSelection['host'])) ||
      (!parsed.flags.has('json') &&
        !parsed.flags.has('non-interactive') &&
        (
          await chooseHostProfile(deps.input ?? process.stdin, output, [
            'Keep grant',
            `Revoke ${host} grant`,
          ])
        )?.startsWith('Revoke'));
    if (!confirmed)
      return actionRequired(
        output,
        parsed.flags.has('json'),
        `Confirm revocation with mnemonik auth logout --host ${host} --confirm`
      );
    const revoked = await logoutHost(host as HostSelection['host'], {
      ...managed,
      instruction: (text) => {
        if (!parsed.flags.has('json')) output.line(text);
      },
    });
    if (parsed.flags.has('json')) output.json({ status: 'revoked', host, grants: revoked });
    else output.line(`Revoked ${revoked.length} ${host} grant(s).`);
    return 0;
  }
  if (command === 'logout') {
    if (subcommand) return (output.error(`Unexpected argument: ${subcommand}`), 2);
    const invalid = allowed(parsed, []);
    if (invalid) return (output.error(invalid), 2);
    await auth(deps, output, false).logout();
    if (parsed.flags.has('json')) output.json({ status: 'logged_out' });
    else output.line('Logged out.');
    return 0;
  }
  output.error(`Unknown command: ${command}`);
  return 2;
}

const serializeReadiness: typeof baseReadiness = (input) => devReadiness(baseReadiness(input));
