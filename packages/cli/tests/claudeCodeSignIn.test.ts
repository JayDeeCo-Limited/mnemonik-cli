import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_CODE_KEYCHAIN_SERVICE,
  claudeCodeCredentialKey,
  claudeCodeStoredAuthorization,
  type ClaudeCodeStoreOptions,
  type KeychainRead,
} from '../src/auth/claudeCodeSignIn.js';

// 2026-10-12: a network outage emptied Claude Code's stored Mnemonik
// authorization while the server still held a valid grant, and status said
// signed in. Claude Code's own store is read here, by key names only.

const NOW = Date.parse('2026-10-12T10:00:00.000Z');
const HOUR = 3_600_000;
const INSTALLATION = 'c8553445-83f4-47f6-a84d-4eb7804eb6e6';
const declaration = {
  type: 'http',
  url: 'https://api.mnemonik.dev/mcp',
  headers: { 'x-mnemonik-installation-id': INSTALLATION },
};
// Observed in Claude Code 2.1.296's own ~/.claude/.credentials.json for exactly this declaration.
const KEY = 'mnemonik|7aea917cc798c31f';
// Stand-ins for token values: none of them may ever appear in a result.
const ACCESS = 'access-token-value-never-shown';
const REFRESH = 'refresh-token-value-never-shown';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function machine(server: unknown = declaration, extra: Record<string, unknown> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'claude-code-sign-in-'));
  homes.push(home);
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({ ...extra, mcpServers: server ? { mnemonik: server } : {} })
  );
  const credentials = (document: unknown) => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(
      join(home, '.claude', '.credentials.json'),
      typeof document === 'string' ? document : JSON.stringify(document)
    );
  };
  const read = (options: Partial<ClaudeCodeStoreOptions> = {}) =>
    claudeCodeStoredAuthorization({
      home,
      platform: 'linux',
      env: {},
      now: () => NOW,
      ...options,
    });
  return { home, credentials, read };
}

const entry = (fields: Record<string, unknown>) => ({
  serverName: 'mnemonik',
  serverUrl: 'https://api.mnemonik.dev/mcp',
  clientId: 'https://claude.ai/oauth/claude-code-client-metadata',
  ...fields,
});
const document = (fields: Record<string, unknown>, key = KEY) => ({
  claudeAiOauth: { accessToken: 'claude-ai-token-never-shown' },
  mcpOAuth: { [key]: entry(fields) },
});
const neverShown = (value: unknown) =>
  expect(JSON.stringify(value)).not.toMatch(/never-shown|access-token|refresh-token/u);

describe('the stored authorization Claude Code keys by its declaration', () => {
  it('is the key Claude Code itself uses', () => {
    expect(claudeCodeCredentialKey('mnemonik', declaration)).toBe(KEY);
    // Claude Code reads streamable-http as http before keying.
    expect(claudeCodeCredentialKey('mnemonik', { ...declaration, type: 'streamable-http' })).toBe(
      KEY
    );
    // Other headers are another declaration, with a sign-in of its own.
    expect(claudeCodeCredentialKey('mnemonik', { ...declaration, headers: {} })).not.toBe(KEY);
  });
});

describe('Claude Code stored authorization states, from its credentials file', () => {
  it('authorized: an access token that has not expired', async () => {
    const m = machine();
    m.credentials(document({ accessToken: ACCESS, refreshToken: REFRESH, expiresAt: NOW + HOUR }));
    const stored = await m.read();
    expect(stored).toEqual({
      state: 'authorized',
      expiresAt: new Date(NOW + HOUR).toISOString(),
    });
    neverShown(stored);
  });

  it('renewable: the access token expired and Claude Code renews it the next time it connects', async () => {
    const m = machine();
    m.credentials(
      document({ accessToken: ACCESS, refreshToken: REFRESH, expiresAt: NOW - 45 * HOUR })
    );
    expect(await m.read()).toEqual({
      state: 'renewable',
      expiresAt: new Date(NOW - 45 * HOUR).toISOString(),
    });
    m.credentials(document({ accessToken: '', refreshToken: REFRESH }));
    expect(await m.read()).toEqual({ state: 'renewable', expiresAt: null });
  });

  it('missing: the entry the 2026-10-12 outage left, with no access or refresh token', async () => {
    const m = machine();
    m.credentials(
      document({
        accessToken: '',
        redirectUri: 'http://localhost:43117/callback',
        discoveryState: { oauthMetadataFound: true },
      })
    );
    const stored = await m.read();
    expect(stored).toEqual({ state: 'missing', expiresAt: null });
    neverShown(stored);
  });

  it('missing: an expired access token with nothing to renew it', async () => {
    const m = machine();
    m.credentials(document({ accessToken: ACCESS, expiresAt: NOW - HOUR }));
    expect(await m.read()).toEqual({
      state: 'missing',
      expiresAt: new Date(NOW - HOUR).toISOString(),
    });
  });

  it('missing: no entry for this declaration, only one for older headers', async () => {
    const m = machine();
    const older = claudeCodeCredentialKey('mnemonik', { ...declaration, headers: {} });
    m.credentials(document({ accessToken: ACCESS, refreshToken: REFRESH }, older));
    expect(await m.read()).toEqual({ state: 'missing', expiresAt: null });
    m.credentials({ mcpOAuth: {} });
    expect(await m.read()).toEqual({ state: 'missing', expiresAt: null });
  });

  it('missing: no credentials file at all', async () => {
    expect(await machine().read()).toEqual({ state: 'missing', expiresAt: null });
  });

  it('unreadable: a file that is not JSON, or not a file, claims nothing and says why', async () => {
    const m = machine();
    m.credentials(`{"mcpOAuth": {"${KEY}": {"accessToken": "${ACCESS}"`);
    const stored = await m.read();
    expect(stored).toEqual({ state: 'unreadable', expiresAt: null, reason: 'file_unreadable' });
    neverShown(stored);
    const n = machine();
    mkdirSync(join(n.home, '.claude', '.credentials.json'), { recursive: true });
    expect(await n.read()).toEqual({
      state: 'unreadable',
      expiresAt: null,
      reason: 'file_unreadable',
    });
  });

  it('unreadable: Claude Code configured to keep its credentials elsewhere', async () => {
    const m = machine();
    m.credentials(document({ accessToken: ACCESS }));
    expect(await m.read({ env: { CLAUDE_CONFIG_DIR: '/elsewhere' } })).toEqual({
      state: 'unreadable',
      expiresAt: null,
      reason: 'custom_folder',
    });
    expect(await m.read({ env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '' } })).toEqual({
      state: 'unreadable',
      expiresAt: null,
      reason: 'custom_folder',
    });
  });

  it('nothing to read: no Mnemonik HTTP declaration that authorizes with OAuth', async () => {
    expect(await machine(null).read()).toBeUndefined();
    expect(await machine({ url: declaration.url }).read()).toBeUndefined();
    expect(await machine({ type: 'stdio', command: 'mnemonik' }).read()).toBeUndefined();
    expect(
      await machine({ ...declaration, headers: { Authorization: 'Bearer x' } }).read()
    ).toBeUndefined();
  });
});

