import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { atomicWrite, stateDirectory, withLock } from '@mnemonik/local-setup';
import type { HostCommand, HostSelection } from './hosts.js';
import type { HostRun } from './ownership.js';
import type { AdapterWriter, FileChange } from '@mnemonik/shared';
import type { HostName } from './adapters.js';

export const MUTATION_KINDS = [
  'journal_created',
  'planned',
  'stage_intent',
  'stage_written',
  'staged',
  'host_intent',
  'host_observed',
  'roots_confirmed',
  'consent_recorded',
  'project_stage_intent',
  'project_staged',
  'projects_staged',
  'final_review',
  'apply',
  'commit_intent',
  'commit_written',
  'committed',
  'local_commit',
  'service_start_intent',
  'service_started',
  'upload_intent',
  'upload_finished',
  'complete',
  'service_restored',
  'project_restored',
  'restored',
  'credential_revoked',
  'compensation_finished',
  'reconciled',
] as const;
export type MutationKind = (typeof MUTATION_KINDS)[number];

export const digest = (bytes: Buffer | null): string | null =>
  bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
export async function bytesAt(path: string): Promise<Buffer | null> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`target_symlink: ${path}`);
    if (!stat.isFile()) throw new Error(`target_not_regular: ${path}`);
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
async function syncDirectory(path: string) {
  if (process.platform === 'win32') return;
  const file = await open(path, 'r');
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
// The shared writer fsyncs private bytes before rename. Preserve target mode on
// another temporary sibling, fsync metadata, then publish and fsync the parent.
async function write(
  path: string,
  bytes: Buffer | null,
  mode: number,
  assertOwned?: () => Promise<void>
) {
  await assertOwned?.();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (bytes === null) await rm(path, { force: true });
  else {
    const temp = `${path}.${randomUUID()}.install`;
    await atomicWrite(temp, bytes, undefined, assertOwned);
    const file = await open(temp, 'r+');
    try {
      await file.chmod(mode);
      await file.sync();
    } finally {
      await file.close();
    }
    await assertOwned?.();
    await rename(temp, path);
  }
  await syncDirectory(dirname(path));
}
export interface Target {
  id: string;
  kind: 'host' | 'runtime' | 'service' | 'project' | 'credential-reference';
  path: string;
  host?: HostName;
  group?: string;
  beforeHash: string | null;
  proposedHash: string | null;
  backup: string;
  proposed: string;
  mode: number;
  status: 'planned' | 'staged' | 'committed' | 'restored';
  staging: 'inactive' | 'additive';
  version?: string;
  artifactDigest?: string;
}
export interface Consent {
  account: string;
  roots: string[];
  exclusions: string[];
  disclosureVersion: string;
}
export interface JournalData {
  schemaVersion: 1;
  joined?: boolean;
  hostRuns?: HostRun[];
  hostRequest?: { command: HostCommand; selections: HostSelection[]; allowMigration: boolean };
  runId: string;
  generation: number;
  account: string;
  components: string[];
  hosts: HostName[];
  scopes: Partial<Record<HostName, { requested: string; effective: string }>>;
  roots: string[];
  declaredTargets: string[];
  targets: Target[];
  consent?: Consent;
  credentials: Array<{
    reference: string;
    kind: 'cli' | 'component';
    component?: 'scanner';
    revoked?: boolean;
  }>;
  projects: Array<{
    selected?: boolean;
    root: string;
    uuid?: string;
    effect?: 'created' | 'restored';
    empty?: boolean;
    nonGitSelected?: true;
  }>;
  services: Array<{ id: string; before: string; started?: boolean }>;
  mutations: Array<{ sequence: number; event: string; target?: string }>;
  reports: string[];
  phase:
    | 'preparing'
    | 'review'
    | 'applying'
    | 'committed'
    | 'uploading'
    | 'complete'
    | 'rolling_back'
    | 'rolled_back';
  state: 'READY' | 'LIMITED' | 'ACTION_REQUIRED' | 'FAILED';
}
export type NewInstall = Pick<
  JournalData,
  | 'account'
  | 'components'
  | 'hosts'
  | 'scopes'
  | 'roots'
  | 'credentials'
  | 'hostRuns'
  | 'hostRequest'
  | 'joined'
>;
export class Journal implements AdapterWriter {
  assertOwned?: () => Promise<void>;
  afterMutation?: (event: MutationKind, journal: Journal) => void | Promise<void>;
  constructor(
    readonly dir: string,
    readonly data: JournalData
  ) {}
  async save() {
    await atomicWrite(
      join(this.dir, 'journal.json'),
      Buffer.from(JSON.stringify(this.data, null, 2) + '\n')
    );
  }
  async event(event: MutationKind, target?: string) {
    this.data.mutations.push({
      sequence: this.data.mutations.length + 1,
      event,
      ...(target ? { target } : {}),
    });
    await this.save();
    await this.afterMutation?.(event, this);
  }
  async plan(
    path: string,
    proposed: Buffer | null,
    fields: Pick<Target, 'kind'> &
      Partial<Pick<Target, 'host' | 'group' | 'staging' | 'version' | 'artifactDigest'>>
  ): Promise<Target> {
    const existing = this.data.targets.find((t) => t.path === path && t.group === fields.group);
    if (existing) return existing;
    const before = await bytesAt(path);
    if (fields.kind === 'project') await access(dirname(path), constants.W_OK);
    const mode = before ? (await lstat(path)).mode & 0o777 : 0o600;
    if (process.platform !== 'win32' && before && (mode & 0o200) === 0)
      throw new Error(`target_read_only: ${path}`);
    const id = String(this.data.targets.length);
    const target: Target = {
      id,
      path,
      beforeHash: digest(before),
      proposedHash: digest(proposed),
      backup: join(this.dir, `${id}.before`),
      proposed: join(this.dir, `${id}.proposed`),
      mode,
      status: 'planned',
      staging: 'inactive',
      ...fields,
    };
    if (before) await write(target.backup, before, target.mode);
    if (proposed) await atomicWrite(target.proposed, proposed);
    this.data.targets.push(target);
    this.data.declaredTargets.push(path);
    await this.event('planned', id);
    return target;
  }
  async propose(target: Target, bytes: Buffer) {
    await atomicWrite(target.proposed, bytes);
    target.proposedHash = digest(bytes);
    if (target.status === 'restored') target.status = 'planned';
    await this.save();
  }
  async stage(change: Target | FileChange) {
    // Adapters may stage only a proposal already captured by the CLI's plan.
    const target =
      'id' in change
        ? change
        : [...this.data.targets].reverse().find((t) => t.path === change.path);
    if (
      !target ||
      (!('id' in change) && digest(change.remove ? null : change.content) !== target.proposedHash)
    )
      throw new Error('adapter_proposal_mismatch');
    if (target.status !== 'planned') return;
    // Durable intent covers a crash after an additive write but before staged.
    await this.event('stage_intent', target.id);
    if (target.staging === 'additive') {
      await this.change(target, false);
      await this.event('stage_written', target.id);
    }
    target.status = 'staged';
    await this.event('staged', target.id);
  }
  async change(target: Target, restore: boolean) {
    const disk = digest(await bytesAt(target.path));
    if (disk !== target.beforeHash && disk !== target.proposedHash)
      throw new Error(`File changed outside install: ${target.path}`);
    const expected = restore ? target.beforeHash : target.proposedHash;
    const bytes =
      expected === null ? null : await bytesAt(restore ? target.backup : target.proposed);
    if (digest(bytes) !== expected)
      throw new Error(`Invalid install backup/proposal: ${target.path}`);
    if (disk === expected) return;
    await write(target.path, bytes, target.mode, this.assertOwned);
  }
  async commit(target: Target) {
    if (target.status === 'restored' || target.status === 'committed') return;
    await this.event('commit_intent', target.id);
    await this.change(target, false);
    await this.event('commit_written', target.id);
    target.status = 'committed';
    await this.event('committed', target.id);
  }
  async restore(target: Target) {
    if (target.status === 'restored') return;
    if (digest(await bytesAt(target.backup)) !== target.beforeHash)
      throw new Error(`Invalid install backup/proposal: ${target.path}`);
    const disk = digest(await bytesAt(target.path));
    if (disk !== target.beforeHash && disk !== target.proposedHash)
      this.data.reports.push(`rollback_kept_file: ${target.path}`);
    else await this.change(target, true);
    await rm(target.proposed, { force: true });
    await syncDirectory(this.dir);
    target.status = 'restored';
    await this.event('restored', target.id);
  }
  async restoreFiles() {
    const failures: string[] = [];
    for (const target of [...this.data.targets].reverse()) {
      try {
        await this.restore(target);
      } catch {
        failures.push(`Could not restore ${target.path}; backup: ${target.backup}.`);
      }
    }
    this.data.reports.push(...failures);
    return failures.length === 0;
  }
  async reconcile() {
    const states = [];
    for (const target of this.data.targets) {
      const disk = digest(await bytesAt(target.path));
      // Compare BEFORE first: unchanged/pre-existing declarations are not ours.
      states.push({
        target,
        state:
          disk === target.beforeHash
            ? 'before'
            : disk === target.proposedHash
              ? 'proposed'
              : 'conflict',
      });
    }
    return states;
  }
}
export async function interrupted(state = stateDirectory()): Promise<Journal[]> {
  const root = join(state, 'install');
  const entries = await readdir(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const result: Journal[] = [];
  for (const entry of entries) {
    if (!/^[0-9a-f-]{36}$/.test(entry)) continue;
    const saved = await bytesAt(join(root, entry, 'journal.json'));
    if (!saved) continue; // A crash before journal creation cannot have staged targets.
    const data = JSON.parse(saved.toString()) as JournalData;
    if (data.schemaVersion !== 1 || data.runId !== entry || !Array.isArray(data.targets))
      throw new Error('Invalid install journal');
    const dir = join(root, entry);
    if (
      !Array.isArray(data.declaredTargets) ||
      data.targets.some((target) => !data.declaredTargets.includes(target.path))
    )
      throw new Error('journal_invalid');
    for (const target of data.targets) {
      const backup = resolve(dir, target.backup);
      const withinRun = relative(dir, backup);
      if (
        withinRun === '..' ||
        withinRun.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
        isAbsolute(withinRun)
      )
        throw new Error('journal_invalid');
      const stat = await lstat(backup).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (stat?.isSymbolicLink()) throw new Error('journal_invalid');
    }
    if (!['complete', 'rolled_back'].includes(data.phase)) result.push(new Journal(dir, data));
  }
  return result;
}

export async function abandonInterrupted(state = stateDirectory()): Promise<void> {
  const pending = (await interrupted(state))[0];
  // Only an interrupted install is abandoned. An interrupted uninstall is
  // resumed and finished by running uninstall again.
  if (!pending || pending.data.hostRequest?.command === 'uninstall') return;
  await withInstall(state, pending.data, pending, async (journal) => {
    const latest = (await interrupted(state)).find(
      (candidate) => candidate.data.runId === journal.data.runId
    );
    if (!latest) return;
    Object.assign(journal.data, latest.data);
    if (!journal.data.reports.includes('installation_abandoned'))
      journal.data.reports.push('installation_abandoned');
    journal.data.phase = 'complete';
    journal.data.state = 'FAILED';
    await journal.event('complete');
  });
}
/** A user-wide lease plus durable generation refuses rollback from an older run. */
export async function withInstall<T>(
  state: string,
  input: NewInstall,
  resume: Journal | undefined,
  work: (journal: Journal) => Promise<T>,
  afterMutation?: Journal['afterMutation']
): Promise<T> {
  const stateStat = await lstat(state).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (stateStat?.isSymbolicLink()) throw new Error('state_directory_symlink');
  if (stateStat && !stateStat.isDirectory()) throw new Error('state_directory_not_directory');
  const ownerPath = join(state, 'install-owner.json');
  return withLock(ownerPath, 1000, async (assertOwned) => {
    const saved = await bytesAt(ownerPath);
    const owner = saved
      ? (JSON.parse(saved.toString()) as { generation: number; runId: string })
      : { generation: 0, runId: '' };
    if (
      resume &&
      (owner.generation !== resume.data.generation || owner.runId !== resume.data.runId)
    )
      throw new Error('Stale install generation');
    if (!resume && (await interrupted(state)).length)
      throw new Error('Resolve interrupted install first');
    const runId = resume?.data.runId ?? randomUUID();
    const dir = join(state, 'install', runId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await syncDirectory(dirname(dir));
    const journal =
      resume ??
      new Journal(dir, {
        schemaVersion: 1,
        runId,
        generation: owner.generation + 1,
        ...input,
        declaredTargets: [],
        targets: [],
        projects: [],
        services: [],
        mutations: [],
        reports: [],
        phase: 'preparing',
        state: 'ACTION_REQUIRED',
      });
    journal.assertOwned = assertOwned;
    journal.afterMutation = afterMutation;
    // Every journal boundary also checks the live lease.
    journal.save = async () => {
      await assertOwned();
      await Journal.prototype.save.call(journal);
    };
    if (!resume) {
      await atomicWrite(
        ownerPath,
        Buffer.from(JSON.stringify({ generation: journal.data.generation, runId }))
      );
      await journal.event('journal_created');
    }
    return work(journal);
  });
}
