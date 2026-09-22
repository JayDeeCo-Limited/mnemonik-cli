import { genericReadinessMessage, messageFor as humanMessageFor } from './humanReason.js';
export { CODEX_TRUST_MESSAGE } from './humanReason.js';
import { cliCredentialStatus } from './auth/credentials.js';
import { readOwnership } from './install/ownership.js';
import { scannerReceipt } from './scanner/control.js';
import {
  scannerService,
  ScannerServiceLimited,
  SCANNER_RESTART_MESSAGE,
  SCANNER_RESTART_ACTION,
  type ScannerServiceOptions,
} from './scanner/service.js';
import { stateDirectory } from '@mnemonik/local-setup';
import {
  scannerAttemptHealthy,
  SCANNER_HANDOFF_BUDGET_MS,
  SCANNER_RECEIPT_STALE_MS,
} from '@mnemonik/shared';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';
import { devReadiness } from './runtime/releaseSource.js';
import { pendingProjectSetup } from '@mnemonik/shared/hook-runtime';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import {
  reduceReadiness,
  serializeReadiness as baseReadiness,
  type ReadinessCondition,
  type ReadinessDocument,
  type ReadinessDocumentInput,
  type ReadinessSummary,
} from '@mnemonik/shared';
import { Output, type Writable } from './output.js';
import {
  runProjectCommand,
  type ProjectCommandDependencies,
  type ProjectExecutor,
  type ProjectReadTransport,
  type ServerProjectState,
} from './project.js';
import type { ScannerPickerResult } from './scanner/picker.js';
import type { PreflightResult } from './preflight.js';
import { hostOrder } from './install/adapters.js';
import { hookStatusConditions } from './install/hosts.js';
import { launcherStatus, type LauncherOptions, type LauncherStatus } from './launcher.js';

const editorFiles = [
  ['claude-code', 'Claude Code', '.claude/settings.json', '.claude.json'],
  ['codex', 'Codex', '.codex/hooks.json', '.codex/config.toml'],
  ['cursor', 'Cursor', '.cursor/hooks.json', '.cursor/mcp.json'],
] as const;

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function hookCommands(value: unknown, owner: string): string[] {
  if (Array.isArray(value)) return value.flatMap((entry) => hookCommands(entry, owner));
  if (!object(value)) return [];
  return [
    ...(typeof value.command === 'string' && value.command.includes(`--mnemonik-owner=${owner}`)
      ? [value.command]
      : []),
    ...Object.values(value).flatMap((entry) => hookCommands(entry, owner)),
  ];
}

function hookTarget(command: string): string | undefined {
  try {
    const plain = /^node ("(?:[^"\\]|\\.)*")/u.exec(command)?.[1];
    if (plain) {
      const parsed: unknown = JSON.parse(plain);
      if (typeof parsed === 'string') return parsed;
    }
    const token = /^node -e .* -- ([A-Za-z0-9_-]+)(?:\s|$)/u.exec(command)?.[1];
    if (token) return fileURLToPath(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    /* Invalid commands are not usable launchers. */
  }
  return undefined;
}

export async function localEditorStatus(home: string) {
  return Promise.all(
    editorFiles.map(async ([host, name, hooksFile, mcpFile]) => {
      const read = (file: string) =>
        readFile(join(home, file), 'utf8').catch((error: NodeJS.ErrnoException) =>
          error.code === 'ENOENT' ? null : ''
        );
      const [hooksRaw, mcpRaw] = await Promise.all([read(hooksFile), read(mcpFile)]);
      let commands: string[] = [];
      try {
        commands = hookCommands(JSON.parse(hooksRaw ?? '{}'), `${host}-hooks`);
      } catch {
        /* Report the hooks as missing below. */
      }
      const hooks =
        commands.length > 0 &&
        (
          await Promise.all(
            commands.map(async (command) => {
              const target = hookTarget(command);
              return !!target && (await stat(target).catch(() => null))?.isFile() === true;
            })
          )
        ).every(Boolean);
      let declaration: unknown;
      try {
        const config = host === 'codex' ? parseToml(mcpRaw ?? '') : JSON.parse(mcpRaw ?? '{}');
        declaration = object(config.mcp_servers)
          ? config.mcp_servers.mnemonik
          : object(config.mcpServers)
            ? config.mcpServers.mnemonik
            : undefined;
      } catch {
        /* Report the connection as missing below. */
      }
      return {
        host,
        name,
        // Only a Mnemonik mark in the editor's own settings counts. The mere
        // presence of ~/.codex or a project-local .cursor is not a choice.
        marked: commands.length > 0 || object(declaration),
        hooks,
        mcp: !object(declaration)
          ? 'missing'
          : declaration.enabled === false || declaration.disabled === true
            ? 'disabled'
            : 'ready',
      };
    })
  );
}

