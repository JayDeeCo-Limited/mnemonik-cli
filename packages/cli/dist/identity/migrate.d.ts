type SourceStatus = {
    name: string;
    path: string;
    status: 'found' | 'absent' | 'unreadable';
};
export type IdentityState = 'v0' | 'v1' | 'absent' | 'unknown_version' | 'malformed' | 'invalid_uuid' | 'unreachable' | 'cursor_match' | 'cursor_mismatch' | 'cursor_orphan' | 'cursor_malformed';
export interface IdentityInventoryEntry {
    kind: 'identity' | 'cursor_rule';
    path: string;
    projectPath: string;
    sources: string[];
    reachable: boolean;
    state: IdentityState;
    strictResult?: 'ok' | 'unknown_version' | 'malformed' | 'absent';
    sha256: `sha256:${string}` | null;
    projectId?: string;
    droppedKeys?: string[];
    detail?: string;
    actionRequired?: boolean;
}
export interface IdentityReport {
    schemaVersion: 1;
    generatedAt: string;
    host: {
        platform: NodeJS.Platform;
        home: string;
        stateDirectory: string;
    };
    sources: SourceStatus[];
    entries: IdentityInventoryEntry[];
    summary: Record<IdentityState, number>;
}
export interface MigrationOptions {
    mode: 'report' | 'backup' | 'apply' | 'verify' | 'rollback';
    paths?: string[];
    runId?: string;
    home?: string;
    cwd?: string;
    stateDir?: string;
    platform?: NodeJS.Platform;
    now?: () => Date;
}
export type MigrationResult = {
    status: 'reported';
    report: IdentityReport;
} | {
    status: 'backed_up';
    runId: string;
    indexPath: string;
    count: number;
    report: IdentityReport;
} | {
    status: 'applied' | 'verified' | 'rolled_back';
    runId: string;
    passed: number;
    failed: number;
    failures: string[];
};
export declare function inventoryIdentityFiles(options: MigrationOptions): Promise<IdentityReport>;
export declare function runIdentityMigration(options: MigrationOptions): Promise<MigrationResult>;
export {};
//# sourceMappingURL=migrate.d.ts.map