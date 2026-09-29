import { type Execute } from './runtimeSigners.js';
import { type ProjectIdentityResolution } from './repositoryRoot.js';
export interface ProjectIdentity {
    projectId: string;
    projectName?: string;
    projectRoot: string;
}
/** Forget cached resolutions (after project setup wrote a `.mnemonik.json`). */
export declare function clearProjectIdentityCache(): void;
export declare function findProjectIdentity(startCwd: string, options?: {
    allowNestedInherit?: boolean;
    maxDepth?: number;
}): Promise<ProjectIdentity | null>;
export declare function findProjectIdentityDetailed(startCwd: string, options?: {
    allowNestedInherit?: boolean;
    maxDepth?: number;
}): Promise<ProjectIdentityResolution>;
/** Largest hook payload read from stdin; a bigger one fails open. */
export declare const HOOK_STDIN_MAX_BYTES = 1048576;
/**
 * Read a hook's stdin payload, bounded in size and in time. Resolves the text
 * (a leading BOM removed) when the host closes stdin, or when `timeoutMs`
 * passes first: then with whatever arrived, which the caller parses like any
 * other payload (a partial one fails to parse and the hook fails open).
 * Resolves null past `maxBytes` or on a stream error. After the timeout or
 * the cap the stream is destroyed, so an unclosed pipe no longer holds the
 * process open (Grok's hook returns without calling exit).
 */
export declare function readHookStdin(options?: {
    stream?: NodeJS.ReadableStream & {
        destroy?: () => void;
    };
    timeoutMs?: number;
    maxBytes?: number;
}): Promise<string | null>;
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