/** What a person can really do to switch a declared connection back on. */
export const mcpTurnOnAction: Record<(typeof editorFiles)[number][0], string> = {
  'claude-code': 'In Claude Code, type /mcp, choose mnemonik, then turn it on.',
  codex: 'Open ~/.codex/config.toml, find mnemonik and set enabled = true.',
  cursor: 'Open Cursor Settings, Customize, MCPs, then turn on mnemonik.',
};

export async function localInstallationConditions(
  home: string,
  stateDir: string,
  launcherOptions?: LauncherOptions
): Promise<ReadinessCondition[]> {
  const conditions: ReadinessCondition[] = [];
  const issue = (reason: string, action: string, component?: string) =>
    conditions.push({
      kind: 'selected_component_failed',
      reason,
      action,
      ...(component ? { component } : {}),
    });
  if ((await launcherStatus({ stateDir, home, ...launcherOptions })).ownership !== 'ours')
    issue(
      'The mnemonik command is missing.',
      'Run npx -y @mnemonik/cli@latest install to restore it.'
    );
  const owned = (await readOwnership(stateDir)).targets.map((target) => target.host);
  const editors = (await localEditorStatus(home)).filter(
    (editor) => editor.marked || owned.includes(editor.host)
  );
  if (!editors.length)
    issue('No editor connections were found.', 'Run mnemonik install to set them up again.');
  for (const editor of editors) {
    if (!editor.hooks)
      issue(
        `${editor.name} hooks are missing.`,
        'Run mnemonik install to set them up again.',
        editor.host
      );
    if (editor.mcp !== 'ready')
      issue(
        `${editor.name} connection is ${editor.mcp === 'disabled' ? 'turned off' : 'missing'}.`,
        editor.mcp === 'missing'
          ? 'Run mnemonik install to set it up again.'
          : mcpTurnOnAction[editor.host],
        editor.host
      );
  }
  return conditions;
}

export interface ProjectStatusResult {
  resolvedRoot: string;
  projectId: string | null;
  identity: string;
  reachability: 'reachable' | 'unreachable';
  server?: ServerProjectState;
  executorState?: string;
}

export interface StatusDocumentInput {
  installationConditions: readonly ReadinessCondition[];
  projectStatus?: ProjectStatusResult;
  scannerStatus?: ScannerPickerResult;
  projectHookConditions?: readonly ReadinessCondition[];
  configuredHosts?: readonly string[];
  details?: Omit<ReadinessDocumentInput, 'installation' | 'projects' | 'generatedAt'>;
  scannerHeartbeat?: { at: string; version: string | null; disclosureVersion: string | null };
  generatedAt?: string;
}

export interface ReadProjectStatusInput {
  cwd: string;
  home?: string;
  input: Readable;
  executor?: ProjectExecutor;
  resolver?: ProjectCommandDependencies['resolver'];
  stateDir?: string;
  getCliBearer?: () => Promise<string | undefined>;
  transport?: ProjectReadTransport;
}

export interface CollectStatusInput extends ReadProjectStatusInput {
  scannerRecovery?: Omit<ScannerServiceOptions, 'stateDir'>;
  launcher?: LauncherOptions;
  /** Accepted for callers that also expose grant diagnostics; readiness ignores editor grants. */
  grants?: unknown;
  preflight: PreflightResult;
  installationConditions?: readonly ReadinessCondition[];
  scannerStatus?: () => Promise<ScannerPickerResult>;
  projectHookConditions?: readonly ReadinessCondition[];
  configuredHosts?: readonly string[];
  details?: StatusDocumentInput['details'];
  generatedAt?: string;
}

