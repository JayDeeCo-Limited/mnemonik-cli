import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  grantHost,
  serverAuthorization,
  signedInElsewhere,
  type AccountGrant,
} from '../src/auth/status.js';
import { runCli, type CliDependencies } from '../src/router.js';

// Plain `mnemonik auth status` is the CLI's own sign-in, then one row per part
// across the account's computers ("Claude Code MCP", "CLI"); the per-grant
// detail is `--json`, which keeps its shape.

const NOW = Date.parse('2026-09-23T12:00:00.000Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const homes: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

let serial = 0;
function grant(clientName: string, lastUsedMinutesAgo: number | null): AccountGrant {
  serial += 1;
  return {
    id: `grant-${serial}`,
    clientId: `https://client-${serial}.example.test/client`,
    clientName,
    softwareId: null,
    scopes: ['mcp:use'],
    resource: 'https://api.mnemonik.dev/mcp',
    createdAt: '2026-09-01T00:00:00.000Z',
    activatedAt: '2026-09-01T00:01:00.000Z',
    lastUsedAt: lastUsedMinutesAgo === null ? null : ago(lastUsedMinutesAgo),
  };
}
const many = (count: number, clientName: string, newest: number) =>
  Array.from({ length: count }, (_, index) => grant(clientName, newest + index * 600));

async function status(grants: AccountGrant[], args: string[] = [], deviceInstallationId?: string) {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  const home = mkdtempSync(join(tmpdir(), 'auth-status-'));
  homes.push(home);
  const stdout = { text: '', write: (chunk: string) => void (stdout.text += chunk) };
  const stderr = { text: '', write: (chunk: string) => void (stderr.text += chunk) };
  const deps: CliDependencies = {
    home,
    stdout,
    stderr,
    hostManagement: {
      stateDir: join(home, 'state'),
      account: 'owner',
      grants: {
        list: async () => ({
          account: 'owner',
          email: 'daemonhunt@gmail.com',
          deviceInstallationId,
          grants,
        }),
        revoke: async () => undefined,
      },
    },
  };
  const code = await runCli(['auth', 'status', ...args], deps);
  return { code, stdout: stdout.text, stderr: stderr.text };
}

describe('auth status', () => {
  it('prints the CLI sign-in, then one row per part: coding tools by most recent use, then the CLI', async () => {
    const grants = [
      ...many(14, 'Mnemonik CLI', 0),
      ...many(3, 'Cursor', 5 * 60 + 10),
      ...many(5, 'Codex', 70),
      ...many(3, 'Claude Code', 65),
    ];
    const result = await status(grants);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(
      [
        'CLI: signed in as daemonhunt@gmail.com.',
        'Claude Code MCP  authorized, last used 1 hour ago (3 authorizations)',
        'Codex MCP        authorized, last used 1 hour ago (5 authorizations)',
        'Cursor MCP       authorized, last used 5 hours ago (3 authorizations)',
        'CLI              signed in, last used just now (14 sign-ins)',
        "These are your account's authorizations on all your computers. Older ones stay valid until `mnemonik auth logout`, and `mnemonik auth status --json` lists every one.",
        '',
      ].join('\n')
    );
  });

  it('counts each host and says minutes, days and never', async () => {
    const result = await status([
      grant('Mnemonik CLI', null),
      ...many(5, 'Codex', 3 * 24 * 60),
      ...many(3, 'Claude Code', 12),
    ]);
    expect(result.stdout.split('\n').slice(1, 4)).toEqual([
      'Claude Code MCP  authorized, last used 12 minutes ago (3 authorizations)',
      'Codex MCP        authorized, last used 3 days ago (5 authorizations)',
      'CLI              signed in, last used never (1 sign-in)',
    ]);
    expect(result.stdout).not.toMatch(/grant-\d|2026-|mcp:use/u);
  });

  it('prints the not-signed-in sentence when nothing is signed in', async () => {
    const result = await status([]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      'This computer is not signed in to Mnemonik.\nRun mnemonik install to sign in.\n'
    );
  });

  it('keeps the --json shape: the account and every grant with its host', async () => {
    const cli = grant('Mnemonik CLI', 0);
    const codex = grant('Codex', 90);
    const result = await status([cli, codex], ['--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      account: 'owner',
      grants: [
        { ...cli, host: 'Mnemonik CLI' },
        { ...codex, host: 'codex' },
      ],
    });
  });
});

// L-182: Cursor on the Mac opens this Linux machine over SSH; its sign-in is
// bound to the Mac's installation and this machine only runs its hooks.
describe('an editor signed in on another machine', () => {
  const HERE = 'c8553445-83f4-47f6-a84d-4eb7804eb6e6';
  const MAC = '9b7404c8-6e39-46bb-a4b4-f2d7fdabf06a';
  const on = (installation: string, minutesAgo: number) => ({
    ...grant('Cursor', minutesAgo),
    deviceInstallationId: installation,
  });
  const listing = (...grants: AccountGrant[]) => ({
    account: 'owner',
    deviceInstallationId: HERE,
    grants,
  });

  it('auth status --host cursor shows the authorization from the other machine', async () => {
    const result = await status([on(MAC, 3 * 60)], ['--host', 'cursor'], HERE);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      'Cursor MCP  authorized, last used 3 hours ago (1 authorization)'
    );
  });

  it('auth status --host cursor with nothing valid anywhere: not authorized on any computer', async () => {
    const result = await status([{ ...on(MAC, 5), status: 'expired' }], ['--host', 'cursor'], HERE);
    expect(result.stdout).toBe('Cursor MCP: not authorized on any of your computers.\n');
  });

  it('counts only a valid sign-in on another installation, however long it sat idle', () => {
    expect(signedInElsewhere(listing(on(MAC, 3 * 60)), 'cursor')).toBe(true);
    // Idle is not signed out: the sign-in renews the next time Cursor uses it.
    expect(signedInElsewhere(listing(on(MAC, 48 * 60)), 'cursor')).toBe(true);
    expect(signedInElsewhere(listing({ ...on(MAC, 5), status: 'expired' }), 'cursor')).toBe(false);
    expect(signedInElsewhere(listing({ ...on(MAC, 5), status: 'disconnected' }), 'cursor')).toBe(
      false
    );
    expect(signedInElsewhere(listing(on(HERE, 5)), 'cursor')).toBe(false);
    expect(signedInElsewhere(listing(on(MAC, 5)), 'codex')).toBe(false);
    // Only editors that can run away from their hooks.
    const elsewhere = (clientName: string) =>
      signedInElsewhere(
        listing({ ...grant(clientName, 5), deviceInstallationId: MAC }),
        grantHost(grant(clientName, 5))!
      );
    expect(elsewhere('GitHub Copilot')).toBe(true);
    expect(elsewhere('Claude Code')).toBe(false);
    expect(elsewhere('Codex')).toBe(false);
    expect(signedInElsewhere(listing({ ...on(MAC, 5), activatedAt: null }), 'cursor')).toBe(false);
  });
});

