import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, readFile, stat } from 'node:fs/promises';
import {
  createCredentialAdapter,
  credentialPaths,
  type ComponentCredentialResponse,
} from '@mnemonik/credentials';
import { createCliAuth } from '../../src/auth/index.js';
import { makeSweepFixture, type SweepFixture } from '../fixtures/sweep.js';

const fixtures: SweepFixture[] = [];
afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup())));
const now = Date.parse('2026-09-11T00:00:00.000Z');

const family = (id: string): ComponentCredentialResponse => ({
  id,
  access_token: `access-${id}`,
  refresh_token: `refresh-${id}`,
  token_type: 'Bearer',
  expires_in: 86_400,
  refresh_expires_in: 31_536_000,
  scope: id.includes('scanner') ? 'scanner:upload' : 'hooks:use',
  display_prefix: 'mnk_component',
});

async function fixture() {
  const result = await makeSweepFixture();
  fixtures.push(result);
  return result;
}

async function seedCli(adapter: ReturnType<typeof createCredentialAdapter>) {
  await adapter.putCliOAuth(
    {
      issuer: 'https://auth.mnemonik.test',
      clientId: 'saved-client',
      scopes: ['account:read', 'offline_access'],
      familyId: 'saved-cli-family',
      lastRotationTime: new Date(now).toISOString(),
    },
    {
      accessToken: 'saved-access',
      refreshToken: 'saved-refresh',
      accessExpiresAt: new Date(now + 60_000).toISOString(),
    }
  );
}

// A completed install exits 3 (LIMITED) until scanner and hook checks prove the
// components work; 0 is READY.
const INSTALLED = 3;

describe('existing credentials', () => {
  it('keeps a valid CLI sign-in without prompting and leaves component families alone', async () => {
    const f = await fixture();
    const credentials = createCredentialAdapter({ stateDir: f.stateDir, now: () => now });
    await seedCli(credentials);
    await credentials.putFamily('hook', family('hook-family'));
    await credentials.putFamily('scanner', family('scanner-family'));
    const hookBefore = await credentials.readFamily('hook-family');
    const scannerBefore = await credentials.readFamily('scanner-family');
    const openBrowser = vi.fn(async () => {
      throw new Error('must not prompt');
    });
    f.cli.cliAuth = createCliAuth({
      credentials,
      now: () => now,
      openBrowser,
      fetch: vi.fn(async (input) => {
        // The account email comes from the CLI's own grant route (f91cfbd2),
        // not the console-only /users/me.
        expect(String(input)).toBe('https://api.mnemonik.dev/api/v1/auth/grants');
        return Response.json({ email: 'owner@example.test', grants: [] });
      }) as typeof fetch,
    });

    expect(await f.run()).toBe(INSTALLED);
    expect(openBrowser).not.toHaveBeenCalled();
    expect(f.stdout.text).toContain('Signed in as owner@example.test');
    expect(f.stdout.text).toContain('mnemonik logout to switch account');
    expect(await credentials.readFamily('hook-family')).toEqual(hookBefore);
    expect(await credentials.readFamily('scanner-family')).toEqual(scannerBefore);
  });

  it('turns one rotated-out family into ACTION_REQUIRED without touching its sibling', async () => {
    const f = await fixture();
    const credentials = createCredentialAdapter({ stateDir: f.stateDir, now: () => now });
    await credentials.putFamily('hook', family('rotated-out'));
    await credentials.putFamily('scanner', family('healthy-scanner'));
    const rotatedBefore = await credentials.readFamily('rotated-out');
    const siblingBefore = await credentials.readFamily('healthy-scanner');

    const result = await credentials.rotateFamily('rotated-out', {
      rotateFamily: async () => ({ status: 400, body: { error: 'invalid_grant' } }),
      revokeFamily: async () => ({ status: 200, body: {} }),
    });

    expect(result).toMatchObject({ status: 'ACTION_REQUIRED', reason: 'invalid_grant' });
    expect(await credentials.readFamily('rotated-out')).toEqual(rotatedBefore);
    expect(await credentials.readFamily('healthy-scanner')).toEqual(siblingBefore);
  });

  it('refuses a weak-mode CLI record without repairing or replacing it', async () => {
    const f = await fixture();
    const credentials = createCredentialAdapter({ stateDir: f.stateDir, now: () => now });
    await seedCli(credentials);
    const path = credentialPaths(f.stateDir).cliRecord;
    await chmod(path, 0o644);
    const before = await readFile(path);
    f.cli.cliAuth = createCliAuth({ credentials, now: () => now });

    expect(await f.run()).toBe(1);
    expect(f.stderr.text).toContain('This machine needs attention before Mnemonik can work fully.');
    expect(f.stderr.text).not.toContain('weak_permissions');
    expect(await readFile(path)).toEqual(before);
    expect((await stat(path)).mode & 0o777).toBe(0o644);
  });
});
