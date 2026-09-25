import {
  humanReason,
  humanReport,
  humanIdentityState,
  INTERRUPTED_INSTALL,
  INTERRUPTED_INSTALL_MESSAGE,
  SCANNER_CONSENT_MESSAGE,
  SCANNER_UPDATE_CONSENT_MESSAGE,
} from './humanReason.js';
import { consentDecision, consentLines } from './consent.js';
import { helpScreen } from './help.js';
import { enableScanner, updateScannerRoots, type EnableOptions } from './scanner/enable.js';
import {
  ABANDONED_PAUSE_RESUMED,
  controlScanner,
  pausedForConsent,
  scannerReceipt,
} from './scanner/control.js';
import { ScannerConsentRequired, updateScanner } from './scanner/update.js';
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
  logoutHost,
  selectOwned,
  type HostDependencies,
  type HostCommand,
  type HostResult,
  type HostSelection,
} from './install/hosts.js';
import { hostOrder, launchHostLabels } from './install/adapters.js';
import { readInstallVersions } from './install/ownership.js';
import { ensureLauncher, removeLauncher, LauncherError, type LauncherOptions } from './launcher.js';
import { readFile, realpath } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { RuntimeStore, updateRuntime, type RuntimeUpdate } from './runtime/store.js';
import { recordUpdateCheck } from './runtime/updateCheck.js';
import { updateCli, cliUpdateHint } from './runtime/selfUpdate.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { Output, type Writable } from './output.js';
import { SCANNER_RESTART_MESSAGE } from './scanner/service.js';
import { SCANNER_FAILURE_MESSAGE, SCANNER_RETRY_MESSAGE } from './screens/journey.js';
import { renderPreflight, runPreflight, type PreflightDependencies } from './preflight.js';
import { postCurrentReadiness, type InstallSessionTransport } from './installSession.js';
import {
  createRealProjectRuntime,
  ensureProjectRoot,
  ensureProjectForAgent,
  folderRefusalMessage,
  projectLimitMessage,
  runProjectCommand,
  type ProjectExecutor,
  type ProjectReadTransport,
} from './project.js';
import { evaluateRoot } from './project/eligibility.js';
import { accountActions } from './transport/server.js';
import {
  apiOrigin,
  describeReadiness,
  serializeReadiness as baseReadiness,
  type ProjectReadinessInput,
  type ReadinessCondition,
  resolveProjectIdentity,
} from '@mnemonik/shared';
import { grantTransport, grantHost, grantSummaryLines, signedInElsewhere } from './auth/status.js';
import { createCliAuth } from './auth/index.js';
import { runEditorLogin, type EditorLoginOverrides } from './auth/pkce.js';
import { currentInstallSession, ensureInstallSession } from './auth/installSession.js';
import { runIdentityMigration } from './identity/migrate.js';
import { renderScannerStatus, type ScannerPickerResult } from './scanner/picker.js';
import { abandonInterrupted, closeUntouchedScannerRun, interrupted } from './install/journal.js';
import {
  installFailureReason,
  runInstall,
  type InstallDependencies,
} from './install/transaction.js';
import { chooseHostProfile, simulatedInstall, terminalInstallUI } from './install/ui.js';
import {
  CODEX_TRUST_MESSAGE,
  collectStatusDocument,
  localEditorStatus,
  localInstallationConditions,
  mcpTurnOnAction,
  renderStatusSummaries,
  renderRefusals,
  REPORT_NOT_SENT,
  renderScannerFailure,
  statusExitCode,
  type StatusDocumentInput,
} from './status.js';
import { editorAuthorizationRows } from './screens/journey.js';
import {
  DiagnosticsError,
  previewDiagnostics,
  sendDiagnostics,
  type DiagnosticsDependencies,
} from './diagnostics.js';

export const connectFolderPrompt = (name: string): string => `Connect ${name} to Mnemonik? [Y/n]`;
export const removeFolderPrompt = (name: string): string =>
  `Stop indexing ${name}? Its memories stay in your account. [y/N]`;
export const connectedFolderLine = (name: string): string => `  ✓ Connected ${name}.`;
export const alreadyConnectedFolderLine = (name: string): string =>
  `  ✓ ${name} is already connected and watched.`;
export const removedFolderLine = (name: string): string => `  ✓ ${name} is no longer connected.`;
export const projectDeletionWarning = (name: string): string =>
  `Deleting ${name} removes its memories, code index and summaries for everyone. This cannot be undone.`;
export const projectDeletedLine = (name: string): string => `Deleted ${name}.`;
export const NOTHING_DELETED_LINE = 'Nothing was deleted.';
export const NOTHING_REMOVED_LINE = 'Nothing was removed.';
export const SCANNER_UNINSTALL_PROMPT =
  'Uninstalling background indexing means your code on this machine is no longer\n' +
  'indexed. Agents here lose code search and file context until you set it up\n' +
  'again with mnemonik scanner enable. This also withdraws your indexing consent\n' +
  'for this machine. Type yes to continue.';
export const SCANNER_REMOVED_LINE = 'Background indexing removed from this machine.';

/** Withdraw this machine's indexing consent: revoke its scanner credential. */
async function revokeScannerCredential(
  deps: CliDependencies,
  output: Output,
  stateDir: string,
  saved?: { config: { credentialFamilyId: string } }
): Promise<void> {
  const state =
    saved ??
    (JSON.parse(await readFile(`${stateDir}/scanner/state.json`, 'utf8')) as {
      config: { credentialFamilyId: string };
    });
  const bearer = await ensureCliAuth(deps, output, false);
  const response = await (deps.grantFetch ?? fetch)(
    `${apiOrigin()}/api/v1/component-credentials/${encodeURIComponent(state.config.credentialFamilyId)}/revoke`,
    { method: 'POST', headers: { Authorization: `Bearer ${bearer}` } }
  );
  if (!response.ok) throw new Error(`revoke_failed_${response.status}`);
}

/**
 * Uninstalling background indexing is an opt-out. Asks first unless --confirm;
 * returns an exit code when the person did not agree, otherwise undefined.
 */
async function confirmScannerOptOut(
  parsed: Parsed,
  deps: CliDependencies,
  output: Output
): Promise<number | undefined> {
  if (parsed.flags.has('confirm')) return undefined;
  if (parsed.flags.has('json') || parsed.flags.has('non-interactive'))
    return actionRequired(output, parsed.flags.has('json'), 'Rerun with --confirm', '--confirm');
  output.line(SCANNER_UNINSTALL_PROMPT);
  const readline = createInterface({ input: deps.input ?? process.stdin, terminal: false });
  const answer = String((await readline[Symbol.asyncIterator]().next()).value ?? '').trim();
  readline.close();
  if (/^(?:y|yes)$/iu.test(answer)) return undefined;
  output.line(NOTHING_REMOVED_LINE);
  return 130;
}

/** Withdraw this machine's indexing consent, then remove the scanner service. */
async function uninstallScannerOptOut(
  deps: CliDependencies,
  output: Output,
  service: { uninstall(): Promise<void> },
  json: boolean
): Promise<number> {
  // Read the credential before removal takes the local state with it.
  const stateDir = deps.installStateDir ?? stateDirectory(process.platform, process.env, deps.home);
  const saved = await readFile(`${stateDir}/scanner/state.json`, 'utf8').then(
    (text) => JSON.parse(text) as { config: { credentialFamilyId: string } },
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    }
  );
  // Withdraw first: if the revoke fails, nothing is removed and the person can retry.
  if (saved)
    try {
      await revokeScannerCredential(deps, output, stateDir, saved);
    } catch (error) {
      output.error(humanReason((error as Error).message));
      return 3;
    }
  await service.uninstall();
  if (json) output.json({ status: 'uninstalled', consent: saved ? 'withdrawn' : 'none' });
  else output.line(SCANNER_REMOVED_LINE);
  return 0;
}
export const dataDeletePrompt = (projectId: string): string =>
  `This deletes everything background indexing has sent for ${projectId} from your account. Type yes to continue.`;
export const stillWatchedLine = (root: string): string =>
  `The folder is still being indexed. Run mnemonik remove ${root} to stop that.`;
export const identityFileKeptLine =
  "This folder's .mnemonik.json still points at the deleted project. Connecting the folder again creates a new project.";
export const CODEX_SIGNED_IN_MESSAGE = 'Codex is signed in to Mnemonik.';
/** An editor signed in on another of the person's machines (L-182). */
export const signedInElsewhereMessage = (editor: string) =>
  `${editor} is already signed in to Mnemonik from another of your machines.`;
export const CONNECT_NOT_APPROVED_MESSAGE =
  'Sign-in timed out. Run mnemonik connect codex to try again.';

export function maintenanceExitCode(results: readonly Pick<HostResult, 'status'>[]): number {
  if (results.some((result) => result.status === 'FAILED')) return 1;
  return results.every((result) => result.status === 'READY') ? 0 : 3;
}

async function retryUpdateOnce<T>(
  update: () => Promise<T>,
  failed: (result: T) => boolean = () => false
): Promise<T> {
  try {
    const result = await update();
    return failed(result) ? update() : result;
  } catch (error) {
    // Asking again changes nothing until a person approves the updated notice.
    if (error instanceof ScannerConsentRequired) throw error;
    return update();
  }
}

