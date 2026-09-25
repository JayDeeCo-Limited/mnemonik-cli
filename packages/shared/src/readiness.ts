export const READINESS_SCHEMA_VERSION = 1 as const;

export type ReadinessState = 'READY' | 'LIMITED' | 'ACTION_REQUIRED' | 'FAILED';

export type ReadinessConditionKind =
  | 'selected_component_failed'
  | 'host_trust_pending'
  | 'vendor_policy_pending'
  | 'login_pending'
  | 'restart_pending'
  | 'project_identity_choice_pending'
  | 'scanner_not_verified'
  | 'hook_not_verified'
  | 'hooks_missing'
  | 'scanner_omitted'
  | 'project_uncovered'
  | 'host_skipped'
  | 'windows_task_creation_failed'
  | 'post_commit_upload_failed'
  | 'indexing_failed'
  | 'indexing_stalled';

export interface ReadinessCondition {
  kind: ReadinessConditionKind;
  component?: string;
  reason: string;
  action?: string;
}

export interface ReadinessSummary {
  state: ReadinessState;
  reasons: string[];
  actions: string[];
}

export interface ReadinessSubjectInput {
  conditions: readonly ReadinessCondition[];
}

export interface IndexingCounts {
  total: number | null;
  completed: number | null;
}

export interface ProjectReadinessInput {
  projectId?: string | null;
  displayName?: string | null;
  owner?: string | null;
  repositoryMatch?: string | null;
  identityFile?: string | null;
  summary: ReadinessSubjectInput | ReadinessSummary;
  indexing?: Partial<IndexingCounts> | null;
  action?: string | null;
}

export interface ProjectReadiness {
  projectId: string | null;
  displayName: string | null;
  owner: string | null;
  repositoryMatch: string | null;
  identityFile: string | null;
  summary: ReadinessSummary;
  indexing: IndexingCounts | null;
  action: string | null;
}

