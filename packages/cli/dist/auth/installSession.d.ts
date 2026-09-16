import type { createCredentialAdapter } from '@mnemonik/credentials';
export interface InstallSession {
    id: string;
    device_installation_id: string;
    expires_at?: string;
}
export interface EnsureInstallSessionOptions {
    stateDir?: string;
    bearer: string;
    deviceInstallationId: string;
    currentSession?: InstallSession | null;
    credentials?: ReturnType<typeof createCredentialAdapter>;
    scannerRoots?: string;
    noBrowser?: boolean;
    print?: (line: string) => void;
    fetch?: typeof fetch;
    authorize?: (deviceInstallationId: string) => Promise<string>;
}
export declare function currentInstallSession(bearer: string, fetcher?: typeof fetch): Promise<InstallSession | null>;
/** Reauthorize the existing installation only when its install session has expired. */
export declare function ensureInstallSession(options: EnsureInstallSessionOptions): Promise<string>;
//# sourceMappingURL=installSession.d.ts.map