const contains = (parent: string, child: string): boolean => {
  const path = relative(resolve(parent), resolve(child));
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
};

function scannerConditions(
  installationConditions: readonly ReadinessCondition[],
  projectRoot: string,
  scanner?: ScannerPickerResult
): ReadinessCondition[] {
  const unverified = installationConditions.find(
    (condition) => condition.kind === 'scanner_not_verified'
  );
  if (unverified) return [unverified];
  if (installationConditions.some((condition) => condition.kind === 'scanner_omitted'))
    return [
      {
        kind: 'scanner_omitted',
        reason: 'Background indexing was deliberately omitted for this installation.',
        action: `mnemonik add ${projectRoot}`,
      },
    ];
  if (!scanner) return [];

  const excluded = scanner.exclusions.some((path) => contains(path, projectRoot));
  if (excluded)
    return [
      {
        kind: 'scanner_omitted',
        reason: 'Background indexing was deliberately omitted for this project.',
        action: `mnemonik add ${projectRoot}`,
      },
    ];
  if (scanner.roots.some((root) => contains(root, projectRoot))) return [];
  return [
    {
      kind: 'project_uncovered',
      reason: 'This project is not connected.',
      action: `mnemonik add ${projectRoot}`,
    },
  ];
}

function projectConditions(input: StatusDocumentInput): ReadinessCondition[] {
  const project = input.projectStatus;
  if (!project) return [];
  const conditions: ReadinessCondition[] = [];
  if (project.reachability === 'unreachable')
    conditions.push({
      kind: 'selected_component_failed',
      reason: 'The recorded project root is unreachable.',
      action: `mnemonik project status ${project.resolvedRoot}`,
    });
  else if (project.identity !== 'ok')
    conditions.push({
      kind: 'project_identity_choice_pending',
      reason: `Project identity is ${project.identity}.`,
      action: `mnemonik project init ${project.resolvedRoot}`,
    });
  else if (!project.server)
    conditions.push({
      kind: 'login_pending',
      reason: 'Project access has not been verified.',
      action: 'Run mnemonik install to sign in.',
    });
  else if (project.server !== 'access')
    conditions.push({
      kind: 'project_identity_choice_pending',
      reason: `Project access is ${project.server}.`,
      action: `mnemonik project status ${project.resolvedRoot}`,
    });
  conditions.push(
    ...scannerConditions(input.installationConditions, project.resolvedRoot, input.scannerStatus),
    ...(input.projectHookConditions ?? [])
  );
  return conditions;
}

export function buildStatusDocument(input: StatusDocumentInput): ReadinessDocument {
  const scannerNotVerified: ReadinessCondition[] =
    input.scannerStatus ||
    input.installationConditions.some(
      (condition) =>
        condition.component === 'scanner' &&
        /^(scanner_replacement_|mac_authorization_required|scanner_restart_requested|scanner_stopped)/u.test(
          condition.reason
        )
    )
      ? []
      : [
          {
            kind: 'scanner_not_verified',
            component: 'scanner',
            reason: 'background_indexing_not_verified',
            action: 'Run mnemonik status after indexing starts.',
          },
        ];
  const hooksNotVerified: ReadinessCondition[] = input.projectHookConditions
    ? []
    : (input.configuredHosts ?? ['host']).map((host) => ({
        kind: 'hook_not_verified' as const,
        component: host,
        reason: 'hook_not_verified',
        action: `run mnemonik status after the ${host} hook starts`,
      }));
  const installationConditions = [
    ...input.installationConditions,
    ...scannerNotVerified,
    ...hooksNotVerified,
  ];
  const project = input.projectStatus;
  const conditions = projectConditions({
    ...input,
    installationConditions,
    projectHookConditions: input.projectHookConditions ?? hooksNotVerified,
  });
  const scannerOmitted = installationConditions.some(
    (condition) => condition.kind === 'scanner_omitted'
  );
  return serializeReadiness({
    ...input.details,
    installation: { conditions: installationConditions },
    ...(project
      ? {
          projects: [
            {
              projectId: project.projectId,
              displayName: basename(project.resolvedRoot),
              repositoryMatch: project.identity,
              identityFile: null,
              summary: { conditions },
              action: conditions.find((condition) => condition.action)?.action ?? null,
            },
          ],
        }
      : {}),
    scanner: input.scannerStatus
      ? {
          roots: input.scannerStatus.roots,
          heartbeatAt: input.scannerHeartbeat?.at ?? null,
          version: input.scannerHeartbeat?.version ?? null,
          readiness: scannerOmitted
            ? reduceReadiness([
                { kind: 'scanner_omitted', reason: 'Limited Mode was acknowledged.' },
              ])
            : null,
          acceptedDisclosureVersion: input.scannerHeartbeat?.disclosureVersion ?? null,
        }
      : null,
    limitedMode: scannerOmitted
      ? {
          acknowledgement: 'Limited Mode was acknowledged.',
          enableScannerAction: 'mnemonik add <folder>',
        }
      : null,
    generatedAt: input.generatedAt,
  });
}

