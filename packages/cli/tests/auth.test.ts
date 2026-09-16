import { createServer, request as httpRequest } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URLSearchParams } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCredentialAdapter, CredentialSessionUnavailableError } from '@mnemonik/credentials';
import {
  CLI_SCOPES,
  createCliAuth,
  noBrowserAvailable,
  runDeviceFlow,
  runPkce,
} from '../src/auth/index.js';
import { DEVICE_WARNING } from '../src/auth/device.js';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const issuer = 'https://auth.mnemonik.ai';
const resource = 'https://api.mnemonik.dev/';
const clientId = `${issuer}/oauth/clients/mnemonik-cli.json`;
const scannerRoots = JSON.stringify({ roots: ['/approved'], exclusions: [] });
const installationId = '11111111-1111-4111-8111-111111111111';
type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;
const token = () =>
  new Response(
    JSON.stringify({
      access_token: 'access',
      refresh_token: 'refresh',
      token_type: 'Bearer',
      expires_in: 900,
      scope: CLI_SCOPES.join(' '),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

async function localhostResponse(url: URL): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: '127.0.0.1',
        port: url.port,
        path: `${url.pathname}${url.search}`,
        headers: { host: `localhost:${url.port}` },
      },
      (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode ?? 0));
      }
    );
    request.once('error', reject);
    request.end();
  });
}