/**
 * Whether a person is there to answer: no --json, no --non-interactive, and a
 * terminal on stdin. Without a terminal (a script, a pipe, a scheduler) the
 * commands that would open a consent or sign-in flow and wait on it (update,
 * scanner enable, add, remove) behave exactly as with --non-interactive; install
 * decides the same way in its own journey. An injected input stream counts as
 * a terminal unless it says isTTY: false, so callers that answer prompts
 * through one keep doing so.
 */
function personPresent(parsed: Parsed, deps: CliDependencies): boolean {
  if (parsed.flags.has('json') || parsed.flags.has('non-interactive')) return false;
  if (deps.input) return (deps.input as Readable & { isTTY?: boolean }).isTTY !== false;
  return process.stdin.isTTY === true;
}

/**
 * A scanner release names a newer notice than the saved consent. With a person
 * at the terminal, ask once in the browser through the flow install uses, over
 * the folders already approved; it installs the new scanner when approved and
 * puts the running one back when not. Without one (automatic, --json,
 * --non-interactive), nothing changes and the running scanner keeps indexing.
 */
async function approveScannerUpdate(
  parsed: Parsed,
  deps: CliDependencies,
  output: Output,
  stateDir: string
): Promise<'approved' | 'pending'> {
  if (parsed.flags.has('automatic') || !personPresent(parsed, deps)) return 'pending';
  const saved = JSON.parse(await readFile(join(stateDir, 'scanner/state.json'), 'utf8')) as {
    config: { roots: string[]; exclusions?: string[] };
  };
  try {
    const document = await enableScanner({
      stateDir,
      cwd: deps.cwd ?? process.cwd(),
      home: deps.home,
      input: deps.input ?? process.stdin,
      output,
      noBrowser: parsed.flags.has('no-browser'),
      roots: saved.config.roots,
      exclusions: saved.config.exclusions ?? [],
      ...deps.scannerService,
      ...deps.scannerEnable,
      projectExecutor: deps.projectExecutor,
      projectStateDir: deps.projectStateDir,
    });
    return document.installation.state === 'READY' ? 'approved' : 'pending';
  } catch {
    return 'pending';
  }
}

/** The scanner paused itself for consent: the decided two lines, never the resume line. */
function scannerConsentRequired(output: Output, json: boolean): number {
  if (json)
    output.json({
      status: 'ACTION_REQUIRED',
      reason: 'scanner_consent_required',
      action: 'mnemonik scanner enable',
    });
  else {
    output.line(SCANNER_CONSENT_MESSAGE.sentence);
    output.line(SCANNER_CONSENT_MESSAGE.nextStep);
  }
  return 3;
}

function hostUpdateFailed(result: { results: readonly HostResult[] }): boolean {
  return result.results.some(
    (target) => target.status !== 'READY' && target.reason !== 'codex_trust_pending'
  );
}
const updateFailureMessage = 'Mnemonik could not update. It will try again automatically tomorrow.';
const booleans = new Set([
  'json',
  'non-interactive',
  'agent',
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
  'cancel',
  'retry',
  'skip',
]);
const values = new Set([
  'components',
  'hosts',
  'scan-roots',
  'host',
  'component',
  'owner',
  'rollback',
  'out',
  'project',
  'exclusions',
]);

export const help = helpScreen([]) ?? '';

interface Parsed {
  positionals: string[];
  flags: Map<string, string | true>;
  error?: string;
  /** --json anywhere in the arguments, even after a flag that stopped parsing. */
  json?: boolean;
}

function parse(args: string[]): Parsed {
  return { ...parseArguments(args), json: args.includes('--json') };
}

