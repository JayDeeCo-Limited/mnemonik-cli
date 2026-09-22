import type { Readable } from 'node:stream';
import type { createCredentialAdapter } from '@mnemonik/credentials';
import { type ExecutorDependencies, type EnsureOptions, type Owner, type SetupResult } from '@mnemonik/local-setup';
import { resolveProjectIdentity, type ProjectIdentityResolution, type RepositoryFingerprint } from '@mnemonik/shared';
import type { Output } from './output.js';
export interface ProjectExecutor {
    resolveProjectIdentity(cwd: string): Promise<ProjectIdentityResolution>;
    ensureProject(options: EnsureOptions): Promise<SetupResult>;
    stage(options: EnsureOptions): Promise<SetupResult>;
    apply(options: EnsureOptions): Promise<SetupResult>;
    rollback(options: EnsureOptions): Promise<SetupResult>;
}
export declare function ensureProjectRoot(root: string, executor: ProjectExecutor): Promise<SetupResult>;
/** Does Mnemonik have plain words for this state? */
export declare const hasRefusalWords: (reason: string) => boolean;
/** No bare line: name the folder, say why in plain words, give the one command. */
export declare function folderRefusalMessage(reason: string, root: string): string[];
export declare function projectLimitMessage(result: SetupResult, roots: string | readonly string[]): string[] | undefined;
export declare const connectedProjectsMessage: (roots: string[]) => string;
export declare const projectExecutor: (dependencies: ExecutorDependencies) => ProjectExecutor;
export type ServerProjectState = 'access' | 'archived' | 'deleted' | 'suspended' | 'mismatch' | 'not_found';
export interface ProjectReadTransport {
    getDefaultOwner(bearer: string): Promise<Owner | undefined>;
    readProjectState(projectId: string, bearer: string, localFingerprint?: RepositoryFingerprint | null): Promise<{
        state: ServerProjectState;
        allowedActions?: string[];
    }>;
}
export interface RealProjectRuntimeOptions {
    /** Roots individually approved by the person for this install. */
    selectedRoots?: boolean;
    apiBase?: string;
    resource?: string;
    fetch?: typeof fetch;
    stateDir?: string;
    credentials?: ReturnType<typeof createCredentialAdapter>;
    getCliBearer?: () => Promise<string | {
        status: string;
        reason: string;
    }>;
    requestId?: string;
    fault?: ExecutorDependencies['fault'];
}
export declare function repositoryFingerprint(root: string): Promise<RepositoryFingerprint | null>;
export declare function createRealProjectRuntime(options?: RealProjectRuntimeOptions): Promise<{
    transport: {
        issueSetupRequest(input: import("@mnemonik/local-setup").Evidence & {
            projectId?: string;
        }): Promise<import("@mnemonik/local-setup").SetupRequired | import("@mnemonik/local-setup").ActionRequired | import("@mnemonik/local-setup").Complete>;
        consumeSetupRequest(input: import("@mnemonik/local-setup").ConsumeInput): Promise<import("@mnemonik/local-setup").Complete | import("@mnemonik/local-setup").ActionRequired>;
        getCliBearer: () => Promise<string | {
            status: string;
            reason: string;
        }>;
        credentials: {
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
        accountContext: (bearer?: string) => Promise<{
            owner: Owner;
            userId: string;
            deviceInstallationId: string;
        }>;
        getDefaultOwner(bearer: string): Promise<Owner | undefined>;
        readProjectState(projectId: string, bearer: string, localFingerprint?: RepositoryFingerprint | null): Promise<{
            state: "mismatch" | ("access" | "archived" | "deleted" | "not_found" | "suspended");
        }>;
    };
    getCliBearer: () => Promise<string | {
        status: string;
        reason: string;
    }>;
    executor: ProjectExecutor;
}>;
export interface ProjectCommandDependencies {
    output: Output;
    input: Readable;
    cwd: string;
    home?: string;
    executor?: ProjectExecutor;
    resolver?: {
        resolveProjectIdentity: typeof resolveProjectIdentity;
    };
    stateDir?: string;
    getCliBearer?: () => Promise<string | undefined>;
    transport?: ProjectReadTransport;
}
export interface ProjectCommandInput {
    command: 'init' | 'setup' | 'status' | 'link';
    path?: string;
    projectId?: string;
    json: boolean;
    nonInteractive: boolean;
    apply: boolean;
    confirmMismatch: boolean;
    replace: boolean;
    owner?: string;
}
export declare function runProjectCommand(input: ProjectCommandInput, deps: ProjectCommandDependencies): Promise<number>;
export declare function ensureProjectForAgent(options: {
    output: Output;
    cwd: string;
    executor?: ProjectExecutor;
    input?: Readable;
}): Promise<number>;
export declare function rollbackProjectIdentity(options: {
    output: Output;
    cwd: string;
    executor?: ProjectExecutor;
}): Promise<number>;
//# sourceMappingURL=project.d.ts.map