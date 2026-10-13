import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createCredentialAdapter, CredentialSessionUnavailableError } from '@mnemonik/credentials';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureLauncher } from '../src/launcher.js';
import { runCli, type CliDependencies } from '../src/router.js';

// `mnemonik status` names each separately authorized part on this computer,
// one line each and never dropped: every installed coding tool's MCP
// connection and hooks, the scanner, and the CLI. Each tool's own store is read
// from temporary files here; no real credential is involved.

const HERE = 'c8553445-83f4-47f6-a84d-4eb7804eb6e6';
const URL = 'https://api.mnemonik.dev/mcp';
const HOOK_FAMILY = '6f1a2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';
const SCANNER_FAMILY = '7a2b3c4d-5e6f-4a7b-8c9d-1e2f3a4b5c6d';
const STEP = {
  claude: 'In Claude Code, type /mcp, choose mnemonik, then Authenticate.',
  cursor: 'In Cursor, open Cursor Settings, Customize, MCPs, then Authenticate.',
};

const homes: string[] = [];
beforeEach(() => {
  vi.stubGlobal('fetch', async () => Response.json({}));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

const family = (id: string, scope: string, refreshSeconds = 7_776_000) => ({
  id,
  access_token: 'mnc_never-shown',
  refresh_token: 'mncr_never-shown',
  token_type: 'Bearer' as const,
  expires_in: 86400,
  refresh_expires_in: refreshSeconds,
  scope,
  display_prefix: 'mnc_never-sh',
});

/** A grant as the server lists it for this installation, by the console's rule. */
const grant = (
  tool: 'claude-code' | 'codex' | 'cursor',
  status: 'connected' | 'disconnected' | 'expired' = 'connected'
) => ({
  id: `${tool}-${status}`,
  clientId:
    tool === 'claude-code'
      ? 'https://claude.ai/oauth/claude-code-client-metadata'
      : tool === 'codex'
        ? 'https://chatgpt.com/codex'
        : 'cursor-client',
  clientName: tool === 'cursor' ? 'Cursor' : null,
  softwareId: null,
  scopes: ['mcp:use'],
  resource: URL,
  deviceInstallationId: HERE,
  createdAt: '2026-09-21T04:32:15.890Z',
  activatedAt: '2026-09-21T04:32:15.890Z',
  lastUsedAt: new Date(Date.now() - 3_600_000).toISOString(),
  status,
});

async function machine(tools: Array<'claude-code' | 'codex' | 'cursor'>) {
  const home = await mkdtemp(join(tmpdir(), 'status-authorizations-'));
  homes.push(home);
  const stateDir = join(home, 'state');
  const cwd = join(home, 'project');
  await mkdir(cwd, { recursive: true });
  const put = async (path: string, value: unknown) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const hookEntry = join(home, 'hook.js');
  await put(hookEntry, '// hook');
  await createCredentialAdapter({ stateDir }).putFamily('hook', family(HOOK_FAMILY, 'hooks:use'));
  const hooks = (host: string) => ({
    hooks: {
      start: [
        {
          command: `node ${JSON.stringify(hookEntry)} --credential-family ${HOOK_FAMILY} --mnemonik-owner=${host}-hooks`,
        },
      ],
    },
  });
  const header = { 'x-mnemonik-installation-id': HERE };
  if (tools.includes('claude-code')) {
    await put(join(home, '.claude/settings.json'), hooks('claude-code'));
    await put(join(home, '.claude.json'), {
      mcpServers: { mnemonik: { type: 'http', url: URL, headers: header } },
    });
  }
  if (tools.includes('codex')) {
    await put(join(home, '.codex/hooks.json'), hooks('codex'));
    await put(
      join(home, '.codex/config.toml'),
      `[mcp_servers.mnemonik]\nurl = "${URL}"\nhttp_headers = { "x-mnemonik-installation-id" = "${HERE}" }\n`
    );
  }
  if (tools.includes('cursor')) {
    await put(join(home, '.cursor/hooks.json'), hooks('cursor'));
    await put(join(home, '.cursor/mcp.json'), {
      mcpServers: { mnemonik: { url: URL, headers: header } },
    });
  }
  await ensureLauncher({ home, stateDir });

  /** What each tool itself stores here. */
  const store = {
    claude: (fields: Record<string, unknown> | null) =>
      put(join(home, '.claude/.credentials.json'), {
        mcpOAuth: fields
          ? { 'mnemonik|7aea917cc798c31f': { serverName: 'mnemonik', ...fields } }
          : {},
      }),
    codex: (fields: Record<string, unknown> | null) =>
      put(join(home, '.codex/.credentials.json'), {
        ...(fields
          ? {
              'mnemonik|ba9709ce6018a6e4': {
                server_name: 'mnemonik',
                server_url: URL,
                client_id: 'client',
                issuer: 'https://auth.mnemonik.ai',
                ...fields,
              },
            }
          : {}),
      }),
    /** Cursor opens this computer over SSH: its settings are on the other computer. */
    cursorRemote: () => mkdir(join(home, '.cursor-server'), { recursive: true }),
    /** Cursor runs here: its settings database, with or without the Mnemonik row. */
    cursorHere: async (authorized: boolean) => {
      const path = join(home, '.config/Cursor/User/globalStorage/state.vscdb');
      await mkdir(dirname(path), { recursive: true });
      const { DatabaseSync } = (await import('node:sqlite' as string)) as {
        DatabaseSync: new (path: string) => {
          exec(sql: string): void;
          prepare(sql: string): { run(...values: unknown[]): unknown };
          close(): void;
        };
      };
      const db = new DatabaseSync(path);
      db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
      if (authorized)
        db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run(
          `mcpOAuth.secret.${Buffer.from('[user-mnemonik::mcpScope:profile:ZGVmYXVsdA] mcp_tokens').toString('base64url')}`,
          'v10never-shown'
        );
      db.close();
    },
    scanner: async (refreshSeconds = 7_776_000) => {
      await createCredentialAdapter({ stateDir }).putFamily(
        'scanner',
        family(SCANNER_FAMILY, 'scanner:upload', refreshSeconds)
      );
      await put(join(stateDir, 'scanner/state.json'), {
        schemaVersion: 1,
        config: {
          roots: [],
          credentialFamilyId: SCANNER_FAMILY,
          serverUrl: 'https://api.mnemonik.dev',
        },
      });
    },
  };

  const asked: string[] = [];
  const invoke = async (
    options: {
      grants?: unknown[];
      bearer?: CliDependencies['cliAuth'] extends infer A
        ? A extends { getCliBearer: infer G }
          ? G
          : never
        : never;
      unreachable?: boolean;
      extra?: Partial<CliDependencies>;
      json?: boolean;
    } = {}
  ) => {
    let text = '';
    const code = await runCli(['status', ...(options.json ? ['--json'] : [])], {
      home,
      cwd,
      installStateDir: stateDir,
      stdout: { write: (value) => void (text += value) },
      preflight: {
        nodeVersion: '24.21.0',
        resolveIdentity: async () => ({ kind: 'git_unavailable', detail: 'fixture' }),
      },
      scannerStatus: async () => ({ roots: [], exclusions: [], repositories: [] }),
      codexTrustConditions: async () => [],
      cliAuth: {
        signIn: async () => undefined,
        getCliBearer: options.bearer ?? (async () => 'access-token'),
        logout: async () => undefined,
      },
      grantFetch: async (input) => {
        asked.push(new globalThis.URL(String(input)).pathname);
        if (options.unreachable) throw new TypeError('fetch failed');
        if (new globalThis.URL(String(input)).pathname === '/api/v1/auth/grants')
          return Response.json({
            account: 'owner',
            email: 'sam@acme.test',
            deviceInstallationId: HERE,
            grants: options.grants ?? [],
          });
        return Response.json({ status: 'recorded' });
      },
      claudeCodeStore: { platform: 'linux', env: {} },
      codexStore: { platform: 'linux', env: {} },
      cursorStore: { platform: 'linux', env: {} },
      ...options.extra,
    });
    return { code, text };
  };
  return { home, stateDir, put, store, invoke, asked };
}

const ALL = ['claude-code', 'codex', 'cursor'] as const;

describe('every part authorized, each named', () => {
  it('three coding tools, Cursor run from another computer over SSH, the scanner and the CLI', async () => {
    const m = await machine([...ALL]);
    await m.store.claude({ accessToken: 'a-never-shown', expiresAt: Date.now() + 3_600_000 });
    await m.store.codex({
      access_token: 'a-never-shown',
      refresh_token: 'r',
      expires_at: Date.now() - 3_600_000,
    });
    await m.store.cursorRemote();
    await m.store.scanner();
    const result = await m.invoke({ grants: ALL.map((tool) => grant(tool)) });
    expect(result).toEqual({
      code: 0,
      text: [
        'Mnemonik is installed and working.',
        'Claude Code MCP: authorized.',
        'Claude Code hooks: authorized.',
        'Codex MCP: authorized.',
        'Codex hooks: authorized.',
        'Cursor MCP: Mnemonik lists it as authorized. Cursor keeps its authorization on the computer it runs on, not on this one, so it was not checked here.',
        'Cursor hooks: authorized.',
        'Scanner: authorized.',
        'CLI: signed in as sam@acme.test.',
        '',
      ].join('\n'),
    });
    expect(result.text).not.toContain('never-shown');
    const json = JSON.parse(
      (await m.invoke({ grants: ALL.map((tool) => grant(tool)), json: true })).text
    );
    expect(json.authorizations.map((entry: { line: string }) => entry.line)).toEqual([
      'Claude Code MCP: authorized.',
      'Claude Code hooks: authorized.',
      'Codex MCP: authorized.',
      'Codex hooks: authorized.',
      'Cursor MCP: Mnemonik lists it as authorized. Cursor keeps its authorization on the computer it runs on, not on this one, so it was not checked here.',
      'Cursor hooks: authorized.',
      'Scanner: authorized.',
      'CLI: signed in.',
    ]);
    expect(json.authorizations[2]).toMatchObject({
      component: 'mcp',
      host: 'codex',
      state: 'authorized',
      stored: { state: 'renewable' },
    });
    expect(json.authorizations[4]).toMatchObject({
      host: 'cursor',
      state: 'store_unchecked',
      stored: { state: 'unreadable', reason: 'remote' },
    });
    expect(JSON.stringify(json)).not.toMatch(/never-shown|sam@acme/u);
  }, 30_000);

  it('Cursor running here holds the authorization: authorized', async () => {
    const m = await machine(['cursor']);
    await m.store.cursorHere(true);
    const result = await m.invoke({ grants: [grant('cursor')] });
    expect(result.text).toContain('\nCursor MCP: authorized.\n');
  }, 30_000);
});

describe('a tool no longer holds what Mnemonik lists (2026-10-12)', () => {
  it('Codex: nothing in its credentials file while the server grant is valid', async () => {
    const m = await machine(['codex']);
    await m.store.codex(null);
    const result = await m.invoke({ grants: [grant('codex')] });
    expect(result).toEqual({
      code: 3,
      text: [
        'Installation: Needs attention.',
        'Codex MCP is not authorized on this computer.',
        'Run mnemonik connect codex.',
        'Codex MCP: not authorized. Codex no longer holds the authorization Mnemonik lists for this computer.',
        'Codex hooks: authorized.',
        'Scanner: not set up on this computer.',
        'CLI: signed in as sam@acme.test.',
        '',
      ].join('\n'),
    });
  }, 30_000);

  it('Cursor: Logout in Cursor on this computer while the server grant is valid', async () => {
    const m = await machine(['cursor']);
    await m.store.cursorHere(false);
    const result = await m.invoke({ grants: [grant('cursor')] });
    expect(result.code).toBe(3);
    expect(result.text).toContain(
      `Cursor MCP is not authorized on this computer.\n${STEP.cursor}\nCursor MCP: not authorized. Cursor no longer holds the authorization Mnemonik lists for this computer.\n`
    );
  }, 30_000);
});

describe('a store that cannot be read is never dropped; the line says why', () => {
  it('a Mac over SSH: the Keychain is locked for Claude Code, and Codex keeps its own in the Keychain', async () => {
    const m = await machine(['claude-code', 'codex']);
    const result = await m.invoke({
      grants: [grant('claude-code'), grant('codex')],
      extra: {
        claudeCodeStore: {
          platform: 'darwin',
          env: { USER: 'owner' },
          keychain: async () => ({ code: 36, stdout: '' }),
        },
        codexStore: { platform: 'darwin', env: {} },
      },
    });
    expect(result.code).toBe(0);
    expect(result.text).toContain(
      "Claude Code MCP: Mnemonik lists it as authorized. Claude Code's copy on this computer could not be checked because the macOS Keychain is locked in this session, as it is over SSH. Run mnemonik status in Terminal on the Mac to check it.\n"
    );
    expect(result.text).toContain(
      "Codex MCP: Mnemonik lists it as authorized. Codex's copy on this computer could not be checked because Codex keeps it in the macOS Keychain, which Mnemonik does not read.\n"
    );
  }, 30_000);

  it('Mnemonik cannot be reached: what the tools hold here, and the CLI unconfirmed', async () => {
    const m = await machine([...ALL]);
    await m.store.claude({ accessToken: 'a-never-shown' });
    await m.store.codex(null);
    await m.store.cursorRemote();
    const result = await m.invoke({ unreachable: true });
    expect(result.text).toContain(
      [
        'Claude Code MCP: Claude Code holds an authorization on this computer, but Mnemonik could not be reached to confirm it.',
        'Claude Code hooks: authorized.',
        'Codex MCP: not authorized. Run mnemonik connect codex.',
        'Codex hooks: authorized.',
        'Cursor MCP: could not be checked because Mnemonik could not be reached. Cursor keeps its authorization on the computer it runs on, not on this one, so it was not checked here.',
        'Cursor hooks: authorized.',
        'Scanner: not set up on this computer.',
        'CLI: signed in on this computer, but Mnemonik could not be reached to confirm it.',
      ].join('\n')
    );
  }, 30_000);
});

describe('the CLI sign-in on this computer', () => {
  it('not signed in, signed out, or locked in the Keychain: said, and each tool line says why it was not confirmed', async () => {
    const m = await machine(['claude-code']);
    await m.store.claude({ accessToken: 'a-never-shown' });
    const missing = await m.invoke({
      bearer: async () => ({ status: 'ACTION_REQUIRED', reason: 'family_missing' }),
    });
    expect(missing.text).toContain(
      'Claude Code MCP: Claude Code holds an authorization on this computer, but it could not be confirmed because the CLI is not signed in.\n'
    );
    expect(missing.text).toContain('CLI: not signed in. Run mnemonik auth login.\n');
    expect(missing.text).toContain(
      'The console has not heard from this computer because the CLI sign-in could not be used.\n'
    );
    const refused = await m.invoke({
      bearer: async () => ({ status: 'ACTION_REQUIRED', reason: 'invalid_grant' }),
    });
    expect(refused.text).toContain(
      'CLI: signed out. Mnemonik no longer accepts its sign-in. Run mnemonik auth renew.\n'
    );
    const locked = await m.invoke({
      bearer: async () => {
        throw new CredentialSessionUnavailableError('keychain');
      },
    });
    expect(locked.text).toContain(
      'CLI: could not be checked because its sign-in is in the macOS Keychain, which is locked in this session, as it is over SSH. Run mnemonik status in Terminal on the Mac to check it.\n'
    );
  }, 30_000);
});

describe('no coding tool installed', () => {
  it('the CLI line names the account recorded at sign-in, without asking the server', async () => {
    const m = await machine([]);
    await m.put(join(m.stateDir, 'installation.json'), {
      deviceInstallationId: HERE,
      account: 'owner',
      accounts: { owner: { deviceInstallationId: HERE, email: 'sam@acme.test' } },
    });
    const result = await m.invoke();
    expect(result.text).toContain(
      '\nScanner: not set up on this computer.\nCLI: signed in as sam@acme.test.\n'
    );
    expect(m.asked).not.toContain('/api/v1/auth/grants');
  }, 30_000);
});

describe('hooks and scanner authorizations of their own', () => {
  it('hooks whose authorization is gone from this computer: not working, named, with the repair step', async () => {
    const m = await machine(['claude-code']);
    await m.store.claude({ accessToken: 'a-never-shown' });
    await rm(join(m.stateDir, 'credentials'), { recursive: true, force: true });
    const result = await m.invoke({ grants: [grant('claude-code')] });
    expect(result.code).toBe(3);
    expect(result.text).toBe(
      [
        'Installation: Needs attention.',
        'Claude Code hooks are not authorized on this computer.',
        'Run mnemonik repair.',
        'Claude Code MCP: authorized.',
        'Claude Code hooks: not authorized. Their authorization is missing from this computer or has expired.',
        'Scanner: not set up on this computer.',
        'CLI: signed in as sam@acme.test.',
        '',
      ].join('\n')
    );
  }, 30_000);

  it('the scanner: authorized, expired, and refused by Mnemonik; a lost one never reads as working', async () => {
    const m = await machine(['claude-code']);
    await m.store.claude({ accessToken: 'a-never-shown' });
    await m.store.scanner();
    expect((await m.invoke({ grants: [grant('claude-code')] })).text).toContain(
      '\nScanner: authorized.\n'
    );
    await m.store.scanner(-60);
    const expired = await m.invoke({ grants: [grant('claude-code')] });
    expect(expired.code).toBe(3);
    expect(expired.text).toBe(
      [
        'Installation: Needs attention.',
        'The scanner is no longer authorized on this computer.',
        'Run mnemonik repair.',
        'Claude Code MCP: authorized.',
        'Claude Code hooks: authorized.',
        'Scanner: not authorized. Its authorization is missing from this computer or has expired.',
        'CLI: signed in as sam@acme.test.',
        '',
      ].join('\n')
    );
    await m.store.scanner();
    await m.put(join(m.stateDir, 'scanner/status.json'), {
      snapshot: { lifecycle: { state: 'stopped', reason: 'credential_revoked' }, heartbeat: {} },
    });
    const refused = await m.invoke({ grants: [grant('claude-code')] });
    expect(refused.text).toContain(
      'The scanner is no longer authorized on this computer.\nRun mnemonik repair.\n'
    );
    expect(refused.text).toContain(
      '\nScanner: not authorized. Mnemonik no longer accepts its authorization.\n'
    );
  }, 30_000);
});
