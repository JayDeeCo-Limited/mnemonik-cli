import { execFile as nodeExecFile } from 'node:child_process';
import { createCredentialAdapter, type CredentialTransport, type WorkResponse } from '@mnemonik/credentials';
export interface DiagnosticsManifest {
    schemaVersion: 1;
    bundleId: string;
    createdAt: string;
    byteCount: number;
    scannerVersion: string | null;
    os: {
        platform: string;
        arch: string;
        release: string;
    };
    entries: Record<string, {
        bytes: number;
        sha256: string;
    }>;
}
export interface PreviewResult {
    path: string;
    manifest: DiagnosticsManifest;
    sha256: string;
}
type CredentialAdapter = Pick<ReturnType<typeof createCredentialAdapter>, 'withCredential'>;
export interface DiagnosticsDependencies {
    stateDir?: string;
    fetch?: typeof fetch;
    execFile?: typeof nodeExecFile;
    scannerBinary?: () => Promise<string>;
    credentials?: CredentialAdapter;
    rotation?: CredentialTransport;
}
export declare class DiagnosticsError extends Error {
    readonly code: string;
    constructor(code: string);
}
export declare function previewDiagnostics(out: string | undefined, dependencies?: DiagnosticsDependencies): Promise<PreviewResult>;
/** Network boundary. Its sole call site is sendDiagnostics below. */
export declare function uploadDiagnosticsBundle(serverUrl: string, token: string, bundleId: string, sha256: string, bytes: Buffer, fetcher: typeof fetch): Promise<WorkResponse<Record<string, unknown>>>;
export declare function sendDiagnostics(bundleId: string, dependencies?: DiagnosticsDependencies): Promise<Record<string, unknown>>;
export {};
//# sourceMappingURL=diagnostics.d.ts.map