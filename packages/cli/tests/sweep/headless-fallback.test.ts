import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCredentialAdapter } from '@mnemonik/credentials';
import { createCliAuth } from '../../src/auth/index.js';
import { DEVICE_WARNING } from '../../src/auth/device.js';
import { makeSweepFixture, type SweepFixture } from '../fixtures/sweep.js';

const fixtures: SweepFixture[] = [];
afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup())));

async function fixture() {
  const result = await makeSweepFixture();
  fixtures.push(result);
  return result;
}

function deviceFetch() {
  return vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.endsWith('/oauth/device_authorization'))
      return Response.json({
        device_code: 'opaque-device-code',
        user_code: 'BCDF-GHJK',
        verification_uri: 'https://auth.mnemonik.test/oauth/device',
        verification_uri_complete: 'https://auth.mnemonik.test/oauth/device?user_code=BCDF-GHJK',
        expires_in: 600,
        interval: 5,
      });
    if (url.endsWith('/oauth/token'))
      return Response.json({
        access_token: 'device-access',
        refresh_token: 'device-refresh',
        expires_in: 900,
        scope: 'account:read offline_access',
      });
    if (url.endsWith('/api/v1/users/me')) return Response.json({ email: 'headless@example.test' });
    // Sign-in now reads the account's grants to place this installation's window.
    if (url.endsWith('/api/v1/auth/grants'))
      return Response.json({ account: 'owner', email: 'headless@example.test', grants: [] });
    throw new Error(`unexpected request: ${url}`);
  });
}

function authFor(
  f: SweepFixture,
  options: { display: boolean; openBrowser?: () => Promise<void> }
) {
  return createCliAuth({
    issuer: 'https://auth.mnemonik.test',
    credentials: createCredentialAdapter({ stateDir: f.stateDir }),
    platform: 'linux',
    env: options.display ? { DISPLAY: ':1' } : {},
    openBrowser: options.openBrowser,
    fetch: deviceFetch() as typeof fetch,
    sleep: async () => {},
    now: () => 1_000,
    deviceName: 'Headless box',
    print: (line) => f.stdout.write(`${line}\n`),
  });
}

describe('headless authentication fallback', () => {
  it('leaves editor sign-in to Codex when Linux has no display', async () => {
    const f = await fixture();
    const openBrowser = vi.fn(async () => {
      throw new Error('browser must not be invoked');
    });
    f.cli.cliAuth = authFor(f, { display: false, openBrowser });

    expect(await f.run(['connect', 'codex'])).toBe(3);
    expect(openBrowser).not.toHaveBeenCalled();
    expect(f.stdout.text).toContain(
      'Codex will ask you to sign in to Mnemonik the first time you use it.'
    );
    expect(f.stderr.text).toBe('');
    expect(f.stdout.text).not.toContain('Code: BCDF-GHJK');
    expect(f.stdout.text).not.toContain(DEVICE_WARNING);
  });

  it('does not open a browser for editor sign-in when a display is available', async () => {
    const f = await fixture();
    const openBrowser = vi.fn(async () => {
      throw new Error('xdg-open exited 1');
    });
    f.cli.cliAuth = authFor(f, { display: true, openBrowser });

    expect(await f.run(['connect', 'codex'])).toBe(3);
    expect(openBrowser).not.toHaveBeenCalled();
    expect(f.stdout.text).toContain(
      'Codex will ask you to sign in to Mnemonik the first time you use it.'
    );
    expect(f.stderr.text).toBe('');
    expect(f.stdout.text).not.toContain('Code: BCDF-GHJK');
    expect(f.stdout.text).not.toContain(DEVICE_WARNING);
  });

  it('names every missing non-interactive consent flag', async () => {
    const f = await fixture();
    f.cli.install = undefined;
    f.cli.preflight = {
      nodeVersion: '24.21.0',
      platform: 'linux',
      resolveIdentity: async () => ({
        kind: 'absent',
        root: f.root,
        repository: { kind: 'plain', root: f.root },
        nested: [],
      }),
      fetch: async () => Response.json({}),
      pathExists: async () => false,
    };

    expect(await f.run(['install', '--non-interactive'])).toBe(3);
    expect(f.stderr.text).toContain('--accept-indexing');
    f.stderr.clear();
    expect(await f.run(['install', '--non-interactive', '--accept-scanner'])).toBe(3);
    expect(f.stderr.text).toContain('--apply');
  });
});
