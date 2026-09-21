import { cliCredentialStatus } from './auth/credentials.js';
import type { Readable } from 'node:stream';
import { type ReadinessCondition, type ReadinessDocument, type ReadinessDocumentInput } from '@mnemonik/shared';
import { Output } from './output.js';
import { type ProjectCommandDependencies, type ProjectExecutor, type ProjectReadTransport, type ServerProjectState } from './project.js';
import type { ScannerPickerResult } from './scanner/picker.js';
import type { PreflightResult } from './preflight.js';
import { type LauncherOptions, type LauncherStatus } from './launcher.js';
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
export declare function buildStatusDocument(input: StatusDocumentInput): ReadinessDocument;
export declare const CODEX_TRUST_MESSAGE: {
    sentence: string;
    nextStep: string;
};
export declare function renderStatusSummaries(document: ReadinessDocument & {
    cliCredential?: Awaited<ReturnType<typeof cliCredentialStatus>>;
    launcher?: LauncherStatus;
}, output: Pick<Output, 'line'>, options?: {
    diagnostics?: boolean;
}): void;
export declare function statusExitCode(document: ReadinessDocument): number;
export declare function readProjectStatus(input: ReadProjectStatusInput): Promise<ProjectStatusResult>;
export declare function collectStatusDocument(input: CollectStatusInput): Promise<ReadinessDocument & {
    cliCredential: Awaited<ReturnType<typeof cliCredentialStatus>>;
    launcher: LauncherStatus;
}>;
//# sourceMappingURL=status.d.ts.map