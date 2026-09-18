import { apiOrigin, type ReadinessCondition } from '@mnemonik/shared';
import {
  bindInstalledHostGrants,
  grantHost,
  matchHostGrant,
  type GrantTransport,
} from '../auth/status.js';
import type { Grant, HostAdapter, Inspection } from './adapters.js';
import type { ComponentCredentialResponse } from '@mnemonik/credentials';
import { readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  hostPackageImports,
  type HostPackageImports,
  type Target,
  type FileChange,
} from './adapters.js';
import {
  RuntimeStore,
  hash,
  hostNpmSource,
  type HostArtifact,
  type HostPackagePin,
  type RuntimeSource,
  type Verified,
} from '../runtime/store.js';
import { bytesAt, digest, interrupted, withInstall, type Journal } from './journal.js';
import {
  readOwnership,
  rollbackHost,
  saveOwnership,
  type OwnedTarget,
  type HostRun,
} from './ownership.js';
import { ensureInstallSession } from '../auth/installSession.js';
import { createCliCredentials } from '../auth/credentials.js';

export interface HostSelection {
  component?: Target['component'];
  host: HostArtifact;
  scope: Target['scope'];
  home: string;
  projectRoot?: string;
  profilePath?: string;
}
export interface HostDependencies {
  stateDir: string;
  account: string;
  /** Continue project/scanner steps under the host install lease and journal. */
  afterHosts?(
    journal: Journal,
    results: HostResult[],
    refreshHosts: () => Promise<void>
  ): Promise<void>;
  rollbackInstall?(journal: Journal): Promise<void>;
  recovery?(journal: Journal): Promise<'resume' | 'rollback'>;
  installPlan?: { components: string[]; roots: string[] };
  env?: NodeJS.ProcessEnv;
  source?(host: HostArtifact): Promise<RuntimeSource>;
  imports?: HostPackageImports;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  fault?: Journal['afterMutation'];
  instruction?(text: string): void;
  grants?: GrantTransport;
  approveHost?: () => Promise<boolean>;
  getCliBearer?: () => Promise<string>;
  authorizeInstallSession?: (installationId: string) => Promise<string>;
  noBrowser?: boolean;
  credentialFetch?: typeof fetch;
  timeout?(host: HostArtifact): Promise<'retry' | 'skip' | 'cancel'>;
  offerRevoke?(host: HostArtifact): Promise<boolean>;
  migrate?(host: HostArtifact, scope: Target['scope']): Promise<boolean>;
  /** Explicit consent to restore a person-disabled native host policy. */
  apply?: boolean;
}
export type HostCommand = 'install' | 'repair' | 'update' | 'uninstall';
export interface HostResult {
  target: string;
  elapsedMs: number;
  status: 'READY' | 'LIMITED' | 'ACTION_REQUIRED' | 'FAILED';
  reason: string;
  detail?: string;
  action?: string;
}
export function codexTrustAction(resolvedPath?: string): string {
  const desktop =
    resolvedPath?.includes('/ChatGPT.app/') ||
    /[\\/]Programs[\\/]OpenAI[\\/]Codex[\\/]/i.test(resolvedPath ?? '');
  return desktop
    ? "Open the ChatGPT app and use the 'Hooks need review' notice at startup to review and allow the Mnemonik hooks. If the notice does not appear, restart the app once."
    : 'Run the codex command in a terminal and use its hook trust prompt to allow the Mnemonik hooks; then quit and reopen Codex.';
}
export const CODEX_TRUST_ACTION = codexTrustAction();
const hostLabels: Record<HostArtifact, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  grok: 'Grok',
};
export const hostNotConnectedCondition = (host: HostArtifact): ReadinessCondition => ({
  kind: 'host_not_connected',
  component: host,
  reason: `${host}: signed in, not connected yet`,
  action: `open ${hostLabels[host]} and start a session, then run mnemonik status`,
});
/**
 * A host skipped at install keeps its hooks and its URL-only MCP declaration and is recorded as
 * still connecting; the sign-in happens in the app and the next status run binds the grant.
 */
export const hostStillConnectingCondition = (host: HostArtifact): ReadinessCondition => ({
  kind: 'login_pending',
  component: host,
  reason: `${hostLabels[host]} is still connecting. Finish the sign-in in the app, then run mnemonik status.`,
  action: 'mnemonik status',
});
const identity = (t: HostSelection) =>
  `${t.host}:${t.component ?? 'hooks'}:${t.scope}:${t.profilePath ?? (t.scope === 'user' ? t.home : t.projectRoot)}`;
export async function hostSource(
  host: HostArtifact,
  packagePath: string | URL = new URL('../../package.json', import.meta.url)
) {
  const pkg = JSON.parse(await readFile(packagePath, 'utf8')) as {
    mnemonik: { hosts: Record<HostArtifact, HostPackagePin> };
  };
  return hostNpmSource(host, pkg.mnemonik.hosts[host]);
}
function targetFor(
  selection: HostSelection,
  runtime: Verified,
  store: RuntimeStore,
  owned?: OwnedTarget
): Target {
  return {
    component: selection.component ?? 'hooks',
    scope: selection.scope,
    projectRoot: selection.projectRoot,
    credentialFamily: '',
    runtimeEntry: runtime.entry,
    runtimeRoot: dirname(store.pointerPath(selection.host)),
    ...(owned
      ? { createdFiles: owned.files.filter((file) => file.created).map((file) => file.path) }
      : {}),
  };
}
function environment(selection: HostSelection, env = process.env, owned = false) {
  const result: NodeJS.ProcessEnv = { ...env, HOME: selection.home, USERPROFILE: selection.home };
  if (owned) result.MNEMONIK_CLI_OWNED_TARGET = '1';
  if (selection.scope === 'user' && selection.profilePath) {
    if (selection.host === 'codex') result.CODEX_HOME = dirname(selection.profilePath);
    if (selection.host === 'grok')
      result.GROK_HOME =
        selection.component === 'mcp'
          ? dirname(selection.profilePath)
          : dirname(dirname(selection.profilePath));
  }
  for (const key of ['CODEX_HOME', 'GROK_HOME'])
    if (result[key]) result[key] = resolve(result[key]);
  return result;
}
async function stage(journal: Journal, run: HostRun, changes: FileChange[], runtime: Verified) {
  for (const change of changes)
    await journal.plan(change.path, change.remove ? null : change.content, {
      kind: 'host',
      host: run.host,
      group: run.id,
      staging: 'inactive',
      version: runtime.manifest.version,
      artifactDigest: runtime.reference.manifestSha256,
    });
  for (const change of changes) await journal.stage(change);
}
async function apply(journal: Journal, run: HostRun) {
  for (const target of journal.data.targets.filter((t) => t.group === run.id))
    await journal.commit(target);
}

