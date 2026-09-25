export { CODEX_TRUST_MESSAGE } from './humanReason.js';
import { cliCredentialStatus } from './auth/credentials.js';
import { type ScannerReceipt } from './scanner/control.js';
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
        missingApprovedRoots?: number;
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
    /** Given by `mnemonik status`: undo a scanner pause left by an install that did not finish. */
    abandonedPause?: Omit<ScannerServiceOptions, 'stateDir'>;
    /** The disclosure version the scanner this CLI installs expects; the bundled release manifest by default. */
    expectedDisclosureVersion?: () => Promise<string | undefined>;
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
/**
 * `status` could not tell the console about this machine because this
 * computer's sign-in is unusable (L-166). Wording decided 2026-09-25; the fix
 * is the approved renew step.
 */
export declare const REPORT_NOT_SENT: {
    sentence: string;
    nextStep: string;
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
/** The plain cause for a failure the scanner reported, by kind. */
export declare function scannerFailureCause(failure: NonNullable<ScannerReceipt['snapshot']['failure']>): string;
/**
 * The cause behind a failing or signed-out scanner, for mnemonik doctor: the
 * plain cause, then the line the scanner logged beneath it as detail.
 */
export declare function renderScannerFailure(stateDir: string, output: Pick<Output, 'line'>): Promise<void>;
/** Print the refusal lines from the scanner's last recorded snapshot, if any. */
export declare function renderRefusals(stateDir: string, output: Pick<Output, 'line'>, withPaths?: boolean): Promise<void>;
export declare function statusExitCode(document: ReadinessDocument): number;
export declare function readProjectStatus(input: ReadProjectStatusInput): Promise<ProjectStatusResult>;
export declare function collectStatusDocument(input: CollectStatusInput): Promise<ReadinessDocument & {
    cliCredential: Awaited<ReturnType<typeof cliCredentialStatus>>;
    launcher: LauncherStatus;
}>;
//# sourceMappingURL=status.d.ts.map