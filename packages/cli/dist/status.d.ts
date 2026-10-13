export { CODEX_TRUST_MESSAGE } from './humanReason.js';
import { cliCredentialStatus } from './auth/credentials.js';
import { type McpAuthorization, type McpState } from './auth/status.js';
import { type CliSignIn, type HooksState, type ScannerAuthorizationState } from './authorizationWords.js';
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
    credentialFamily?: string | undefined;
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
 * `status` could not tell the console about this machine because the CLI's own
 * sign-in could not be used (L-166): expired, revoked, or locked in the macOS
 * Keychain over SSH. The CLI line of the authorization block gives the step.
 */
export declare const REPORT_NOT_SENT: {
    sentence: string;
};
export declare function renderStatusSummaries(document: ReadinessDocument & {
    cliCredential?: Awaited<ReturnType<typeof cliCredentialStatus>>;
    launcher?: LauncherStatus;
    conditions?: readonly ReadinessCondition[];
}, output: Pick<Output, 'line'>, 
/** agent: no person at a terminal; an approval step names what the agent runs. */
options?: {
    diagnostics?: boolean;
    agent?: boolean;
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
    conditions?: ReadinessCondition[];
    cliCredential: Awaited<ReturnType<typeof cliCredentialStatus>>;
    launcher: LauncherStatus;
}>;
/** One installed coding tool on this machine, for `mnemonik status`. */
export interface CodingToolStatus {
    host: string;
    name: string;
    /** Its MCP connection's authorization; the evidence is in `authorizations`. */
    mcp: McpState;
    /** Its hooks' own authorization, from this machine's files and the tool's own trust records. */
    hooks: HooksState;
    /** Commands the agent runs to fix what is wrong with this tool, in order; empty when none. */
    actions: string[];
    /**
     * Steps only the person can take, inside the coding tool, in plain words
     * (Claude Code and Cursor authorize MCP only there); empty when none.
     */
    personSteps: string[];
}
/** One line of the authorization block, with the evidence behind it. */
export type AuthorizationEntry = ({
    component: 'mcp';
    host: string;
    line: string;
} & McpAuthorization) | {
    component: 'hooks';
    host: string;
    state: HooksState;
    line: string;
} | {
    component: 'scanner';
    state: ScannerAuthorizationState;
    line: string;
} | ({
    component: 'cli';
    line: string;
} & CliSignIn);
/** The coding tools installed on this machine: chosen at install or marked in their own settings. */
export declare function installedCodingTools(home: string, stateDir: string): Promise<{
    host: "claude-code" | "codex" | "cursor";
    name: "Claude Code" | "Codex" | "Cursor";
    marked: boolean;
    hooks: boolean;
    credentialFamily?: string | undefined;
    mcp: string;
}[]>;
/** The hooks' own authorization, as hookAuthorizations reads it. */
export type HookCredentialState = 'authorized' | 'not_authorized' | 'unchecked';
/**
 * Each tool's hooks' own authorization: the credential the installer recorded
 * for them (or their command names), stored here and inside its refresh
 * window. Hooks that name none sign in some other way, which is not read here.
 */
export declare function hookAuthorizations(stateDir: string, editors: ReadonlyArray<{
    host: string;
    credentialFamily?: string;
}>, now?: number): Promise<Map<string, HookCredentialState>>;
export declare function codingToolStatuses(editors: ReadonlyArray<{
    host: string;
    name: string;
    hooks: boolean;
}>, conditions: readonly ReadinessCondition[], mcp: ReadonlyMap<string, McpAuthorization>, hookCredentials?: ReadonlyMap<string, HookCredentialState>): CodingToolStatus[];
/**
 * The status document with each tool's state added. A tool whose MCP
 * authorization here was revoked, expired, or is no longer held by the tool,
 * hooks or a scanner whose own authorization is missing, expired or refused,
 * is a condition of the installation: status never says the machine is
 * working while one is. A tool never authorized here is not (it may simply be
 * unused); its line says how to authorize it.
 */
export declare function withCodingTools<T extends ReadinessDocument & {
    conditions?: readonly ReadinessCondition[];
}>(document: T, tools: readonly CodingToolStatus[], mcp: ReadonlyMap<string, McpAuthorization>, 
/** The scanner's own authorization; one that is gone is a condition too, said once. */
scanner?: ScannerAuthorizationState): T & {
    codingTools: CodingToolStatus[];
};
/**
 * Background indexing's own authorization on this computer: set up, its
 * credential stored here and inside its refresh window, and no refusal
 * reported by the running scanner. The server's record of it is not asked.
 */
export declare function scannerAuthorization(stateDir: string, now?: number): Promise<ScannerAuthorizationState>;
/**
 * The authorization block of `status`: each tool's MCP connection and hooks,
 * then the scanner and the CLI, one line each, never dropped. A state the
 * installation's attention lines already give a step for says only what is wrong.
 */
export declare function authorizationEntries(input: {
    tools: readonly CodingToolStatus[];
    mcp: ReadonlyMap<string, McpAuthorization>;
    conditions: readonly ReadinessCondition[];
    scanner: ScannerAuthorizationState;
    cli: CliSignIn;
}): AuthorizationEntry[];
//# sourceMappingURL=status.d.ts.map