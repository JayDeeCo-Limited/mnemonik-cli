import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cursorStoredAuthorization,
  cursorUserData,
  isMnemonikTokens,
  type CursorStoreOptions,
} from '../src/auth/cursorAuthorization.js';

// Cursor keeps MCP authorizations in its settings database, one encrypted row
// per server: Authenticate adds `mcpOAuth.secret.<base64url name>`, Logout
// deletes it (Cursor 3.21.16, observed on macOS on 2026-10-13). Only the row's
// key name is read, never its value.

const URL = 'https://api.mnemonik.dev/mcp';
const SCOPED = '[user-mnemonik::mcpScope:profile:ZGVmYXVsdA] mcp_tokens';
const secretRow = (name: string) => `mcpOAuth.secret.${Buffer.from(name).toString('base64url')}`;
const globalRow = (name: string) => `mcpOAuth.global.${Buffer.from(name).toString('base64url')}`;
/** The rows Cursor keeps beside the tokens, which say nothing about authorization. */
const AROUND = [
  secretRow('[user-mnemonik::mcpScope:profile:ZGVmYXVsdA] mcp_client_information'),
  secretRow('[user-mnemonik::mcpScope:profile:ZGVmYXVsdA] mcp_code_verifier'),
  globalRow('[user-mnemonik::mcpScope:profile:ZGVmYXVsdA] mcp_oauth_updated_at_ms'),
  globalRow('[user-mnemonik::mcpScope:profile:ZGVmYXVsdA] mcp_server_url'),
  secretRow('[plugin-resend-resend::mcpScope:profile:ZGVmYXVsdA] mcp_tokens'),
  'secret://{"extensionId":"vscode.git","key":"git-ipc-auth-token:/tmp/x"}',
];

interface Database {
  exec(sql: string): void;
  prepare(sql: string): { run(...values: unknown[]): unknown };
  close(): void;
}
const SQLITE = 'node:sqlite';
async function database(path: string): Promise<Database> {
  const { DatabaseSync } = (await import(SQLITE)) as {
    DatabaseSync: new (path: string) => Database;
  };
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  return db;
}

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function machine(server: unknown = { url: URL }, platform: NodeJS.Platform = 'linux') {
  const home = mkdtempSync(join(tmpdir(), 'cursor-authorization-'));
  homes.push(home);
  mkdirSync(join(home, '.cursor'));
  writeFileSync(
    join(home, '.cursor', 'mcp.json'),
    JSON.stringify({ mcpServers: server ? { mnemonik: server } : {} })
  );
  const userData = cursorUserData(home, platform, {});
  const path = join(userData, 'User', 'globalStorage', 'state.vscdb');
  const open = async () => {
    mkdirSync(join(userData, 'User', 'globalStorage'), { recursive: true });
    return database(path);
  };
  /** Cursor quits: every change written into the database, nothing beside it. */
  const rows = async (keys: string[]) => {
    const db = await open();
    for (const key of keys)
      db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(key, 'v10never-shown');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
  };
  const read = (options: Partial<CursorStoreOptions> = {}) =>
    cursorStoredAuthorization({ home, platform, env: {}, ...options });
  return { home, path, open, rows, read };
}

