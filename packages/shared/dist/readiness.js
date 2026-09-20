export const READINESS_SCHEMA_VERSION = 1;
const stateFor = {
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
const rank = {
    READY: 0,
    LIMITED: 1,
    ACTION_REQUIRED: 2,
    FAILED: 3,
};
function defaultAction(condition) {
    if (condition.kind === 'windows_task_creation_failed')
        return 'Run mnemonik scanner enable to try again.';
    return condition.action;
}
export function reduceReadiness(input) {
    let state = 'READY';
    const reasons = [];
    const actions = [];
    for (const condition of input) {
        const candidate = stateFor[condition.kind];
        if (rank[candidate] > rank[state])
            state = candidate;
        if (!reasons.includes(condition.reason))
            reasons.push(condition.reason);
        const action = defaultAction(condition);
        if (action && !actions.includes(action))
            actions.push(action);
    }
    return { state, reasons, actions };
}
function sentence(value) {
    return /[.!?]$/u.test(value) ? value : `${value}.`;
}
export function remainingReadinessCount(summary) {
    return summary.reasons.filter((reason) => reason !== 'dev_release_source').length;
}
export function describeReadiness(summary) {
    if (summary.state === 'READY')
        return 'Done.';
    const count = remainingReadinessCount(summary);
    const opening = summary.state === 'FAILED'
        ? 'Setup failed.'
        : count === 0
            ? 'Done.'
            : summary.state === 'ACTION_REQUIRED'
                ? `Setup needs ${count === 1 ? 'one action' : `${count} actions`}.`
                : `Done, with ${count === 1 ? 'one thing' : `${count} things`} left.`;
    return [opening, ...summary.reasons.map(sentence), ...summary.actions].join(' ');
}
const counts = (value) => value ? { total: value.total ?? null, completed: value.completed ?? null } : null;
const summary = (value) => 'conditions' in value
    ? reduceReadiness(value.conditions)
    : { state: value.state, reasons: [...value.reasons], actions: [...value.actions] };
export function serializeReadiness(input) {
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
const strings = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');
const record = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => key in value);
const nullableString = (value) => value === null || typeof value === 'string';
const nullableCount = (value) => value === null || (Number.isInteger(value) && Number(value) >= 0);
const versionString = (value) => typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[\x20-\x7e]+$/u.test(value);
const validVersions = (value) => record(value) &&
    Object.keys(value).every((key) => ['cli', 'scanner', 'hosts'].includes(key)) &&
    (value.cli === undefined || versionString(value.cli)) &&
    (value.scanner === undefined || versionString(value.scanner)) &&
    (value.hosts === undefined ||
        (Array.isArray(value.hosts) &&
            value.hosts.length <= 32 &&
            value.hosts.every((host) => record(host) &&
                versionString(host.host) &&
                Object.keys(host).every((key) => ['host', 'editor', 'hooks'].includes(key)) &&
                (host.editor === undefined || versionString(host.editor)) &&
                (host.hooks === undefined || versionString(host.hooks)))));
const validSummary = (value) => {
    if (!record(value) || !exact(value, ['state', 'reasons', 'actions']))
        return false;
    const row = value;
    return (['READY', 'LIMITED', 'ACTION_REQUIRED', 'FAILED'].includes(String(row.state)) &&
        strings(row.reasons) &&
        strings(row.actions));
};
const validCounts = (value) => {
    if (value === null)
        return true;
    if (!record(value) || !exact(value, ['total', 'completed']))
        return false;
    const row = value;
    return nullableCount(row.total) && nullableCount(row.completed);
};
const validProject = (value) => {
    if (!record(value) ||
        !exact(value, [
            'projectId',
            'displayName',
            'owner',
            'repositoryMatch',
            'identityFile',
            'summary',
            'indexing',
            'action',
        ]))
        return false;
    return (nullableString(value.projectId) &&
        nullableString(value.displayName) &&
        nullableString(value.owner) &&
        nullableString(value.repositoryMatch) &&
        nullableString(value.identityFile) &&
        validSummary(value.summary) &&
        validCounts(value.indexing) &&
        nullableString(value.action));
};
const validInstallSession = (value) => value === null ||
    (record(value) &&
        exact(value, ['id', 'status', 'kind', 'startedAt', 'completedAt']) &&
        [value.id, value.status, value.kind, value.startedAt, value.completedAt].every(nullableString));
const validGrant = (value) => record(value) &&
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
const validComponent = (value) => record(value) &&
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
const validScanner = (value) => value === null ||
    (record(value) &&
        exact(value, ['roots', 'heartbeatAt', 'version', 'readiness', 'acceptedDisclosureVersion']) &&
        (value.roots === null || strings(value.roots)) &&
        nullableString(value.heartbeatAt) &&
        nullableString(value.version) &&
        (value.readiness === null || validSummary(value.readiness)) &&
        nullableString(value.acceptedDisclosureVersion));
const validSetup = (value) => record(value) &&
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
export function isReadinessDocument(value) {
    if (!record(value))
        return false;
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
    if (!Object.keys(value).every((key) => [...required, 'projects', 'versions', 'platform'].includes(key)))
        return false;
    const row = value;
    if ('versions' in row && !validVersions(row.versions))
        return false;
    if ('platform' in row && !versionString(row.platform))
        return false;
    if (row.schemaVersion !== READINESS_SCHEMA_VERSION ||
        !validSummary(row.installation) ||
        !validCounts(row.indexing) ||
        typeof row.generatedAt !== 'string' ||
        !Number.isFinite(Date.parse(row.generatedAt)))
        return false;
    if (row.projects !== undefined &&
        (!Array.isArray(row.projects) || !row.projects.every(validProject)))
        return false;
    if (!required.every((field) => field in row))
        return false;
    if (!validInstallSession(row.installSession))
        return false;
    if (row.devicesAndGrants !== null &&
        (!Array.isArray(row.devicesAndGrants) || !row.devicesAndGrants.every(validGrant)))
        return false;
    if (row.componentCredentials !== null &&
        (!Array.isArray(row.componentCredentials) || !row.componentCredentials.every(validComponent)))
        return false;
    if (!validScanner(row.scanner))
        return false;
    if (row.projectSetupResults !== null &&
        (!Array.isArray(row.projectSetupResults) || !row.projectSetupResults.every(validSetup)))
        return false;
    if (row.defaultOwner !== null &&
        (!record(row.defaultOwner) ||
            !exact(row.defaultOwner, ['kind', 'id', 'name']) ||
            !['personal', 'team'].includes(String(row.defaultOwner.kind)) ||
            !nullableString(row.defaultOwner.id) ||
            !nullableString(row.defaultOwner.name)))
        return false;
    return (row.limitedMode === null ||
        (record(row.limitedMode) &&
            exact(row.limitedMode, ['acknowledgement', 'enableScannerAction']) &&
            nullableString(row.limitedMode.acknowledgement) &&
            typeof row.limitedMode.enableScannerAction === 'string'));
}
//# sourceMappingURL=readiness.js.map