export interface InstallSessionStatus {
  id: string | null;
  status: string | null;
  kind: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface DeviceGrantStatus {
  id: string;
  client: string;
  device: string | null;
  platform: string | null;
  scopes: string[];
  resource: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  incompleteInstallation: boolean;
  revokeAction: string;
}

export interface ComponentCredentialStatus {
  id: string;
  kind: string;
  displayPrefix: string | null;
  device: string | null;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokeAction: string;
}

export interface ScannerStatus {
  roots: string[] | null;
  heartbeatAt: string | null;
  version: string | null;
  readiness: ReadinessSummary | null;
  acceptedDisclosureVersion: string | null;
  /** Approved folders that no longer exist on disk; absent when there are none. */
  missingApprovedRoots?: number;
}

export interface ProjectSetupResult {
  projectId: string | null;
  displayName: string | null;
  owner: string | null;
  repositoryMatch: string | null;
  identityFile: string | null;
  action: string | null;
}

export interface DefaultOwnerStatus {
  kind: 'personal' | 'team';
  id: string | null;
  name: string | null;
}

export interface LimitedModeStatus {
  acknowledgement: string | null;
  enableScannerAction: string;
}

/** The last `mnemonik update` on the machine, automatic or by hand. */
export interface ReadinessUpdateCheck {
  checkedAt: string;
  result: 'updated' | 'current' | 'failed';
}

/** Optional receipt metadata; older schema-1 installers omit these observations. */
export interface ReadinessVersions {
  cli?: string;
  scanner?: string;
  hosts?: Array<{ host: string; editor?: string; hooks?: string }>;
  update?: ReadinessUpdateCheck;
}

export interface ReadinessDocumentInput {
  versions?: ReadinessVersions;
  platform?: string;
  installation: ReadinessSubjectInput | ReadinessSummary;
  projects?: readonly ProjectReadinessInput[];
  indexing?: Partial<IndexingCounts> | null;
  installSession?: InstallSessionStatus | null;
  devicesAndGrants?: readonly DeviceGrantStatus[] | null;
  componentCredentials?: readonly ComponentCredentialStatus[] | null;
  scanner?: ScannerStatus | null;
  projectSetupResults?: readonly ProjectSetupResult[] | null;
  defaultOwner?: DefaultOwnerStatus | null;
  limitedMode?: LimitedModeStatus | null;
  generatedAt?: string;
}

export interface ReadinessDocument {
  versions?: ReadinessVersions;
  platform?: string;
  schemaVersion: typeof READINESS_SCHEMA_VERSION;
  installation: ReadinessSummary;
  projects?: ProjectReadiness[];
  indexing: IndexingCounts | null;
  installSession: InstallSessionStatus | null;
  devicesAndGrants: DeviceGrantStatus[] | null;
  componentCredentials: ComponentCredentialStatus[] | null;
  scanner: ScannerStatus | null;
  projectSetupResults: ProjectSetupResult[] | null;
  defaultOwner: DefaultOwnerStatus | null;
  limitedMode: LimitedModeStatus | null;
  generatedAt: string;
}

const stateFor: Record<ReadinessConditionKind, Exclude<ReadinessState, 'READY'>> = {
  selected_component_failed: 'FAILED',
  host_trust_pending: 'ACTION_REQUIRED',
  vendor_policy_pending: 'ACTION_REQUIRED',
  login_pending: 'ACTION_REQUIRED',
  restart_pending: 'ACTION_REQUIRED',
  project_identity_choice_pending: 'ACTION_REQUIRED',
  scanner_not_verified: 'LIMITED',
  hook_not_verified: 'LIMITED',
  hooks_missing: 'ACTION_REQUIRED',
  scanner_omitted: 'LIMITED',
  project_uncovered: 'LIMITED',
  host_skipped: 'LIMITED',
  windows_task_creation_failed: 'LIMITED',
  post_commit_upload_failed: 'FAILED',
  indexing_failed: 'FAILED',
  indexing_stalled: 'FAILED',
};
const rank: Record<ReadinessState, number> = {
  READY: 0,
  LIMITED: 1,
  ACTION_REQUIRED: 2,
  FAILED: 3,
};

function defaultAction(condition: ReadinessCondition): string | undefined {
  if (condition.kind === 'windows_task_creation_failed')
    return 'Run mnemonik scanner enable to try again.';
  return condition.action;
}

export function reduceReadiness(input: readonly ReadinessCondition[]): ReadinessSummary {
  let state: ReadinessState = 'READY';
  const reasons: string[] = [];
  const actions: string[] = [];
  for (const condition of input) {
    const candidate = stateFor[condition.kind];
    if (rank[candidate] > rank[state]) state = candidate;
    if (!reasons.includes(condition.reason)) reasons.push(condition.reason);
    const action = defaultAction(condition);
    if (action && !actions.includes(action)) actions.push(action);
  }
  return { state, reasons, actions };
}

function sentence(value: string): string {
  return /[.!?]$/u.test(value) ? value : `${value}.`;
}

export function remainingReadinessCount(summary: ReadinessSummary): number {
  return summary.reasons.filter((reason) => reason !== 'dev_release_source').length;
}

export function describeReadiness(summary: ReadinessSummary): string {
  if (summary.state === 'READY') return 'Done.';
  const count = remainingReadinessCount(summary);
  const opening =
    summary.state === 'FAILED'
      ? 'Setup failed.'
      : count === 0
        ? 'Done.'
        : summary.state === 'ACTION_REQUIRED'
          ? `Setup needs ${count === 1 ? 'one action' : `${count} actions`}.`
          : `Done, with ${count === 1 ? 'one thing' : `${count} things`} left.`;
  return [opening, ...summary.reasons.map(sentence), ...summary.actions].join(' ');
}

const counts = (value: Partial<IndexingCounts> | null | undefined): IndexingCounts | null =>
  value ? { total: value.total ?? null, completed: value.completed ?? null } : null;

const summary = (value: ReadinessSubjectInput | ReadinessSummary): ReadinessSummary =>
  'conditions' in value
    ? reduceReadiness(value.conditions)
    : { state: value.state, reasons: [...value.reasons], actions: [...value.actions] };

export function serializeReadiness(input: ReadinessDocumentInput): ReadinessDocument {
  const projects = input.projects?.map((project) => ({
    projectId: project.projectId ?? null,
    displayName: project.displayName ?? null,
    owner: project.owner ?? null,
    repositoryMatch: project.repositoryMatch ?? null,
    identityFile: project.identityFile ?? null,
    summary: summary(project.summary),
    indexing: counts(project.indexing),
    action: project.action ?? null,
  }));
  return {
    schemaVersion: READINESS_SCHEMA_VERSION,
    ...(input.platform !== undefined ? { platform: input.platform } : {}),
    ...(input.versions
      ? {
          versions: {
            ...input.versions,
            ...(input.versions.hosts
              ? { hosts: input.versions.hosts.map((host) => ({ ...host })) }
              : {}),
          },
        }
      : {}),
    installation: summary(input.installation),
    ...(projects ? { projects } : {}),
    indexing: counts(input.indexing),
    installSession: input.installSession ?? null,
    devicesAndGrants: input.devicesAndGrants ? [...input.devicesAndGrants] : null,
    componentCredentials: input.componentCredentials ? [...input.componentCredentials] : null,
    scanner: input.scanner ?? null,
    projectSetupResults: input.projectSetupResults ? [...input.projectSetupResults] : null,
    defaultOwner: input.defaultOwner ?? null,
    limitedMode: input.limitedMode ?? null,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  };
}

const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => key in value);
const nullableString = (value: unknown): boolean => value === null || typeof value === 'string';
const nullableCount = (value: unknown): boolean =>
  value === null || (Number.isInteger(value) && Number(value) >= 0);