function parseArguments(args: string[]): Parsed {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  // Only `mnemonik project delete` takes a project name after --confirm.
  // Everywhere else the flag stands alone and the next word is that command's
  // own argument.
  const namedConfirm = args[0] === 'project' && args[1] === 'delete';
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
      const takesName = name === 'confirm' && namedConfirm;
      if (inline !== undefined && !takesName)
        return { positionals, flags, error: `Unknown flag: ${argument}` };
      const next = args[index + 1];
      let value: string | true = true;
      if (takesName && inline !== undefined) value = inline;
      else if (takesName && next !== undefined && !next.startsWith('--')) {
        value = next;
        index++;
      }
      flags.set(name, value);
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

type UsageReason =
  | 'unknown_command'
  | 'unknown_subcommand'
  | 'missing_subcommand'
  | 'missing_argument'
  | 'invalid_flag'
  | 'invalid_value';

/** The words that name a help screen: `auth logout extra` is `auth logout`. */
function commandPath(positionals: string[]): string[] {
  for (let length = positionals.length; length > 0; length--)
    if (helpScreen(positionals.slice(0, length))) return positionals.slice(0, length);
  return [];
}

/**
 * Every usage error leaves through here. With --json it is one JSON object on
 * stdout and nothing else; without, the person gets the sentence, or the
 * command's help screen when there is no sentence.
 */
function usageFailure(
  output: Output,
  parsed: Parsed,
  failure: { reason: UsageReason; path?: string[]; detail?: string },
  human: string | (() => void)
): 2 {
  if (parsed.json) {
    const command =
      failure.reason === 'unknown_command'
        ? (parsed.positionals[0] ?? '')
        : (failure.path ?? commandPath(parsed.positionals)).join(' ');
    output.json({
      status: 'usage_error',
      reason: failure.reason,
      command,
      ...(failure.detail ? { detail: failure.detail } : {}),
      action:
        failure.reason === 'unknown_command' || !command
          ? 'mnemonik --help'
          : `mnemonik ${command} --help`,
    });
  } else if (typeof human === 'string') output.error(human);
  else human();
  return 2;
}

/** A flag the command does not take, or a flag given without its value. */
function flagError(output: Output, parsed: Parsed, message: string): 2 {
  const [, kind, detail] = /^(Unknown flag|Missing value for flag)(?: combination)?: (\S+)/u.exec(
    message
  ) ?? [undefined, 'Unknown flag'];
  const reason = kind === 'Unknown flag' ? 'invalid_flag' : 'invalid_value';
  return usageFailure(output, parsed, { reason, detail }, message);
}

/**
 * The reason for a command's help screen shown as an error, from the words
 * given against the words the screen names. Commands that take arguments say
 * their own reason.
 */
function usageReason(
  positionals: string[],
  path: string[]
): { reason: UsageReason; detail?: string } {
  if (!path.length) return { reason: 'unknown_command' };
  for (let index = 1; index < path.length; index++)
    if (positionals[index] !== path[index])
      return positionals[index] === undefined
        ? { reason: index === 1 ? 'missing_subcommand' : 'missing_argument' }
        : { reason: 'unknown_subcommand', detail: positionals[index] };
  const extra = positionals[path.length];
  if (extra !== undefined)
    return { reason: path.length === 1 ? 'unknown_subcommand' : 'invalid_value', detail: extra };
  return { reason: path.length === 1 ? 'missing_subcommand' : 'missing_argument' };
}

function allowed(parsed: Parsed, names: string[]): string | undefined {
  const permitted = new Set(['json', 'non-interactive', 'no-browser', 'help', ...names]);
  for (const name of parsed.flags.keys())
    if (!permitted.has(name)) return `Unknown flag: --${name}`;
  return undefined;
}

function actionRequired(output: Output, json: boolean, message: string, flag?: string): number {
  const decision = flag ? consentDecision(flag) : undefined;
  if (json)
    output.json({
      status: 'action_required',
      reason: 'consent_required',
      ...(flag ? { flag } : {}),
      action: message,
      ...(decision
        ? { question: decision.question, then: decision.then, answers: decision.answers }
        : {}),
    });
  else if (flag) for (const line of consentLines(flag)) output.error(line);
  else output.error(/^[a-z][a-z0-9_]*$/u.test(message) ? humanReason(message) : message);
  return 3;
}

/**
 * A scanner wait that ran out with nobody at the terminal: `--retry` waits once
 * more, then gives up; without it the wait gives up at once.
 */
function retryOnce(flags: Map<string, string | true>): EnableOptions['timeout'] {
  if (!flags.has('retry')) return undefined;
  let retried = false;
  return async () => (retried ? 'skip' : ((retried = true), 'retry'));
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
  editorLogin?: EditorLoginOverrides;
  cliAuth?: {
    signIn(): Promise<unknown>;
    getCliBearer(): Promise<string | { status: string; reason: string }>;
    accountEmail?(bearer: string): Promise<string>;
    logout(): Promise<void>;
  };
  identityStateDir?: string;
  scannerService?: ScannerServiceOptions;
  scannerEnable?: Partial<EnableOptions>;
  /** The disclosure version the scanner this CLI installs expects; the bundled release manifest by default. */
  scannerDisclosureVersion?: () => Promise<string | undefined>;
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
  showIdentity = true,
  fresh = false
) {
  const cliAuth = auth(deps, output, noBrowser);
  // A fresh sign-in never reads the stored token: the server already refused it.
  let bearer = fresh
    ? { status: 'ACTION_REQUIRED', reason: 'renew' }
    : await cliAuth.getCliBearer().catch((error: unknown) => {
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
  const bearer = await cliAuth.getCliBearer();
  if (typeof bearer !== 'string') throw new Error(bearer.reason);
  if (!cliAuth.accountEmail) throw new Error('account_identity_failed');
  const email = await cliAuth.accountEmail(bearer);
  const installation = JSON.parse(
    await readFile(join(state, 'installation.json'), 'utf8').catch(() => '{}')
  ) as { account?: unknown };
  return {
    stateDir: state,
    account: typeof installation.account === 'string' ? installation.account : email,
    grants,
    getCliBearer: async () => {
      const bearer = await cliAuth.getCliBearer();
      if (typeof bearer !== 'string') throw new Error(bearer.reason);
      return bearer;
    },
    credentialFetch: deps.grantFetch,
  };
}

async function updateHostDependencies(
  deps: CliDependencies,
  state: string
): Promise<HostDependencies> {
  if (deps.hostManagement) return { ...deps.hostManagement, stateDir: state };
  const installation = JSON.parse(
    await readFile(join(state, 'installation.json'), 'utf8').catch(() => '{}')
  ) as { account?: unknown };
  return {
    stateDir: state,
    account: typeof installation.account === 'string' ? installation.account : '',
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
  const host = parsed.flags.get('host');
  const component = parsed.flags.get('component');
  const fullUninstall = command === 'uninstall' && !host && !component;
  if (
    (host && !hostOrder.includes(host as never)) ||
    (component && !['hooks', 'mcp'].includes(String(component)))
  )
    return usageFailure(
      output,
      parsed,
      {
        reason: 'invalid_value',
        detail: String(host && !hostOrder.includes(host as never) ? host : component),
      },
      'Invalid host or component'
    );
  if (command === 'uninstall') await abandonInterrupted(state);
  // A scanner approval killed while it waited changed nothing; it must not
  // block the host step. One still running keeps its lease and is named below.
  else if (command === 'update') await closeUntouchedScannerRun(state).catch(() => false);
  let selections: HostSelection[];
  if (command === 'install') {
    const names = String(parsed.flags.get('hosts') ?? hostOrder.join(',')).split(',');
    const unknownHost = names.find((name) => !hostOrder.includes(name as never));
    if (unknownHost !== undefined)
      return usageFailure(
        output,
        parsed,
        { reason: 'invalid_value', detail: unknownHost },
        'Invalid hosts'
      );
    const components = String(parsed.flags.get('components') ?? 'hooks,mcp').split(',');
    if (components.some((c) => !['hooks', 'mcp'].includes(c)))
      return placeholder(output, json, 'install scanner', 'scanner setup');
    const missing = requireConsent(parsed, output, [
      ...(scannerSelected ? [] : ['accept-limited']),
      'apply',
    ]);
    if (missing !== undefined) return missing;
    await ensureCliAuth(deps, output, parsed.flags.has('no-browser'), false);
    selections = [...new Set(names)].flatMap((name) =>
      [...new Set(components)].map((component) => ({
        component: component as 'hooks' | 'mcp',
        host: name as HostSelection['host'],
        scope: 'user',
        home: deps.home ?? homedir(),
        projectRoot: deps.cwd ?? process.cwd(),
      }))
    );
  } else {
    const resolved = await selectOwned(
      state,
      host ? String(host) : undefined,
      undefined,
      component ? String(component) : undefined
    );
    resolved.selected = resolved.selected.filter((target) =>
      hostOrder.includes(target.host as never)
    );
    resolved.ambiguous = resolved.ambiguous.filter((profile) =>
      resolved.selected.some((target) => target.profilePath === profile)
    );
    if (command === 'update')
      resolved.selected = resolved.selected.filter((target) => target.component === 'hooks');
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
    if ((host || component) && !selections.length && !(await interrupted(state)).length) {
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
    if (command === 'update') await retryUpdateOnce(() => ensureLauncher(launcherOptions));
    else if (command === 'repair') await ensureLauncher(launcherOptions);
    const all = command === 'update' && !host && !component;
    const store = new RuntimeStore(state);
    const cli = all
      ? await retryUpdateOnce(
          () => updateCli(store),
          (result) => result.status === 'FAILED'
        )
      : undefined;
    const updatedCli =
      selections.length && (cli?.status === 'UPDATED' || cli?.status === 'UP_TO_DATE')
        ? await retryUpdateOnce(() => store.verifyRuntime('cli'))
        : undefined;
    const managed =
      selections.length || (await interrupted(state)).length
        ? command === 'update'
          ? await retryUpdateOnce(() => updateHostDependencies(deps, state))
          : await hostDependencies(deps, output, state)
        : undefined;
    const maintainHosts = (dependencies: HostDependencies) =>
      runHosts(
        command,
        selections,
        {
          ...dependencies,
          noBrowser: parsed.flags.has('no-browser'),
          source:
            dependencies.source ??
            (updatedCli
              ? (host) =>
                  hostSource(
                    host,
                    join(updatedCli.directory, 'node_modules/@mnemonik/cli/package.json')
                  )
              : undefined),
          instruction: json ? undefined : (text) => output.line(text),
          apply: parsed.flags.has('apply'),
        },
        false
      );
    // A host step that throws is that step's failure, named below; the scanner
    // step still runs and the update never collapses into one generic line.
    let hostError: string | undefined;
    const result = managed
      ? command === 'update'
        ? await retryUpdateOnce(() => maintainHosts(managed), hostUpdateFailed).catch(
            (error: unknown) => {
              hostError = (error as Error).message;
              return { journal: { state: 'FAILED' }, results: [], reports: [] as string[] };
            }
          )
        : await maintainHosts(managed)
      : { journal: { state: 'READY' }, results: [], reports: [] };
    let scanner:
      | {
          status: string;
          version?: string;
          reason?: string;
          action?: string;
          summary?: string;
          verbs?: string[];
          retained?: string[];
        }
      | undefined;
    let launcher: { status: 'removed' | 'not_installed' | 'retained' } | undefined;
    let scannerRecovery: { message: string; action: string } | undefined;
    if (
      all &&
      (await readFile(`${state}/scanner/state.json`).then(
        () => true,
        () => false
      ))
    ) {
      try {
        const before = await store.verifyRuntime('scanner').catch(() => undefined);
        const runtime = await retryUpdateOnce(() =>
          updateScanner(
            {
              stateDir: state,
              ...deps.scannerService,
              onScannerRestartRequested: () => {
                if (!json) output.line(SCANNER_RESTART_MESSAGE);
              },
              onAbandonedPauseResumed: () => {
                if (!json) output.line(ABANDONED_PAUSE_RESUMED);
              },
            },
            deps.scannerEnable?.source
          )
        );
        scanner = {
          status:
            before?.reference.version === runtime.reference.version ? 'UP_TO_DATE' : 'UPDATED',
          version: runtime.manifest.version,
        };
      } catch (error) {
        if (error instanceof ScannerConsentRequired)
          scanner =
            (await approveScannerUpdate(parsed, deps, output, state)) === 'approved'
              ? { status: 'UPDATED' }
              : {
                  status: 'ACTION_REQUIRED',
                  reason: 'scanner_update_consent_required',
                  action: 'mnemonik scanner enable',
                };
        else scanner = { status: 'FAILED', reason: (error as Error).message };
        if (!json && scanner.status === 'FAILED')
          scannerRecovery = await scannerRecoveryAction(error, {
            stateDir: state,
            ...deps.scannerService,
          });
      }
    }
    let failed = scanner?.status === 'FAILED' || cli?.status === 'FAILED';
    const scannerConsentPending = scanner?.status === 'ACTION_REQUIRED';
    const hostExit = maintenanceExitCode(result.results);
    const remaining =
      command === 'repair' ? await collectCurrentInstallation(deps, output) : undefined;
    const remainingExit =
      remaining?.installation.state === 'FAILED'
        ? 1
        : remaining?.installation.state === 'READY' || !remaining
          ? 0
          : 3;
    const hostsFailed = hostError !== undefined || hostUpdateFailed(result);
    const codexTrustPending = result.results.some(
      (target) => target.reason === 'codex_trust_pending'
    );
    // Every host update is journaled: a failed one has already put the previous
    // runtime back. The record says so to the console through the readiness report.
    if (all)
      await recordUpdateCheck(
        state,
        failed || hostsFailed
          ? 'failed'
          : cli?.status === 'UPDATED' || result.reports.length > 0 || scanner?.status === 'UPDATED'
            ? 'updated'
            : 'current'
      );
    if (fullUninstall && hostExit === 0) {
      // A damaged install can lose the runtime pointer and still leave a service
      // registered, so the saved scanner state also counts as one to remove. A
      // machine that never had a scanner must not be asked about one.
      const installed = await Promise.all(
        [new RuntimeStore(state).pointerPath('scanner'), `${state}/scanner/state.json`].map(
          (path) =>
            readFile(path).then(
              () => true,
              () => false
            )
        )
      );
      if (installed.some(Boolean)) {
        try {
          await scannerService({ stateDir: state, ...deps.scannerService }).uninstall();
          scanner = {
            status: 'uninstalled',
            verbs: ['stop collection', 'remove local software'],
            retained: ['credentials', 'cloud data', 'consent'],
          };
        } catch (error) {
          const failure =
            scannerFailure(error) ??
            new ScannerServiceLimited('scanner_service_unavailable', (error as Error).message);
          scanner = {
            status: 'failed',
            reason: (error as Error).message,
            action: failure.action,
            summary: failure.summary,
          };
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
        status:
          failed || remainingExit === 1
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
      if (failed || hostsFailed) {
        // A part that updated is said so, and only the part that did not gets a step.
        if (cli?.status === 'UPDATED') output.line('The mnemonik command updated.');
        if (result.reports.length > 0 && !hostsFailed) output.line('Your coding tools updated.');
        if (scanner?.status === 'UPDATED') output.line('The scanner updated.');
        if (cli?.status === 'FAILED') {
          output.error('The mnemonik command could not update.');
          output.error('Run npx -y @mnemonik/cli@latest install to update it.');
        }
        if (hostsFailed) {
          output.error('Your coding tools could not update.');
          if (hostError && INTERRUPTED_INSTALL.test(hostError)) {
            output.error(INTERRUPTED_INSTALL_MESSAGE.sentence);
            output.error(INTERRUPTED_INSTALL_MESSAGE.nextStep);
          } else if (hostError === 'lock_held') output.error(humanReason(hostError));
          else output.error('Run mnemonik repair, then start a new session in each coding tool.');
        }
        if (scanner?.status === 'FAILED') {
          output.error(scannerRecovery?.message ?? 'The scanner could not update.');
          output.error(scannerRecovery?.action ?? SCANNER_RETRY_MESSAGE);
        }
      } else if (codexTrustPending) {
        output.line('Mnemonik updated.');
        output.line(CODEX_TRUST_MESSAGE.sentence);
        output.line(CODEX_TRUST_MESSAGE.nextStep);
      } else if (
        cli?.status === 'UPDATED' ||
        result.reports.length > 0 ||
        scanner?.status === 'UPDATED'
      )
        output.line('Mnemonik updated.');
      else output.line('Mnemonik is up to date.');
      // The scanner kept running; its update waits for the person's approval.
      if (scannerConsentPending) {
        output.line(SCANNER_UPDATE_CONSENT_MESSAGE.sentence);
        output.line(SCANNER_UPDATE_CONSENT_MESSAGE.nextStep);
      }
    } else {
      for (const target of result.results)
        output.line(target.status === 'READY' ? 'Done.' : humanReason(target.reason));
      for (const report of result.reports) output.line(humanReport(report));
      if (remaining) renderStatusSummaries(remaining, output);
      if (!selections.length && !fullUninstall && !remaining)
        output.line('No recorded host targets.');
      if (fullUninstall && !failed && hostExit === 0)
        output.line(
          'Stopped collection; removed local software. Credentials, cloud data and consent retained.'
        );
      // A failure is said once, as an error below, never also as a line here.
      else if (scanner && scanner.status !== 'failed')
        output.line(
          scanner.reason
            ? humanReason(scanner.reason)
            : scanner.status === 'not_installed'
              ? 'The scanner is not installed.'
              : 'The scanner was uninstalled.'
        );
    }
    if (scanner?.status === 'failed') {
      // Machine output keeps the reason on stderr; stdout stays pure JSON.
      if (json) output.error(scanner.reason ?? 'scanner_uninstall_failed', false);
      else {
        output.error(scanner.summary ?? SCANNER_FAILURE_MESSAGE);
        if (scanner.action) output.error(scanner.action);
      }
    }
    if (failed || remainingExit === 1) return 1;
    // An earlier run in the way needs the person, not a retry.
    if (hostError) return INTERRUPTED_INSTALL.test(hostError) || hostError === 'lock_held' ? 3 : 1;
    return (
      hostExit || remainingExit || (scannerConsentPending && !parsed.flags.has('automatic') ? 3 : 0)
    );
  } catch (error) {
    if (command === 'update' && !host && !component) await recordUpdateCheck(state, 'failed');
    if (command === 'update' && !json) {
      output.error(updateFailureMessage);
      return error instanceof LauncherError ? 3 : 1;
    }
    if (error instanceof LauncherError) {
      if (json)
        output.json({ status: error.status, reason: error.message, launcher: error.launcher });
      else output.error(humanReason(error.message));
      return 3;
    }
    const reason = installFailureReason(error);
    if (reason === 'lock_held') {
      if (json) output.json({ status: 'FAILED', reason });
      else output.error('Another mnemonik command holds the state lock; retry in a moment.');
    } else output.error(humanReason(reason));
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
  if (command === 'repair' || command === 'update') await reportCurrentInstallation(deps, output);
  return code;
}

function scannerFailure(error: unknown): ScannerServiceLimited | undefined {
  if (error instanceof ScannerServiceLimited) return error;
  if (error instanceof Error && error.message === 'scanner_stop_failed')
    return new ScannerServiceLimited('scanner_stop_failed');
  return undefined;
}

async function scannerRecoveryAction(error: unknown, options: ScannerServiceOptions) {
  const failure = scannerFailure(error);
  if (
    failure?.reason !== 'scanner_replacement_rolled_back' &&
    !failure?.reason.startsWith('mac_authorization_') &&
    (
      await scannerService(options)
        .status()
        .catch(() => undefined)
    )?.running
  )
    return undefined;
  return {
    message: failure?.summary ?? SCANNER_FAILURE_MESSAGE,
    action: failure?.action ?? SCANNER_RETRY_MESSAGE,
  };
}

async function enableCommand(
  parsed: Parsed,
  deps: CliDependencies,
  output: Output
): Promise<number> {
  const json = parsed.flags.has('json');
  const present = personPresent(parsed, deps);
  if (!present) {
    const missing = requireConsent(parsed, output, ['accept-indexing', 'apply']);
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
    await closeUntouchedScannerRun(
      deps.installStateDir ?? stateDirectory(process.platform, process.env, deps.home)
    ).catch(() => false);
    const roots = parsed.flags.get('scan-roots');
    const exclusions = parsed.flags.get('exclusions');
    const result = await enableScanner({
      stateDir: deps.installStateDir ?? stateDirectory(process.platform, process.env, deps.home),
      cwd: deps.cwd ?? process.cwd(),
      home: deps.home,
      input: deps.input ?? process.stdin,
      output,
      nonInteractive: !present,
      noBrowser: parsed.flags.has('no-browser'),
      timeout: retryOnce(parsed.flags),
      ...(typeof roots === 'string' ? { roots: roots.split(',').filter(Boolean) } : {}),
      ...(typeof exclusions === 'string'
        ? { exclusions: exclusions.split(',').filter(Boolean) }
        : {}),
      ...deps.scannerService,
      ...deps.scannerEnable,
      projectExecutor: deps.projectExecutor,
      projectStateDir: deps.projectStateDir,
    });
    if (json) output.json(result);
    else renderStatusSummaries(result, output);
    return result.installation.state === 'READY' ? 0 : 3;
  } catch (error) {
    const failure =
      scannerFailure(error) ??
      new ScannerServiceLimited('scanner_service_unavailable', (error as Error).message);
    const result = {
      status: 'ACTION_REQUIRED',
      reason: (error as Error).message,
      action: failure.action,
    };
    if (json) output.json(result);
    else {
      output.error(failure.summary);
      if (failure.action) output.error(failure.action);
    }
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
    'scan-roots',
    'exclusions',
    'accept-indexing',
    'accept-limited',
    'without-scanner',
    'apply',
    'no-browser',
    'dry-run',
    'retry',
    'skip',
  ]);
  if (invalid) return flagError(output, parsed, invalid);
  if (parsed.flags.has('retry') && parsed.flags.has('skip'))
    return flagError(output, parsed, 'Unknown flag combination: --retry --skip');
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
      () => ensureCliAuth(deps, output, parsed.flags.has('no-browser'), false),
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
      output.error(humanReason(installFailureReason(error)));
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
    // A stale install journal is recovered here, not abandoned: runInstall
    // offers Resume or Rollback. Only uninstall abandons one.
    const pending = await interrupted(install.stateDir);
    const result = await runInstall(install, pending[0]);
    output.line(`${result.state}: install ${result.runId}`);
    for (const report of result.reports) output.line(humanReport(report));
    return result.phase === 'rolled_back'
      ? 130
      : result.state === 'FAILED'
        ? 1
        : result.state === 'READY'
          ? 0
          : 3;
  } catch (error) {
    output.error(humanReason(installFailureReason(error)));
    return 1;
  } finally {
    terminal?.close();
  }
}

/** The state directory status and doctor read the scanner's receipt from. */
function refusalStateDir(deps: CliDependencies): string {
  return (
    deps.projectStateDir ??
    deps.installStateDir ??
    stateDirectory(process.platform, process.env, deps.home)
  );
}

async function doctorCommand(
  parsed: Parsed,
  deps: CliDependencies,
  output: Output
): Promise<number> {
  const invalid = allowed(parsed, []);
  if (invalid) return flagError(output, parsed, invalid);
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
    renderStatusSummaries(document, output, { diagnostics: true });
    if (
      document.installation.reasons.some(
        (reason) => reason === 'scanner_failing' || reason === 'scanner_signed_out'
      )
    )
      await renderScannerFailure(refusalStateDir(deps), output);
    await renderRefusals(refusalStateDir(deps), output, true);
  }
  // The console's device card shows what the last report said, so doctor sends one as status does.
  await reportCurrentInstallation(deps, output);
  return document.installation.state === 'READY'
    ? 0
    : document.installation.state === 'FAILED'
      ? 1
      : 3;
}

async function collectCurrentInstallation(
  deps: CliDependencies,
  output: Output,
  announce?: (line: string) => void
): Promise<Awaited<ReturnType<typeof collectStatusDocument>>> {
  const result = await runPreflight({
    cwd: deps.cwd,
    home: deps.home,
    ...deps.preflight,
    fetch: async () => new Response(null, { status: 204 }),
  });
  output.setContext({ home: deps.home ?? homedir(), projectRoot: result.project.root });
  const hostStateDir =
    deps.hostManagement?.stateDir ??
    deps.installStateDir ??
    stateDirectory(process.platform, process.env, deps.home);
  const localConditions = deps.projectHookConditions
    ? []
    : [
        ...(await localInstallationConditions(deps.home ?? homedir(), hostStateDir, deps.launcher)),
        // Installed Codex hooks that Codex has not trusted cannot run.
        ...(await (
          deps.codexTrustConditions ??
          (() =>
            codexTrustConditions({
              stateDir: hostStateDir,
              env: deps.hostManagement?.env,
              imports: deps.hostManagement?.imports,
            }))
        )()),
      ];
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
    expectedDisclosureVersion: deps.scannerDisclosureVersion,
    ...(announce
      ? {
          abandonedPause: {
            ...deps.scannerService,
            onAbandonedPauseResumed: () => announce(ABANDONED_PAUSE_RESUMED),
          },
        }
      : {}),
  });
  const versions = await readInstallVersions(hostStateDir, document.scanner?.version ?? undefined);
  const installedCli = await new RuntimeStore(hostStateDir)
    .verifyRuntime('cli')
    .catch(() => undefined);
  if (installedCli) versions.cli = installedCli.reference.version;
  return { ...document, versions };
}

/**
 * The web console's devices page reads the row this writes. Local evidence has
 * already decided the verdict and the exit code, so the upload is best effort:
 * it is bounded like the update hint and changes nothing a person sees.
 *
 * Resolves `signed_out` when nothing was sent because this computer's own
 * sign-in is unusable (L-166), and `refused` with the store's reason when the
 * credential file itself was refused (L-131: readable by other users). Those
 * are the failures a person can fix, which `status` says. Any other failure
 * says nothing about this machine.
 */
async function reportCurrentInstallation(
  deps: CliDependencies,
  output: Output,
  document?: Awaited<ReturnType<typeof collectStatusDocument>>
): Promise<'sent' | 'signed_out' | 'failed' | { refused: string }> {
  let refused: string | undefined;
  const bearer = await auth(deps, output, false)
    .getCliBearer()
    .catch((error: unknown) => {
      // The same reading ensureCliAuth gives a credential store it cannot open.
      if (isCredentialSessionUnavailableError(error)) return { status: 'ACTION_REQUIRED' };
      const reason = (error as { name?: unknown; reason?: unknown } | null)?.reason;
      if (
        (error as { name?: unknown } | null)?.name === 'CredentialError' &&
        typeof reason === 'string'
      )
        refused = reason;
      return undefined;
    });
  if (refused) return { refused };
  if (typeof bearer !== 'string')
    return bearer?.status === 'ACTION_REQUIRED' ? 'signed_out' : 'failed';
  const send = deps.grantFetch ?? globalThis.fetch;
  return postCurrentReadiness(
    bearer,
    baseReadiness(document ?? (await collectCurrentInstallation(deps, output))),
    (url, options) => send(url, { ...options, signal: AbortSignal.timeout(2500) })
  ).then(
    () => 'sent' as const,
    /* An unreachable server says nothing about this machine. */
    () => 'failed' as const
  );
}

/**
 * Delete a project, from the folder it belongs to or by id or name. The server
 * takes the name back as the confirmation, so the person types it either at the
 * prompt or in --confirm; nothing is sent until it matches.
 */
async function deleteProjectCommand(
  parsed: Parsed,
  rest: string[],
  deps: CliDependencies,
  output: Output
): Promise<number> {
  const json = parsed.flags.has('json');
  const cwd = deps.cwd ?? process.cwd();
  const resolve = deps.projectResolver?.resolveProjectIdentity ?? resolveProjectIdentity;
  const here = await resolve(cwd, { allowNestedInherit: false });
  const hereId = here.kind === 'ok' ? here.identity.projectId : undefined;
  const root = 'root' in here ? here.root : cwd;
  const target = rest[0] ?? hereId;
  if (!target) {
    output.error(
      'This folder is not connected to a project. Run mnemonik project delete <name> instead.'
    );
    return 3;
  }
  const bearer = await ensureCliAuth(deps, output, parsed.flags.has('no-browser'), false);
  const send = deps.grantFetch ?? fetch;
  const listed = await send(`${apiOrigin()}/api/v1/users/me/projects?days=0&limit=200`, {
    headers: { Authorization: `Bearer ${bearer}` },
  }).catch(() => undefined);
  if (!listed?.ok) {
    // Only a request that got no answer means Mnemonik could not be reached.
    const reason = !listed
      ? 'unreachable'
      : listed.status === 401 || listed.status === 403
        ? 'renew'
        : 'server_error';
    if (json) output.json({ status: 'action_required', reason, action: accountActions[reason] });
    else output.error(humanReason(reason));
    return 3;
  }
  const listing = await listed.json().catch(() => []);
  const projects = (Array.isArray(listing) ? listing : []) as { id: string; name: string }[];
  const project = projects.find(
    (candidate) => candidate.id === target || candidate.name?.toLowerCase() === target.toLowerCase()
  );
  if (!project) {
    output.error(`There is no project called ${target} in your account.`);
    return 3;
  }
  const supplied = parsed.flags.get('confirm');
  let typed = typeof supplied === 'string' ? supplied : '';
  if (typeof supplied !== 'string') {
    if (parsed.flags.has('non-interactive') || json) {
      output.error(
        `To skip this check, run mnemonik project delete ${project.name} --confirm "${project.name}".`
      );
      return 3;
    }
    output.line(projectDeletionWarning(project.name));
    output.line('Type the project name to confirm.');
    const readline = createInterface({ input: deps.input ?? process.stdin, terminal: false });
    typed = String((await readline[Symbol.asyncIterator]().next()).value ?? '').trim();
    readline.close();
    if (typed.toLowerCase() !== project.name.toLowerCase()) {
      output.line(NOTHING_DELETED_LINE);
      return 130;
    }
  }
  if (typed.toLowerCase() !== project.name.toLowerCase()) {
    output.error('That is not the project name. Nothing was deleted.');
    return 3;
  }
  const response = await send(`${apiOrigin()}/api/v1/projects/${encodeURIComponent(project.id)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({ confirmProjectName: typed }),
  });
  if (!response.ok) {
    output.error(
      response.status === 403
        ? `Only the owner of ${project.name} can delete it.`
        : response.status === 404
          ? `There is no project called ${target} in your account.`
          : `${project.name} could not be deleted. Try again in a moment.`
    );
    return 3;
  }
  const result = await response.json().catch(() => ({ success: true }));
  const stateDir = deps.installStateDir ?? stateDirectory(process.platform, process.env, deps.home);
  const saved = JSON.parse(
    await readFile(`${stateDir}/scanner/state.json`, 'utf8').catch(() => 'null')
  ) as { config: { roots: string[] } } | null;
  let stillWatched = false;
  if (hereId === project.id && saved?.config.roots.includes(root)) {
    // The project is already gone, so a watched list that will not update is
    // reported rather than thrown: the person is told the one command that
    // clears it.
    const update = await updateScannerRoots({
      stateDir,
      bearer,
      add: [],
      remove: [root],
      fetch: deps.grantFetch,
    }).catch(() => undefined);
    stillWatched = update?.status !== 'updated';
  }
  if (json) output.json(result);
  else {
    output.line(projectDeletedLine(project.name));
    if (stillWatched) output.line(stillWatchedLine(root));
    if (hereId === project.id) output.line(identityFileKeptLine);
  }
  return 0;
}

export async function runCli(args: string[], deps: CliDependencies = {}): Promise<number> {
  const parsed = parse(args);
  const helpIndex = args.findIndex(
    (argument) => argument === '--help' || argument.startsWith('--help=')
  );
  const silent = helpIndex === -1 && parsed.flags.has('automatic');
  const discard = { write: () => {} };
  const stdout = silent ? discard : (deps.stdout ?? process.stdout);
  const stderr = silent ? discard : (deps.stderr ?? process.stderr);
  const output = new Output(stdout, stderr, {
    home: deps.home ?? homedir(),
  });
  const usageError = (
    positionals: string[],
    failure: { reason: UsageReason; detail?: string; path?: string[] } = usageReason(
      parsed.positionals,
      positionals
    )
  ): 2 =>
    usageFailure(output, parsed, { path: positionals, ...failure }, () =>
      stderr.write(helpScreen(positionals) ?? help)
    );
  /** Too few or too many arguments after the command's words. */
  const argumentError = (screen: string[], words: string[], given: string[], most: number): 2 =>
    usageError(
      screen,
      given.length > most
        ? { reason: 'invalid_value', detail: given[most], path: words }
        : { reason: 'missing_argument', path: words }
    );
  if (helpIndex !== -1) {
    const positionals = args.slice(0, helpIndex).filter((argument) => !argument.startsWith('--'));
    const screen = helpScreen(positionals);
    stdout.write(screen ?? helpScreen(positionals.slice(0, 1)) ?? help);
    return screen ? 0 : 2;
  }
  if (process.env.MNEMONIK_DEV_RELEASE_DIR && !silent)
    stderr.write(
      'WARNING: MNEMONIK_DEV_RELEASE_DIR uses development artifacts; readiness remains LIMITED.\n'
    );
  if (parsed.error) return flagError(output, parsed, parsed.error);
  if (parsed.flags.has('version')) {
    if (parsed.positionals.length || parsed.flags.size !== 1)
      return flagError(output, parsed, 'Unknown flag combination: --version');
    output.line(await packageVersion());
    return 0;
  }
  if (!parsed.positionals.length) {
    stdout.write(help);
    return 0;
  }

  const [command, subcommand, ...rest] = parsed.positionals;
  if (command === 'install') {
    if (subcommand) return usageError(['install']);
    return installCommand(parsed, deps, output);
  }
  if (command === 'roots' || command === 'add' || command === 'remove') {
    const action = command === 'roots' ? subcommand : command;
    const actionArguments = command === 'roots' ? rest : [subcommand, ...rest].filter(Boolean);
    // `--non-git` is accepted and ignored: a folder is a project with or without Git.
    // `remove` keeps --accept-indexing: a disclosure change sends it through enable.
    const invalid = allowed(parsed, [
      'no-browser',
      'non-git',
      ...(action === 'list' ? [] : ['accept-indexing', 'apply']),
    ]);
    if (
      invalid ||
      !['add', 'remove', 'list'].includes(action ?? '') ||
      actionArguments.length !== (action === 'list' ? 0 : 1)
    )
      return invalid
        ? flagError(output, parsed, invalid)
        : !['add', 'remove', 'list'].includes(action ?? '')
          ? usageError([command])
          : argumentError(
              [command],
              command === 'roots' ? [command, action ?? ''] : [command],
              actionArguments.map(String),
              action === 'list' ? 0 : 1
            );
    const stateDir =
      deps.installStateDir ?? stateDirectory(process.platform, process.env, deps.home);
    const saved = JSON.parse(
      await readFile(`${stateDir}/scanner/state.json`, 'utf8').catch(() => 'null')
    ) as { config: { roots: string[]; exclusions?: string[] } } | null;
    if (!saved) return actionRequired(output, parsed.flags.has('json'), 'mnemonik install');
    if (
      (action === 'add' || action === 'remove') &&
      pausedForConsent(await scannerReceipt(stateDir))
    )
      return scannerConsentRequired(output, parsed.flags.has('json'));
    if (action === 'list') {
      if (parsed.flags.has('json')) output.json(saved.config.roots);
      else for (const root of saved.config.roots) output.line(root);
      return 0;
    }
    if (
      (action === 'add' || action === 'remove') &&
      !personPresent(parsed, deps) &&
      !parsed.flags.has('apply')
    )
      return actionRequired(output, parsed.flags.has('json'), 'Rerun with --apply', '--apply');
    const pathArgument = actionArguments[0] ?? '';
    const requested =
      action === 'add'
        ? await realpath(pathArgument)
        : (saved.config.roots.find((root) => root === pathArgument) ?? pathArgument);
    const name = requested.split(/[\\/]/u).filter(Boolean).at(-1) ?? requested;
    // Already connected and watched: say so and stop. Nothing is asked again.
    if (action === 'add' && saved.config.roots.includes(requested)) {
      if (parsed.flags.has('json')) output.json(saved.config.roots);
      else output.line(alreadyConnectedFolderLine(name));
      return 0;
    }
    if (personPresent(parsed, deps)) {
      output.line(action === 'add' ? connectFolderPrompt(name) : removeFolderPrompt(name));
      const readline = createInterface({ input: deps.input ?? process.stdin, terminal: false });
      const answer = String((await readline[Symbol.asyncIterator]().next()).value ?? '').trim();
      readline.close();
      if (
        (action === 'add' && /^(?:n|no)$/iu.test(answer)) ||
        (action === 'remove' && !/^(?:y|yes)$/iu.test(answer))
      )
        return 130;
    }
    const bearer = await ensureCliAuth(deps, output, parsed.flags.has('no-browser'), false);
    if (action === 'add') {
      let executor = deps.projectExecutor;
      if (!executor)
        executor = (
          await createRealProjectRuntime({
            stateDir: deps.projectStateDir ?? stateDir,
            getCliBearer: async () => bearer,
            fetch: deps.grantFetch,
          })
        ).executor;
      const resolution = await executor.resolveProjectIdentity(requested);
      const decision = await evaluateRoot(resolution, { cwd: requested, home: deps.home });
      if (!decision.allowed) {
        if (parsed.flags.has('json')) return actionRequired(output, true, decision.reason);
        for (const line of folderRefusalMessage(decision.reason, decision.root)) output.line(line);
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
        else for (const line of limit) output.line(line);
        return 3;
      }
      if (project.status !== 'done') {
        const state = 'state' in project ? String(project.state) : project.status;
        if (parsed.flags.has('json')) output.json({ status: 'ACTION_REQUIRED', state });
        else for (const line of folderRefusalMessage(state, requested)) output.line(line);
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
      if (parsed.flags.has('json')) output.json(updated.state.config.roots);
      else output.line(action === 'add' ? connectedFolderLine(name) : removedFolderLine(name));
      return 0;
    }
    const roots =
      action === 'add'
        ? [...new Set([...saved.config.roots, requested])]
        : saved.config.roots.filter((root) => root !== requested);
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
    if (invalid || rest.length)
      return invalid ? flagError(output, parsed, invalid) : usageError(['auth', 'logout']);
    try {
      await revokeScannerCredential(
        deps,
        output,
        deps.installStateDir ?? stateDirectory(process.platform, process.env, deps.home)
      );
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
      output.error(humanReason((error as Error).message));
      return 3;
    }
  }
  if (command === 'data') {
    const invalid = allowed(parsed, ['project', 'confirm']);
    const project = parsed.flags.get('project');
    if (invalid || subcommand !== 'delete' || rest.length || typeof project !== 'string')
      return invalid ? flagError(output, parsed, invalid) : usageError(['data', 'delete']);
    if (!parsed.flags.has('confirm')) {
      if (parsed.flags.has('non-interactive') || parsed.flags.has('json'))
        return actionRequired(
          output,
          parsed.flags.has('json'),
          'Rerun with --confirm',
          '--confirm'
        );
      output.line(dataDeletePrompt(project));
      const readline = createInterface({ input: deps.input ?? process.stdin, terminal: false });
      const answer = String((await readline[Symbol.asyncIterator]().next()).value ?? '').trim();
      readline.close();
      if (!/^(?:y|yes)$/iu.test(answer)) {
        output.line(NOTHING_DELETED_LINE);
        return 130;
      }
    }
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
      output.error(humanReason((error as Error).message));
      return 3;
    }
  }
  if (
    (command === 'update' || command === 'uninstall') &&
    parsed.flags.get('component') === 'scanner'
  ) {
    const invalid = allowed(parsed, ['component', ...(command === 'uninstall' ? ['confirm'] : [])]);
    if (invalid || subcommand)
      return invalid ? flagError(output, parsed, invalid) : usageError([command]);
    // The same act as mnemonik scanner uninstall: an opt-out.
    if (command === 'uninstall') {
      const declined = await confirmScannerOptOut(parsed, deps, output);
      if (declined !== undefined) return declined;
    }
    try {
      const options = {
        stateDir: deps.installStateDir ?? stateDirectory(process.platform, process.env, deps.home),
        ...deps.scannerService,
      };
      if (command === 'update') {
        const store = new RuntimeStore(options.stateDir);
        const before = await store.verifyRuntime('scanner').catch(() => undefined);
        const runtime = await retryUpdateOnce(() =>
          updateScanner(
            {
              ...options,
              onScannerRestartRequested: () => {
                if (!parsed.flags.has('json')) output.line(SCANNER_RESTART_MESSAGE);
              },
              onAbandonedPauseResumed: () => {
                if (!parsed.flags.has('json')) output.line(ABANDONED_PAUSE_RESUMED);
              },
            },
            deps.scannerEnable?.source
          )
        );
        const result = {
          status:
            before?.reference.version === runtime.reference.version ? 'up_to_date' : 'updated',
          version: runtime.manifest.version,
          cli: { status: 'NOT_SELECTED' },
          ...(process.env.MNEMONIK_DEV_RELEASE_DIR
            ? { status: 'LIMITED', reason: 'dev_release_source' }
            : {}),
        };
        if (parsed.flags.has('json')) output.json(result);
        else
          output.line(
            result.status === 'updated' ? 'Mnemonik updated.' : 'Mnemonik is up to date.'
          );
      } else
        return await uninstallScannerOptOut(
          deps,
          output,
          scannerService(options),
          parsed.flags.has('json')
        );
      return 0;
    } catch (error) {
      if (command === 'update' && error instanceof ScannerConsentRequired) {
        const stateDir =
          deps.installStateDir ?? stateDirectory(process.platform, process.env, deps.home);
        if ((await approveScannerUpdate(parsed, deps, output, stateDir)) === 'approved') {
          if (parsed.flags.has('json')) output.json({ status: 'updated' });
          else output.line('Mnemonik updated.');
          return 0;
        }
        if (parsed.flags.has('json'))
          output.json({
            status: 'ACTION_REQUIRED',
            reason: 'scanner_update_consent_required',
            action: 'mnemonik scanner enable',
          });
        else {
          output.line(SCANNER_UPDATE_CONSENT_MESSAGE.sentence);
          output.line(SCANNER_UPDATE_CONSENT_MESSAGE.nextStep);
        }
        return 3;
      }
      const failure = scannerFailure(error);
      if (command === 'uninstall' && parsed.flags.has('json'))
        output.json({
          status: 'FAILED',
          reason: failure?.reason ?? (error as Error).message,
          action: failure?.action,
        });
      else
        output.error(
          command === 'update'
            ? updateFailureMessage
            : (failure?.summary ?? humanReason((error as Error).message))
        );
      // A failure that leaves nothing to do says so on one line, not a blank one.
      if (command === 'uninstall' && !parsed.flags.has('json') && failure?.action)
        output.error(failure.action);
      if (command === 'update' && !parsed.flags.has('json')) {
        const action = await scannerRecoveryAction(error, {
          stateDir:
            deps.installStateDir ?? stateDirectory(process.platform, process.env, deps.home),
          ...deps.scannerService,
        });
        if (action) {
          output.error(action.message);
          if (action.action) output.error(action.action);
        }
      }
      return 3;
    }
  }
  if (command === 'repair' || command === 'update' || command === 'uninstall') {
    const invalid = allowed(
      parsed,
      command === 'repair'
        ? ['host', 'component', 'apply']
        : command === 'update'
          ? ['host', 'automatic']
          : ['host', 'component', 'confirm']
    );
    if (invalid || subcommand)
      return invalid ? flagError(output, parsed, invalid) : usageError([command]);
    if (command === 'uninstall' && parsed.flags.has('non-interactive')) {
      const missing = requireConsent(parsed, output, ['confirm']);
      if (missing !== undefined) return missing;
    }
    if (!deps.runtimeUpdate || command !== 'update')
      return hostCommand(command, parsed, deps, output);
  }
  if (command === 'update') {
    const invalid = allowed(parsed, ['automatic']);
    if (invalid || subcommand)
      return invalid ? flagError(output, parsed, invalid) : usageError(['update']);
    const runtimeUpdate = deps.runtimeUpdate;
    if (!runtimeUpdate)
      return placeholder(
        output,
        parsed.flags.has('json'),
        'update',
        'runtime release and service restart'
      );
    let runtime: Awaited<ReturnType<typeof updateRuntime>>;
    try {
      runtime = await retryUpdateOnce(() => updateRuntime(runtimeUpdate));
    } catch {
      output.error(updateFailureMessage);
      return 3;
    }
    if (parsed.flags.has('json'))
      output.json({
        status: 'updated',
        artifact: runtime.manifest.artifact,
        version: runtime.manifest.version,
      });
    else output.line('Mnemonik updated.');
    return 0;
  }
  if (command === 'doctor') {
    if (subcommand) return usageError(['doctor']);
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
      return invalid
        ? flagError(output, parsed, invalid)
        : subcommand === 'preview' || subcommand === 'send'
          ? argumentError(
              ['diagnostics'],
              ['diagnostics', subcommand],
              rest,
              subcommand === 'send' ? 1 : 0
            )
          : usageError(['diagnostics']);
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
      const nativeCode = (error as NodeJS.ErrnoException).code;
      const code =
        error instanceof DiagnosticsError
          ? error.code
          : typeof nativeCode === 'string'
            ? nativeCode
            : 'diagnostics_failed';
      if (parsed.flags.has('json')) output.json({ status: 'error', error: code });
      else if (
        /^(?:bundle_id_invalid|bundle_hash_mismatch|diagnostics_preview_invalid|ENOENT)$/u.test(
          code
        )
      )
        output.error(
          'Saved diagnostics could not be used.\nRun mnemonik diagnostics preview, then try again.'
        );
      else
        output.error(
          subcommand === 'preview'
            ? 'Diagnostics could not be created.\nRun mnemonik install to try again.'
            : 'Diagnostics could not be sent.\nCheck your internet connection, then try again.'
        );
      return 1;
    }
  }
  if (command === 'status') {
    const invalid = allowed(parsed, []);
    if (invalid || subcommand)
      return invalid ? flagError(output, parsed, invalid) : usageError(['status']);
    const document = await collectCurrentInstallation(
      deps,
      output,
      parsed.flags.has('json') ? undefined : (line) => output.line(line)
    );
    const version = await packageVersion();
    const store = new RuntimeStore(
      deps.installStateDir ?? stateDirectory(process.platform, process.env, deps.home)
    );
    if (!parsed.flags.has('json')) {
      renderStatusSummaries(document, output);
      await renderRefusals(refusalStateDir(deps), output);
    }
    const hint = await cliUpdateHint(store, version);
    if (parsed.flags.has('json'))
      output.json({ ...document, cli: { version, ...(hint ? { updateAvailable: hint } : {}) } });
    else if (hint) output.line(hint);
    const reported = await reportCurrentInstallation(deps, output, document);
    if (reported === 'signed_out' && !parsed.flags.has('json')) {
      output.line(REPORT_NOT_SENT.sentence);
      output.line(REPORT_NOT_SENT.nextStep);
    } else if (typeof reported === 'object' && !parsed.flags.has('json'))
      output.line(humanReason(reported.refused));
    return statusExitCode(document);
  }
  if (command === 'connect') {
    const invalid = allowed(parsed, []);
    if (invalid) return flagError(output, parsed, invalid);
    if (!subcommand || rest.length || !hostOrder.includes(subcommand as never))
      return subcommand && !hostOrder.includes(subcommand as never)
        ? usageError(['connect'], { reason: 'invalid_value', detail: subcommand })
        : argumentError(['connect'], ['connect'], [subcommand ?? '', ...rest].filter(Boolean), 1);
    const host = subcommand as (typeof hostOrder)[number];
    const editor = (await localEditorStatus(deps.home ?? homedir())).find(
      (candidate) => candidate.host === host
    );
    // Only Codex has a headless login command, so only Codex can be signed in
    // from here; the others print their own instructions as before.
    if (host === 'codex' && editor?.mcp === 'ready' && !parsed.flags.has('json')) {
      const bearer = await auth(deps, output, false)
        .getCliBearer()
        .catch(() => undefined);
      if (typeof bearer === 'string') {
        const outcome = await runEditorLogin({
          command: ['codex', 'mcp', 'login', 'mnemonik'],
          apiOrigin: apiOrigin(),
          issuer: process.env.MNEMONIK_OAUTH_ISSUER ?? 'https://auth.mnemonik.ai',
          bearer: () => Promise.resolve(bearer),
          print: (line) => void output.line(line),
          fetch: deps.grantFetch,
          ...deps.editorLogin,
        });
        if (outcome === 'signed_in') return (output.line(CODEX_SIGNED_IN_MESSAGE), 0);
        if (outcome === 'not_approved') return (output.line(CONNECT_NOT_APPROVED_MESSAGE), 1);
      }
      // An editor that could not be started at all still has its own instructions.
    }
    // An editor that opens this machine from another one (Cursor over SSH) is
    // signed in there; asking for Authenticate here would send the person to an
    // editor that is already signed in.
    if (editor?.mcp === 'ready') {
      const bearer = await auth(deps, output, false)
        .getCliBearer()
        .catch(() => undefined);
      const send = deps.grantFetch ?? globalThis.fetch;
      const grants =
        typeof bearer === 'string'
          ? await grantTransport(
              async () => bearer,
              (url, options) => send(url, { ...options, signal: AbortSignal.timeout(2500) })
            )
              .list()
              .catch(() => undefined)
          : undefined;
      if (grants && signedInElsewhere(grants, host)) {
        const message = signedInElsewhereMessage(launchHostLabels[host]);
        if (parsed.flags.has('json')) output.json({ status: 'READY', reason: message });
        else output.line(message);
        return 0;
      }
    }
    const reason =
      editor?.mcp === 'disabled'
        ? `${editor.name} connection is turned off.`
        : editor?.mcp === 'ready'
          ? 'Finish signing in to Mnemonik in the coding tool.'
          : `${launchHostLabels[host]} connection is missing.`;
    const actions =
      editor?.mcp === 'ready'
        ? editorAuthorizationRows([host])
        : [
            editor?.mcp === 'disabled'
              ? mcpTurnOnAction[host]
              : 'Run mnemonik install to set it up again.',
          ];
    if (parsed.flags.has('json')) output.json({ status: 'ACTION_REQUIRED', reason, actions });
    else {
      output.line(reason);
      for (const action of actions) output.line(action);
    }
    return 3;
  }
  if (command === 'project') {
    if (
      !subcommand ||
      !['init', 'setup', 'status', 'link', 'ensure', 'delete'].includes(subcommand)
    )
      return usageError(['project']);
    if (subcommand === 'delete') {
      const unknown = allowed(parsed, ['confirm']);
      if (unknown || rest.length > 1)
        return unknown
          ? flagError(output, parsed, unknown)
          : argumentError(['project', 'delete'], ['project', 'delete'], rest, 1);
      return deleteProjectCommand(parsed, rest, deps, output);
    }
    const invalid = allowed(
      parsed,
      subcommand === 'ensure'
        ? ['agent']
        : subcommand === 'status'
          ? []
          : subcommand === 'link'
            ? ['apply', 'non-git', 'confirm-mismatch', 'replace']
            : subcommand === 'setup'
              ? ['apply', 'non-git', 'owner', 'cancel']
              : ['apply', 'non-git', 'owner']
    );
    if (invalid) return flagError(output, parsed, invalid);
    if (subcommand === 'ensure') {
      // The output is always JSON, so `--json` changes nothing, and it never
      // asks. `--agent` is the hook's: only then is a request id read from
      // stdin, so an agent's shell with stdin left open does not wait forever.
      if (rest.length) return usageError(['project', 'ensure']);
      return ensureProjectForAgent({
        output,
        cwd: deps.cwd ?? process.cwd(),
        executor: deps.projectExecutor,
        input: deps.input ?? process.stdin,
        handoff: parsed.flags.has('agent'),
        // The same sign-in reader status and every other command use.
        runtime: {
          stateDir: deps.projectStateDir ?? deps.installStateDir,
          fetch: deps.grantFetch,
          getCliBearer: auth(deps, output, true).getCliBearer,
        },
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
      return argumentError(
        ['project', subcommand],
        ['project', subcommand],
        rest,
        subcommand === 'link' ? 2 : 1
      );
    return runProjectCommand(
      {
        command: subcommand as 'init' | 'setup' | 'status' | 'link',
        ...(subcommand === 'link' ? { projectId: rest[0], path: rest[1] } : { path: rest[0] }),
        json: parsed.flags.has('json'),
        nonInteractive: parsed.flags.has('non-interactive'),
        apply: parsed.flags.has('apply'),
        confirmMismatch: parsed.flags.has('confirm-mismatch'),
        replace: parsed.flags.has('replace'),
        cancel: parsed.flags.has('cancel'),
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
    if (subcommand !== 'migrate') return usageError(['identity', 'migrate']);
    const invalid = allowed(parsed, ['report', 'backup', 'apply', 'verify', 'rollback']);
    if (invalid) return flagError(output, parsed, invalid);
    const selected = ['report', 'backup', 'apply', 'verify', 'rollback'].filter((flag) =>
      parsed.flags.has(flag)
    );
    if (selected.length > 1)
      return usageFailure(
        output,
        parsed,
        { reason: 'invalid_flag', detail: `--${selected[1]}` },
        'Choose one migration phase: --report, --backup, --apply, --verify, or --rollback'
      );
    const mode = (selected[0] ?? 'report') as 'report' | 'backup' | 'apply' | 'verify' | 'rollback';
    if (rest.length && mode !== 'report' && mode !== 'backup')
      return usageFailure(
        output,
        parsed,
        { reason: 'invalid_value', detail: rest[0] },
        'Paths are only accepted by --report and --backup'
      );
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
      output.error(humanReason((error as Error).message));
      return 1;
    }
    if (parsed.flags.has('json')) output.json(result);
    else if ('report' in result) {
      for (const entry of result.report.entries)
        output.line(`${entry.path}: ${humanIdentityState(entry.state)}`);
      output.line(`Checked ${result.report.entries.length} project identity files.`);
      if (result.status === 'backed_up')
        output.line(`Backup run: ${result.runId} (${result.count} file(s))`);
    } else {
      output.line(`Identity migration: ${result.passed} passed; ${result.failed} failed.`);
      for (const failure of result.failures) output.error(humanReason(failure));
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
      return usageError(
        subcommand && helpScreen(['scanner', subcommand]) ? ['scanner', subcommand] : ['scanner']
      );
    const invalid = allowed(
      parsed,
      subcommand === 'enable'
        ? ['accept-indexing', 'apply', 'scan-roots', 'exclusions', 'no-browser', 'retry', 'skip']
        : subcommand === 'export-preview'
          ? ['out']
          : subcommand === 'uninstall'
            ? ['confirm']
            : subcommand === 'start'
              ? ['retry', 'skip']
              : []
    );
    if (invalid) return flagError(output, parsed, invalid);
    if (parsed.flags.has('retry') && parsed.flags.has('skip'))
      return flagError(output, parsed, 'Unknown flag combination: --retry --skip');
    if (subcommand === 'enable') return enableCommand(parsed, deps, output);
    if (subcommand === 'uninstall') {
      const declined = await confirmScannerOptOut(parsed, deps, output);
      if (declined !== undefined) return declined;
    }
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
        await renderRefusals(refusalStateDir(deps), output);
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
          ? retryOnce(parsed.flags)
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
      // Resume cannot lift a pause for consent; say what can.
      if (subcommand === 'resume' && pausedForConsent(await scannerReceipt(options.stateDir)))
        return scannerConsentRequired(output, json);
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
      } else if (subcommand === 'stop') {
        // Tell the server this stop was chosen, so it is not taken for a reboot.
        // A scanner that is not running has nothing to announce.
        await controlScanner('stop', options).catch(() => undefined);
        await service.stop();
        // The boot registration stays, so say what stopping does and does not do.
        if ((deps.scannerService?.platform ?? process.platform) === 'darwin')
          output.line('Background indexing will start again when this Mac restarts.');
      } else if (subcommand === 'uninstall')
        return await uninstallScannerOptOut(deps, output, service, json);
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
        if (subcommand === 'status') await renderRefusals(options.stateDir, output);
      }
      return 0;
    } catch (error) {
      const failure =
        scannerFailure(error) ??
        new ScannerServiceLimited('scanner_service_unavailable', (error as Error).message);
      const result = {
        status: 'LIMITED',
        reason: failure.reason,
        detail: failure.message,
        action: failure.action,
        choices: ['retry', 'skip'],
      };
      if (json) output.json(result);
      else {
        output.line(failure.summary);
        if (failure.action) output.line(failure.action);
      }
      return 3;
    }
  }
  if (command === 'auth') {
    const invalid = allowed(parsed, [
      'host',
      'no-browser',
      'reopen-install',
      ...(subcommand === 'logout' ? ['confirm'] : []),
    ]);
    if (
      invalid ||
      rest.length ||
      !['login', 'renew', 'status', 'logout'].includes(subcommand ?? '') ||
      (parsed.flags.has('reopen-install') && subcommand !== 'login' && subcommand !== 'renew')
    )
      return invalid
        ? flagError(output, parsed, invalid)
        : usageError(
            subcommand && helpScreen(['auth', subcommand]) ? ['auth', subcommand] : ['auth'],
            !rest.length && ['login', 'renew', 'status', 'logout'].includes(subcommand ?? '')
              ? { reason: 'invalid_flag', detail: '--reopen-install' }
              : undefined
          );
    const host = parsed.flags.get('host');
    if (host && !hostOrder.includes(host as never))
      return usageFailure(
        output,
        parsed,
        { reason: 'invalid_value', detail: String(host) },
        'Invalid host'
      );
    // `auth renew` is `auth login` that always signs in again, as on a machine
    // with no sign-in: the renew action follows a token the server refused.
    if (subcommand === 'login' || subcommand === 'renew') {
      if (host)
        return usageFailure(
          output,
          parsed,
          { reason: 'invalid_flag', detail: '--host' },
          'Use mnemonik connect <host> for a host login'
        );
      const noBrowser = parsed.flags.has('no-browser');
      const bearer = await ensureCliAuth(deps, output, noBrowser, true, subcommand === 'renew');
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
        .filter((g) => {
          const grantHostName = grantHost(g);
          return (
            (!grantHostName || hostOrder.includes(grantHostName as never)) &&
            (!host || grantHostName === host)
          );
        })
        .map((g) => ({ ...g, host: grantHost(g) ?? g.clientName ?? g.clientId }));
      if (parsed.flags.has('json')) output.json({ account: status.account, grants });
      else if (!grants.length)
        output.line(
          host
            ? `${launchHostLabels[host as keyof typeof launchHostLabels]} is not signed in.`
            : humanReason('not_signed_in')
        );
      else {
        output.signedInAs(status.email);
        for (const line of grantSummaryLines(grants, launchHostLabels)) output.line(line);
        output.line(
          'Older sign-ins stay valid until `mnemonik auth logout`. `mnemonik auth status --json` lists every one.'
        );
      }
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
    if (subcommand) return usageError(['logout']);
    const invalid = allowed(parsed, []);
    if (invalid) return flagError(output, parsed, invalid);
    await auth(deps, output, false).logout();
    if (parsed.flags.has('json')) output.json({ status: 'logged_out' });
    else output.line('Logged out.');
    return 0;
  }
  return usageError([]);
}

const serializeReadiness: typeof baseReadiness = (input) => devReadiness(baseReadiness(input));
