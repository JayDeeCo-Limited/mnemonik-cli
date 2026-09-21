import { createCliCredentials } from './auth/credentials.js';
import { createInterface, type Interface } from 'node:readline';
import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Readable } from 'node:stream';
import type { createCredentialAdapter } from '@mnemonik/credentials';
import {
  createProjectSetupExecutor,
  type ExecutorDependencies,
  type EnsureOptions,
  type Owner,
  type SetupResult,
} from '@mnemonik/local-setup';
import {
  resolveProjectIdentity,
  selectRemote,
  type ProjectIdentityResolution,
  type RepositoryFingerprint,
  type RepositoryRemote,
} from '@mnemonik/shared';
import type { Output } from './output.js';
import {
  createServerTransport,
  ServerActionRequiredError,
  type CliIssueContext,
} from './transport/server.js';
import { evaluateRoot } from './project/eligibility.js';
import {
  identityHash,
  ownerLabel,
  readExecutorState,
  saveCommandRecord,
  type ProjectCommandRecord,
} from './project/records.js';

export interface ProjectExecutor {
  resolveProjectIdentity(cwd: string): Promise<ProjectIdentityResolution>;
  ensureProject(options: EnsureOptions): Promise<SetupResult>;
  stage(options: EnsureOptions): Promise<SetupResult>;
  apply(options: EnsureOptions): Promise<SetupResult>;
  rollback(options: EnsureOptions): Promise<SetupResult>;
}

export async function ensureProjectRoot(
  root: string,
  executor: ProjectExecutor
): Promise<SetupResult> {
  const resolution = await executor.resolveProjectIdentity(root);
  return executor.ensureProject({
    cwd: root,
    allowCreate: true,
    allowNestedInherit: false,
    ...(resolution.kind !== 'git_unavailable' && resolution.repository.kind === 'plain'
      ? { nonGitSelected: true as const }
      : {}),
  });
}

export function projectLimitMessage(
  result: SetupResult,
  roots: string | readonly string[]
): string[] | undefined {
  if (!('state' in result) || result.state !== 'project_limit_reached') return undefined;
  const details = result as unknown as Record<string, unknown>;
  const limit = typeof details.limit === 'number' ? details.limit : 1;
  const tier = typeof details.tier === 'string' ? details.tier : limit === 1 ? 'free' : 'plan';
  const plan = tier === 'plan' ? 'current' : `${tier[0]?.toUpperCase()}${tier.slice(1)}`;
  const allowance = limit === 1 ? 'one project' : `${limit} projects`;
  const skipped = (Array.isArray(roots) ? roots : [roots]).map((root) => basename(root));
  const subject =
    skipped.length === 1 ? skipped[0] : `${skipped[0]} and ${skipped.length - 1} more`;
  return [
    `${subject} ${skipped.length === 1 ? 'was' : 'were'} not connected. The ${plan} plan includes ${allowance}.`,
    'To connect more projects, upgrade your plan via the Mnemonik web console.',
  ];
}

export const connectedProjectsMessage = (roots: string[]): string =>
  roots.length === 1
    ? `  ✓ Connected ${basename(roots[0] ?? '')}.`
    : `  ✓ Connected ${roots.length} repositories.`;

export const projectExecutor = (dependencies: ExecutorDependencies): ProjectExecutor => {
  const executor = createProjectSetupExecutor(dependencies);
  return {
    resolveProjectIdentity: (cwd) =>
      dependencies.resolver.resolveProjectIdentity(cwd, { allowNestedInherit: false }),
    ...executor,
  };
};

export type ServerProjectState =
  'access' | 'archived' | 'deleted' | 'suspended' | 'mismatch' | 'not_found';

export interface ProjectReadTransport {
  getDefaultOwner(bearer: string): Promise<Owner | undefined>;
  readProjectState(
    projectId: string,
    bearer: string,
    localFingerprint?: RepositoryFingerprint | null
  ): Promise<{ state: ServerProjectState; allowedActions?: string[] }>;
}

