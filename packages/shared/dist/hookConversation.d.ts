type HookFetchInit = NonNullable<Parameters<typeof fetch>[1]>;
export declare const CONVERSATION_STATE_FILE = "conversation.json";
export interface HookConversationInput {
    stateFile: string;
    server: string;
    account: string;
    host: string;
    nativeSessionId: string;
    agentId?: string;
    acquire?: boolean;
    /**
     * What the hook has left before its host's timeout. An acquiring request
     * with no handle waits for the lock only this long (less a round trip), so a
     * held lock never costs the hook its answer; past it the request fails open.
     */
    timeLeftMs?: () => number;
}
export declare class HookConversation {
    private readonly input;
    private conversationId?;
    /**
     * The hook call (x-mnemonik-hook-request-id) whose acquiring request holds
     * the conversation lock in this process. Its hedged second request
     * (hedgedHookRequest) is the same call: waiting for the lock would hold it
     * until the first request finished, which is exactly what the hedge exists
     * to route around. The server hands both requests the same answer, so the
     * second may save the handle without the lock.
     */
    private lockHeldFor?;
    private readonly scope;
    constructor(input: HookConversationInput);
    get id(): string | undefined;
    /**
     * Re-reads the cache. Only a valid handle read from it replaces the one held:
     * a hook's calls run side by side, and a read that started before another's
     * save renamed the file (or one that fails) must not drop the handle, or the
     * call reaches the server without it. forget() is the one way to drop it.
     */
    load(): Promise<string | undefined>;
    private read;
    private locked;
    private save;
    /** Existing authenticated response is the acquisition; no additional endpoint. */
    request(url: string, init: HookFetchInit, post: (init: HookFetchInit) => Promise<Response>): Promise<Response>;
    private forget;
    /** Grok adopts only an authenticated explicit-bootstrap tool result. */
    adopt(result: unknown): Promise<void>;
}
export declare function configureHookConversation(input: HookConversationInput): Promise<void>;
export declare function currentConversationId(): string | undefined;
export declare function conversationMarker(): string | undefined;
export declare function adoptHookConversation(result: unknown): Promise<void>;
export declare function withHookConversation(url: string, init: HookFetchInit, post: (init: HookFetchInit) => Promise<Response>): Promise<Response>;
export {};
//# sourceMappingURL=hookConversation.d.ts.map