// 2026-09-28: after 45 hours away every tool was still signed in. Only the
// server's validity decides revoked or expired; last use only dates it.
describe('serverAuthorization: one tool on this machine, as the server records it', () => {
  const HERE = 'c8553445-83f4-47f6-a84d-4eb7804eb6e6';
  const MAC = '9b7404c8-6e39-46bb-a4b4-f2d7fdabf06a';
  const at = (
    clientName: string,
    status: AccountGrant['status'],
    minutesAgo: number,
    installation = HERE
  ): AccountGrant => ({
    ...grant(clientName, minutesAgo),
    deviceInstallationId: installation,
    status,
  });
  const here = (...grants: AccountGrant[]) => ({
    account: 'owner',
    deviceInstallationId: HERE,
    grants,
  });

  it('a valid grant idle for 45 hours is authorized, with its last use', () => {
    const idle = at('Claude Code', 'connected', 45 * 60);
    expect(serverAuthorization('claude-code', here(idle))).toEqual({
      state: 'authorized',
      lastUsedAt: idle.lastUsedAt,
    });
  });

  it('revoked or expired grants and nothing valid: revoked or expired', () => {
    expect(
      serverAuthorization(
        'codex',
        here(
          at('Codex', 'disconnected', 5),
          at('Codex', 'expired', 60),
          at('Claude Code', 'connected', 1)
        )
      )
    ).toEqual({ state: 'revoked_or_expired', lastUsedAt: null });
  });

  it('one valid grant beside dead ones is authorized, dated by the newest valid use', () => {
    const valid = at('Codex', 'connected', 90);
    expect(serverAuthorization('codex', here(at('Codex', 'expired', 5), valid))).toEqual({
      state: 'authorized',
      lastUsedAt: valid.lastUsedAt,
    });
  });

  it('never authorized here; an authorization never finished is not one either', () => {
    expect(serverAuthorization('cursor', here())).toEqual({
      state: 'never_authorized',
      lastUsedAt: null,
    });
    expect(serverAuthorization('cursor', here(at('Cursor', 'incomplete', 5)))).toEqual({
      state: 'never_authorized',
      lastUsedAt: null,
    });
  });

  it('Cursor authorized on another machine counts, for the tools that can run remotely', () => {
    const mac = at('Cursor', 'connected', 48 * 60, MAC);
    const everywhere = { account: 'owner', deviceInstallationId: HERE, grants: [mac] };
    expect(serverAuthorization('cursor', here(), everywhere)).toEqual({
      state: 'authorized_elsewhere',
      lastUsedAt: mac.lastUsedAt,
    });
    const codexMac = at('Codex', 'connected', 5, MAC);
    expect(serverAuthorization('codex', here(), { ...everywhere, grants: [codexMac] })).toEqual({
      state: 'never_authorized',
      lastUsedAt: null,
    });
  });
});