export interface RealProjectRuntimeOptions {
  /** Roots individually approved by the person for this install. */
  selectedRoots?: boolean;
  apiBase?: string;
  resource?: string;
  fetch?: typeof fetch;
  stateDir?: string;
  credentials?: ReturnType<typeof createCredentialAdapter>;
  getCliBearer?: () => Promise<string | { status: string; reason: string }>;
  requestId?: string;
  fault?: ExecutorDependencies['fault'];
}

const gitEnvironment = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { LC_ALL: 'C' };
  for (const key of ['PATH', 'HOME', 'LANG', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE'])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
};

const git = (cwd: string, args: string[]): Promise<string> =>
  new Promise((resolvePromise, reject) =>
    execFile(
      'git',
      args,
      { cwd, timeout: 2_000, encoding: 'utf8', env: gitEnvironment() },
      (error, stdout) => (error ? reject(error) : resolvePromise(stdout))
    )
  );

export async function repositoryFingerprint(root: string): Promise<RepositoryFingerprint | null> {
  let names: string[];
  try {
    names = (await git(root, ['remote'])).split(/\r?\n/u).filter(Boolean);
  } catch {
    return null;
  }
  const remotes: RepositoryRemote[] = await Promise.all(
    names.map(async (name) => {
      const urls = async (push: boolean) => {
        try {
          return (
            await git(root, ['remote', 'get-url', '--all', ...(push ? ['--push'] : []), name])
          )
            .split(/\r?\n/u)
            .filter(Boolean);
        } catch {
          return [];
        }
      };
      return { name, fetchUrls: await urls(false), pushUrls: await urls(true) };
    })
  );
  const selected = selectRemote(remotes);
  return selected.status === 'fingerprint'
    ? {
        algorithmVersion: selected.fingerprint.algorithmVersion,
        hash: selected.fingerprint.hash,
      }
    : null;
}

export async function createRealProjectRuntime(options: RealProjectRuntimeOptions = {}) {
  const resolveIdentity: typeof resolveProjectIdentity = (cwd, resolverOptions) =>
    resolveProjectIdentity(cwd, { ...resolverOptions, selectedRoot: options.selectedRoots });
  const credentials =
    options.credentials ??
    createCliCredentials(options.stateDir ? { stateDir: options.stateDir } : {});
  const contexts = new Map<string, CliIssueContext>();
  const contextKey = (input: {
    deviceRootContext: { algorithmVersion: 1; hash: string };
    repositoryFingerprint: RepositoryFingerprint | null;
  }) => JSON.stringify([input.deviceRootContext, input.repositoryFingerprint]);
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
  const bindContext = async (root: string) => {
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
    const context: CliIssueContext = {
      ...evidence,
      rootKind:
        resolution.kind !== 'git_unavailable' && resolution.repository.kind === 'plain'
          ? 'selected_non_git'
          : resolution.kind === 'git_unavailable'
            ? 'ineligible'
            : 'git',
      identityState:
        resolution.kind === 'ok' ? 'valid' : resolution.kind === 'absent' ? 'absent' : 'invalid',
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

export interface ProjectCommandDependencies {
  output: Output;
  input: Readable;
  cwd: string;
  home?: string;
  executor?: ProjectExecutor;
  resolver?: { resolveProjectIdentity: typeof resolveProjectIdentity };
  stateDir?: string;
  getCliBearer?: () => Promise<string | undefined>;
  transport?: ProjectReadTransport;
}

export interface ProjectCommandInput {
  command: 'init' | 'setup' | 'status' | 'link';
  path?: string;
  projectId?: string;
  json: boolean;
  nonInteractive: boolean;
  apply: boolean;
  nonGit: boolean;
  confirmMismatch: boolean;
  replace: boolean;
  owner?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function actionRequired(
  output: Output,
  json: boolean,
  state: string,
  details: Record<string, unknown> = {}
): number {
  const result = { status: 'ACTION_REQUIRED', state, ...details };
  if (json) output.json(result);
  else {
    output.error(`Project action required: ${state}`);
    if (Array.isArray(details.allowedActions))
      output.line(`  Allowed actions: ${details.allowedActions.join(', ')}`);
  }
  return 3;
}

class Prompter {
  private readline?: Interface;
  private lines?: AsyncIterator<string>;

  constructor(
    private readonly input: Readable,
    private readonly output: Output
  ) {}

  async confirm(prompt: string): Promise<boolean> {
    this.output.line(`${prompt} [y/N]`);
    this.readline ??= createInterface({
      input: this.input,
      terminal: Boolean((this.input as Readable & { isTTY?: boolean }).isTTY),
    });
    this.lines ??= this.readline[Symbol.asyncIterator]();
    const answer = await this.lines.next();
    return /^(?:y|yes)$/i.test(answer.value?.trim() ?? '');
  }

  close(): void {
    this.readline?.close();
  }
}

function parseOwner(value: string | undefined): Owner | undefined | null {
  if (!value) return undefined;
  if (value === 'personal') return 'personal';
  if (value.startsWith('team:') && UUID.test(value.slice(5))) return { teamId: value.slice(5) };
  return null;
}

async function selectedOwner(
  explicit: string | undefined,
  bearer: string,
  transport: ProjectReadTransport | undefined
): Promise<Owner | null> {
  const parsed = parseOwner(explicit);
  if (parsed === null) return null;
  if (parsed) return parsed;
  return (await transport?.getDefaultOwner(bearer)) ?? 'personal';
}

function showPlan(
  output: Output,
  plan: { root: string; reason: string; owner: Owner; candidates: unknown[] }
): void {
  output.line('Project plan');
  output.line(`  Root: ${plan.root}`);
  output.line(`  Decision: ${plan.reason}`);
  output.line(`  Owner: ${ownerLabel(plan.owner)}`);
  output.line(`  Candidates: ${plan.candidates.length ? JSON.stringify(plan.candidates) : 'none'}`);
}

function showResult(
  output: Output,
  json: boolean,
  result: SetupResult,
  root: string,
  owner: Owner,
  record: ProjectCommandRecord
) {
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
    output.error(`Project action required: ${'state' in result ? result.state : result.status}`);
    if ('candidates' in result && Array.isArray(result.candidates))
      for (const candidate of result.candidates)
        output.line(`  ${candidate.displayName} (${candidate.projectId})`);
    if ('used' in result && 'limit' in result)
      output.line(`  Projects: ${result.used} used, limit ${result.limit}`);
    if ('allowedActions' in result)
      output.line(`  Allowed actions: ${result.allowedActions.join(', ')}`);
  }
}

async function finish(
  deps: ProjectCommandDependencies,
  input: ProjectCommandInput,
  result: SetupResult,
  root: string,
  reason: string,
  owner: Owner,
  beforeHash: ProjectCommandRecord['beforeHash']
): Promise<number> {
  const afterHash = await identityHash(root);
  const record: ProjectCommandRecord = {
    resolvedRoot: root,
    decisionReason: result.status === 'done' || !('state' in result) ? reason : result.state,
    chosenOwner: ownerLabel(owner),
    projectId:
      result.status === 'done'
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
    else deps.output.line(`Repository ignored on this device: ${root}`);
    return 0;
  }
  if (result.status !== 'done') {
    showResult(deps.output, input.json, result, root, owner, record);
    return 3;
  }
  if (input.json) deps.output.json(record);
  else {
    deps.output.line(`Project ${result.projectId ?? 'ready'} at ${root}`);
    deps.output.line(`Identity: ${root}/.mnemonik.json`);
  }
  return 0;
}

async function finishRequired(
  deps: ProjectCommandDependencies,
  input: ProjectCommandInput,
  root: string,
  reason: string,
  owner: Owner,
  state: string,
  allowedActions: string[],
  details: Record<string, unknown> = {}
): Promise<number> {
  const beforeHash = await identityHash(root);
  return finish(
    deps,
    input,
    { status: 'ACTION_REQUIRED', state, allowedActions, ...details },
    root,
    reason,
    owner,
    beforeHash
  );
}

async function statusCommand(
  input: ProjectCommandInput,
  deps: ProjectCommandDependencies
): Promise<number> {
  const cwd = input.path ?? deps.cwd;
  const resolution = await (deps.resolver?.resolveProjectIdentity ?? resolveProjectIdentity)(cwd, {
    allowNestedInherit: false,
  });
  const root = 'root' in resolution ? resolution.root : cwd;
  const projectId = resolution.kind === 'ok' ? resolution.identity.projectId : null;
  const currentHash = await identityHash(root);
  const reachable = await lstat(root).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  );
  const bearer = await deps.getCliBearer?.();
  const server =
    projectId && bearer && deps.transport
      ? await deps.transport.readProjectState(projectId, bearer, await repositoryFingerprint(root))
      : undefined;
  const savedExecutorState = await readExecutorState(root, deps.stateDir);
  const executorState = !reachable && savedExecutorState ? 'unreachable' : savedExecutorState;
  const record = {
    resolvedRoot: root,
    decisionReason: resolution.kind,
    chosenOwner: 'personal' as const,
    projectId,
    beforeHash: currentHash,
    afterHash: currentHash,
    identity: resolution.kind,
    reachability: reachable ? 'reachable' : 'unreachable',
    ...(server ? { server: server.state } : {}),
    ...(executorState ? { executorState } : {}),
  };
  if (input.json) deps.output.json(record);
  else {
    deps.output.line(`Root: ${root}`);
    deps.output.line(`Identity: ${resolution.kind}`);
    if (!reachable) deps.output.line('Reachability: unreachable');
    if (server) deps.output.line(`Server: ${server.state}`);
    if (executorState) deps.output.line(`Executor: ${executorState}`);
  }
  return 0;
}

async function runProjectCommandInner(
  input: ProjectCommandInput,
  deps: ProjectCommandDependencies,
  prompts: Prompter
): Promise<number> {
  if (input.command === 'status') return statusCommand(input, deps);
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
    return finishRequired(
      deps,
      input,
      resolution.root,
      resolution.kind,
      owner,
      resolution.kind,
      [
        'use_parent_identity',
        'initialize_nested_separately',
        'select_main_or_worktree_identity',
        'cancel',
      ],
      { identityLocation }
    );
  }
  let selectedNonGit = input.nonGit || input.command === 'link';
  let decision = await evaluateRoot(resolution, {
    cwd,
    home: deps.home,
    nonGitSelected: selectedNonGit,
  });
  if (
    !decision.allowed &&
    decision.reason === 'non_git_selection_required' &&
    !input.nonInteractive &&
    !input.json &&
    (await prompts.confirm(`Use non-git folder ${decision.root}?`))
  ) {
    selectedNonGit = true;
    decision = await evaluateRoot(resolution, { cwd, home: deps.home, nonGitSelected: true });
  }
  if (!decision.allowed)
    return actionRequired(deps.output, input.json, decision.reason, {
      root: decision.root,
      allowedActions:
        decision.reason === 'non_git_selection_required'
          ? ['select_non_git', 'cancel']
          : ['cancel'],
    });
  deps.output.setContext({ home: deps.home, projectRoot: decision.root });
  const base: EnsureOptions = {
    cwd,
    owner,
    allowCreate: input.command !== 'link',
    allowNestedInherit: false,
    ...(selectedNonGit ? { nonGitSelected: true } : {}),
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
      return finishRequired(
        deps,
        input,
        decision.root,
        decision.reason,
        owner,
        'apply_required',
        ['rerun_with_apply', 'cancel'],
        { decisionReason: decision.reason, candidates: [] }
      );
    }
    if (!input.nonInteractive && !input.json) {
      const beforeHash = await identityHash(decision.root);
      const preview = await executor.stage({ ...base, allowCreate: false });
      const candidates =
        'candidates' in preview && Array.isArray(preview.candidates) ? preview.candidates : [];
      showPlan(deps.output, {
        root: decision.root,
        reason: decision.reason,
        owner,
        candidates,
      });
      const canContinue =
        preview.status === 'staged' ||
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
      const result =
        preview.status === 'staged'
          ? await executor.apply(base)
          : await executor
              .stage(base)
              .then(async (staged) => (staged.status === 'staged' ? executor.apply(base) : staged));
      return finish(deps, input, result, decision.root, decision.reason, owner, beforeHash);
    }
  }
  if (input.command === 'link') {
    if (!input.projectId || !UUID.test(input.projectId))
      return finishRequired(
        deps,
        input,
        decision.root,
        decision.reason,
        owner,
        'invalid_project_id',
        ['provide_project_uuid', 'cancel']
      );
    if (!deps.transport)
      return finishRequired(
        deps,
        input,
        decision.root,
        decision.reason,
        owner,
        'status_unavailable',
        ['retry', 'cancel']
      );
    const server = await deps.transport.readProjectState(
      input.projectId,
      bearer,
      await repositoryFingerprint(decision.root)
    );
    if (server.state === 'mismatch') {
      if (
        !input.confirmMismatch &&
        (input.nonInteractive ||
          input.json ||
          !(await prompts.confirm('Repository fingerprint differs. Link anyway?')))
      ) {
        return finishRequired(
          deps,
          input,
          decision.root,
          decision.reason,
          owner,
          'fingerprint_mismatch',
          ['confirm_mismatch', 'cancel']
        );
      }
    } else if (server.state !== 'access') {
      return finishRequired(
        deps,
        input,
        decision.root,
        decision.reason,
        owner,
        server.state,
        server.allowedActions ?? []
      );
    }
    if (
      resolution.kind === 'ok' &&
      resolution.identity.projectId !== input.projectId &&
      !input.replace
    )
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
  let result =
    input.command === 'init'
      ? await executor.ensureProject(base)
      : await executor
          .stage(base)
          .then(async (staged) => (staged.status === 'staged' ? executor.apply(base) : staged));
  if (input.command === 'init' && !input.nonInteractive && !input.json) {
    if (result.status === 'ignored') {
      deps.output.line(`Root: ${decision.root}`);
      deps.output.line(`Identity: ${join(decision.root, '.mnemonik.json')}`);
      if (await prompts.confirm('Clear this repository ignore and continue?'))
        result = await executor.ensureProject({ ...base, clearIgnore: true });
    } else if (
      'allowedActions' in result &&
      result.allowedActions.includes('ignore') &&
      (await prompts.confirm('Ignore this repository on this device?'))
    )
      result = await executor.ensureProject({ ...base, ignore: true });
  }
  return finish(deps, input, result, decision.root, decision.reason, owner, beforeHash);
}

export async function runProjectCommand(
  input: ProjectCommandInput,
  deps: ProjectCommandDependencies
): Promise<number> {
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
      } catch (error) {
        if (input.command !== 'status') {
          const state =
            error instanceof ServerActionRequiredError && error.result.state !== 'family_missing'
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
    } catch (error) {
      if (error instanceof ServerActionRequiredError)
        return actionRequired(deps.output, input.json, error.result.state, {
          allowedActions: error.result.allowedActions,
        });
      throw error;
    }
  } finally {
    prompts.close();
  }
}

export async function ensureProjectForAgent(options: {
  output: Output;
  cwd: string;
  executor?: ProjectExecutor;
  input?: Readable;
}): Promise<number> {
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
      let requestId: string | undefined;
      const input = options.input ?? process.stdin;
      if (!(input as Readable & { isTTY?: boolean }).isTTY) {
        let text = '';
        for await (const chunk of input) {
          text += String(chunk);
          if (text.length > 4_096) throw new Error('invalid_request');
        }
        const value = JSON.parse(text) as { requestId?: unknown };
        if (typeof value.requestId !== 'string') throw new Error('invalid_request');
        requestId = value.requestId;
      }
      executor = (await createRealProjectRuntime({ credentials, requestId })).executor;
    } catch (error) {
      const reason =
        error instanceof ServerActionRequiredError && error.result.state !== 'family_missing'
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

export async function rollbackProjectIdentity(options: {
  output: Output;
  cwd: string;
  executor?: ProjectExecutor;
}): Promise<number> {
  if (!options.executor) return 3;
  const result = await options.executor.rollback({
    cwd: options.cwd,
    allowCreate: false,
    allowNestedInherit: false,
  });
  options.output.json(result);
  return result.status === 'rolled_back' ? 0 : 3;
}