function actionFor(
  reason: string,
  selection: HostSelection,
  searchedLocations: string[] = [],
  resolvedPath?: string
): string | undefined {
  if (reason === 'not_found') {
    const name = hostLabels[selection.host];
    return searchedLocations.length
      ? `${name} was not found (looked on PATH and in ${searchedLocations.join(', ')}). Install it, or open a new terminal if you just installed it.`
      : `${name} was not found on PATH. Install it, or open a new terminal if you just installed it.`;
  }
  if (reason === 'unsupported_version')
    return `upgrade ${selection.host} to ${selection.host === 'codex' ? '0.145.0' : 'a supported version'} and retry`;
  if (reason === 'unverified_version')
    return `Verify ${selection.host} is installed and prints a supported version, then retry.`;
  if (reason === 'codex_trust_pending') return codexTrustAction(resolvedPath);
  if (reason === 'codex_trust_declined') return 'Approve the Mnemonik hook in Codex.';
  if (reason === 'codex_hooks_policy_disabled')
    return 'Review Codex [features] hooks = false, then rerun repair with --apply to re-enable it.';
  if (reason === 'mcp_name_conflict')
    return `Resolve the existing Mnemonik MCP declaration in ${selection.host}, then retry.`;
  if (reason === 'project_shared_declaration_conflict')
    return 'Ask the collaborator who owns the project declaration to reconcile it, then retry.';
  if (reason === 'host_grant_unverified') return `Run mnemonik connect ${selection.host}.`;
  if (reason === 'host_enable_required')
    return `Enable Mnemonik in ${hostLabels[selection.host]}, then run mnemonik connect ${selection.host}.`;
  if (reason === 'hooks_missing' || reason === 'mcp_declaration_missing')
    return `mnemonik repair --host ${selection.host} --component ${selection.component ?? 'hooks'}`;
  if (reason === 'installation_required') return 'Run mnemonik install first.';
  if (reason === 'digest_mismatch') return 'mnemonik repair';
  if (reason === 'host_account_mismatch')
    return `Sign out of Mnemonik in ${selection.host}${selection.profilePath ? ` profile ${selection.profilePath}` : ''}, then run mnemonik connect ${selection.host}.`;
  if (reason === 'hook_credential_authorization_required')
    return 'Run `mnemonik auth login --reopen-install` to start a new install session';
  return undefined;
}

