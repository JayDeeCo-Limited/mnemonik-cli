import { type StoredAuthorization } from './storedAuthorization.js';
/**
 * What Codex itself holds for Mnemonik's MCP server on this computer.
 *
 * Until 2026-10-13 Codex's authorization came from the server's record alone,
 * so the false "authorized" seen for Claude Code on 2026-10-12 could happen for
 * Codex too. Read the way Codex 0.162.1 reads it (codex-rs/rmcp-client/src/oauth.rs,
 * resolved_store.rs; codex-rs/config/src/types.rs):
 *
 * - Where: `mcp_oauth_credentials_store` at the top of $CODEX_HOME/config.toml
 *   (CODEX_HOME defaults to ~/.codex): `auto` (the default) tries the
 *   operating system's keyring first and falls back to the file; `file` uses
 *   $CODEX_HOME/.credentials.json only; `keyring` uses the keyring only. The
 *   keyring (macOS Keychain, Windows Credential Manager, the Secret Service on
 *   Linux) is never read here: that store is said to be unchecked.
 * - The file is a JSON object of entries keyed `mnemonik|` and the first 16
 *   hex characters of the SHA-256 of `{"type":"http","url":<url>,"headers":{}}`
 *   (codexCredentialKey; headers are always empty in the key, whatever the
 *   declaration sends). For a plain server name Codex finds the entry by its
 *   `server_name` and `server_url`, in key order, skipping executor-owned ones.
 * - `auto` with an entry in the file: Codex wrote it there because its keyring
 *   failed, and it removes the file entry whenever a keyring save succeeds, so
 *   the file entry is the one it uses. `auto` with nothing in the file: on macOS
 *   and Windows the keyring holds it (unchecked); on Linux it can only be in a
 *   Secret Service keyring, so when this user has none, Codex holds nothing.
 * - Usable as Codex judges it (oauth_tokens_are_usable): a client id; then an
 *   access token that does not expire within 30 seconds, or else a refresh
 *   token together with the issuer it is bound to.
 *
 * Only key names, presence and `expires_at` are looked at.
 */
export interface CodexStoreOptions {
    home: string;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    now?: () => number;
}
/** Codex's key for a server's stored authorization (compute_store_key). */
export declare function codexCredentialKey(name: string, url: string): string;
/** One file entry, judged as Codex judges it when it connects. */
export declare function codexEntryState(entry: Record<string, unknown>, now: number): StoredAuthorization;
/**
 * Codex's stored Mnemonik authorization on this computer, or undefined when
 * Codex has no Mnemonik HTTP declaration that authorizes with OAuth here.
 */
export declare function codexStoredAuthorization(options: CodexStoreOptions): Promise<StoredAuthorization | undefined>;
//# sourceMappingURL=codexAuthorization.d.ts.map