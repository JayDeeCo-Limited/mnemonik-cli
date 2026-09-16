import { type Execute } from './runtimeSigners.js';
import { type ProjectIdentityResolution } from './repositoryRoot.js';
export interface ProjectIdentity {
    projectId: string;
    projectName?: string;
    projectRoot: string;
}
export declare function findProjectIdentity(startCwd: string, options?: {
    allowNestedInherit?: boolean;
    maxDepth?: number;
}): Promise<ProjectIdentity | null>;
export declare function findProjectIdentityDetailed(startCwd: string, options?: {
    allowNestedInherit?: boolean;
    maxDepth?: number;
}): Promise<ProjectIdentityResolution>;
export declare function parseHookResponse<T>(response: Response): Promise<T>;
/** Native host correlation only; never accept checkpoint/model fields here. */
export declare function validHookSessionId(value: unknown): value is string;
export interface HookBindingInput {
    host: 'claude_code' | 'cursor' | 'grok';
    hostSessionId: string;
    cwd: string;
    server: string;
    stateFile: string;
}
/** Bounded JSON transport; never log credentials, request/response bodies or URLs. */
export declare function postHookBoundJson(server: string, path: string, token: string, body: object): Promise<{
    status: number;
    body: unknown;
}>;
/** Shared context/cache logic. Credentials remain owned by each host package's
 * adapter callback so shared acquires no runtime credential dependency. */
export declare function bindHookContext(input: HookBindingInput, familyId: string, hmac: (root: string) => Promise<{
    version: 1;
    hmac: string;
}>, post: (body: object) => Promise<number | string>, options?: {
    platform?: NodeJS.Platform;
    run?: Execute;
}): Promise<void>;
export * from './runtimeReader.js';
export * from './runtimeSigners.js';
export * from './projectSetupHandoff.js';
//# sourceMappingURL=hookRuntime.d.ts.map