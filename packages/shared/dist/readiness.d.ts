export declare const READINESS_SCHEMA_VERSION: 1;
export type ReadinessState = 'READY' | 'LIMITED' | 'ACTION_REQUIRED' | 'FAILED';
export type ReadinessConditionKind = 'selected_component_failed' | 'host_trust_pending' | 'vendor_policy_pending' | 'login_pending' | 'restart_pending' | 'project_identity_choice_pending' | 'scanner_not_verified' | 'hook_not_verified' | 'hooks_missing' | 'scanner_omitted' | 'project_uncovered' | 'host_skipped' | 'windows_task_creation_failed' | 'post_commit_upload_failed' | 'indexing_failed' | 'indexing_stalled';
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
    hosts?: Array<{
        host: string;
        editor?: string;
        hooks?: string;
    }>;
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
export declare function reduceReadiness(input: readonly ReadinessCondition[]): ReadinessSummary;
export declare function remainingReadinessCount(summary: ReadinessSummary): number;
export declare function describeReadiness(summary: ReadinessSummary): string;
export declare function serializeReadiness(input: ReadinessDocumentInput): ReadinessDocument;
/** Strict enough for the install-session trust boundary; nested console rows stay JSON-only. */
export declare function isReadinessDocument(value: unknown): value is ReadinessDocument;
//# sourceMappingURL=readiness.d.ts.map