const versionString = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 128 &&
  /^[\x20-\x7e]+$/u.test(value);
const validUpdateCheck = (value: unknown): boolean =>
  record(value) &&
  exact(value, ['checkedAt', 'result']) &&
  typeof value.checkedAt === 'string' &&
  Number.isFinite(Date.parse(value.checkedAt)) &&
  ['updated', 'current', 'failed'].includes(String(value.result));
const validVersions = (value: unknown): boolean =>
  record(value) &&
  Object.keys(value).every((key) => ['cli', 'scanner', 'hosts', 'update'].includes(key)) &&
  (value.update === undefined || validUpdateCheck(value.update)) &&
  (value.cli === undefined || versionString(value.cli)) &&
  (value.scanner === undefined || versionString(value.scanner)) &&
  (value.hosts === undefined ||
    (Array.isArray(value.hosts) &&
      value.hosts.length <= 32 &&
      value.hosts.every(
        (host) =>
          record(host) &&
          versionString(host.host) &&
          Object.keys(host).every((key) => ['host', 'editor', 'hooks'].includes(key)) &&
          (host.editor === undefined || versionString(host.editor)) &&
          (host.hooks === undefined || versionString(host.hooks))
      )));
const validSummary = (value: unknown): value is ReadinessSummary => {
  if (!record(value) || !exact(value, ['state', 'reasons', 'actions'])) return false;
  const row = value;
  return (
    ['READY', 'LIMITED', 'ACTION_REQUIRED', 'FAILED'].includes(String(row.state)) &&
    strings(row.reasons) &&
    strings(row.actions)
  );
};
const validCounts = (value: unknown): boolean => {
  if (value === null) return true;
  if (!record(value) || !exact(value, ['total', 'completed'])) return false;
  const row = value;
  return nullableCount(row.total) && nullableCount(row.completed);
};

const validProject = (value: unknown): boolean => {
  if (
    !record(value) ||
    !exact(value, [
      'projectId',
      'displayName',
      'owner',
      'repositoryMatch',
      'identityFile',
      'summary',
      'indexing',
      'action',
    ])
  )
    return false;
  return (
    nullableString(value.projectId) &&
    nullableString(value.displayName) &&
    nullableString(value.owner) &&
    nullableString(value.repositoryMatch) &&
    nullableString(value.identityFile) &&
    validSummary(value.summary) &&
    validCounts(value.indexing) &&
    nullableString(value.action)
  );
};

const validInstallSession = (value: unknown): boolean =>
  value === null ||
  (record(value) &&
    exact(value, ['id', 'status', 'kind', 'startedAt', 'completedAt']) &&
    [value.id, value.status, value.kind, value.startedAt, value.completedAt].every(nullableString));

const validGrant = (value: unknown): boolean =>
  record(value) &&
  exact(value, [
    'id',
    'client',
    'device',
    'platform',
    'scopes',
    'resource',
    'createdAt',
    'lastUsedAt',
    'expiresAt',
    'incompleteInstallation',
    'revokeAction',
  ]) &&
  typeof value.id === 'string' &&
  typeof value.client === 'string' &&
  nullableString(value.device) &&
  nullableString(value.platform) &&
  strings(value.scopes) &&
  typeof value.resource === 'string' &&
  typeof value.createdAt === 'string' &&
  nullableString(value.lastUsedAt) &&
  nullableString(value.expiresAt) &&
  typeof value.incompleteInstallation === 'boolean' &&
  typeof value.revokeAction === 'string';