// 2026-10-12: an outage emptied Claude Code's stored authorization on this
// computer and auth status still said Claude Code was signed in.
describe('auth status says what each coding tool stores on this computer', () => {
  const KEY = 'mnemonik|7aea917cc798c31f';
  async function stored(
    entry: Record<string, unknown> | null,
    args: string[] = [],
    claudeCodeStore: CliDependencies['claudeCodeStore'] = { platform: 'linux', env: {} },
    setup?: (home: string) => void,
    more: AccountGrant[] = []
  ) {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const home = mkdtempSync(join(tmpdir(), 'auth-status-'));
    homes.push(home);
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          mnemonik: {
            type: 'http',
            url: 'https://api.mnemonik.dev/mcp',
            headers: { 'x-mnemonik-installation-id': 'c8553445-83f4-47f6-a84d-4eb7804eb6e6' },
          },
        },
      })
    );
    if (entry) {
      mkdirSync(join(home, '.claude'));
      writeFileSync(
        join(home, '.claude/.credentials.json'),
        JSON.stringify({ mcpOAuth: { [KEY]: entry } })
      );
    }
    setup?.(home);
    const stdout = { text: '', write: (chunk: string) => void (stdout.text += chunk) };
    const deps: CliDependencies = {
      home,
      stdout,
      stderr: { write: () => undefined },
      claudeCodeStore,
      codexStore: { platform: 'linux', env: {} },
      cursorStore: { platform: 'linux', env: {} },
      hostManagement: {
        stateDir: join(home, 'state'),
        account: 'owner',
        grants: {
          list: async () => ({
            account: 'owner',
            email: 'daemonhunt@gmail.com',
            grants: [grant('Claude Code', 12), grant('Codex', 70), ...more],
          }),
          revoke: async () => undefined,
        },
      },
    };
    const code = await runCli(['auth', 'status', ...args], deps);
    return { code, stdout: stdout.text };
  }

  it('authorized or renewable here: the account row alone', async () => {
    for (const expiresAt of [NOW + 3e6, NOW - 3e6]) {
      const result = await stored({ accessToken: 'a', refreshToken: 'r', expiresAt });
      expect(result.stdout.split('\n')[1]).toBe(
        'Claude Code MCP  authorized, last used 12 minutes ago (1 authorization)'
      );
    }
  });

  it('nothing stored: the account row, that Claude Code holds none here, and the step', async () => {
    for (const entry of [{ accessToken: '' }, null]) {
      const result = await stored(entry);
      expect(result.code).toBe(0);
      expect(result.stdout.split('\n').slice(1, 3)).toEqual([
        'Claude Code MCP  authorized, last used 12 minutes ago (1 authorization). Claude Code holds none on this computer. In Claude Code, type /mcp, choose mnemonik, then Authenticate.',
        'Codex MCP        authorized, last used 1 hour ago (1 authorization)',
      ]);
    }
    const json = JSON.parse((await stored({ accessToken: '' }, ['--json'])).stdout);
    expect(json.stored).toEqual({ 'claude-code': { state: 'missing', expiresAt: null } });
    expect(json.grants).toHaveLength(2);
  });

  it('a store that cannot be read: the account row, and why this computer was not checked', async () => {
    const result = await stored({ accessToken: 'a' }, [], {
      platform: 'darwin',
      env: { USER: 'owner' },
      keychain: async () => ({ code: 36, stdout: '' }),
    });
    expect(result.stdout.split('\n')[1]).toBe(
      "Claude Code MCP  authorized, last used 12 minutes ago (1 authorization). Claude Code's copy on this computer could not be checked because the macOS Keychain is locked in this session, as it is over SSH. Run mnemonik status in Terminal on the Mac to check it."
    );
    const json = JSON.parse(
      (
        await stored({ accessToken: 'a' }, ['--json'], {
          platform: 'darwin',
          env: { USER: 'owner' },
          keychain: async () => ({ code: 36, stdout: '' }),
        })
      ).stdout
    );
    expect(json.stored).toEqual({
      'claude-code': { state: 'unreadable', expiresAt: null, reason: 'keychain_locked' },
    });
  });

  it('Codex and Cursor too: each read from its own store', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const result = await stored(
      null,
      [],
      undefined,
      (home) => {
        mkdirSync(join(home, '.codex'));
        writeFileSync(
          join(home, '.codex/config.toml'),
          '[mcp_servers.mnemonik]\nurl = "https://api.mnemonik.dev/mcp"\n'
        );
        writeFileSync(join(home, '.codex/.credentials.json'), '{}');
        mkdirSync(join(home, '.cursor'));
        writeFileSync(
          join(home, '.cursor/mcp.json'),
          JSON.stringify({ mcpServers: { mnemonik: { url: 'https://api.mnemonik.dev/mcp' } } })
        );
        mkdirSync(join(home, '.cursor-server'));
      },
      [grant('Cursor', 30)]
    );
    expect(result.stdout.split('\n').slice(1, 4)).toEqual([
      'Claude Code MCP  authorized, last used 12 minutes ago (1 authorization). Claude Code holds none on this computer. In Claude Code, type /mcp, choose mnemonik, then Authenticate.',
      'Cursor MCP       authorized, last used 30 minutes ago (1 authorization). Cursor keeps its authorization on the computer it runs on, not on this one, so it was not checked here.',
      'Codex MCP        authorized, last used 1 hour ago (1 authorization). Codex holds none on this computer. Run mnemonik connect codex.',
    ]);
  });
});

describe('auth status counts only valid grants', () => {
  it('leaves an expired or revoked grant out of the rows', async () => {
    const result = await status([
      { ...grant('Codex', 5), status: 'expired' },
      { ...grant('Claude Code', 30), status: 'connected' },
      { ...grant('Cursor', 10), status: 'disconnected' },
    ]);
    expect(result.stdout.split('\n').slice(1, -2)).toEqual([
      'Claude Code MCP  authorized, last used 30 minutes ago (1 authorization)',
    ]);
  });
});