async function codexHooksDisabled(changes: FileChange[]): Promise<boolean> {
  const config = changes.find((change) => change.path.endsWith('config.toml'));
  const raw = config ? (await bytesAt(config.path))?.toString() : undefined;
  if (!raw) return false;
  let features = false;
  for (const line of raw.split(/\r?\n/)) {
    if (/^\s*\[/.test(line))
      features = /^\s*\[\s*(?:features|"features"|'features')\s*\]/.test(line);
    else if (features && /^\s*(?:hooks|"hooks"|'hooks')\s*=\s*false\b/.test(line)) return true;
  }
  return false;
}

async function removeUnusedRuntimePointers(
  journal: Journal,
  store: RuntimeStore,
  stateDir: string,
  hosts: HostArtifact[]
) {
  const owned = await readOwnership(stateDir);
  for (const host of new Set(hosts)) {
    if (owned.targets.some((target) => target.host === host)) continue;
    const pointer = store.pointerPath(host);
    if (!(await bytesAt(pointer))) continue;
    const target = await journal.plan(pointer, null, {
      kind: 'runtime',
      host,
      group: `uninstall-runtime:${host}`,
    });
    await journal.stage(target);
    await journal.commit(target);
  }
}

type HostOutcome = {
  results: HostResult[];
  reports: string[];
  journal: Journal['data'];
  recovery?: { command: HostCommand; selections: HostSelection[]; allowMigration: boolean };
};
const protectInstall =
  (deps: HostDependencies, work: (journal: Journal) => Promise<HostOutcome>) =>
  async (journal: Journal): Promise<HostOutcome> => {
    try {
      return await work(journal);
    } catch (error) {
      if (!deps.afterHosts) throw error;
      journal.data.phase = 'rolling_back';
      journal.data.reports.push(error instanceof Error ? error.message : 'install_failed');
      await journal.save();
      if (deps.rollbackInstall) await deps.rollbackInstall(journal);
      else journal.data.phase = (await journal.restoreFiles()) ? 'rolled_back' : 'rolling_back';
      journal.data.state = 'FAILED';
      await journal.save();
      return {
        results: (journal.data.hostRuns ?? []).map((run) => ({
          target: run.id,
          elapsedMs: run.elapsedMs ?? 0,
          status: 'FAILED',
          reason: 'installation_rolled_back',
        })),
        reports: journal.data.reports,
        journal: journal.data,
      };
    }
  };

/** All selected targets share the ownership lease; a failed target restores only its group. */
export async function runHosts(
  command: HostCommand,
  selections: HostSelection[],
  deps: HostDependencies,
  allowMigration = false
): Promise<{ results: HostResult[]; reports: string[]; journal: Journal['data'] }> {
  const pending = (await interrupted(deps.stateDir))[0];
  if (pending && !pending.data.hostRequest) throw new Error('resolve_interrupted_install_first');
  const outcome = await withInstall(
    deps.stateDir,
    {
      account: deps.account,
      ...(deps.afterHosts ? { joined: true } : {}),
      hosts: selections.map((s) => s.host),
      components: [...new Set(selections.map((s) => s.component ?? 'hooks'))],
      scopes: {},
      roots: [],
      credentials: [],
      hostRuns: [],
      hostRequest: { command, selections, allowMigration },
      ...deps.installPlan,
    },
    pending,
    protectInstall(deps, async (journal) => {
      const results: HostResult[] = [];
      const completionChecks: Array<() => Promise<void>> = [];
      const store = new RuntimeStore(deps.stateDir);
      journal.data.hostRuns ??= [];
      if (pending?.data.joined) {
        const request = pending.data.hostRequest;
        if (!request || !deps.afterHosts || !deps.rollbackInstall)
          throw new Error('resolve_interrupted_install_first');
        if ((await deps.recovery?.(journal)) !== 'resume') {
          await deps.rollbackInstall(journal);
          return { results, reports: journal.data.reports, journal: journal.data };
        }
        const completed = journal.data.hostRuns.filter(
          (run) =>
            (run.status === 'complete' ||
              run.status === 'verified' ||
              run.reason === 'host_skipped') &&
            !journal.data.targets.some(
              (target) => target.group === run.id && target.status === 'restored'
            )
        );
        for (const run of journal.data.hostRuns.filter(
          (r) => r.status !== 'rolled_back' && !completed.includes(r)
        )) {
          await rollbackHost(deps.stateDir, journal, run.id);
          const restoredGroup = `restored:${journal.data.hostRuns.length}:${run.id}`;
          for (const target of journal.data.targets)
            if (target.group === run.id) target.group = restoredGroup;
          run.id = restoredGroup;
          run.status = 'rolled_back';
        }
        for (const run of completed) {
          if (run.status === 'verified') {
            await saveOwnership(deps.stateDir, journal, run);
            run.status = 'complete';
          }
          results.push({
            target: run.id,
            elapsedMs: run.elapsedMs ?? 0,
            status:
              run.reason === 'host_skipped'
                ? 'LIMITED'
                : run.candidate?.component === 'mcp' && !run.candidate.grant
                  ? 'ACTION_REQUIRED'
                  : deps.grants
                    ? 'READY'
                    : 'LIMITED',
            reason: run.reason ?? 'host_grant_unverified',
          });
        }
        selections = request.selections.filter(
          (selection) => !completed.some((run) => run.id === identity(selection))
        );
      } else if (pending) {
        const request = pending.data.hostRequest;
        if (!request) throw new Error('host_request_missing');
        const retry = request.selections.filter(
          (_, index) =>
            !['complete', 'verified'].includes(journal.data.hostRuns?.[index]?.status ?? 'pending')
        );
        // An interrupted verified target can finish ownership publication without redoing native actions.
        for (const run of journal.data.hostRuns) {
          if (run.status === 'pending') {
            await rollbackHost(deps.stateDir, journal, run.id);
            run.status = 'rolled_back';
            run.reason = 'interrupted_target_restored';
          } else if (run.status === 'verified') {
            await saveOwnership(deps.stateDir, journal, run);
            run.status = 'complete';
          }
          if (run.status === 'complete')
            results.push({
              target: run.id,
              elapsedMs: run.elapsedMs ?? 0,
              status:
                run.reason === 'uninstalled'
                  ? 'READY'
                  : run.candidate?.component === 'mcp' && !run.candidate.grant
                    ? 'ACTION_REQUIRED'
                    : 'LIMITED',
              reason: run.reason ?? 'host_grant_unverified',
            });
        }
        if (request.command === 'uninstall')
          await removeUnusedRuntimePointers(
            journal,
            new RuntimeStore(deps.stateDir),
            deps.stateDir,
            request.selections.map((selection) => selection.host)
          );
        journal.data.phase = 'complete';
        await journal.event('complete');
        return {
          results,
          reports: journal.data.reports,
          journal: journal.data,
          recovery: { ...request, selections: retry },
        };
      }
      for (const selection of selections) {
        const now = deps.now ?? Date.now;
        const startedAt = now();
        const record = await readOwnership(deps.stateDir);
        let old = record.targets.find(
          (t) =>
            t.host === selection.host &&
            t.component === (selection.component ?? 'hooks') &&
            t.scope === selection.scope &&
            (selection.profilePath
              ? t.profilePath === selection.profilePath
              : t.home === selection.home &&
                (selection.scope === 'user' || t.projectRoot === selection.projectRoot))
        );
        const run: HostRun = {
          id: old?.id ?? identity(selection),
          host: selection.host,
          status: 'pending',
        };
        journal.data.hostRuns.push(run);
        await journal.save();
        let freshRuntimeVersion: string | undefined;
        let searchedLocations: string[] = [];
        let resolvedPath: string | undefined;
        try {
          const pointer = store.pointerPath(selection.host);
          const beforePointer = await bytesAt(pointer);
          if (beforePointer) await store.verifyRuntime(selection.host);
          let runtime: Verified;
          if (command === 'update' || command === 'install') {
            const source = await (deps.source ?? hostSource)(selection.host);
            const previous = beforePointer
              ? (JSON.parse(beforePointer.toString()) as { current: Verified['reference'] })
              : undefined;
            const proposed =
              previous?.current.version === source.manifest.version
                ? beforePointer
                : Buffer.from(
                    JSON.stringify({
                      current: {
                        version: source.manifest.version,
                        manifestSha256: hash(JSON.stringify(source.manifest)),
                      },
                      previous: previous?.current,
                    })
                  );
            const runtimeTarget = await journal.plan(pointer, proposed, {
              kind: 'runtime',
              host: selection.host,
              group: run.id,
            });
            await journal.stage(runtimeTarget);
            // Store verifies before publishing current; journal has captured its prior value first.
            runtime = await store.installRuntime(selection.host, source.manifest.version, source);
            if (!beforePointer) freshRuntimeVersion = runtime.reference.version;
            await journal.commit(runtimeTarget);
          } else runtime = await store.verifyRuntime(selection.host);
          const target = targetFor(selection, runtime, store, old);
          const module = await (deps.imports ?? hostPackageImports)[selection.host](runtime);
          const adapter = module.createHostAdapter({
            target,
            env: environment(selection, deps.env, !!selection.profilePath && !!old),
            version: runtime.manifest.version,
            artifactDigest: runtime.reference.manifestSha256,
          });
          if (adapter.name !== selection.host) throw new Error('adapter_identity_mismatch');
          const detected = await adapter.detect();
          resolvedPath = detected.resolvedPath;
          if (!detected.supported) {
            searchedLocations = detected.searchedLocations ?? [];
            if (target.component === 'mcp' && command !== 'update' && command !== 'repair') {
              const instruction = await adapter.launch();
              journal.data.reports.push(instruction);
              deps.instruction?.(instruction);
            }
            throw new Error(detected.reason ?? 'unverified_version');
          }
          if (!adapter.capabilities().components.includes(target.component))
            throw new Error('unsupported_component');
          if (!adapter.capabilities().scopes.includes(selection.scope))
            throw new Error('unsupported_scope');
          const beforeInspection = await adapter.inspect(target);
          const otherScopes = command === 'install' ? (beforeInspection.otherScopes ?? []) : [];
          if (
            otherScopes.length &&
            !allowMigration &&
            !(await deps.migrate?.(selection.host, selection.scope))
          )
            throw new Error('integration_scope_required');
          if (target.component === 'hooks') {
            const credentials = createCliCredentials({ stateDir: deps.stateDir });
            target.credentialFamily =
              old?.credentialFamily ??
              record.targets.find(
                (candidate) =>
                  candidate.host === selection.host &&
                  candidate.component === 'hooks' &&
                  candidate.home === selection.home
              )?.credentialFamily ??
              '';
            if (
              command !== 'uninstall' &&
              (!target.credentialFamily || !(await credentials.readFamily(target.credentialFamily)))
            ) {
              let bearer = await deps.getCliBearer?.();
              if (!bearer) throw new Error('hook_credential_authorization_required');
              const issue = () =>
                (deps.credentialFetch ?? fetch)(`${apiOrigin()}/api/v1/component-credentials`, {
                  method: 'POST',
                  headers: {
                    authorization: `Bearer ${bearer}`,
                    'content-type': 'application/json',
                  },
                  body: JSON.stringify({ component_kind: 'hook' }),
                  signal: AbortSignal.timeout(10_000),
                });
              let response = await issue();
              const body =
                response.status === 403
                  ? ((await response.json().catch(() => ({}))) as { error?: string })
                  : undefined;
              if (body?.error === 'install_session_required') {
                const installation = (await deps.grants?.list())?.deviceInstallationId;
                if (!installation) throw new Error('hook_credential_authorization_required');
                if (!deps.authorizeInstallSession && !deps.timeout)
                  throw new Error('hook_credential_authorization_required');
                try {
                  bearer = await ensureInstallSession({
                    stateDir: deps.stateDir,
                    bearer,
                    deviceInstallationId: installation,
                    credentials,
                    fetch: deps.credentialFetch,
                    print: deps.instruction,
                    noBrowser: deps.noBrowser,
                    ...(deps.authorizeInstallSession
                      ? { authorize: deps.authorizeInstallSession }
                      : {}),
                  });
                } catch (error) {
                  throw new Error('hook_credential_authorization_required', { cause: error });
                }
                response = await issue();
              }
              if (!response.ok) throw new Error('hook_credential_authorization_required');
              const family = (await response.json()) as ComponentCredentialResponse;
              if (!/^[A-Za-z0-9_-]+$/.test(family.id)) throw new Error('invalid_credential_family');
              // Journal only the reference, before storing any credential value.
              journal.data.credentials.push({ reference: family.id, kind: 'component' });
              await journal.save();
              await credentials.putFamily('hook', family);
              target.credentialFamily = family.id;
            }
            if (target.credentialFamily && command !== 'uninstall') {
              const reference = await journal.plan(
                join(deps.stateDir, 'hook-families', `${hash(run.id)}.json`),
                Buffer.from(JSON.stringify({ credentialFamily: target.credentialFamily })),
                { kind: 'credential-reference', host: run.host, group: run.id }
              );
              await journal.stage(reference);
              await journal.commit(reference);
            }
          }
          const changes: FileChange[] = [];
          let ownedChanges: FileChange[] = changes;
          let profilePath: string | undefined;
          if (command === 'uninstall') {
            target.originalFiles = {};
            for (const file of old?.files ?? []) {
              if (!file.original) continue;
              const bytes = await bytesAt(file.original.backup);
              if (digest(bytes) !== file.original.hash) throw new Error('host_backup_invalid');
              target.originalFiles[file.path] = bytes;
            }
            await adapter.uninstall(
              {
                stage: async (c) => {
                  changes.push(c);
                },
              },
              target
            );
          } else {
            const plan = await adapter.plan(target);
            if (
              plan.version !== runtime.manifest.version ||
              plan.artifactDigest !== runtime.reference.manifestSha256
            )
              throw new Error('adapter_provenance_mismatch');
            profilePath = plan.changes.at(-1)?.path;
            if (
              command === 'repair' &&
              selection.host === 'codex' &&
              target.component === 'hooks' &&
              !deps.apply &&
              (await codexHooksDisabled(plan.changes))
            )
              throw new Error('codex_hooks_policy_disabled');
            if (
              command === 'install' &&
              selection.scope === 'project' &&
              !old &&
              beforeInspection.declarationPresent
            ) {
              const declaration = plan.changes.at(-1);
              const existing = declaration ? await bytesAt(declaration.path) : null;
              if (!declaration || !existing || hash(existing) !== hash(declaration.content))
                throw new Error('project_shared_declaration_conflict');
              changes.push(...plan.changes.slice(0, -1));
              ownedChanges = [...changes, { path: declaration.path, content: existing }];
            } else changes.push(...plan.changes);
          }
          if (command !== 'uninstall') {
            profilePath ??= changes.at(-1)?.path;
            if (!profilePath) throw new Error('adapter_empty_plan');
            selection.profilePath = resolve(profilePath);
            old = record.targets.find(
              (t) =>
                t.host === selection.host &&
                t.component === (selection.component ?? 'hooks') &&
                t.scope === selection.scope &&
                t.profilePath === selection.profilePath
            );
            const id = old?.id ?? identity(selection);
            for (const entry of journal.data.targets) if (entry.group === run.id) entry.group = id;
            run.id = id;
            // Persist the concrete profile for recovery, even if the environment changes later.
            await journal.save();
          }
          await stage(journal, run, changes, runtime);
          await journal.event('apply', run.id);
          await apply(journal, run);
          await journal.event('host_intent', run.id);
          let inspection: Inspection | undefined;
          if (command === 'uninstall') {
            if ((await adapter.verify(target)).declarationPresent)
              throw new Error('uninstall_verification_failed');
            if (target.component === 'mcp' && (await deps.offerRevoke?.(selection.host))) {
              await revokeHostGrants(selection.host, deps, old?.grant?.id);
              if (old?.grant && adapter.revoke) await adapter.revoke(old.grant);
              else deps.instruction?.(adapter.revokeAction);
            }
          } else {
            try {
              inspection = await waitForHost(
                adapter,
                target,
                selection.host,
                {
                  ...deps,
                  instruction: (text) => {
                    journal.data.reports.push(`${run.id}: ${text}`);
                    deps.instruction?.(text);
                  },
                },
                old?.grant,
                command
              );
              run.reason = inspection.trustPending
                ? 'codex_trust_pending'
                : target.component === 'hooks' || inspection.grant
                  ? 'hooks_not_verified'
                  : 'host_grant_unverified';
              if (inspection.trustPending)
                journal.data.reports.push(
                  `codex: ${codexTrustAction(inspection.resolvedPath ?? resolvedPath)}`
                );
            } catch (error) {
              if (target.component !== 'mcp') throw error;
              // Retain the URL-only declaration for `connect` to resume without planning again.
              run.reason = error instanceof Error ? error.message : 'host_verification_timeout';
              if (deps.afterHosts && run.reason === 'host_verification_timeout')
                run.reason = 'login_pending';
              journal.data.reports.push(
                `${run.id}: URL-only entry retained, not connected. Run mnemonik connect ${selection.host}.`
              );
            }
          }
          await journal.event('host_observed', run.id);
          // Keep the old scope until the requested scope has passed its native probe.
          const migrated = inspection?.grant || target.component === 'hooks' ? otherScopes : [];
          for (const other of migrated) {
            const removals: FileChange[] = [];
            const otherOwned = record.targets.find(
              (candidate) =>
                candidate.host === selection.host &&
                candidate.component === target.component &&
                candidate.scope === other.scope &&
                candidate.profilePath === other.path
            );
            await adapter.uninstall(
              {
                stage: async (c) => {
                  removals.push(c);
                },
              },
              {
                ...target,
                scope: other.scope,
                createdFiles: otherOwned?.files
                  .filter((file) => file.created)
                  .map((file) => file.path),
              }
            );
            await stage(journal, run, removals, runtime);
            await apply(journal, run);
            if ((await adapter.verify({ ...target, scope: other.scope })).declarationPresent)
              throw new Error('scope_removal_failed');
          }
          run.remove = record.targets
            .filter(
              (t) =>
                t.host === selection.host &&
                t.component === (selection.component ?? 'hooks') &&
                migrated.some((s) => s.path === t.profilePath)
            )
            .map((t) => t.id);
          if (command !== 'uninstall') {
            const profilePath = old?.profilePath ?? ownedChanges.at(-1)?.path;
            if (!profilePath) throw new Error('adapter_empty_plan');
            // An attempt that binds nothing keeps the grant already on record: status reads a
            // missing grant as a sign-in that never happened, so dropping it here would turn a
            // revoked binding into a host that looks like it is still connecting. Only a new
            // binding replaces it; uninstall and auth logout are what remove it.
            const grant = inspection?.grant ?? old?.grant;
            const candidate: OwnedTarget = {
              ...selection,
              id: run.id,
              component: target.component,
              credentialFamily: target.credentialFamily,
              ...(grant ? { grant } : {}),
              profilePath,
              version: runtime.manifest.version,
              ...(detected.version ? { editorVersion: detected.version } : {}),
              artifactDigest: runtime.reference.manifestSha256,
              runtimePointer: pointer,
              files: ownedChanges.map((c) => {
                const prior = old?.files.find((file) => file.path === c.path);
                const planned = journal.data.targets.find(
                  (entry) => entry.group === run.id && entry.path === c.path
                );
                return {
                  path: c.path,
                  hash: hash(c.content),
                  original:
                    prior?.original ??
                    record.targets
                      .flatMap((entry) => entry.files)
                      .find((file) => file.path === c.path && file.original)?.original ??
                    (planned ? { backup: planned.backup, hash: planned.beforeHash } : undefined),
                  ...(prior?.created || planned?.beforeHash === null ? { created: true } : {}),
                };
              }),
              ...(old
                ? {
                    previous: {
                      version: old.version,
                      artifactDigest: old.artifactDigest,
                      files: old.files,
                      runtimePointer: old.runtimePointer,
                    },
                  }
                : {}),
            };
            if (!grant) delete candidate.grant;
            run.candidate = candidate;
          }
          run.reason ??= 'uninstalled';
          run.elapsedMs = Math.max(0, now() - startedAt);
          run.status = 'verified';
          await journal.save();
          await saveOwnership(deps.stateDir, journal, run);
          run.status = 'complete';
          await journal.event('local_commit', run.id);
          if (command === 'update')
            journal.data.reports.push(
              `${selection.host}: shared runtime updated for all scopes to ${runtime.manifest.version}.`
            );
          const result: HostResult = {
            target: run.id,
            elapsedMs: run.elapsedMs ?? 0,
            status:
              inspection?.trustPending ||
              (target.component === 'mcp' && command !== 'uninstall' && !inspection?.grant)
                ? 'ACTION_REQUIRED'
                : deps.grants
                  ? 'READY'
                  : 'LIMITED',
            reason: run.reason,
            ...(actionFor(run.reason, selection, [], inspection?.resolvedPath ?? resolvedPath)
              ? {
                  action: actionFor(
                    run.reason,
                    selection,
                    [],
                    inspection?.resolvedPath ?? resolvedPath
                  ),
                }
              : {}),
          };
          results.push(result);
          if (
            command === 'install' &&
            deps.afterHosts &&
            (inspection?.trustPending || run.reason === 'login_pending')
          )
            completionChecks.push(async () => {
              const reread = await adapter.verify(target);
              if (reread.trustDeclined) {
                result.status = 'ACTION_REQUIRED';
                result.reason = 'codex_trust_declined';
                result.action = actionFor(
                  result.reason,
                  selection,
                  [],
                  reread.resolvedPath ?? resolvedPath
                );
                return;
              }
              if (reread.trustPending) return;
              if (target.component === 'hooks') {
                result.status = reread.declarationPresent
                  ? deps.grants
                    ? 'READY'
                    : 'LIMITED'
                  : 'ACTION_REQUIRED';
                result.reason = reread.declarationPresent ? 'hooks_not_verified' : 'hooks_missing';
                if (reread.declarationPresent) delete result.action;
                else result.action = `mnemonik repair --host ${selection.host} --component hooks`;
                const report = `codex: ${codexTrustAction(reread.resolvedPath ?? resolvedPath)}`;
                const index = journal.data.reports.indexOf(report);
                if (index >= 0) journal.data.reports.splice(index, 1);
                return;
              }
              if (!deps.grants) return;
              const listing = await deps.grants.list();
              if (!deps.account || listing.account !== deps.account) return;
              const grants = listing.grants.filter(
                (grant) =>
                  grantHost(grant) === selection.host &&
                  grant.resource === `${apiOrigin()}/mcp` &&
                  grant.scopes.includes('mcp:use')
              );
              const bound =
                grants.find(
                  (grant) =>
                    listing.deviceInstallationId &&
                    grant.deviceInstallationId === listing.deviceInstallationId &&
                    grant.activatedAt
                ) ??
                grants.find(
                  (grant) =>
                    listing.deviceInstallationId &&
                    grant.deviceInstallationId === listing.deviceInstallationId
                );
              if (bound && !bound.activatedAt) {
                const condition = hostNotConnectedCondition(selection.host);
                result.status = 'LIMITED';
                result.reason = condition.reason;
                result.action = condition.action;
              } else if (
                bound?.activatedAt &&
                reread.declarationPresent &&
                reread.authenticatedTools
              ) {
                result.status = 'READY';
                result.reason = 'connected to this machine';
                delete result.action;
              }
            });
        } catch (error) {
          if (deps.fault || (deps.afterHosts && (error as NodeJS.ErrnoException).code)) throw error;
          // A verified target's ownership publication is recoverable; never undo it after publication.
          if (run.status === 'verified' || run.status === 'complete') throw error;
          await rollbackHost(deps.stateDir, journal, run.id);
          if (freshRuntimeVersion)
            await rm(join(dirname(store.pointerPath(selection.host)), freshRuntimeVersion), {
              recursive: true,
              force: true,
            });
          run.status = 'rolled_back';
          run.reason = error instanceof Error ? error.message : 'host_failed';
          const detail =
            error instanceof Error && error.cause instanceof Error
              ? error.cause.message
              : undefined;
          results.push({
            target: run.id,
            elapsedMs: run.elapsedMs ?? 0,
            status: 'ACTION_REQUIRED',
            reason: run.reason,
            ...(detail ? { detail } : {}),
            ...(actionFor(run.reason, selection, searchedLocations, resolvedPath)
              ? { action: actionFor(run.reason, selection, searchedLocations, resolvedPath) }
              : {}),
          });
          await journal.save();
        } finally {
          const result = results.at(-1);
          if (result?.target === run.id) {
            run.elapsedMs = result.elapsedMs = Math.max(0, now() - startedAt);
            await journal.save();
          }
        }
      }
      if (command === 'uninstall')
        await removeUnusedRuntimePointers(
          journal,
          store,
          deps.stateDir,
          selections.map((selection) => selection.host)
        );
      journal.data.phase = 'complete';
      journal.data.state = results.some((r) => r.status === 'ACTION_REQUIRED')
        ? 'ACTION_REQUIRED'
        : results.every((r) => r.status === 'READY')
          ? 'READY'
          : 'LIMITED';
      if (deps.afterHosts) {
        journal.data.phase = 'review';
        await deps.afterHosts(journal, results, async () => {
          for (const check of completionChecks.splice(0)) await check();
          journal.data.state = results.some((r) => r.status === 'ACTION_REQUIRED')
            ? 'ACTION_REQUIRED'
            : results.every((r) => r.status === 'READY')
              ? 'READY'
              : 'LIMITED';
        });
        journal.data.phase = 'complete';
      }
      await journal.event('complete');
      return { results, reports: journal.data.reports, journal: journal.data };
    }),
    deps.fault
  );
  if (outcome.recovery?.selections.length) {
    const recovered = await runHosts(
      outcome.recovery.command,
      outcome.recovery.selections,
      deps,
      outcome.recovery.allowMigration
    );
    return {
      ...recovered,
      results: [...outcome.results, ...recovered.results],
      reports: [...outcome.reports, ...recovered.reports],
    };
  }
  return { results: outcome.results, reports: outcome.reports, journal: outcome.journal };
}

export async function selectOwned(
  state: string,
  host?: string,
  scope?: string,
  component?: string
) {
  const selected = (await readOwnership(state)).targets.filter(
    (t) =>
      (!host || t.host === host) &&
      (!scope || t.scope === scope) &&
      (!component || t.component === component)
  );
  const ambiguous = selected.filter((t) =>
    selected.some(
      (other) =>
        other.id !== t.id &&
        other.host === t.host &&
        other.scope === t.scope &&
        other.component === t.component
    )
  );
  return { selected, ambiguous: ambiguous.map((t) => t.profilePath) };
}

export async function codexTrustConditions(
  deps: Pick<HostDependencies, 'stateDir' | 'env' | 'imports'>
): Promise<ReadinessCondition[]> {
  const store = new RuntimeStore(deps.stateDir);
  for (const owned of (await readOwnership(deps.stateDir)).targets) {
    if (owned.host !== 'codex' || owned.component !== 'hooks') continue;
    try {
      const runtime = await store.verifyRuntime('codex');
      const target = targetFor(owned, runtime, store);
      const adapter = (await (deps.imports ?? hostPackageImports).codex(runtime)).createHostAdapter(
        {
          target,
          env: environment(owned, deps.env),
        }
      );
      const inspection = await adapter.inspect(target);
      if (inspection.trustPending)
        return [
          {
            kind: 'host_trust_pending',
            component: 'codex',
            reason: 'codex_trust_pending',
            action: codexTrustAction(inspection.resolvedPath),
          },
        ];
    } catch {
      /* Existing hook_not_verified status covers an unavailable runtime or adapter. */
    }
  }
  return [];
}

export async function hookStatusConditions(
  deps: Pick<HostDependencies, 'stateDir' | 'env' | 'imports'>,
  hosts: readonly HostArtifact[]
): Promise<ReadinessCondition[]> {
  const owned = (await readOwnership(deps.stateDir)).targets;
  const store = new RuntimeStore(deps.stateDir);
  const credentials = createCliCredentials({ stateDir: deps.stateDir });
  const conditions: ReadinessCondition[] = [];
  for (const host of hosts) {
    const record = owned.find((target) => target.host === host && target.component === 'hooks');
    if (!record) {
      conditions.push({
        kind: 'hook_not_verified',
        component: host,
        reason: `${host} hooks are not installed.`,
        action: `run mnemonik status after the ${host} hook starts`,
      });
      continue;
    }
    let inspection: Inspection;
    try {
      const runtime = await store.verifyRuntime(host);
      const target = targetFor(record, runtime, store);
      target.credentialFamily = record.credentialFamily ?? '';
      const adapter = (await (deps.imports ?? hostPackageImports)[host](runtime)).createHostAdapter(
        {
          target,
          env: environment(record, deps.env),
        }
      );
      inspection = await adapter.verify(target);
    } catch {
      conditions.push({
        kind: 'hook_not_verified',
        component: host,
        reason: `${host} hook configuration could not be inspected.`,
        action: `run mnemonik status after the ${host} hook starts`,
      });
      continue;
    }
    if (inspection.trustPending) {
      conditions.push({
        kind: 'host_trust_pending',
        component: 'codex',
        reason: 'codex_trust_pending',
        action: codexTrustAction(inspection.resolvedPath),
      });
      continue;
    }
    const missing = !inspection.declarationPresent
      ? `${host} hook declaration is missing.`
      : !record.credentialFamily ||
          !(await credentials.readFamily(record.credentialFamily).catch(() => null))
        ? `${host} hook credential family is missing or revoked.`
        : undefined;
    if (missing)
      conditions.push({
        kind: 'hooks_missing',
        component: host,
        reason: missing,
        action: `mnemonik repair --host ${host} --component hooks`,
      });
  }
  return conditions;
}

async function finishMcpTarget(
  adapter: HostAdapter,
  target: Target,
  deps: HostDependencies,
  status: Inspection
): Promise<Inspection> {
  if (adapter.capabilities().nativeListing === false) {
    if (!status.declarationPresent || !deps.grants) return status;
    const hookPath = (await adapter.verify({ ...target, component: 'hooks' })).declarationPath;
    const hooks = (await readOwnership(deps.stateDir)).targets.find(
      (t) => t.host === adapter.name && t.component === 'hooks' && t.profilePath === hookPath
    );
    if (
      !hooks?.credentialFamily ||
      !(
        await adapter.verify({
          ...target,
          component: 'hooks',
          credentialFamily: hooks.credentialFamily,
        })
      ).declarationPresent
    )
      return status;
    const listing = await deps.grants.list();
    if (!deps.account || listing.account !== deps.account) throw new Error('host_account_mismatch');
    return {
      ...status,
      authenticatedTools: listing.grants.some(
        (g) =>
          grantHost(g) === adapter.name &&
          g.resource === `${apiOrigin()}/mcp` &&
          !!g.activatedAt &&
          g.scopes.includes('mcp:use')
      ),
    };
  }
  if (!status.enableRequired) return status;
  const instruction = await adapter.enable?.();
  if (instruction) deps.instruction?.(instruction);
  const verified = await adapter.verify(target);
  if (!verified.authenticatedTools) throw new Error('host_enable_required');
  return verified;
}

/** Shared native approval wait; a configured/connected listing never invents server account evidence. */
export async function waitForHost(
  adapter: HostAdapter,
  target: Target,
  host: HostArtifact,
  deps: HostDependencies,
  recorded?: Grant,
  command?: HostCommand
): Promise<Inspection> {
  if (command === 'update' || command === 'repair') {
    let status = await adapter.verify(target);
    if (!status.trustPending && !status.trustDeclined && status.enableRequired) {
      const instruction = await adapter.enable?.();
      if (instruction) deps.instruction?.(instruction);
      status = await adapter.verify(target);
    }
    if (status.trustDeclined) throw new Error('codex_trust_declined');
    if (status.trustPending) return status;
    if (status.enableRequired) throw new Error('host_enable_required');
    if (!status.declarationPresent)
      throw new Error(target.component === 'hooks' ? 'hooks_missing' : 'mcp_declaration_missing');
    // runHosts has already checked the hook component credential before applying files.
    if (target.component === 'hooks') return status;
    if (!deps.grants) throw new Error('host_grant_unverified');
    if (!recorded) {
      // Nothing recorded for this target: hosts that sign in on their own (Cursor Desktop) leave
      // the grant to adopt from the account listing. One listing, one match, no launch, no wait.
      if (!deps.account) throw new Error('host_account_mismatch');
      status = await finishMcpTarget(adapter, target, deps, status);
      if (!status.authenticatedTools) throw new Error('host_grant_unverified');
      try {
        const matched = await matchHostGrant(
          status,
          host,
          deps.account,
          deps.grants,
          (deps.now ?? Date.now)(),
          undefined,
          deps.approveHost,
          'recovered'
        );
        if (matched.grant?.installationId) return matched;
      } catch (error) {
        if (error instanceof Error && error.message === 'host_connection_pending')
          throw new Error('host_grant_unverified');
        throw error;
      }
      throw new Error('host_grant_unverified');
    }
    const listing = await deps.grants.list();
    if (!deps.account || listing.account !== deps.account || recorded.account !== deps.account)
      throw new Error('host_account_mismatch');
    const live = listing.grants.find(
      (grant) =>
        grant.id === recorded.id &&
        grantHost(grant) === host &&
        grant.resource === `${apiOrigin()}/mcp` &&
        !!grant.activatedAt &&
        grant.scopes.includes('mcp:use') &&
        (!grant.deviceInstallationId ||
          grant.deviceInstallationId === listing.deviceInstallationId) &&
        (!recorded.installationId || recorded.installationId === listing.deviceInstallationId)
    );
    if (!live) throw new Error('host_grant_unverified');
    return { ...status, grant: { ...recorded, scopes: live.scopes } };
  }
  for (;;) {
    const now = deps.now ?? Date.now;
    const attemptStartedAt = now();
    let signedIn = false;
    let waitingForActivation = false;
    // A recorded grant the server no longer lists is dead (revoked, expired, or refused with
    // invalid_grant). Waiting for it to reappear can only time out; the host must sign in again.
    let staleRecord = false;
    const match = async (status: Inspection, approvalMode: 'all' | 'recovered' = 'all') => {
      const grants = deps.grants;
      if (!grants) return status;
      try {
        return await matchHostGrant(
          status,
          host,
          deps.account,
          grants,
          attemptStartedAt,
          recorded,
          deps.approveHost,
          approvalMode
        );
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'host_connection_pending') throw error;
        if (approvalMode === 'recovered' && recorded) {
          staleRecord = true;
          deps.instruction?.(
            `${hostLabels[host]} is no longer signed in to Mnemonik; starting a new sign-in.`
          );
          return undefined;
        }
        if (!waitingForActivation && !staleRecord)
          deps.instruction?.(
            `${host === 'codex' ? 'Codex' : host} is still finishing its connection.`
          );
        waitingForActivation = true;
        return undefined;
      }
    };
    if (target.component === 'mcp' && deps.grants) {
      const status = await finishMcpTarget(adapter, target, deps, await adapter.verify(target));
      if (status.declarationPresent && status.authenticatedTools) {
        const matched = await match(status, 'recovered');
        if (matched?.grant?.installationId) return matched;
        signedIn = !staleRecord && (waitingForActivation || !!matched?.grant);
      }
    }
    if (
      target.component === 'mcp' &&
      adapter.capabilities().nativeConnect &&
      deps.grants &&
      !signedIn &&
      !staleRecord
    ) {
      const status = await deps.grants.list();
      if (!deps.account || status.account !== deps.account)
        throw new Error('host_account_mismatch');
      signedIn = status.grants.some(
        (grant) =>
          grantHost(grant) === host &&
          grant.resource === `${apiOrigin()}/mcp` &&
          !!grant.activatedAt &&
          grant.scopes.includes('mcp:use')
      );
    }
    const instruction =
      target.component === 'mcp' && !waitingForActivation
        ? await adapter.launch({ signedIn: signedIn && !staleRecord })
        : '';
    if (instruction) deps.instruction?.(instruction);
    const deadline = now() + 120_000;
    while (now() < deadline) {
      const status =
        target.component === 'mcp'
          ? await finishMcpTarget(adapter, target, deps, await adapter.verify(target))
          : await adapter.verify(target);
      if (status.trustDeclined) throw new Error('codex_trust_declined');
      if (status.trustPending) return status;
      if (
        status.declarationPresent &&
        (target.component === 'hooks' || status.authenticatedTools)
      ) {
        if (target.component === 'hooks') return status;
        if (!deps.grants) throw new Error('host_grant_unverified');
        try {
          const matched = await match(status);
          if (matched) return matched;
        } catch (error) {
          deps.instruction?.(`Sign out of Mnemonik in ${host}, then run mnemonik connect ${host}.`);
          throw error;
        }
      }
      await (deps.sleep ?? delay)(Math.max(0, Math.min(2000, deadline - now())));
    }
    if (host === 'cursor' && instruction) deps.instruction?.(instruction);
    deps.instruction?.(`mnemonik connect ${host}: retry or skip this host for now.`);
    if ((await deps.timeout?.(host)) !== 'retry') throw new Error('host_verification_timeout');
  }
}
export async function revokeHostGrants(
  host: HostArtifact,
  deps: HostDependencies,
  grantId?: string
) {
  if (!deps.grants) throw new Error('host_grant_unverified');
  const status = await deps.grants.list();
  if (status.account !== deps.account) throw new Error('host_account_mismatch');
  const { grantHost } = await import('../auth/status.js');
  const grants = status.grants.filter(
    (g) =>
      (!grantId || g.id === grantId) && grantHost(g) === host && g.resource === `${apiOrigin()}/mcp`
  );
  for (const grant of grants) await deps.grants.revoke(grant.id);
  return grants.map((g) => g.id);
}