describe('macOS: the login Keychain first, the file only when it holds no item', () => {
  const keychain = (result: { code: number | null; stdout: string }) => {
    const calls: Array<[string, string]> = [];
    const read: KeychainRead = async (service, account) => {
      calls.push([service, account]);
      return result;
    };
    return { calls, read };
  };

  it('reads Claude Code-credentials for $USER and judges the item it holds', async () => {
    const m = machine();
    // A stale file beside a Keychain item is not what Claude Code reads.
    m.credentials(document({ accessToken: ACCESS, refreshToken: REFRESH }));
    const item = keychain({
      code: 0,
      stdout: `${JSON.stringify(document({ accessToken: '' }))}\n`,
    });
    const stored = await m.read({
      platform: 'darwin',
      env: { USER: 'owner' },
      keychain: item.read,
    });
    expect(stored).toEqual({ state: 'missing', expiresAt: null });
    expect(item.calls).toEqual([[CLAUDE_CODE_KEYCHAIN_SERVICE, 'owner']]);
    expect(CLAUDE_CODE_KEYCHAIN_SERVICE).toBe('Claude Code-credentials');
    neverShown(stored);
  });

  it('no Keychain item (exit 44): the credentials file, as Claude Code falls back', async () => {
    const m = machine();
    m.credentials(document({ accessToken: ACCESS, refreshToken: REFRESH, expiresAt: NOW + HOUR }));
    const item = keychain({ code: 44, stdout: '' });
    expect(
      await m.read({ platform: 'darwin', env: { USER: 'owner' }, keychain: item.read })
    ).toMatchObject({ state: 'authorized' });
    expect(
      await machine().read({ platform: 'darwin', env: { USER: 'owner' }, keychain: item.read })
    ).toEqual({ state: 'missing', expiresAt: null });
  });

  it('a locked or unavailable Keychain claims nothing, and says which', async () => {
    const m = machine();
    m.credentials(document({ accessToken: ACCESS }));
    for (const [result, reason] of [
      // Over SSH: errSecInteractionNotAllowed, the 2026-10-12 Mac case.
      [{ code: 36, stdout: '' }, 'keychain_locked'],
      [{ code: 51, stdout: '' }, 'keychain_unreadable'],
      [{ code: null, stdout: '' }, 'keychain_unreadable'],
      [{ code: 0, stdout: 'not json' }, 'keychain_unreadable'],
    ] as const)
      expect(
        await m.read({
          platform: 'darwin',
          env: { USER: 'owner' },
          keychain: keychain(result).read,
        })
      ).toEqual({ state: 'unreadable', expiresAt: null, reason });
    const thrown: KeychainRead = async () => {
      throw new Error('spawn failed');
    };
    expect(await m.read({ platform: 'darwin', env: { USER: 'owner' }, keychain: thrown })).toEqual({
      state: 'unreadable',
      expiresAt: null,
      reason: 'keychain_unreadable',
    });
  });

  it('an account name Claude Code would not use becomes claude-code-user', async () => {
    const item = keychain({ code: 44, stdout: '' });
    await machine().read({ platform: 'darwin', env: { USER: 'Jane Doe' }, keychain: item.read });
    expect(item.calls).toEqual([[CLAUDE_CODE_KEYCHAIN_SERVICE, 'claude-code-user']]);
  });
});

describe('Windows: the credentials file unless Credential Manager holds the authorization', () => {
  it('reads the file by default', async () => {
    const m = machine();
    m.credentials(document({ accessToken: '', refreshToken: REFRESH }));
    expect(await m.read({ platform: 'win32' })).toEqual({ state: 'renewable', expiresAt: null });
  });

  it('Credential Manager in use: claims nothing, and says so', async () => {
    const forced = machine();
    expect(
      await forced.read({ platform: 'win32', env: { CLAUDE_CODE_FORCE_WINDOWS_CREDMAN: '1' } })
    ).toEqual({ state: 'unreadable', expiresAt: null, reason: 'credential_manager' });
    const flagged = machine(declaration, {
      cachedGrowthBookFeatures: { tengu_windows_credman: true },
    });
    expect(await flagged.read({ platform: 'win32' })).toEqual({
      state: 'unreadable',
      expiresAt: null,
      reason: 'credential_manager',
    });
  });
});
