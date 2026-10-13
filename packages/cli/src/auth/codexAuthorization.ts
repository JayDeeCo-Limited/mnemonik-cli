import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import {
  object,
  parseObject,
  present,
  unreadable,
  type StoredAuthorization,
} from './storedAuthorization.js';

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

/** Codex refreshes an access token this long before it expires (REFRESH_SKEW_MILLIS). */
const REFRESH_SKEW_MS = 30_000;

/** Codex's key for a server's stored authorization (compute_store_key). */
export function codexCredentialKey(name: string, url: string): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({ type: 'http', url, headers: {} }))
    .digest('hex');
  return `${name}|${digest.slice(0, 16)}`;
}

/** One file entry, judged as Codex judges it when it connects. */
export function codexEntryState(entry: Record<string, unknown>, now: number): StoredAuthorization {
  const expires =
    typeof entry.expires_at === 'number' && Number.isFinite(entry.expires_at)
      ? entry.expires_at
      : undefined;
  const expiresAt = expires === undefined ? null : new Date(expires).toISOString();
  if (!present(entry.client_id)) return { state: 'missing', expiresAt };
  if (expires !== undefined && now + REFRESH_SKEW_MS >= expires)
    return {
      state: present(entry.issuer) && present(entry.refresh_token) ? 'renewable' : 'missing',
      expiresAt,
    };
  return { state: present(entry.access_token) ? 'authorized' : 'missing', expiresAt };
}

/** Whether this Linux user has a Secret Service keyring Codex could have written to. */
async function secretServiceKeyring(home: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const data = env.XDG_DATA_HOME || join(home, '.local', 'share');
  const found = await Promise.all(
    ['keyrings', 'kwalletd'].map((dir) =>
      stat(join(data, dir)).then(
        (entry) => entry.isDirectory(),
        () => false
      )
    )
  );
  return found.some(Boolean);
}

/**
 * Codex's stored Mnemonik authorization on this computer, or undefined when
 * Codex has no Mnemonik HTTP declaration that authorizes with OAuth here.
 */
export async function codexStoredAuthorization(
  options: CodexStoreOptions
): Promise<StoredAuthorization | undefined> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const codexHome = env.CODEX_HOME || join(options.home, '.codex');
  const raw = await readFile(join(codexHome, 'config.toml'), 'utf8').catch(() => undefined);
  let config: Record<string, unknown>;
  try {
    config = raw === undefined ? {} : (parseToml(raw) as Record<string, unknown>);
  } catch {
    return undefined;
  }
  const declaration = object(config.mcp_servers) ? config.mcp_servers.mnemonik : undefined;
  if (!object(declaration) || typeof declaration.url !== 'string') return undefined;
  // A declaration that sends its own bearer token does not use Codex's OAuth store.
  if (
    declaration.bearer_token_env_var !== undefined ||
    declaration.bearer_token !== undefined ||
    (object(declaration.http_headers) &&
      Object.keys(declaration.http_headers).some((name) => name.toLowerCase() === 'authorization'))
  )
    return undefined;
  const url = declaration.url;
  const mode = config.mcp_oauth_credentials_store ?? 'auto';
  // Codex's keyring on each system, said by name.
  const keyring = unreadable(
    platform === 'darwin'
      ? 'macos_keychain'
      : platform === 'win32'
        ? 'credential_manager'
        : 'system_keyring'
  );
  if (mode === 'keyring') return keyring;
  let text: string | undefined;
  try {
    text = await readFile(join(codexHome, '.credentials.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return unreadable('file_unreadable');
  }
  const file = text === undefined ? {} : parseObject(text);
  if (!file) return unreadable('file_unreadable');
  const entry = Object.keys(file)
    .sort()
    .map((key) => file[key])
    .find(
      (candidate): candidate is Record<string, unknown> =>
        object(candidate) &&
        candidate.executor_owned !== true &&
        candidate.server_url === url &&
        candidate.server_name === 'mnemonik'
    );
  const now = (options.now ?? Date.now)();
  if (entry) return codexEntryState(entry, now);
  if (mode === 'file') return { state: 'missing', expiresAt: null };
  // `auto` with nothing in the file: the keyring may hold it.
  if (platform === 'linux' && !(await secretServiceKeyring(options.home, env)))
    return { state: 'missing', expiresAt: null };
  return keyring;
}
