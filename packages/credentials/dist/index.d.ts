import { windowsCurrentUserAcl } from '@mnemonik/local-setup';
import { type ActionRequired, type CliOAuthCredential, type CliOAuthMetadata, type CliOAuthTokens, type CliCredentialTransport, type ComponentCredentialResponse, type ComponentKind, type CredentialTransport, type FamilyCredential, type RetryLater, type RotationResult, type SecretStore, SimulatedSecretStore, type WorkResponse } from './contracts.js';
import { CredentialError, credentialPaths, stateDirectory, type SecureFileOptions } from './storage.js';
export * from './contracts.js';
import { osSecretStore } from './osSecretStore.js';
export { osSecretStore };
export { CredentialError, SimulatedSecretStore, credentialPaths, stateDirectory, windowsCurrentUserAcl, };
export interface CredentialAdapterOptions extends SecureFileOptions {
    secretStore?: SecretStore;
    onDiagnostic?: (code: 'os_store_unavailable') => void;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
    retryLimit?: number;
    lockWaitMs?: number;
}
export declare function createCredentialAdapter(options?: CredentialAdapterOptions): {
    putCliOAuth: (metadata: CliOAuthMetadata, tokens: CliOAuthTokens | string) => Promise<{
        store: string;
    }>;
    readCliOAuth: () => Promise<CliOAuthCredential | null>;
    rotateCli: (transport: CliCredentialTransport) => Promise<ActionRequired | RetryLater | CliOAuthCredential>;
    withCliCredential: <T>(transport: CliCredentialTransport, work: (accessToken: string) => Promise<WorkResponse<T>>) => Promise<WorkResponse<T> | ActionRequired | RetryLater>;
    removeCliOAuth: () => Promise<void>;
    putFamily: (componentKind: ComponentKind, response: ComponentCredentialResponse) => Promise<FamilyCredential>;
    readFamily: (familyId: string) => Promise<FamilyCredential | null>;
    rotateFamily: (familyId: string, transport: CredentialTransport) => Promise<RotationResult>;
    withCredential: <T>(familyId: string, transport: CredentialTransport, work: (accessToken: string) => Promise<WorkResponse<T>>) => Promise<WorkResponse<T> | ActionRequired | RetryLater>;
    revokeFamily: (familyId: string, transport: CredentialTransport) => Promise<ActionRequired | RetryLater | {
        status: 'revoked';
        familyId: string;
    }>;
    forget: () => Promise<{
        status: 'forgotten';
        retainedServerSide: {
            cliFamilyId?: string | undefined;
            componentFamilyIds: string[];
        };
    }>;
    hmacRootBinding: (version: 1, input: string) => Promise<{
        version: 1;
        hmac: string;
    }>;
};
/** Shared CLI/hook backend selection; component records keep their recorded backend. */
export declare function createLocalCredentialAdapter(options?: CredentialAdapterOptions): {
    putCliOAuth: (metadata: CliOAuthMetadata, tokens: CliOAuthTokens | string) => Promise<{
        store: string;
    }>;
    readCliOAuth: () => Promise<CliOAuthCredential | null>;
    rotateCli: (transport: CliCredentialTransport) => Promise<ActionRequired | RetryLater | CliOAuthCredential>;
    withCliCredential: <T>(transport: CliCredentialTransport, work: (accessToken: string) => Promise<WorkResponse<T>>) => Promise<WorkResponse<T> | ActionRequired | RetryLater>;
    removeCliOAuth: () => Promise<void>;
    putFamily: (componentKind: ComponentKind, response: ComponentCredentialResponse) => Promise<FamilyCredential>;
    readFamily: (familyId: string) => Promise<FamilyCredential | null>;
    rotateFamily: (familyId: string, transport: CredentialTransport) => Promise<RotationResult>;
    withCredential: <T>(familyId: string, transport: CredentialTransport, work: (accessToken: string) => Promise<WorkResponse<T>>) => Promise<WorkResponse<T> | ActionRequired | RetryLater>;
    revokeFamily: (familyId: string, transport: CredentialTransport) => Promise<ActionRequired | RetryLater | {
        status: 'revoked';
        familyId: string;
    }>;
    forget: () => Promise<{
        status: 'forgotten';
        retainedServerSide: {
            cliFamilyId?: string | undefined;
            componentFamilyIds: string[];
        };
    }>;
    hmacRootBinding: (version: 1, input: string) => Promise<{
        version: 1;
        hmac: string;
    }>;
};
type HookFamily = {
    familyId: string;
    server: string;
    credentials: ReturnType<typeof createCredentialAdapter>;
    unavailable: boolean;
    diagnosed?: boolean;
};
export type HookCredential = string | HookFamily;
/** Family handles contain no tokens. Legacy keys are considered only without a family. */
export declare function resolveHookCredential(legacyKey: string | null, server: string, env?: NodeJS.ProcessEnv, argv?: string[]): HookCredential | null;
/** Preserve each caller's wire body and budget; share rotation and failure state with bound context. */
export declare function fetchWithHookCredential(credential: HookCredential | null, url: string, init: NonNullable<Parameters<typeof fetch>[1]> & {
    headers?: Record<string, string>;
}): Promise<Response>;
//# sourceMappingURL=index.d.ts.map