const validComponent = (value: unknown): boolean =>
  record(value) &&
  exact(value, [
    'id',
    'kind',
    'displayPrefix',
    'device',
    'scopes',
    'lastUsedAt',
    'expiresAt',
    'revokeAction',
  ]) &&
  typeof value.id === 'string' &&
  typeof value.kind === 'string' &&
  nullableString(value.displayPrefix) &&
  nullableString(value.device) &&
  strings(value.scopes) &&
  nullableString(value.lastUsedAt) &&
  nullableString(value.expiresAt) &&
  typeof value.revokeAction === 'string';

const validScanner = (value: unknown): boolean =>
  value === null ||
  (record(value) &&
    exact(
      Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'missingApprovedRoots')),
      ['roots', 'heartbeatAt', 'version', 'readiness', 'acceptedDisclosureVersion']
    ) &&
    (value.missingApprovedRoots === undefined ||
      (Number.isSafeInteger(value.missingApprovedRoots) &&
        Number(value.missingApprovedRoots) > 0)) &&
    (value.roots === null || strings(value.roots)) &&
    nullableString(value.heartbeatAt) &&
    nullableString(value.version) &&
    (value.readiness === null || validSummary(value.readiness)) &&
    nullableString(value.acceptedDisclosureVersion));

const validSetup = (value: unknown): boolean =>
  record(value) &&
  exact(value, [
    'projectId',
    'displayName',
    'owner',
    'repositoryMatch',
    'identityFile',
    'action',
  ]) &&
  [
    value.projectId,
    value.displayName,
    value.owner,
    value.repositoryMatch,
    value.identityFile,
    value.action,
  ].every(nullableString);

/** Strict enough for the install-session trust boundary; nested console rows stay JSON-only. */
export function isReadinessDocument(value: unknown): value is ReadinessDocument {
  if (!record(value)) return false;
  const required = [
    'schemaVersion',
    'installation',
    'indexing',
    'installSession',
    'devicesAndGrants',
    'componentCredentials',
    'scanner',
    'projectSetupResults',
    'defaultOwner',
    'limitedMode',
    'generatedAt',
  ];
  if (
    !Object.keys(value).every((key) =>
      [...required, 'projects', 'versions', 'platform'].includes(key)
    )
  )
    return false;
  const row = value;
  if ('versions' in row && !validVersions(row.versions)) return false;
  if ('platform' in row && !versionString(row.platform)) return false;
  if (
    row.schemaVersion !== READINESS_SCHEMA_VERSION ||
    !validSummary(row.installation) ||
    !validCounts(row.indexing) ||
    typeof row.generatedAt !== 'string' ||
    !Number.isFinite(Date.parse(row.generatedAt))
  )
    return false;
  if (
    row.projects !== undefined &&
    (!Array.isArray(row.projects) || !row.projects.every(validProject))
  )
    return false;
  if (!required.every((field) => field in row)) return false;
  if (!validInstallSession(row.installSession)) return false;
  if (
    row.devicesAndGrants !== null &&
    (!Array.isArray(row.devicesAndGrants) || !row.devicesAndGrants.every(validGrant))
  )
    return false;
  if (
    row.componentCredentials !== null &&
    (!Array.isArray(row.componentCredentials) || !row.componentCredentials.every(validComponent))
  )
    return false;
  if (!validScanner(row.scanner)) return false;
  if (
    row.projectSetupResults !== null &&
    (!Array.isArray(row.projectSetupResults) || !row.projectSetupResults.every(validSetup))
  )
    return false;
  if (
    row.defaultOwner !== null &&
    (!record(row.defaultOwner) ||
      !exact(row.defaultOwner, ['kind', 'id', 'name']) ||
      !['personal', 'team'].includes(String(row.defaultOwner.kind)) ||
      !nullableString(row.defaultOwner.id) ||
      !nullableString(row.defaultOwner.name))
  )
    return false;
  return (
    row.limitedMode === null ||
    (record(row.limitedMode) &&
      exact(row.limitedMode, ['acknowledgement', 'enableScannerAction']) &&
      nullableString(row.limitedMode.acknowledgement) &&
      typeof row.limitedMode.enableScannerAction === 'string')
  );
}