/**
 * Scanner service failures carry their own approved sentence and next step; every
 * other reason keeps the wording shared with humanReason.
 */
function messageFor(reason: string, actions: readonly string[]) {
  if (reason === 'scanner_restart_requested')
    return { sentence: SCANNER_RESTART_MESSAGE, nextStep: SCANNER_RESTART_ACTION };
  if (
    /^(scanner_replacement_|scanner_other_account|scanner_stopped|mac_authorization_)/u.test(reason)
  ) {
    const failure = new ScannerServiceLimited(reason.split(':')[0] ?? reason, reason);
    return { sentence: failure.summary, nextStep: failure.action };
  }
  return humanMessageFor(reason, actions);
}

function renderAttention(
  label: string,
  summary: ReadinessSummary,
  output: Pick<Output, 'line'>,
  rendered: Set<string>
): void {
  output.line(`${label}: Needs attention.`);
  const messages = summary.reasons.length
    ? summary.reasons.map((reason) => messageFor(reason, summary.actions))
    : [genericReadinessMessage];
  for (const message of messages) {
    const key = `${message.sentence}\n${message.nextStep}`;
    if (rendered.has(key)) continue;
    rendered.add(key);
    output.line(message.sentence);
    // Some states leave nothing for the person to do, and say so on one line.
    if (message.nextStep) output.line(message.nextStep);
  }
}

export function renderStatusSummaries(
  document: ReadinessDocument & {
    cliCredential?: Awaited<ReturnType<typeof cliCredentialStatus>>;
    launcher?: LauncherStatus;
  },
  output: Pick<Output, 'line'>,
  options: { diagnostics?: boolean } = {}
): void {
  if (options.diagnostics && document.cliCredential)
    output.line(
      `CLI credential: store=${document.cliCredential.store ?? 'unknown'} present=${document.cliCredential.present}`
    );
  if (options.diagnostics && document.cliCredential?.detail)
    output.line(document.cliCredential.detail);
  if (options.diagnostics && document.launcher) {
    const state =
      document.launcher.ownership === 'ours'
        ? 'present and ours'
        : document.launcher.ownership === 'not_ours'
          ? 'present and not ours'
          : 'missing';
    const action =
      document.launcher.ownership === 'not_ours'
        ? document.launcher.action.replace(
            /^Move the existing .+ aside yourself,/u,
            'Move the existing mnemonik launcher aside,'
          )
        : document.launcher.ownership === 'ours' && document.launcher.onPath
          ? ''
          : document.launcher.action;
    output.line(
      `Launcher: ${state}; directory ${document.launcher.onPath ? 'on' : 'off'} current PATH.${action ? ` ${action}` : ''}`
    );
  }
  const rendered = new Set<string>();
  if (document.installation.state === 'READY') output.line('Mnemonik is installed and working.');
  else renderAttention('Installation', document.installation, output, rendered);
  const connected = document.scanner?.roots?.map((root) => basename(root)) ?? [];
  if (connected.length) {
    const shown = connected.slice(0, 8).join(', ');
    output.line(
      `Connected: ${shown}${connected.length > 8 ? `, and ${connected.length - 8} more` : ''}`
    );
  }
  const project = document.projects?.[0];
  if (project) {
    if (project.summary.state === 'READY') output.line('This project: Done.');
    else renderAttention('This project', project.summary, output, rendered);
  }
}

