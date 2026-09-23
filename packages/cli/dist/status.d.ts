export { CODEX_TRUST_MESSAGE } from './humanReason.js';
import { cliCredentialStatus } from './auth/credentials.js';
import { type ScannerServiceOptions } from './scanner/service.js';
import type { Readable } from 'node:stream';
import { type ReadinessCondition, type ReadinessDocument, type ReadinessDocumentInput } from '@mnemonik/shared';
import { Output } from './output.js';
import { type ProjectCommandDependencies, type ProjectExecutor, type ProjectReadTransport, type ServerProjectState } from './project.js';
import type { ScannerPickerResult } from './scanner/picker.js';
import type { PreflightResult } from './preflight.js';
import { type LauncherOptions, type LauncherStatus } from './launcher.js';
declare const editorFiles: readonly [readonly ['claude-code', 'Claude Code', '.claude/settings.json', '.claude.json'], readonly ['codex', 'Codex', '.codex/hooks.json', '.codex/config.toml'], readonly ['cursor', 'Cursor', '.cursor/hooks.json', '.cursor/mcp.json']];
export declare function localEditorStatus(home: string): Promise<{
    host: "claude-code" | "codex" | "cursor";
    name: "Claude Code" | "Codex" | "Cursor";
    marked: boolean;
    hooks: boolean;
    mcp: string;
}[]>;
/** What a person can really do to switch a declared connection back on. */
export declare const mcpTurnOnAction: Record<(typeof editorFiles)[number][0], string>;
export declare function localInstallationConditions(home: string, stateDir: string, launcherOptions?: LauncherOptions): Promise<ReadinessCondition[]>;
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
    scannerHeartbeat?: {
        at: string;
        version: string | null;
        disclosureVersion: string | null;
    };
    /** True once the scanner has sent a heartbeat, so indexing needs no announcement. */
    scannerReported?: boolean;
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
export declare function buildStatusDocument(input: StatusDocumentInput): ReadinessDocument & {
    conditions: ReadinessCondition[];
};
export declare function renderStatusSummaries(document: ReadinessDocument & {
    cliCredential?: Awaited<ReturnType<typeof cliCredentialStatus>>;
    launcher?: LauncherStatus;
    conditions?: readonly ReadinessCondition[];
}, output: Pick<Output, 'line'>, options?: {
    diagnostics?: boolean;
}): void;
/**
 * One line per project whose files the server refused to index, summed over its
 * refused batches. `mnemonik doctor` follows each with its distinct issue paths.
 */
export declare function refusalLines(batches: ReadonlyArray<{
    project: string;
    files: number;
    issue: string;
}> | undefined, withPaths?: boolean): string[];
/** Print the refusal lines from the scanner's last recorded snapshot, if any. */
export declare function renderRefusals(stateDir: string, output: Pick<Output, 'line'>, withPaths?: boolean): Promise<void>;
export declare function statusExitCode(document: ReadinessDocument): number;
export declare function readProjectStatus(input: ReadProjectStatusInput): Promise<ProjectStatusResult>;
export declare function collectStatusDocument(input: CollectStatusInput): Promise<ReadinessDocument & {
    cliCredential: Awaited<ReturnType<typeof cliCredentialStatus>>;
    launcher: LauncherStatus;
}>;
//# sourceMappingURL=status.d.ts.map