describe('Cursor stored authorization states, from its settings database', () => {
  it('authorized: the row Authenticate adds, by its key name alone', async () => {
    const m = machine();
    await m.rows([...AROUND, secretRow(SCOPED)]);
    const stored = await m.read();
    expect(stored).toEqual({ state: 'authorized', expiresAt: null });
    expect(JSON.stringify(stored)).not.toContain('never-shown');
  });

  it('missing: after Logout, with client registration and the rest still there', async () => {
    const m = machine();
    await m.rows(AROUND);
    expect(await m.read()).toEqual({ state: 'missing', expiresAt: null });
  });

  it('missing: Cursor is installed but has never kept anything', async () => {
    const m = machine();
    mkdirSync(cursorUserData(m.home, 'linux', {}), { recursive: true });
    expect(await m.read()).toEqual({ state: 'missing', expiresAt: null });
  });

  it('reads the live database while Cursor holds it open, before anything is checkpointed', async () => {
    const m = machine();
    await m.rows(AROUND);
    const cursor = await m.open();
    cursor
      .prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
      .run(secretRow(SCOPED), 'v10');
    expect(existsSync(`${m.path}-wal`)).toBe(true);
    expect(await m.read()).toMatchObject({ state: 'authorized' });
    // Logout while Cursor runs.
    cursor.prepare('DELETE FROM ItemTable WHERE key = ?').run(secretRow(SCOPED));
    expect(await m.read()).toMatchObject({ state: 'missing' });
    cursor.close();
  });

  it('writes nothing beside a database Cursor has closed', async () => {
    const m = machine();
    await m.rows([secretRow(SCOPED)]);
    expect(await m.read()).toMatchObject({ state: 'authorized' });
    expect(existsSync(`${m.path}-wal`)).toBe(false);
    expect(existsSync(`${m.path}-shm`)).toBe(false);
  });

  it('unreadable: a database that is not one, or that cannot be listed', async () => {
    const m = machine();
    mkdirSync(join(cursorUserData(m.home, 'linux', {}), 'User', 'globalStorage'), {
      recursive: true,
    });
    writeFileSync(m.path, 'not a database');
    expect(await m.read()).toEqual({
      state: 'unreadable',
      expiresAt: null,
      reason: 'database_unreadable',
    });
    rmSync(m.path);
    await m.rows([]);
    expect(
      await m.read({
        listKeys: async () => {
          throw new Error('database is locked');
        },
      })
    ).toMatchObject({ reason: 'database_unreadable' });
  });

  it('not on this computer: Cursor opens it over SSH, or is not installed here', async () => {
    const m = machine();
    expect(await m.read()).toEqual({
      state: 'unreadable',
      expiresAt: null,
      reason: 'not_on_this_computer',
    });
    mkdirSync(join(m.home, '.cursor-server'));
    expect(await m.read()).toEqual({ state: 'unreadable', expiresAt: null, reason: 'remote' });
  });
});

describe('which rows are Mnemonik tokens', () => {
  it('every form Cursor keys them by, and nothing else', () => {
    const identifier = (id: string) =>
      `[identifier:v1:${Buffer.from(id).toString('base64url')}] mcp_tokens`;
    const byUrl = (url: string) => `[url:${Buffer.from(url).toString('base64url')}] mcp_tokens`;
    for (const name of [
      SCOPED,
      '[user-mnemonik] mcp_tokens',
      '[profile:work] [user-mnemonik] mcp_tokens',
      identifier('user-mnemonik::mcpScope:profile:ZGVmYXVsdA'),
      byUrl(URL),
      byUrl(`${URL}/`),
      byUrl('https://API.mnemonik.dev/mcp'),
    ])
      expect(isMnemonikTokens(name, URL), name).toBe(true);
    for (const name of [
      '[user-mnemonik::mcpScope:profile:ZGVmYXVsdA] mcp_client_information',
      '[user-mnemonikx] mcp_tokens',
      '[user-sentry] mcp_tokens',
      '[project-0-repo-mnemonik] mcp_tokens',
      byUrl('https://staging.example.test/mcp'),
      '[oauth-attempt:123] mcp_code_verifier',
    ])
      expect(isMnemonikTokens(name, URL), name).toBe(false);
  });

  it('the older copy in the extension secret storage counts too', async () => {
    const m = machine();
    await m.rows([
      `secret://${JSON.stringify({ extensionId: 'anysphere.cursor-mcp', key: '[user-mnemonik] mcp_tokens' })}`,
    ]);
    expect(await m.read()).toMatchObject({ state: 'authorized' });
  });
});

describe("where Cursor's settings live on each system", () => {
  it('macOS, Windows and Linux user-data folders', () => {
    expect(cursorUserData('/Users/sam', 'darwin', {})).toBe(
      '/Users/sam/Library/Application Support/Cursor'
    );
    expect(cursorUserData('/home/sam', 'linux', {})).toBe('/home/sam/.config/Cursor');
    expect(cursorUserData('/home/sam', 'linux', { XDG_CONFIG_HOME: '/cfg' })).toBe('/cfg/Cursor');
    expect(
      cursorUserData('C:/Users/sam', 'win32', { APPDATA: 'C:/Users/sam/AppData/Roaming' })
    ).toMatch(/AppData[\\/]Roaming[\\/]Cursor$/u);
  });

  it('macOS: the database under Application Support', async () => {
    const m = machine({ url: URL }, 'darwin');
    await m.rows([secretRow(SCOPED)]);
    expect(m.path).toContain(join('Library', 'Application Support', 'Cursor'));
    expect(await m.read()).toMatchObject({ state: 'authorized' });
  });
});

describe('nothing to read', () => {
  it('no Mnemonik HTTP declaration that authorizes with OAuth', async () => {
    expect(await machine(null).read()).toBeUndefined();
    expect(await machine({ command: 'mnemonik' }).read()).toBeUndefined();
    expect(
      await machine({ url: URL, headers: { Authorization: 'Bearer x' } }).read()
    ).toBeUndefined();
  });
});
