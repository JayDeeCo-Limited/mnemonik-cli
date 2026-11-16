import { windowsCurrentUserAcl } from '@mnemonik/local-setup';
import { type ActionRequired, type CliOAuthCredential, type CliOAuthMetadata, type CliOAuthTokens, type CliCredentialTransport, type CliRevocationTransport, type ComponentCredentialResponse, type ComponentKind, type CredentialTransport, type FamilyCredential, type RetryLater, type RotationResult, type SecretStore, SimulatedSecretStore, type WorkResponse } from './contracts.js';
import { CredentialError, credentialPaths, stateDirectory, type SecureFileOptions } from './storage.js';
export * from './contracts.js';
import { osSecretStore } from './osSecretStore.js';
export { osSecretStore };
export { CredentialError, SimulatedSecretStore, credentialPaths, stateDirectory, windowsCurrentUserAcl, };
/** The issuer's lasting refusal of a family, as recorded by whoever was refused. */
export interface FamilyRefusal {
    schemaVersion: 1;
    familyId: string;
    reason: string;
    refusedAt: string;
    /** The refused record's lastRotationTime: a record written since is not refused. */
    lastRotationTime: string;
}
export interface CredentialAdapterOptions extends SecureFileOptions {
    secretStore?: SecretStore;
    onDiagnostic?: (code: 'os_store_unavailable') => void;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
    retryLimit?: number;
    lockWaitMs?: number;
}
export declare function createCredentialAdapter(options?: CredentialAdapterOptions): {
    putCliOAuth: (metadata: CliOAuthMetadata, tokens: CliOAuthTokens | string) => ReturnType<(metadata: CliOAuthMetadata, tokens: CliOAuthTokens | string) => Promise<{
        store: string;
    }>>;
    readCliOAuth: () => Promise<CliOAuthCredential | null>;
    rotateCli: (transport: CliCredentialTransport) => Promise<ActionRequired | RetryLater | CliOAuthCredential>;
    withCliCredential: <T>(transport: CliCredentialTransport, work: (accessToken: string) => Promise<WorkResponse<T>>) => Promise<WorkResponse<T> | ActionRequired | RetryLater>;
    removeCliOAuth: () => Promise<void>;
    revokeCli: (transport: CliRevocationTransport) => Promise<ActionRequired | RetryLater | {
        status: 'revoked';
        familyId: string;
    }>;
    waitForCliLease: () => Promise<void>;
    putFamily: (componentKind: ComponentKind, response: ComponentCredentialResponse) => Promise<FamilyCredential>;
    readFamily: (familyId: string) => Promise<FamilyCredential | null>;
    readRefusal: (familyId: string) => Promise<FamilyRefusal | null>;
    recordRefusal: (familyId: string, reason: string) => Promise<void>;
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
    putCliOAuth: (metadata: CliOAuthMetadata, tokens: CliOAuthTokens | string) => ReturnType<(metadata: CliOAuthMetadata, tokens: CliOAuthTokens | string) => Promise<{
        store: string;
    }>>;
    readCliOAuth: () => Promise<CliOAuthCredential | null>;
    rotateCli: (transport: CliCredentialTransport) => Promise<ActionRequired | RetryLater | CliOAuthCredential>;
    withCliCredential: <T>(transport: CliCredentialTransport, work: (accessToken: string) => Promise<WorkResponse<T>>) => Promise<WorkResponse<T> | ActionRequired | RetryLater>;
    removeCliOAuth: () => Promise<void>;
    revokeCli: (transport: CliRevocationTransport) => Promise<ActionRequired | RetryLater | {
        status: 'revoked';
        familyId: string;
    }>;
    waitForCliLease: () => Promise<void>;
    putFamily: (componentKind: ComponentKind, response: ComponentCredentialResponse) => Promise<FamilyCredential>;
    readFamily: (familyId: string) => Promise<FamilyCredential | null>;
    readRefusal: (familyId: string) => Promise<FamilyRefusal | null>;
    recordRefusal: (familyId: string, reason: string) => Promise<void>;
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
    /** Whether the issuer has refused this family for good, read once per process. */
    refusal?: Promise<boolean>;
};
export type HookCredential = string | HookFamily;
/**
 * The one sentence a hook gives the agent when its credential is refused for good. Without
 * it the hooks go silent: every call fails open and nothing reaches the agent (2026-11-15).
 */
export declare const HOOK_CREDENTIAL_REFUSED_NOTICE = "Mnemonik's hooks on this machine have lost their sign-in and are not working; run mnemonik repair to restore them.";
/**
 * Whether this hook family is refused for good: by the issuer in this process, or in an
 * earlier one that recorded the refusal and the family record has not been written since.
 * A refused family sends nothing more; only a new record (repair, update) retries it.
 */
export declare function hookCredentialRefused(credential: HookCredential | null): Promise<boolean>;
/** Family handles contain no tokens. Legacy keys are considered only without a family. */
export declare function resolveHookCredential(legacyKey: string | null, server: string, env?: NodeJS.ProcessEnv, argv?: string[]): HookCredential | null;
/** Header on a synthetic answer that no server sent: the credential was not usable. */
export declare const HOOK_CREDENTIAL_HEADER = "x-mnemonik-credential";
/**
 * Preserve each caller's wire body and budget; share rotation and failure state with bound context.
 *
 * When no request could be sent, the answer is synthetic and says whether that is lasting, so a
 * caller that retries (edit reports) can tell the two apart without knowing about credentials:
 * - lasting (no credential, revoked or expired grant, family gone, refused rotation):
 *   403 `{"ok":false}`, as before;
 * - transient (rotation answered 429/5xx, its response lost, the successor not persisted, the
 *   lease or store unavailable): 503 `{"ok":false,"retryable":true,"reason":"credential_unavailable"}`.
 * Both carry `x-mnemonik-credential: unavailable`.
 */
export declare function fetchWithHookCredential(credential: HookCredential | null, url: string, init: NonNullable<Parameters<typeof fetch>[1]> & {
    headers?: Record<string, string>;
}): Promise<Response>;
//# sourceMappingURL=index.d.ts.map