/** Local logout is secondary to server revocation and never reads host token storage. */
export async function logoutHost(host: HostArtifact, deps: HostDependencies) {
  const ids = await revokeHostGrants(host, deps);
  const store = new RuntimeStore(deps.stateDir);
  for (const owned of (await readOwnership(deps.stateDir)).targets.filter(
    (t) => t.host === host && t.component === 'mcp'
  )) {
    try {
      const runtime = await store.verifyRuntime(host);
      const adapter = (await (deps.imports ?? hostPackageImports)[host](runtime)).createHostAdapter(
        { target: targetFor(owned, runtime, store), env: environment(owned, deps.env) }
      );
      if (!owned.grant || !adapter.revoke || !(await adapter.revoke(owned.grant)))
        deps.instruction?.(adapter.revokeAction);
    } catch {
      deps.instruction?.(`${host}: grant revoked; local OAuth credentials could not be cleared.`);
    }
  }
  return ids;
}

/** Resume one concrete profile under the ownership lease, with no config/runtime plan or stage. */
export async function connectHost(
  selection: OwnedTarget,
  deps: HostDependencies
): Promise<HostResult> {
  return withInstall(
    deps.stateDir,
    {
      account: deps.account,
      hosts: [selection.host],
      components: ['mcp'],
      scopes: {},
      roots: [],
      credentials: [],
    },
    undefined,
    async (journal) => {
      const now = deps.now ?? Date.now;
      const startedAt = now();
      const current = (await readOwnership(deps.stateDir)).targets.find(
        (t) => t.id === selection.id
      );
      if (!current || current.component !== 'mcp') throw new Error('no_recorded_targets');
      const store = new RuntimeStore(deps.stateDir);
      const runtime = await store.verifyRuntime(current.host);
      const target = targetFor(current, runtime, store);
      const adapter = (
        await (deps.imports ?? hostPackageImports)[current.host](runtime)
      ).createHostAdapter({ target, env: environment(current, deps.env) });
      let reason = 'hooks_not_verified';
      let status: HostResult['status'] = 'LIMITED';
      // The recorded grant survives an attempt that binds nothing: status reads a missing grant as
      // a sign-in that never happened, not as a binding to reconnect.
      const candidate: OwnedTarget = { ...current };
      const run: HostRun = { id: current.id, host: current.host, status: 'verified', candidate };
      try {
        const inspection = await waitForHost(adapter, target, current.host, deps, current.grant);
        if (deps.grants) {
          const listing = await deps.grants.list();
          if (listing.account !== deps.account) throw new Error('host_account_mismatch');
          await bindInstalledHostGrants(listing, [current.host], deps.grants);
        }
        if (inspection.grant) run.candidate = { ...candidate, grant: inspection.grant };
        if (inspection.grant?.installationId) {
          status = 'READY';
          reason = 'connected to this machine';
        } else reason = 'host_grant_unbound';
      } catch (error) {
        reason = error instanceof Error ? error.message : 'host_verification_timeout';
        status = 'ACTION_REQUIRED';
      }
      await saveOwnership(deps.stateDir, journal, run);
      journal.data.phase = 'complete';
      journal.data.state = status;
      run.elapsedMs = Math.max(0, now() - startedAt);
      journal.data.hostRuns = [run];
      await journal.event('complete');
      return {
        target: current.id,
        elapsedMs: run.elapsedMs,
        status,
        reason,
        ...(status === 'ACTION_REQUIRED'
          ? {
              action:
                reason === 'installation_required'
                  ? 'Run mnemonik install first.'
                  : reason === 'host_account_mismatch'
                    ? `Sign out of Mnemonik in ${current.host} profile ${current.profilePath}, then run mnemonik connect ${current.host}.`
                    : `Run mnemonik connect ${current.host}.`,
            }
          : {}),
      };
    },
    deps.fault
  );
}
