import { type createCredentialAdapter, type CliCredentialTransport, type CliOAuthCredential } from '@mnemonik/credentials';
import type { ActionRequired, ConsumeInput, Evidence, Owner, SetupRequired } from '@mnemonik/local-setup';
import type { RepositoryFingerprint } from '@mnemonik/shared';
export interface CliIssueContext extends Evidence {
    rootKind: 'git' | 'selected_non_git' | 'ineligible';
    identityState: 'absent' | 'valid' | 'invalid';
    projectId?: string;
    requestedProjectId?: string;
    requestId?: string;
}
export interface ServerTransportOptions {
    apiBase?: string;
    resource?: string;
    fetch?: typeof fetch;
    credentials?: ReturnType<typeof createCredentialAdapter>;
    getCliBearer?: () => Promise<string | {
        status: string;
        reason: string;
    }>;
    requestId?: string;
    issueContext(input: Evidence & {
        projectId?: string;
    }): Promise<CliIssueContext>;
}
type AccountContext = {
    owner: Owner;
    userId: string;
    deviceInstallationId: string;
};
type ProjectState = 'access' | 'archived' | 'deleted' | 'suspended' | 'not_found';
export declare class ServerActionRequiredError extends Error {
    readonly result: ActionRequired;
    constructor(result: ActionRequired);
}
export declare function createServerTransport(options: ServerTransportOptions): {
    issueSetupRequest(input: Evidence & {
        projectId?: string;
    }): Promise<SetupRequired | ActionRequired | import("@mnemonik/local-setup").Complete>;
    consumeSetupRequest(input: ConsumeInput): Promise<import("@mnemonik/local-setup").Complete | ActionRequired>;
    getCliBearer: () => Promise<string | {
        status: string;
        reason: string;
    }>;
    credentials: {
        putCliOAuth: (metadata: import("@mnemonik/credentials").CliOAuthMetadata, tokens: import("@mnemonik/credentials").CliOAuthTokens | string) => Promise<{
            store: string;
        }>;
        readCliOAuth: () => Promise<CliOAuthCredential | null>;
        rotateCli: (transport: CliCredentialTransport) => Promise<import("@mnemonik/credentials").ActionRequired | import("@mnemonik/credentials").RetryLater | CliOAuthCredential>;
        withCliCredential: <T>(transport: CliCredentialTransport, work: (accessToken: string) => Promise<import("@mnemonik/credentials").WorkResponse<T>>) => Promise<import("@mnemonik/credentials").WorkResponse<T> | import("@mnemonik/credentials").ActionRequired | import("@mnemonik/credentials").RetryLater>;
        removeCliOAuth: () => Promise<void>;
        putFamily: (componentKind: import("@mnemonik/credentials").ComponentKind, response: import("@mnemonik/credentials").ComponentCredentialResponse) => Promise<import("@mnemonik/credentials").FamilyCredential>;
        readFamily: (familyId: string) => Promise<import("@mnemonik/credentials").FamilyCredential | null>;
        rotateFamily: (familyId: string, transport: import("@mnemonik/credentials").CredentialTransport) => Promise<import("@mnemonik/credentials").RotationResult>;
        withCredential: <T>(familyId: string, transport: import("@mnemonik/credentials").CredentialTransport, work: (accessToken: string) => Promise<import("@mnemonik/credentials").WorkResponse<T>>) => Promise<import("@mnemonik/credentials").WorkResponse<T> | import("@mnemonik/credentials").ActionRequired | import("@mnemonik/credentials").RetryLater>;
        revokeFamily: (familyId: string, transport: import("@mnemonik/credentials").CredentialTransport) => Promise<import("@mnemonik/credentials").ActionRequired | import("@mnemonik/credentials").RetryLater | {
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
    accountContext: (bearer?: string) => Promise<AccountContext>;
    getDefaultOwner(bearer: string): Promise<Owner | undefined>;
    readProjectState(projectId: string, bearer: string, localFingerprint?: RepositoryFingerprint | null): Promise<{
        state: "mismatch" | ProjectState;
    }>;
};
export {};
//# sourceMappingURL=server.d.ts.map