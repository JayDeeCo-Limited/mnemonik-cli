import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  codexCredentialKey,
  codexStoredAuthorization,
  type CodexStoreOptions,
} from '../src/auth/codexAuthorization.js';

// Codex's MCP authorization came from the server's record alone, so the false
// "authorized" Claude Code showed on 2026-10-12 could happen for Codex too.
// Codex's own store is read here the way Codex 0.162.1 reads it, by key names
// and expiry only.

const NOW = Date.parse('2026-10-13T00:00:00.000Z');
const HOUR = 3_600_000;
const URL = 'https://api.mnemonik.dev/mcp';
// The key Codex 0.162.1 wrote for exactly this URL in a real ~/.codex/.credentials.json.
const KEY = 'mnemonik|ba9709ce6018a6e4';
const ACCESS = 'access-token-value-never-shown';
const REFRESH = 'refresh-token-value-never-shown';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function machine(config = `[mcp_servers.mnemonik]\nurl = "${URL}"\n`, codexHome = '.codex') {
  const home = mkdtempSync(join(tmpdir(), 'codex-authorization-'));
  homes.push(home);
  mkdirSync(join(home, codexHome), { recursive: true });
  writeFileSync(join(home, codexHome, 'config.toml'), config);
  const credentials = (document: unknown) =>
    writeFileSync(
      join(home, codexHome, '.credentials.json'),
      typeof document === 'string' ? document : JSON.stringify(document)
    );
  const read = (options: Partial<CodexStoreOptions> = {}) =>
    codexStoredAuthorization({ home, platform: 'linux', env: {}, now: () => NOW, ...options });
  return { home, credentials, read };
}

const entry = (fields: Record<string, unknown>) => ({
  server_name: 'mnemonik',
  server_url: URL,
  client_id: 'client-from-registration',
  issuer: 'https://auth.mnemonik.ai',
  scopes: ['mcp:use'],
  ...fields,
});
const neverShown = (value: unknown) =>
  expect(JSON.stringify(value)).not.toMatch(/never-shown|access-token|refresh-token/u);

describe("the key Codex stores Mnemonik's authorization under", () => {
  it('is sha256 of {type, url, headers: {}}, whatever headers the declaration sends', () => {
    expect(codexCredentialKey('mnemonik', URL)).toBe(KEY);
    // Another URL, as Codex keyed it as a macOS Keychain account.
    expect(codexCredentialKey('mnemonik', 'https://mnemonik-api.devops.jaydeeco.com/mcp')).toBe(
      'mnemonik|258cc76b7f95089e'
    );
  });
});

describe('Codex stored authorization states, from its credentials file', () => {
  it('authorized: an access token that does not expire within 30 seconds', async () => {
    const m = machine();
    m.credentials({
      [KEY]: entry({ access_token: ACCESS, refresh_token: REFRESH, expires_at: NOW + HOUR }),
    });
    const stored = await m.read();
    expect(stored).toEqual({ state: 'authorized', expiresAt: new Date(NOW + HOUR).toISOString() });
    neverShown(stored);
    m.credentials({ [KEY]: entry({ access_token: ACCESS }) });
    expect(await m.read()).toEqual({ state: 'authorized', expiresAt: null });
  });

  it('renewable: expired, or about to, with a refresh token and its issuer', async () => {
    const m = machine();
    m.credentials({
      [KEY]: entry({ access_token: ACCESS, refresh_token: REFRESH, expires_at: NOW - 14 * HOUR }),
    });
    expect(await m.read()).toEqual({
      state: 'renewable',
      expiresAt: new Date(NOW - 14 * HOUR).toISOString(),
    });
    m.credentials({
      [KEY]: entry({ access_token: ACCESS, refresh_token: REFRESH, expires_at: NOW + 10_000 }),
    });
    expect(await m.read()).toMatchObject({ state: 'renewable' });
  });

  it('missing: what Codex itself would ask to authorize again', async () => {
    const m = machine();
    for (const fields of [
      // Expired with no refresh token, or a refresh token not bound to an issuer.
      { access_token: ACCESS, expires_at: NOW - HOUR },
      { access_token: ACCESS, refresh_token: REFRESH, issuer: '', expires_at: NOW - HOUR },
      // No client id, or no access token.
      { access_token: ACCESS, client_id: ' ' },
      { access_token: '' },
    ]) {
      m.credentials({ [KEY]: entry(fields) });
      expect(await m.read()).toMatchObject({ state: 'missing' });
    }
  });

  it('missing: no entry for Mnemonik at this URL, or only one owned by an executor', async () => {
    const m = machine();
    m.credentials({
      'sentry|800cb29a3ac61727': entry({ server_name: 'sentry', access_token: ACCESS }),
      'mnemonik|0000000000000000': entry({
        server_url: 'https://staging.example.test/mcp',
        access_token: ACCESS,
      }),
      'executor:mnemonik|1111111111111111': entry({ access_token: ACCESS, executor_owned: true }),
    });
    expect(await m.read({ env: {}, platform: 'linux' })).toEqual({
      state: 'missing',
      expiresAt: null,
    });
  });

  it('finds the entry by server name and URL, as Codex does, under any key', async () => {
    const m = machine();
    m.credentials({ 'mnemonik|written-by-an-older-codex': entry({ access_token: ACCESS }) });
    expect(await m.read()).toMatchObject({ state: 'authorized' });
  });

  it('reads CODEX_HOME when it is set', async () => {
    const m = machine(undefined, 'codex-home');
    m.credentials({ [KEY]: entry({ access_token: ACCESS }) });
    expect(await m.read({ env: { CODEX_HOME: join(m.home, 'codex-home') } })).toMatchObject({
      state: 'authorized',
    });
  });

  it('unreadable: a credentials file that is not JSON, or not a file', async () => {
    const m = machine();
    m.credentials(`{"${KEY}": {"access_token": "${ACCESS}"`);
    const stored = await m.read();
    expect(stored).toEqual({ state: 'unreadable', expiresAt: null, reason: 'file_unreadable' });
    neverShown(stored);
    const n = machine();
    mkdirSync(join(n.home, '.codex', '.credentials.json'));
    expect(await n.read()).toMatchObject({ reason: 'file_unreadable' });
  });
});

