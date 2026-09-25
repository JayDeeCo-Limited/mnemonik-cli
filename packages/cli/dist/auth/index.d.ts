import { type createCredentialAdapter, type CliOAuthCredential, type CredentialAdapterOptions } from '@mnemonik/credentials';
export declare const CLI_SCOPES: readonly ['account:read', 'install:manage', 'components:manage', 'projects:manage', 'offline_access'];
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
    fetch?: typeof fetch;
    openBrowser?: (url: string) => Promise<void>;
    sleep?: (milliseconds: number) => Promise<void>;
    now?: () => number;
    credentials?: ReturnType<typeof createCredentialAdapter>;
    credentialOptions?: CredentialAdapterOptions;
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