describe('PKCE loopback flow', () => {
  it('binds before opening, refuses callback mix-ups, exchanges once, and closes', async () => {
    const events: string[] = [];
    let redirect!: URL;
    const fetcher = vi.fn(async (_input: string | URL, init?: FetchInit) => {
      events.push('exchange');
      const form = new URLSearchParams(String(init?.body));
      expect(form.get('client_id')).toBe(clientId);
      expect(form.get('redirect_uri')).toBe(redirect.origin + '/callback');
      expect(form.get('resource')).toBe(resource);
      expect(form.get('code')).toBe('one-use-code');
      expect(form.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      return token();
    });
    const result = await runPkce({
      scannerRoots,
      deviceName: 'windows11-agent',
      deviceInstallationId: installationId,
      deviceInstallationIds: [installationId],
      issuer,
      resource,
      scopes: CLI_SCOPES,
      clientId,
      print: () => undefined,
      fetch: fetcher as typeof fetch,
      createServer: (handler) => {
        const server = createServer(handler);
        server.once('listening', () => events.push('bound'));
        return server;
      },
      openBrowser: async (authorizeUrl) => {
        events.push('open');
        const authorize = new URL(authorizeUrl);
        redirect = new URL(authorize.searchParams.get('redirect_uri')!);
        expect(authorize.searchParams.get('response_type')).toBe('code');
        expect(authorize.searchParams.get('scanner_roots')).toBe(scannerRoots);
        expect(authorize.searchParams.get('device_installation_id')).toBe(installationId);
        expect(JSON.parse(authorize.searchParams.get('device_installation_ids')!)).toEqual([
          installationId,
        ]);
        expect(authorize.searchParams.get('device_name')).toBe('windows11-agent');
        expect(authorize.searchParams.get('scope')).toBe(CLI_SCOPES.join(' '));
        expect(authorize.searchParams.get('resource')).toBe(resource);
        expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
        expect(authorize.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/u);
        const state = authorize.searchParams.get('state')!;
        expect(await fetch(`${redirect.origin}/wrong?state=${state}&iss=${issuer}`)).toMatchObject({
          status: 404,
        });
        expect(await fetch(`${redirect.origin}/callback?state=wrong&iss=${issuer}`)).toMatchObject({
          status: 404,
        });
        expect(
          await fetch(`${redirect.origin}/callback?state=${state}&iss=https://evil.example`)
        ).toMatchObject({ status: 404 });
        expect(
          await localhostResponse(
            new URL(`${redirect.origin}/callback?state=${state}&iss=${issuer}`)
          )
        ).toBe(404);
        expect(
          await fetch(`${redirect.origin}/callback?code=one-use-code&state=${state}&iss=${issuer}`)
        ).toMatchObject({ status: 200 });
      },
    });
    expect(result.redirectUri).toBe(redirect.origin + '/callback');
    expect(events.slice(-3)).toEqual(['bound', 'open', 'exchange']);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(fetch(redirect.origin)).rejects.toThrow();
  });

  it('uses a constant-time comparison for a state differing in its last byte', async () => {
    await runPkce({
      issuer,
      resource,
      scopes: CLI_SCOPES,
      clientId,
      print: () => undefined,
      fetch: vi.fn(async () => token()) as typeof fetch,
      openBrowser: async (url) => {
        const authorize = new URL(url);
        const redirect = authorize.searchParams.get('redirect_uri')!;
        const state = authorize.searchParams.get('state')!;
        const wrong = `${state.slice(0, -1)}${state.endsWith('A') ? 'B' : 'A'}`;
        expect(await fetch(`${redirect}?code=nope&state=${wrong}&iss=${issuer}`)).toMatchObject({
          status: 404,
        });
        expect(timingSafeEqual).toHaveBeenCalledTimes(1);
        await fetch(`${redirect}?code=valid&state=${state}&iss=${issuer}`);
      },
    });
  });

  it('completes an immediate callback before the browser command returns', async () => {
    let release!: () => void;
    const browserFinished = new Promise<void>((resolve) => (release = resolve));
    const result = runPkce({
      issuer,
      resource,
      scopes: CLI_SCOPES,
      clientId,
      print: () => undefined,
      fetch: vi.fn(async () => token()) as typeof fetch,
      openBrowser: async (url) => {
        const authorize = new URL(url);
        const redirect = authorize.searchParams.get('redirect_uri')!;
        const state = authorize.searchParams.get('state')!;
        await fetch(`${redirect}?code=instant&state=${state}&iss=${issuer}`);
        await browserFinished;
      },
    });
    await expect(
      Promise.race([
        result,
        new Promise((_, reject) => setTimeout(() => reject(new Error('blocked')), 200)),
      ])
    ).resolves.toMatchObject({
      tokens: { access_token: 'access' },
    });
    release();
  });

  it('falls back from an occupied preferred port and uses the bound port in the exchange', async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
    const address = occupied.address();
    if (!address || typeof address === 'string') throw new Error('fixture did not bind');
    let actual = 0;
    const result = await runPkce({
      issuer,
      resource,
      scopes: CLI_SCOPES,
      clientId,
      preferredPort: address.port,
      print: () => undefined,
      fetch: vi.fn(async (_url, init) => {
        expect(new URLSearchParams(String(init?.body)).get('redirect_uri')).toContain(
          `:${actual}/`
        );
        return token();
      }) as typeof fetch,
      openBrowser: async (url) => {
        const authorize = new URL(url);
        const redirect = new URL(authorize.searchParams.get('redirect_uri')!);
        actual = Number(redirect.port);
        expect(actual).not.toBe(address.port);
        await fetch(
          `${redirect}?code=fresh&state=${authorize.searchParams.get('state')}&iss=${issuer}`
        );
      },
    });
    expect(result.redirectUri).toContain(`:${actual}/callback`);
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  });

  it.each([
    ['denied', 'access_denied', 'denied in the browser'],
    ['invalid client', 'invalid_client', 'invalid_client'],
  ])('closes after %s', async (_label, error, message) => {
    let origin = '';
    await expect(
      runPkce({
        issuer,
        resource,
        scopes: CLI_SCOPES,
        clientId,
        print: () => undefined,
        openBrowser: async (url) => {
          const authorize = new URL(url);
          const redirect = new URL(authorize.searchParams.get('redirect_uri')!);
          origin = redirect.origin;
          await fetch(
            `${redirect}?error=${error}&state=${authorize.searchParams.get('state')}&iss=${issuer}`
          );
        },
      })
    ).rejects.toThrow(message);
    await expect(fetch(origin)).rejects.toThrow();
  });

  it('expires and closes without a callback', async () => {
    let origin = '';
    await expect(
      runPkce({
        issuer,
        resource,
        scopes: CLI_SCOPES,
        clientId,
        timeoutMs: 10,
        print: () => undefined,
        openBrowser: async (url) => {
          origin = new URL(new URL(url).searchParams.get('redirect_uri')!).origin;
        },
      })
    ).rejects.toThrow('expired');
    await expect(fetch(origin)).rejects.toThrow();
  });

  it('does not retry a rejected code exchange', async () => {
    const exchange = vi.fn(
      async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
    );
    await expect(
      runPkce({
        issuer,
        resource,
        scopes: CLI_SCOPES,
        clientId,
        print: () => undefined,
        fetch: exchange as typeof fetch,
        openBrowser: async (url) => {
          const authorize = new URL(url);
          await fetch(
            `${authorize.searchParams.get('redirect_uri')}?code=replayed&state=${authorize.searchParams.get('state')}&iss=${issuer}`
          );
        },
      })
    ).rejects.toMatchObject({ code: 'invalid_grant' });
    expect(exchange).toHaveBeenCalledTimes(1);
  });
});