export function statusExitCode(document: ReadinessDocument): number {
  const states = [document.installation, ...(document.projects ?? []).map((row) => row.summary)];
  if (states.some((summary) => summary.state === 'FAILED')) return 1;
  return states.some((summary) => summary.state !== 'READY') ? 3 : 0;
}

export async function readProjectStatus(
  input: ReadProjectStatusInput
): Promise<ProjectStatusResult> {
  let text = '';
  const writer: Writable = { write: (chunk) => (text += chunk) };
  await runProjectCommand(
    {
      command: 'status',
      json: true,
      nonInteractive: true,
      apply: false,
      nonGit: false,
      confirmMismatch: false,
      replace: false,
    },
    { ...input, output: new Output(writer) }
  );
  return JSON.parse(text) as ProjectStatusResult;
}

export async function collectStatusDocument(input: CollectStatusInput): Promise<
  ReadinessDocument & {
    cliCredential: Awaited<ReturnType<typeof cliCredentialStatus>>;
    launcher: LauncherStatus;
  }
> {
  const statusStateDir =
    input.stateDir ?? stateDirectory(process.platform, process.env, input.home);
  let scannerStatus = await input.scannerStatus?.();
  let scannerHeartbeat: StatusDocumentInput['scannerHeartbeat'];
  let scannerReason: ReadinessCondition | undefined;
  const restarted =
    !input.scannerStatus &&
    (await scannerService({
      stateDir: statusStateDir,
      ...input.scannerRecovery,
    })
      .recover()
      .catch(() => false));
  const receipt = await scannerReceipt(statusStateDir);
  const attempt = await readFile(
    join(statusStateDir, 'scanner/service-replacement/result.json'),
    'utf8'
  )
    .then(
      (text) =>
        JSON.parse(text) as {
          authorizationRequired?: boolean;
          stopped?: boolean;
          pid?: number;
          startedAt?: number;
          fallback?: boolean;
          candidateError?: string;
          fallbackError?: string;
        }
    )
    .catch(() => undefined);
  const pid = attempt?.pid ?? receipt?.snapshot.lifecycle.pid;
  let alive = false;
  if (pid)
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      /* exited */
    }
  if (!input.scannerStatus) {
    const state = JSON.parse(
      await readFile(join(statusStateDir, 'scanner/state.json'), 'utf8').catch(() => 'null')
    ) as {
      boundary?: string;
      consent?: { disclosureVersion: string };
      devReleaseSource?: boolean;
      config: { roots: string[]; exclusions?: string[] };
    } | null;
    const snapshot = receipt?.snapshot;
    const heartbeat = snapshot?.heartbeat.lastSuccess;
    if (snapshot?.devReleaseSource || state?.devReleaseSource)
      scannerReason = { kind: 'scanner_not_verified', reason: 'dev_release_source' };
    if (snapshot?.lifecycle.reason === 'credential_revoked')
      scannerReason = {
        kind: 'login_pending',
        reason: 'credential_revoked',
        action: 'mnemonik install',
      };
    else if (snapshot?.lifecycle.state === 'paused')
      scannerReason = {
        kind: 'scanner_not_verified',
        reason: 'scanner_paused',
        action: 'mnemonik install',
      };
    if (
      state &&
      alive &&
      snapshot?.lifecycle.pid === pid &&
      !restarted &&
      (snapshot?.lifecycle.state === 'running' || snapshot?.lifecycle.state === 'starting') &&
      heartbeat &&
      Date.now() - heartbeat < SCANNER_RECEIPT_STALE_MS
    ) {
      scannerStatus = {
        roots: state.config.roots,
        exclusions: state.config.exclusions ?? [],
        repositories: [],
      };
      scannerHeartbeat = {
        at: new Date(heartbeat).toISOString(),
        version: snapshot.version,
        disclosureVersion: state.consent?.disclosureVersion ?? null,
      };
    }
    if (restarted)
      scannerReason = {
        kind: 'scanner_not_verified',
        component: 'scanner',
        reason: 'scanner_restart_requested',
        action: SCANNER_RESTART_ACTION,
      };
  }
  const installationConditions: ReadinessCondition[] = [
    ...(input.installationConditions ?? []),
    ...(scannerReason ? [scannerReason] : []),
    ...(input.preflight.status === 'ready'
      ? []
      : [
          {
            kind: 'host_trust_pending' as const,
            reason: 'Preflight needs attention before installation can continue.',
            action: 'Resolve the preflight checks and run mnemonik doctor again.',
          },
        ]),
    ...(scannerStatus?.repositories
      .filter((repository) => !repository.selected)
      .map((repository) => ({
        kind: 'scanner_omitted' as const,
        component: repository.path,
        reason: `${repository.path} is not connected.`,
        action: `mnemonik add ${repository.path}`,
      })) ?? []),
  ];
  if (attempt && !restarted) {
    const checkedAt = receipt?.recordedAt ?? 0;
    const healthy =
      alive &&
      scannerAttemptHealthy(
        receipt,
        { pid: attempt.pid, startedAt: attempt.startedAt ?? Infinity },
        true
      ) &&
      Date.now() >= checkedAt &&
      Date.now() - checkedAt <= SCANNER_RECEIPT_STALE_MS;
    const reason = attempt.stopped
      ? 'scanner_stopped'
      : attempt.authorizationRequired
        ? 'mac_authorization_required'
        : healthy
          ? attempt.fallback
            ? 'scanner_replacement_rolled_back'
            : undefined
          : attempt.fallbackError
            ? attempt.fallbackError === 'scanner_fallback_missing'
              ? 'scanner_replacement_candidate_failed'
              : 'scanner_replacement_failed'
            : alive && Date.now() - (attempt.startedAt ?? 0) <= SCANNER_HANDOFF_BUDGET_MS
              ? 'scanner_replacement_pending'
              : 'scanner_replacement_interrupted';
    if (reason) {
      const detail = [attempt.candidateError, attempt.fallbackError].filter(Boolean).join('; ');
      const failure = new ScannerServiceLimited(reason, detail);
      installationConditions.push({
        kind:
          reason === 'mac_authorization_required'
            ? 'login_pending'
            : reason === 'scanner_replacement_pending' || reason === 'scanner_stopped'
              ? 'scanner_not_verified'
              : 'selected_component_failed',
        component: 'scanner',
        reason: detail ? `${reason}: ${detail}` : reason,
        action: failure.action,
      });
    }
  }
  const owned = await readOwnership(statusStateDir);
  const details = { ...input.details };
  const projectStatus = input.preflight.project.root ? await readProjectStatus(input) : undefined;
  const pending = await pendingProjectSetup(projectStatus?.resolvedRoot ?? input.cwd).catch(
    () => []
  );
  const setupConditions: ReadinessCondition[] = pending.map((diagnostic) => ({
    kind: 'project_identity_choice_pending',
    reason: 'A local hook reports pending project setup.',
    action: diagnostic.action,
  }));
  installationConditions.unshift(...setupConditions);
  const hosts = (
    input.configuredHosts ??
    owned.targets.filter((target) => target.component === 'hooks').map((target) => target.host)
  ).filter((host) =>
    hostOrder.includes(host as (typeof hostOrder)[number])
  ) as (typeof hostOrder)[number][];
  const hookConditions =
    input.projectHookConditions ??
    (await hookStatusConditions({ stateDir: statusStateDir }, hosts));
  installationConditions.push(...hookConditions);

  const document = buildStatusDocument({
    installationConditions,
    projectStatus,
    scannerStatus,
    scannerHeartbeat,
    projectHookConditions: hookConditions,
    configuredHosts: input.configuredHosts,
    details,
    generatedAt: input.generatedAt,
  });
  return {
    ...document,
    launcher: await launcherStatus({
      stateDir: statusStateDir,
      home: input.home,
      ...input.launcher,
    }),
    cliCredential: await cliCredentialStatus({
      stateDir: statusStateDir,
    }),
  };
}

const serializeReadiness: typeof baseReadiness = (input) => devReadiness(baseReadiness(input));