describe('where Codex keeps it: mcp_oauth_credentials_store', () => {
  const declaration = `[mcp_servers.mnemonik]\nurl = "${URL}"\n`;

  it('keyring: not read here, and said so, by the name of each system keyring', async () => {
    const m = machine(`mcp_oauth_credentials_store = "keyring"\n${declaration}`);
    m.credentials({ [KEY]: entry({ access_token: ACCESS }) });
    for (const [platform, reason] of [
      ['linux', 'system_keyring'],
      ['darwin', 'macos_keychain'],
      ['win32', 'credential_manager'],
    ] as const)
      expect(await m.read({ platform })).toEqual({ state: 'unreadable', expiresAt: null, reason });
  });

  it('file: the file alone; nothing there is nothing held', async () => {
    const m = machine(`mcp_oauth_credentials_store = "file"\n${declaration}`);
    expect(await m.read({ platform: 'darwin' })).toEqual({ state: 'missing', expiresAt: null });
    m.credentials({ [KEY]: entry({ access_token: ACCESS }) });
    expect(await m.read({ platform: 'darwin' })).toMatchObject({ state: 'authorized' });
  });

  it('auto, an entry in the file: the one Codex uses, on any system', async () => {
    const m = machine();
    m.credentials({ [KEY]: entry({ access_token: ACCESS }) });
    for (const platform of ['linux', 'darwin', 'win32'] as const)
      expect(await m.read({ platform })).toMatchObject({ state: 'authorized' });
  });

  it('auto, nothing in the file: the keyring may hold it on macOS and Windows', async () => {
    const m = machine();
    expect(await m.read({ platform: 'darwin' })).toEqual({
      state: 'unreadable',
      expiresAt: null,
      reason: 'macos_keychain',
    });
    expect(await m.read({ platform: 'win32' })).toMatchObject({ reason: 'credential_manager' });
  });

  it('auto, nothing in the file, Linux: held nowhere unless this user has a Secret Service keyring', async () => {
    const m = machine();
    expect(await m.read()).toEqual({ state: 'missing', expiresAt: null });
    mkdirSync(join(m.home, '.local', 'share', 'keyrings'), { recursive: true });
    expect(await m.read()).toEqual({
      state: 'unreadable',
      expiresAt: null,
      reason: 'system_keyring',
    });
    const n = machine();
    mkdirSync(join(n.home, 'data', 'kwalletd'), { recursive: true });
    expect(await n.read({ env: { XDG_DATA_HOME: join(n.home, 'data') } })).toMatchObject({
      reason: 'system_keyring',
    });
  });
});

describe('nothing to read', () => {
  it('no Mnemonik HTTP declaration that authorizes with OAuth', async () => {
    expect(await machine('').read()).toBeUndefined();
    expect(await machine('[mcp_servers.mnemonik]\ncommand = "mnemonik"\n').read()).toBeUndefined();
    expect(
      await machine(
        `[mcp_servers.mnemonik]\nurl = "${URL}"\nbearer_token_env_var = "MNEMONIK_TOKEN"\n`
      ).read()
    ).toBeUndefined();
    expect(
      await machine(
        `[mcp_servers.mnemonik]\nurl = "${URL}"\nhttp_headers = { Authorization = "Bearer x" }\n`
      ).read()
    ).toBeUndefined();
    expect(await machine('not = [toml').read()).toBeUndefined();
  });

  it('a declaration that sends the installation header still authorizes with OAuth', async () => {
    const m = machine(
      `[mcp_servers.mnemonik]\nurl = "${URL}"\nhttp_headers = { "x-mnemonik-installation-id" = "c8553445" }\n`
    );
    m.credentials({ [KEY]: entry({ access_token: ACCESS }) });
    expect(await m.read()).toMatchObject({ state: 'authorized' });
  });
});