describe('device fallback', () => {
  const issued = {
    device_code: 'opaque-device-code',
    user_code: 'BCDF-GHJK',
    expires_in: 600,
    interval: 5,
    verification_uri: `${issuer}/oauth/device`,
    verification_uri_complete: `${issuer}/oauth/device?user_code=BCDF-GHJK`,
  };

  it('prints only the exact code and verification URIs, and permanently adds five seconds on slow_down', async () => {
    let now = 0;
    const sleeps: number[] = [];
    const responses = [
      new Response(JSON.stringify(issued), { status: 200 }),
      new Response(JSON.stringify({ error: 'slow_down' }), { status: 400 }),
      new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 400 }),
      token(),
    ];
    const lines: string[] = [];
    const fetcher = vi.fn(async (_input: string | URL, _init?: FetchInit) => responses.shift()!);
    await expect(
      runDeviceFlow({
        issuer,
        resource,
        scopes: CLI_SCOPES,
        clientId,
        deviceName: 'Headless box',
        print: (line) => lines.push(line),
        fetch: fetcher as typeof fetch,
        now: () => now,
        sleep: async (ms) => {
          sleeps.push(ms);
          now += ms;
        },
      })
    ).resolves.toMatchObject({ tokens: { access_token: 'access' } });
    const start = new URLSearchParams(String(fetcher.mock.calls[0]![1]?.body));
    expect(start.get('device_name')).toBe('Headless box');
    expect(lines).toEqual([
      'Code: BCDF-GHJK',
      `Verification URI: ${issuer}/oauth/device`,
      `Complete URI: ${issuer}/oauth/device?user_code=BCDF-GHJK`,
      DEVICE_WARNING,
    ]);
    expect(sleeps).toEqual([5000, 10_000, 10_000]);
  });

  it.each([
    [
      'the reviewer body',
      '{"device_code":"raw-device-code","user_code":"BCDF-GHJK","verification_uri":"https://auth.mnemonik.ai/device","verification_uri_complete":"https://auth.mnemonik.ai/device?device_code=raw-device-code","expires_in":1e400,"interval":0}',
    ],
    ['an expiry over ten minutes', JSON.stringify({ ...issued, expires_in: 601 })],
    ['a fractional interval', JSON.stringify({ ...issued, interval: 5.5 })],
    ['an interval below five seconds', JSON.stringify({ ...issued, interval: 4 })],
    [
      'a verification URI off the exact issuer device path',
      JSON.stringify({ ...issued, verification_uri: `${issuer}/oauth/device/extra` }),
    ],
    [
      'a complete URI carrying a device code',
      JSON.stringify({
        ...issued,
        verification_uri_complete: `${issuer}/oauth/device?device_code=opaque-device-code`,
      }),
    ],
    [
      'a complete URI carrying an extra parameter',
      JSON.stringify({
        ...issued,
        verification_uri_complete: `${issued.verification_uri_complete}&extra=1`,
      }),
    ],
    [
      'a complete URI on another origin',
      JSON.stringify({
        ...issued,
        verification_uri_complete: 'https://evil.example/device?user_code=BCDF-GHJK',
      }),
    ],
  ])('rejects %s without printing response values', async (_label, body) => {
    const lines: string[] = [];
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(body, { status: 200 }))
      .mockResolvedValueOnce(token());
    await expect(
      runDeviceFlow({
        issuer,
        resource,
        scopes: CLI_SCOPES,
        clientId,
        deviceName: 'box',
        print: (line) => lines.push(line),
        fetch: fetcher,
        sleep: async () => undefined,
      })
    ).rejects.toMatchObject({ code: 'invalid_device_response' });
    expect(lines).toEqual([]);
  });

  it('backs off transport timeouts', async () => {
    let now = 0;
    const sleeps: number[] = [];
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(issued), { status: 200 }))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(token());
    await runDeviceFlow({
      scannerRoots,
      deviceInstallationId: installationId,
      deviceInstallationIds: [installationId],
      issuer,
      resource,
      scopes: CLI_SCOPES,
      clientId,
      deviceName: 'box',
      print: () => undefined,
      fetch: fetcher,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });
    expect(sleeps).toEqual([5000, 10_000]);
    const authorization = new URLSearchParams(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(authorization.get('scanner_roots')).toBe(scannerRoots);
    expect(authorization.get('device_installation_id')).toBe(installationId);
    expect(JSON.parse(authorization.get('device_installation_ids')!)).toEqual([installationId]);
  });

  it.each([
    ['access_denied', 'denied on the other device'],
    ['expired_token', 'expired'],
  ])('stops polling on %s', async (error, message) => {
    let now = 0;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(issued), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error }), { status: 400 }));
    await expect(
      runDeviceFlow({
        issuer,
        resource,
        scopes: CLI_SCOPES,
        clientId,
        deviceName: 'box',
        print: () => undefined,
        fetch: fetcher,
        now: () => now,
        sleep: async (ms) => void (now += ms),
      })
    ).rejects.toThrow(message);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('registers once and persists the DCR client after CIMD invalid_client', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'cli-auth-'));
    dirs.push(parent);
    const credentials = createCredentialAdapter({ stateDir: join(parent, 'state') });
    let now = 0;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'invalid_client' }), { status: 400 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ client_id: 'registered-cli' }), { status: 201 })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(issued), { status: 200 }))
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(
        Response.json({ email: 'owner@example.test', deviceInstallationId: installationId })
      );
    const auth = createCliAuth({
      stateDir: join(parent, 'state'),
      noBrowser: true,
      credentials,
      fetch: fetcher,
      now: () => now,
      sleep: async (ms) => void (now += ms),
      print: () => undefined,
    });
    await expect(auth.signIn()).resolves.toMatchObject({ clientId: 'registered-cli' });
    expect(new URL(String(fetcher.mock.calls[1]![0])).pathname).toBe('/oauth/register');
    const registration = JSON.parse(String(fetcher.mock.calls[1]![1]?.body));
    expect(registration).toMatchObject({
      token_endpoint_auth_method: 'none',
      redirect_uris: ['http://127.0.0.1/callback', 'http://[::1]/callback'],
    });
    expect(registration).not.toHaveProperty('client_id');
    expect(await credentials.readCliOAuth()).toMatchObject({
      clientId: 'registered-cli',
      accessToken: 'access',
      scopes: CLI_SCOPES,
    });
  });

  it('detects a missing Linux display but not Wayland, macOS, or Windows', () => {
    expect(noBrowserAvailable('linux', {})).toBe(true);
    expect(noBrowserAvailable('linux', { WAYLAND_DISPLAY: 'wayland-0' })).toBe(false);
    expect(noBrowserAvailable('darwin', {})).toBe(false);
    expect(noBrowserAvailable('win32', {})).toBe(false);
  });
});

