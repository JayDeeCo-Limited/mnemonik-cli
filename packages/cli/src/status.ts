import { cliCredentialStatus } from './auth/credentials.js';
import { readOwnership } from './install/ownership.js';
import { scannerReceipt } from './scanner/control.js';
import { stateDirectory } from '@mnemonik/local-setup';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
  const scannerNotVerified: ReadinessCondition[] = input.scannerStatus
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

type ReadinessMessage = { sentence: string; nextStep: string };

const readinessMessages: Array<[RegExp, ReadinessMessage]> = [
  [
    /host_trust_pending|trust_pending/iu,
    {
      sentence: 'Codex needs permission to use the Mnemonik hooks.',
      nextStep: 'Open Codex, allow the Mnemonik hooks, then quit and reopen Codex.',
    },
  ],
  [
    /vendor_policy_pending|vendor policy/iu,
    {
      sentence: 'Your editor is waiting for permission to use Mnemonik.',
      nextStep: 'Open the editor, approve Mnemonik, then start a new session.',
    },
  ],
  [
    /restart_pending|needs? (?:a )?restart/iu,
    {
      sentence: 'An editor needs to restart before Mnemonik can work.',
      nextStep: 'Quit and reopen the editor, then start a new session.',
    },
  ],
  [
    /project_identity_choice_pending|project_setup_required|project identity|pending project setup/iu,
    {
      sentence: 'A project on this machine still needs to be connected.',
      nextStep: 'Run mnemonik status in the project and follow the project setup step.',
    },
  ],
  [
    /scanner_not_verified|background_indexing_not_verified|scanner_paused|dev_release_source/iu,
    {
      sentence: 'The scanner has not checked in yet.',
      nextStep: 'Run mnemonik status on this machine after the scanner starts.',
    },
  ],
  [
    /hook_not_verified|hooks? (?:still )?needs? verification|could not be inspected/iu,
    {
      sentence: 'Mnemonik has not received context from an editor hook yet.',
      nextStep: 'Start a new editor session, then run mnemonik status.',
    },
  ],
  [
    /hooks_missing|hook (?:declaration|credential family) is missing|hooks are not installed/iu,
    {
      sentence: 'The Mnemonik hooks are not installed correctly for an editor.',
      nextStep: 'Run mnemonik repair on this machine, then restart the editor.',
    },
  ],
  [
    /host_grant_unbound|credential_revoked/iu,
    {
      sentence: 'An editor is signed out of Mnemonik on this machine.',
      nextStep: 'Sign in to Mnemonik from that editor to restore context.',
    },
  ],
  [
    /host_not_connected|signed in, not connected yet/iu,
    {
      sentence: 'An editor is signed in but has not used Mnemonik yet.',
      nextStep: 'Open the editor and start a session in a connected project.',
    },
  ],
  [
    /scanner_omitted|scanner (?:was |coverage was )?(?:deliberately )?(?:omitted|skipped)/iu,
    {
      sentence: 'The scanner is not watching projects on this machine.',
      nextStep: 'Run mnemonik scanner enable to choose the projects to watch.',
    },
  ],
  [
    /project_uncovered|outside approved scanner roots/iu,
    {
      sentence: 'A connected project is outside the folders watched by the scanner.',
      nextStep: 'Run mnemonik scanner enable and add that project.',
    },
  ],
  [
    /host_skipped/iu,
    {
      sentence: 'An editor on this machine is not connected to Mnemonik.',
      nextStep: 'Open that editor and sign in to Mnemonik.',
    },
  ],
  [
    /windows_task_creation_failed|windows.*task/iu,
    {
      sentence: 'Windows could not start the scanner in the background.',
      nextStep:
        'Run mnemonik scanner enable again from a terminal with permission to create tasks.',
    },
  ],
  [
    /post_commit_upload_failed|status could not be uploaded/iu,
    {
      sentence: 'Setup finished on this machine, but its status did not reach Mnemonik.',
      nextStep: 'Run mnemonik doctor, then run mnemonik status again.',
    },
  ],
  [
    /indexing_failed|indexing failed/iu,
    {
      sentence: 'The scanner could not index one or more projects.',
      nextStep: 'Run mnemonik doctor on this machine and follow the scanner repair step.',
    },
  ],
  [
    /indexing_stalled|not_reporting|indexing stalled/iu,
    {
      sentence: 'The scanner stopped making progress.',
      nextStep: 'Run mnemonik doctor on this machine and restart the scanner when prompted.',
    },
  ],
  [
    /selected_component_failed|failed|unreachable/iu,
    {
      sentence: 'Part of Mnemonik did not finish setting up.',
      nextStep: 'Run mnemonik doctor on this machine and follow the first repair step.',
    },
  ],
  [
    /login_pending|sign.?in|grants? could not be verified|access has not been verified/iu,
    {
      sentence: 'A Mnemonik sign-in has not finished on this machine.',
      nextStep: 'Finish signing in from the editor, then run mnemonik status.',
    },
  ],
];

const genericReadinessMessage: ReadinessMessage = {
  sentence: 'This machine needs attention before Mnemonik can work fully.',
  nextStep: 'Run mnemonik doctor on this machine and follow the first repair step.',
};

function messageFor(reason: string, actions: readonly string[]): ReadinessMessage {
  const message =
    readinessMessages.find(([pattern]) => pattern.test(reason))?.[1] ?? genericReadinessMessage;
  if (!/host_trust_pending|trust_pending/iu.test(reason)) return message;
  const nextStep = actions.find(
    (action) =>
      action.startsWith('Run the codex command in a terminal ') ||
      action.startsWith('Open the ChatGPT app ')
  );
  return nextStep ? { ...message, nextStep } : message;
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
    output.line(message.nextStep);
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
  if (!input.scannerStatus) {
    const receipt = await scannerReceipt(statusStateDir);
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
    let alive = false;
    if (snapshot?.lifecycle.pid)
      try {
        process.kill(snapshot.lifecycle.pid, 0);
        alive = true;
      } catch {
        /* stale receipt */
      }
    if (
      state &&
      alive &&
      (snapshot?.lifecycle.state === 'running' || snapshot?.lifecycle.state === 'starting') &&
      heartbeat &&
      Date.now() - heartbeat < 360000
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
