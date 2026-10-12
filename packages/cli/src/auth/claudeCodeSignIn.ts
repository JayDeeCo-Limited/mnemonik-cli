import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';

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

/** `security find-generic-password` exit code for an item that does not exist. */
const KEYCHAIN_ITEM_NOT_FOUND = 44;
export const CLAUDE_CODE_KEYCHAIN_SERVICE = 'Claude Code-credentials';

export type KeychainRead = (
  service: string,
  account: string
) => Promise<{ code: number | null; stdout: string }>;

export interface ClaudeCodeStoreOptions {
  home: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** The macOS Keychain read; /usr/bin/security by default. */
  keychain?: KeychainRead;
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const present = (value: unknown) => typeof value === 'string' && value.length > 0;

const readKeychain: KeychainRead = (service, account) =>
  new Promise((resolve) => {
    execFile(
      '/usr/bin/security',
      ['find-generic-password', '-a', account, '-w', '-s', service],
      { encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout) =>
        resolve(
          error
            ? { code: typeof error.code === 'number' ? error.code : null, stdout: '' }
            : { code: 0, stdout }
        )
    );
  });

/** Claude Code's Keychain account: $USER, else the login name, if it is a plain name. */
function keychainAccount(env: NodeJS.ProcessEnv) {
  let name: string | undefined;
  try {
    name = env.USER || userInfo().username;
  } catch {
    name = undefined;
  }
  return name && /^[a-zA-Z0-9._-]+$/u.test(name) ? name : 'claude-code-user';
}

function parse(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return object(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The credential document, null when Claude Code holds none, undefined when unreadable. */
async function credentialDocument(
  options: Required<Omit<ClaudeCodeStoreOptions, 'now'>>,
  config: Record<string, unknown>
): Promise<Record<string, unknown> | null | undefined> {
  const { env, home, platform } = options;
  if (platform === 'darwin') {
    const item = await options
      .keychain(CLAUDE_CODE_KEYCHAIN_SERVICE, keychainAccount(env))
      .catch(() => undefined);
    if (!item) return undefined;
    if (item.code === 0) return parse(item.stdout.trim());
    // A locked or unavailable Keychain says nothing about what it holds.
    if (item.code !== KEYCHAIN_ITEM_NOT_FOUND) return undefined;
  }
  if (
    platform === 'win32' &&
    (env.CLAUDE_CODE_FORCE_WINDOWS_CREDMAN === '1' ||
      (object(config.cachedGrowthBookFeatures) &&
        config.cachedGrowthBookFeatures.tengu_windows_credman === true))
  )
    return undefined;
  let text: string;
  try {
    text = await readFile(join(home, '.claude', '.credentials.json'), 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined;
  }
  return parse(text);
}

/** Claude Code's key for a server's stored sign-in (its `zl(name, config)`). */
export function claudeCodeCredentialKey(
  name: string,
  declaration: { type: string; url: string; headers?: unknown }
): string {
  const type = declaration.type === 'streamable-http' ? 'http' : declaration.type;
  const digest = createHash('sha256')
    .update(JSON.stringify({ type, url: declaration.url, headers: declaration.headers || {} }))
    .digest('hex');
  return `${name}|${digest.slice(0, 16)}`;
}

/** One stored entry, judged as Claude Code judges it when it connects. */
export function storedSignInState(entry: unknown, now: number): StoredSignIn {
  if (!object(entry) || (!present(entry.accessToken) && !present(entry.refreshToken)))
    return { state: 'missing', expiresAt: null };
  const expires =
    typeof entry.expiresAt === 'number' && Number.isFinite(entry.expiresAt)
      ? entry.expiresAt
      : undefined;
  const expiresAt = expires === undefined ? null : new Date(expires).toISOString();
  if (present(entry.accessToken) && (expires === undefined || expires > now))
    return { state: 'signed_in', expiresAt };
  // An expired access token with nothing to renew it is one Claude Code asks to replace.
  return { state: present(entry.refreshToken) ? 'refreshable' : 'missing', expiresAt };
}

/**
 * Claude Code's stored Mnemonik sign-in on this computer, or undefined when
 * Claude Code has no Mnemonik HTTP declaration that signs in with OAuth here.
 */
export async function claudeCodeStoredSignIn(
  options: ClaudeCodeStoreOptions
): Promise<StoredSignIn | undefined> {
  const env = options.env ?? process.env;
  const raw = await readFile(join(options.home, '.claude.json'), 'utf8').catch(() => undefined);
  const config = raw === undefined ? undefined : parse(raw);
  const declaration = object(config?.mcpServers) ? config.mcpServers.mnemonik : undefined;
  if (
    !config ||
    !object(declaration) ||
    typeof declaration.url !== 'string' ||
    typeof declaration.type !== 'string' ||
    !['http', 'streamable-http', 'sse'].includes(declaration.type)
  )
    return undefined;
  // A declaration that carries its own credentials does not use Claude Code's sign-in.
  if (
    declaration.headersHelper !== undefined ||
    (object(declaration.headers) &&
      Object.keys(declaration.headers).some((name) => name.toLowerCase() === 'authorization'))
  )
    return undefined;
  const unreadable: StoredSignIn = { state: 'unreadable', expiresAt: null };
  // Claude Code would keep its credentials somewhere other than the defaults.
  if (env.CLAUDE_CONFIG_DIR || env.CLAUDE_SECURESTORAGE_CONFIG_DIR !== undefined) return unreadable;
  const document = await credentialDocument(
    {
      home: options.home,
      env,
      platform: options.platform ?? process.platform,
      keychain: options.keychain ?? readKeychain,
    },
    config
  );
  if (document === undefined) return unreadable;
  const entries = object(document?.mcpOAuth) ? document.mcpOAuth : {};
  const key = claudeCodeCredentialKey('mnemonik', {
    type: declaration.type,
    url: declaration.url,
    headers: declaration.headers,
  });
  return storedSignInState(entries[key], (options.now ?? Date.now)());
}
