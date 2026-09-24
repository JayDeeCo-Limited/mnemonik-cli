import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { grantHost, signedInElsewhere, type AccountGrant } from '../src/auth/status.js';
import { runCli, type CliDependencies } from '../src/router.js';

// Plain `mnemonik auth status` is one row per host; the per-grant detail is
// `--json`, which keeps its shape.

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
  it('prints one row per host, editors by most recent use, then the CLI', async () => {
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
        'Signed in as daemonhunt@gmail.com.',
        'Claude Code   signed in, last used 1 hour ago (3 sign-ins)',
        'Codex         signed in, last used 1 hour ago (5 sign-ins)',
        'Cursor        signed in, last used 5 hours ago (3 sign-ins)',
        'Mnemonik CLI  signed in, last used just now (14 sign-ins)',
        'Older sign-ins stay valid until `mnemonik auth logout`. `mnemonik auth status --json` lists every one.',
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
      'Claude Code   signed in, last used 12 minutes ago (3 sign-ins)',
      'Codex         signed in, last used 3 days ago (5 sign-ins)',
      'Mnemonik CLI  signed in, last used never (1 sign-in)',
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

  it('auth status --host cursor shows the sign-in from the other machine', async () => {
    const result = await status([on(MAC, 3 * 60)], ['--host', 'cursor'], HERE);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Cursor  signed in, last used 3 hours ago (1 sign-in)');
  });

  it('counts only an activated sign-in on another installation used within the day', () => {
    expect(signedInElsewhere(listing(on(MAC, 3 * 60)), 'cursor', NOW)).toBe(true);
    expect(signedInElsewhere(listing(on(MAC, 48 * 60)), 'cursor', NOW)).toBe(false);
    expect(signedInElsewhere(listing(on(HERE, 5)), 'cursor', NOW)).toBe(false);
    expect(signedInElsewhere(listing(on(MAC, 5)), 'codex', NOW)).toBe(false);
    // Only editors that can run away from their hooks.
    const elsewhere = (clientName: string) =>
      signedInElsewhere(
        listing({ ...grant(clientName, 5), deviceInstallationId: MAC }),
        grantHost(grant(clientName, 5))!,
        NOW
      );
    expect(elsewhere('GitHub Copilot')).toBe(true);
    expect(elsewhere('Claude Code')).toBe(false);
    expect(elsewhere('Codex')).toBe(false);
    expect(signedInElsewhere(listing({ ...on(MAC, 5), activatedAt: null }), 'cursor', NOW)).toBe(
      false
    );
  });
});