describe('stored CLI grant', () => {
  async function stored(expiresAt: string) {
    const parent = await mkdtemp(join(tmpdir(), 'cli-grant-'));
    dirs.push(parent);
    const credentials = createCredentialAdapter({ stateDir: join(parent, 'state') });
    await credentials.putCliOAuth(
      {
        issuer,
        clientId,
        scopes: [...CLI_SCOPES],
        familyId: 'local-family-key',
        lastRotationTime: '2026-09-11T00:00:00.000Z',
      },
      { accessToken: 'old-access', refreshToken: 'old-refresh', accessExpiresAt: expiresAt }
    );
    return credentials;
  }

  it('refreshes once for two concurrent getCliBearer callers with the exact refresh form', async () => {
    const now = Date.parse('2026-09-11T00:20:00.000Z');
    const credentials = await stored('2026-09-11T00:15:00.000Z');
    const fetcher = vi.fn(async (_url: string | URL, init?: FetchInit) => {
      const form = new URLSearchParams(String(init?.body));
      expect(Object.fromEntries(form)).toEqual({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: 'old-refresh',
        resource,
      });
      return token();
    });
    const auth = createCliAuth({ credentials, fetch: fetcher as typeof fetch, now: () => now });
    await expect(Promise.all([auth.getCliBearer(), auth.getCliBearer()])).resolves.toEqual([
      'access',
      'access',
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('revokes the CLI refresh grant before removing only its local record', async () => {
    const credentials = await stored('2026-09-11T00:15:00.000Z');
    const fetcher = vi.fn(async (_url: string | URL, init?: FetchInit) => {
      expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
        client_id: clientId,
        token: 'old-refresh',
        token_type_hint: 'refresh_token',
      });
      return new Response('{}', { status: 200 });
    });
    await createCliAuth({ credentials, fetch: fetcher as typeof fetch }).logout();
    expect(fetcher).toHaveBeenCalledWith(`${issuer}/oauth/revoke`, expect.any(Object));
    expect(await credentials.readCliOAuth()).toBeNull();
  });
});

it('login reuses owned installation identity when the session cannot read its credential', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'cli-installation-login-'));
  dirs.push(stateDir);
  await writeFile(
    join(stateDir, 'host-ownership.json'),
    JSON.stringify({
      schemaVersion: 1,
      generation: 1,
      targets: [
        {
          id: 'codex',
          profilePath: '/fixture/config',
          component: 'mcp',
          files: [],
          grant: { installationId, account: 'owner' },
        },
      ],
    })
  );
  const credentials = createCredentialAdapter({ stateDir });
  vi.spyOn(credentials, 'readCliOAuth').mockRejectedValueOnce(
    new CredentialSessionUnavailableError('keychain')
  );
  const fetcher = vi.fn(async (_url: string | URL, init?: FetchInit) => {
    expect(new URLSearchParams(String(init?.body)).get('device_installation_id')).toBe(
      installationId
    );
    throw new Error('stop_after_authorization_request');
  });
  await expect(
    createCliAuth({
      credentials,
      credentialOptions: { stateDir },
      noBrowser: true,
      fetch: fetcher as typeof fetch,
      print: () => undefined,
    }).signIn()
  ).rejects.toThrow('stop_after_authorization_request');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('browser CLI sign-in sends the hostname as the device name', async () => {
  const { hostname } = await import('node:os');
  const stateDir = await mkdtemp(join(tmpdir(), 'browser-name-'));
  dirs.push(stateDir);
  let observed: string | null = null;
  const auth = createCliAuth({
    stateDir,
    issuer,
    resource,
    platform: 'win32',
    credentials: createCredentialAdapter({ stateDir }),
    fetch: async (url) =>
      String(url).includes('/auth/grants')
        ? Response.json({ email: 'owner@example.test' })
        : token(),
    print: () => {},
    openBrowser: async (url) => {
      const authorize = new URL(url);
      observed = authorize.searchParams.get('device_name');
      await fetch(
        `${authorize.searchParams.get('redirect_uri')}?code=fixture&state=${authorize.searchParams.get('state')}&iss=${issuer}`
      );
    },
  });
  await auth.signIn();
  expect(observed).toBe(hostname());
});
