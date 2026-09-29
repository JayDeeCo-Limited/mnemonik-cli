import { type createCredentialAdapter, type CliOAuthCredential, type CredentialAdapterOptions } from '@mnemonik/credentials';
export declare const CLI_SCOPES: readonly ['account:read', 'install:manage', 'components:manage', 'projects:manage', 'offline_access'];
/**
 * Sign-out holds the CLI credential lease across its /oauth/revoke call, so the call is
 * bounded: a hung issuer must not keep the lease (and a sign-in waiting for it) indefinitely.
 */
export declare const CLI_REVOKE_TIMEOUT_MS = 10000;
/**
 * Bound on one token refresh. The credential adapter retries a lost response
 * once, so a refresh the server never answers ends as rotation_response_lost
 * (retry) after about twice this.
 */
export declare const CLI_REFRESH_TIMEOUT_MS = 5000;
export interface CliAuthOptions {
    stateDir?: string;
    scannerRoots?: string;
    deviceInstallationId?: string;
    issuer?: string;
    resource?: string;
    noBrowser?: boolean;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    deviceName?: string;
    /** Reads the macOS Computer Name; replaced in tests. */
    computerName?: () => Promise<string>;
    print?: (line: string) => void;
    /** Each approval link as it is issued, instead of printing it. */
    onApprovalLink?: (url: string, expiresAt: number) => void;
    fetch?: typeof fetch;
    openBrowser?: (url: string) => Promise<void>;
    sleep?: (milliseconds: number) => Promise<void>;
    now?: () => number;
    credentials?: ReturnType<typeof createCredentialAdapter>;
    credentialOptions?: CredentialAdapterOptions;
    /** Bound on the sign-out revoke call; CLI_REVOKE_TIMEOUT_MS unless a test replaces it. */
    revokeTimeoutMs?: number;
    /** Bound on one token refresh; CLI_REFRESH_TIMEOUT_MS unless a test replaces it. */
    refreshTimeoutMs?: number;
}
export declare function noBrowserAvailable(platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv): boolean;
export declare function createCliAuth(options?: CliAuthOptions): {
    signIn: () => Promise<CliOAuthCredential>;
    getCliBearer: () => Promise<string | {
        status: string;
        reason: string;
    }>;
    accountEmail: (bearer: string) => Promise<string>;
    logout: () => Promise<void>;
};
export * from './device.js';
export * from './pkce.js';
//# sourceMappingURL=index.d.ts.map