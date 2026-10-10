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
}
export declare class HookConversation {
    private readonly input;
    private conversationId?;
    private readonly scope;
    constructor(input: HookConversationInput);
    get id(): string | undefined;
    load(): Promise<string | undefined>;
    private locked;
    private save;
    /** Existing authenticated response is the acquisition; no additional endpoint. */
    request(url: string, init: HookFetchInit, post: (init: HookFetchInit) => Promise<Response>): Promise<Response>;
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