/**
 * What Claude Code itself holds for Mnemonik's MCP server on this computer.
 *
 * On 2026-10-12 a network outage emptied Claude Code's stored Mnemonik sign-in
 * while the server still held a valid grant, and status said signed in. The
 * server's grant says a sign-in exists; only Claude Code's own store says
 * whether Claude Code can use it. Read the way Claude Code 2.1.296 reads it:
 *
 * - The entry is `mcpOAuth["mnemonik|" + sha256(JSON.stringify({type, url,
 *   headers}))[0..16]]`, keyed by the declaration in ~/.claude.json, so a sign-in
 *   stored for an older declaration (other headers) is not this one's.
 * - Linux and Windows keep the document in ~/.claude/.credentials.json; a
 *   missing file means Claude Code holds nothing.
 * - macOS keeps it in the login Keychain, generic password service
 *   `Claude Code-credentials`, account $USER, written and read with
 *   /usr/bin/security; the file is read only when that item does not exist.
 * - Windows uses Credential Manager instead when CLAUDE_CODE_FORCE_WINDOWS_CREDMAN
 *   is 1 or ~/.claude.json caches `tengu_windows_credman: true`; that store is
 *   not read here.
 *
 * Only key names, presence and `expiresAt` are looked at. Token values are never
 * returned, printed or logged, and a parse error (whose message can quote the
 * input) is never passed on.
 */
export type StoredSignInState = 'signed_in' | 'refreshable' | 'missing' | 'unreadable';
export interface StoredSignIn {
    /**
     * `signed_in`: an access token that has not expired. `refreshable`: the access
     * token has expired or is gone, and a refresh token renews it the next time
     * Claude Code connects. `missing`: nothing Claude Code can use; it shows
     * mnemonik as needing authentication. `unreadable`: it could not be read.
     */
    state: StoredSignInState;
    /** When the stored access token expires or expired; null when unknown. */
    expiresAt: string | null;
}
export declare const CLAUDE_CODE_KEYCHAIN_SERVICE = "Claude Code-credentials";
export type KeychainRead = (service: string, account: string) => Promise<{
    code: number | null;
    stdout: string;
}>;
export interface ClaudeCodeStoreOptions {
    home: string;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    now?: () => number;
    /** The macOS Keychain read; /usr/bin/security by default. */
    keychain?: KeychainRead;
}
/** Claude Code's key for a server's stored sign-in (its `zl(name, config)`). */
export declare function claudeCodeCredentialKey(name: string, declaration: {
    type: string;
    url: string;
    headers?: unknown;
}): string;
/** One stored entry, judged as Claude Code judges it when it connects. */
export declare function storedSignInState(entry: unknown, now: number): StoredSignIn;
/**
 * Claude Code's stored Mnemonik sign-in on this computer, or undefined when
 * Claude Code has no Mnemonik HTTP declaration that signs in with OAuth here.
 */
export declare function claudeCodeStoredSignIn(options: ClaudeCodeStoreOptions): Promise<StoredSignIn | undefined>;
//# sourceMappingURL=claudeCodeSignIn.d.ts.map