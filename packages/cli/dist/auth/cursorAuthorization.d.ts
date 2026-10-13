import { type StoredAuthorization } from './storedAuthorization.js';
/**
 * What Cursor itself holds for Mnemonik's MCP server on this computer.
 *
 * Observed on 2026-10-13 with Cursor 3.21.16 on macOS (Cursor Settings,
 * Customize, MCPs; Local, Authenticate and Logout), and read from its
 * McpOAuthStoreMainService and cursor-mcp extension:
 *
 * - Cursor keeps MCP authorizations in its own settings database,
 *   <user data>/User/globalStorage/state.vscdb (SQLite, table ItemTable), not in
 *   ~/.cursor and not as Keychain items of their own. Each token set is one row,
 *   `mcpOAuth.secret.` + base64url(`[<identifier>] mcp_tokens`), whose value is
 *   encrypted with the key in the "Cursor Safe Storage" Keychain item. Authorize
 *   adds the row; Logout deletes it; the Keychain does not change.
 * - For ~/.cursor/mcp.json the identifier is `user-mnemonik`, scoped as
 *   `user-mnemonik::mcpScope:profile:<base64url of the profile name>`. Cursor also
 *   knows `identifier:v1:`/`raw-identifier:v1:` forms of the same identifier, a
 *   `url:<base64url of the server URL>` form shared by URL, and an older copy in
 *   its extension's secret storage (`secret://` and a JSON key naming the same row).
 * - The expiry is inside the encrypted value. Decrypting it would mean reading
 *   the Cursor Safe Storage key from the Keychain, which can prompt, so only the
 *   presence of the row is read: a row means Cursor holds an authorization it
 *   renews with its refresh token, and the server's record says whether that
 *   authorization is still valid.
 * - Cursor holds the database open in WAL mode while it runs; it is opened read
 *   only, and immutable when no write-ahead log exists (Cursor is closed), so
 *   nothing is ever written beside it (databaseKeys).
 * - When Cursor opens this computer over SSH, its authorization lives on the
 *   computer Cursor runs on, and this computer has none of its settings.
 */
export interface CursorStoreOptions {
    home: string;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    /** Lists the database's MCP authorization key names; node:sqlite, read only, by default. */
    listKeys?: (database: string) => Promise<string[]>;
}
/** Cursor's own user-data folder for this platform (Electron's appData plus "Cursor"). */
export declare function cursorUserData(home: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string;
/** Whether one storage key name holds Mnemonik's tokens for this declaration. */
export declare function isMnemonikTokens(name: string, url: string): boolean;
/**
 * Cursor's stored Mnemonik authorization on this computer, or undefined when
 * Cursor has no Mnemonik HTTP declaration that authorizes with OAuth here.
 */
export declare function cursorStoredAuthorization(options: CursorStoreOptions): Promise<StoredAuthorization | undefined>;
//# sourceMappingURL=cursorAuthorization.d.ts.map