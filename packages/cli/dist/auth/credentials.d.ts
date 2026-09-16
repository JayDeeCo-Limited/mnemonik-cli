import { type CredentialAdapterOptions, type CredentialStoreKind } from '@mnemonik/credentials';
/** Every CLI OAuth consumer uses the same process-scoped OS store. */
export declare function createCliCredentials(options?: CredentialAdapterOptions): {
    putCliOAuth: (metadata: import("@mnemonik/credentials").CliOAuthMetadata, tokens: import("@mnemonik/credentials").CliOAuthTokens | string) => Promise<{
        store: string;
    }>;
    readCliOAuth: () => Promise<import("@mnemonik/credentials").CliOAuthCredential | null>;
    rotateCli: (transport: import("@mnemonik/credentials").CliCredentialTransport) => Promise<import("@mnemonik/credentials").ActionRequired | import("@mnemonik/credentials").RetryLater | import("@mnemonik/credentials").CliOAuthCredential>;
    withCliCredential: <T>(transport: import("@mnemonik/credentials").CliCredentialTransport, work: (accessToken: string) => Promise<import("@mnemonik/credentials").WorkResponse<T>>) => Promise<import("@mnemonik/credentials").WorkResponse<T> | import("@mnemonik/credentials").ActionRequired | import("@mnemonik/credentials").RetryLater>;
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
export declare function cliCredentialStatus(options?: CredentialAdapterOptions): Promise<{
    store: CredentialStoreKind | null;
    present: boolean;
    diagnostics: string[];
    reason?: string;
    detail?: string;
}>;
//# sourceMappingURL=credentials.d.ts.map