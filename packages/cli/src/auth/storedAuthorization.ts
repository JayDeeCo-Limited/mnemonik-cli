/**
 * What a coding tool itself keeps on this computer for Mnemonik's MCP server,
 * read the way the tool reads it, by key names, presence and expiry only.
 * Token values are never returned, printed or logged, and a parse error (whose
 * message can quote the input) is never passed on.
 *
 * - `authorized`: an access token that has not expired, or (Cursor, whose
 *   tokens are encrypted) a stored token whose expiry cannot be read.
 * - `renewable`: the access token has expired or is gone, and the tool renews
 *   it with its refresh token the next time it connects.
 * - `missing`: nothing the tool can use; it asks for authorization again.
 * - `unreadable`: the store could not be read; `reason` says why.
 */
export type StoredState = 'authorized' | 'renewable' | 'missing' | 'unreadable';

/** Why a tool's store could not be read on this computer. */
export type UnreadableReason =
  /** macOS Keychain locked with no way to ask for it in this session (exit 36: over SSH). */
  | 'keychain_locked'
  /** macOS Keychain answered with anything else, or not at all. */
  | 'keychain_unreadable'
  /** The tool keeps it in Windows Credential Manager (Claude Code when told to; Codex's keyring). */
  | 'credential_manager'
  /** Codex keeps its MCP authorizations in the macOS Keychain (its keyring on macOS). */
  | 'macos_keychain'
  /** Codex keeps them in a Secret Service keyring (its keyring on Linux). */
  | 'system_keyring'
  /** CLAUDE_CONFIG_DIR or CLAUDE_SECURESTORAGE_CONFIG_DIR moves Claude Code's files. */
  | 'custom_folder'
  /** The tool's credentials file exists but could not be read or parsed. */
  | 'file_unreadable'
  /** Cursor's settings database could not be read. */
  | 'database_unreadable'
  /** Cursor runs on another computer and opens this one remotely; its store is there. */
  | 'remote'
  /** The tool's own settings are not on this computer. */
  | 'not_on_this_computer';

export interface StoredAuthorization {
  state: StoredState;
  /** When the stored access token expires or expired; null when unknown or unreadable. */
  expiresAt: string | null;
  /** Present when `state` is `unreadable`. */
  reason?: UnreadableReason;
}

export const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** A non-empty string after trimming, the test each tool applies to a token field. */
export const present = (value: unknown): boolean =>
  typeof value === 'string' && value.trim().length > 0;

/** JSON text as an object, or undefined; the parse error is dropped because it can quote the input. */
export function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return object(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export const unreadable = (reason: UnreadableReason): StoredAuthorization => ({
  state: 'unreadable',
  expiresAt: null,
  reason,
});
