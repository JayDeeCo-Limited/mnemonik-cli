import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { provisionComponentFamily } from '../../../src/server/oauth/components.js';
import {
  CredentialError,
  SimulatedSecretStore,
  createCredentialAdapter,
  credentialPaths,
  osSecretStore,
  stateDirectory,
  windowsCurrentUserAcl,
  type ComponentCredentialResponse,
  type CliCredentialTransport,
  type CredentialTransport,
} from '../src/index.js';

const dirs: string[] = [];
const familyId = '12345678-1234-4234-8234-123456789012';
const successorId = familyId;
const pair = (suffix: string): ComponentCredentialResponse => ({
  id: successorId,
  access_token: `mnc_${suffix}`,
  refresh_token: `mncr_${suffix}`,
  token_type: 'Bearer',
  expires_in: 86400,
  refresh_expires_in: 7_776_000,
  scope: 'hooks:use',
  display_prefix: `mnc_${suffix}`.slice(0, 12),
});
const _serverShape: Awaited<ReturnType<typeof provisionComponentFamily>> = pair('server-shape');
void _serverShape;
const cliPair = (suffix: string) => ({
  access_token: `access-${suffix}`,
  refresh_token: `refresh-${suffix}`,
  token_type: 'Bearer' as const,
  expires_in: 900,
  scope: 'account:read offline_access',
});

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

async function fixture(options: Parameters<typeof createCredentialAdapter>[0] = {}) {
  const parent = await mkdtemp(join(tmpdir(), 'credentials-'));
  dirs.push(parent);
  const stateDir = join(parent, 'state');
  const adapter = createCredentialAdapter({ stateDir, ...options });
  return { parent, stateDir, adapter, paths: credentialPaths(stateDir, familyId) };
}

async function seedFamily(
  options: Parameters<typeof createCredentialAdapter>[0] = {},
  current = pair('old')
) {
  const f = await fixture(options);
  await f.adapter.putFamily('hook', current);
  return { ...f, current };
}

const reason = (value: unknown) =>
  value instanceof CredentialError ? value.reason : (value as { reason?: string }).reason;

describe('secure credential storage', () => {
  it('uses the repository state-directory shapes on Linux, macOS, and Windows', () => {
    expect(stateDirectory('linux', {}, '/u')).toBe('/u/.local/state/mnemonik');
    expect(stateDirectory('linux', { XDG_STATE_HOME: '/s' }, '/u')).toBe('/s/mnemonik');
    expect(stateDirectory('darwin', {}, '/u')).toBe('/u/Library/Application Support/Mnemonik');
    expect(
      stateDirectory('win32', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'C:\\Users\\u')
    ).toBe('C:\\Users\\u\\AppData\\Local\\Mnemonik');
  });

  it('writes file-backend records as 0600 beneath 0700 directories', async () => {
    const f = await seedFamily();
    expect((await stat(f.paths.record)).mode & 0o777).toBe(0o600);
    expect((await stat(f.paths.secret)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(f.paths.secret))).mode & 0o777).toBe(0o700);
    expect(await f.adapter.readFamily(familyId)).toMatchObject({
      store: 'file',
      familyId,
      componentKind: 'hook',
      accessToken: f.current.access_token,
      refreshToken: f.current.refresh_token,
    });
  });

  it('keeps hook, scanner and root-binding secrets in files even with an OS store', async () => {
    const secretStore = new SimulatedSecretStore();
    const f = await seedFamily({ secretStore });
    await f.adapter.putFamily('scanner', { ...pair('scanner'), id: 'scanner-family' });
    await f.adapter.hmacRootBinding(1, 'root');
    expect((await f.adapter.readFamily(familyId))?.store).toBe('file');
    expect((await f.adapter.readFamily('scanner-family'))?.store).toBe('file');
    expect(secretStore.values.size).toBe(0);
  });

  it('falls back after an OS write failure and logs only a sanitized diagnostic once', async () => {
    const secretStore = new SimulatedSecretStore();
    const diagnostic = vi.fn();
    const f = await fixture({ secretStore, onDiagnostic: diagnostic });
    vi.spyOn(secretStore, 'set').mockRejectedValue(new Error('secret-from-process-stderr'));
    const metadata = {
      issuer: 'https://auth.mnemonik.ai',
      clientId: 'cli',
      familyId: 'cli',
      scopes: [],
      lastRotationTime: new Date().toISOString(),
    };
    await f.adapter.putCliOAuth(metadata, 'refresh');
    await f.adapter.putCliOAuth(metadata, 'replacement');
    expect(await f.adapter.readCliOAuth()).toMatchObject({
      store: 'file',
      refreshToken: 'replacement',
    });
    expect(JSON.parse(await readFile(f.paths.cliRecord, 'utf8')).store).toBe('file');
    expect(diagnostic.mock.calls).toEqual([['os_store_unavailable']]);
    expect(secretStore.set).toHaveBeenCalledTimes(1);
  });

  it('uses OS storage for CLI OAuth and upgrades a file credential on persistence', async () => {
    const f = await fixture();
    const metadata = {
      issuer: 'https://auth.mnemonik.ai',
      clientId: 'cli',
      familyId: 'cli',
      scopes: [],
      lastRotationTime: new Date().toISOString(),
    };
    await f.adapter.putCliOAuth(metadata, 'old');
    const secretStore = Object.assign(new SimulatedSecretStore(), { kind: 'keychain' as const });
    const adapter = createCredentialAdapter({ stateDir: f.stateDir, secretStore });
    await adapter.putCliOAuth(metadata, 'new');
    expect(await adapter.readCliOAuth()).toMatchObject({ store: 'keychain', refreshToken: 'new' });
    expect(JSON.parse(await readFile(f.paths.cliRecord, 'utf8'))).toMatchObject({
      store: 'os',
      secretRef: 'mnemonik.credentials.v1:cli-oauth',
    });
    await expect(readFile(f.paths.cliSecret)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(secretStore.values.size).toBe(1);
    await adapter.removeCliOAuth();
    await adapter.removeCliOAuth();
    expect(secretStore.values.size).toBe(0);
  });

  it('reads one OS credential once across adapter constructions', async () => {
    const f = await fixture();
    const tokens = {
      accessToken: 'access',
      refreshToken: 'refresh',
      accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await mkdir(dirname(f.paths.cliRecord), { recursive: true, mode: 0o700 });
    await writeFile(
      f.paths.cliRecord,
      JSON.stringify({
        schemaVersion: 1,
        kind: 'cli-oauth',
        issuer: 'issuer',
        clientId: 'cli',
        familyId: 'cli',
        scopes: [],
        lastRotationTime: new Date().toISOString(),
        store: 'os',
        secretRef: 'mnemonik.credentials.v1:cli-oauth',
      }),
      { mode: 0o600 }
    );
    let stdout = '';
    const execFile = vi.fn((_file, _args, _options, callback) => {
      const stdin = new PassThrough();
      stdin.on('finish', () => callback(null, stdout, ''));
      return { stdin };
    });
    const secretStore = osSecretStore({ platform: 'linux', execFile: execFile as never })!;
    await secretStore.isAvailable();
    execFile.mockClear();
    stdout = Buffer.from(JSON.stringify(tokens)).toString('base64');

    const adapters = Array.from({ length: 5 }, () =>
      createCredentialAdapter({ stateDir: f.stateDir, secretStore })
    );
    for (const adapter of adapters) expect(await adapter.readCliOAuth()).toMatchObject(tokens);
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it.each(['missing', 'failure'] as const)(
    'reads the protected fallback after OS %s and reports its real location',
    async (mode) => {
      const secretStore = new SimulatedSecretStore();
      const diagnostic = vi.fn();
      const f = await fixture({ secretStore, onDiagnostic: diagnostic });
      const metadata = {
        issuer: 'https://auth.mnemonik.ai',
        clientId: 'cli',
        familyId: 'cli',
        scopes: [],
        lastRotationTime: new Date().toISOString(),
      };
      await f.adapter.putCliOAuth(metadata, 'os-value');
      // A file can remain after an interrupted transition; an OS read still wins.
      await mkdir(dirname(f.paths.cliSecret), { recursive: true, mode: 0o700 });
      await writeFile(
        f.paths.cliSecret,
        JSON.stringify({
          accessToken: '',
          refreshToken: 'fallback',
          accessExpiresAt: new Date(0).toISOString(),
        }),
        { mode: 0o600 }
      );
      expect((await f.adapter.readCliOAuth())?.refreshToken).toBe('os-value');
      if (mode === 'missing') secretStore.values.clear();
      else vi.spyOn(secretStore, 'get').mockRejectedValue(new Error('private stderr'));
      expect(await f.adapter.readCliOAuth()).toMatchObject({
        store: 'file',
        refreshToken: 'fallback',
      });
      expect(diagnostic).toHaveBeenCalledTimes(mode === 'failure' ? 1 : 0);
      await rm(f.paths.cliSecret);
      await expect(f.adapter.readCliOAuth()).rejects.toThrow(
        mode === 'failure' ? 'Not signed in in this session.' : 'credential_secret_missing'
      );
      await f.adapter.removeCliOAuth();
      expect(await f.adapter.readCliOAuth()).toBeNull();
    }
  );

  it('reports the GUI keychain credential as unavailable in an SSH session without copying it', async () => {
    const guiStore = Object.assign(new SimulatedSecretStore(), { kind: 'keychain' as const });
    const f = await fixture({ secretStore: guiStore });
    await f.adapter.putCliOAuth(
      {
        issuer: 'issuer',
        clientId: 'cli',
        familyId: 'cli',
        scopes: [],
        lastRotationTime: new Date().toISOString(),
      },
      'gui-refresh'
    );
    const record = await readFile(f.paths.cliRecord);
    const execFile = vi.fn((_file, _args, _options, callback) => {
      const stdin = new PassThrough();
      let input = '';
      stdin.on('data', (chunk) => {
        input += chunk.toString();
      });
      stdin.on('finish', () => {
        const denied = input.startsWith('add-generic-password');
        callback(
          denied ? Object.assign(new Error('security failed'), { code: 36 }) : null,
          '',
          denied
            ? 'security: SecKeychainItemCreateFromContent (<default>): User interaction is not allowed.\nadd-generic-password: returned -25308\n'
            : ''
        );
      });
      return { stdin };
    });
    const sshStore = osSecretStore({ platform: 'darwin', execFile: execFile as never })!;
    const ssh = createCredentialAdapter({ stateDir: f.stateDir, secretStore: sshStore });
    await expect(ssh.readCliOAuth()).rejects.toMatchObject({
      name: 'CredentialSessionUnavailableError',
      reason: 'credential_session_unavailable',
      store: 'keychain',
    });
    expect(await sshStore.isAvailable()).toBe(false);
    expect(await readFile(f.paths.cliRecord)).toEqual(record);
    await expect(readFile(f.paths.cliSecret)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(guiStore.values.size).toBe(1);
  });

  it('falls back to protected files when the OS store is absent or unavailable', async () => {
    const unavailable = new SimulatedSecretStore(false);
    const f = await seedFamily({ secretStore: unavailable });
    expect((await f.adapter.readFamily(familyId))?.store).toBe('file');
    await expect(readFile(f.paths.secret, 'utf8')).resolves.toContain(f.current.refresh_token);
  });

  it.each(['secret', 'state', 'component-parent'] as const)(
    'refuses a symlink at %s on read and write without touching its target',
    async (location) => {
      const f = await seedFamily();
      const target = join(f.parent, 'target');
      await writeFile(target, 'untouched', { mode: 0o600 });
      if (location === 'secret') {
        await rm(f.paths.secret);
        await symlink(target, f.paths.secret);
      } else if (location === 'state') {
        await rm(f.stateDir, { recursive: true });
        await symlink(dirname(target), f.stateDir);
      } else {
        const parent = dirname(f.paths.record);
        await rm(parent, { recursive: true });
        await mkdir(join(f.parent, 'linked-parent'));
        await symlink(join(f.parent, 'linked-parent'), parent);
      }
      await expect(f.adapter.readFamily(familyId)).rejects.toSatisfy(
        (error: unknown) => reason(error) === 'symlink_rejected'
      );
      await expect(f.adapter.putFamily('hook', pair('new'))).rejects.toSatisfy(
        (error: unknown) => reason(error) === 'symlink_rejected'
      );
      expect(await readFile(target, 'utf8')).toBe('untouched');
    }
  );

  it.each([0o640, 0o644])('refuses mode %o and accepts 0600', async (mode) => {
    const f = await seedFamily();
    await chmod(f.paths.secret, mode);
    await expect(f.adapter.readFamily(familyId)).rejects.toSatisfy(
      (error: unknown) => reason(error) === 'weak_permissions'
    );
    await expect(f.adapter.putFamily('hook', pair('replacement'))).rejects.toSatisfy(
      (error: unknown) => reason(error) === 'weak_permissions'
    );
    await chmod(f.paths.secret, 0o600);
    await expect(f.adapter.readFamily(familyId)).resolves.toMatchObject({ familyId });
  });

  it('refuses a credential file owned by another uid through injected lstat', async () => {
    const f = await seedFamily();
    const actual = await import('node:fs/promises');
    const adapter = createCredentialAdapter({
      stateDir: f.stateDir,
      lstat: async (path) => {
        const value = await actual.lstat(path);
        return path === f.paths.secret
          ? Object.assign(Object.create(Object.getPrototypeOf(value)), value, {
              uid: (process.getuid?.() ?? 0) + 1,
            })
          : value;
      },
    });
    await expect(adapter.readFamily(familyId)).rejects.toSatisfy(
      (error: unknown) => reason(error) === 'wrong_owner'
    );
    await expect(adapter.putFamily('hook', pair('replacement'))).rejects.toSatisfy(
      (error: unknown) => reason(error) === 'wrong_owner'
    );
  });

  it('uses icacls without a shell for a current-user-only file or directory ACL', async () => {
    const execFile = vi.fn((_file, _args, callback) => callback(null, '', ''));
    await windowsCurrentUserAcl('C:\\state\\secret.json', false, {
      execFile,
      username: 'DOMAIN\\user',
    });
    await windowsCurrentUserAcl('C:\\state', true, { execFile, username: 'DOMAIN\\user' });
    expect(execFile).toHaveBeenNthCalledWith(
      1,
      'icacls.exe',
      ['C:\\state\\secret.json', '/inheritance:r', '/grant:r', 'DOMAIN\\user:F'],
      expect.any(Function)
    );
    expect(execFile).toHaveBeenNthCalledWith(
      2,
      'icacls.exe',
      ['C:\\state', '/inheritance:r', '/grant:r', 'DOMAIN\\user:(OI)(CI)F'],
      expect.any(Function)
    );
  });
});

describe('credential records and rotation', () => {
  it('stores CLI refresh metadata without identities or absolute home paths', async () => {
    const f = await fixture();
    await f.adapter.putCliOAuth(
      {
        issuer: 'https://auth.mnemonik.ai',
        clientId: 'https://cli.mnemonik.dev/oauth/client.json',
        scopes: ['openid', 'offline_access'],
        familyId,
        lastRotationTime: '2026-09-11T00:00:00.000Z',
      },
      'refresh-secret'
    );
    expect(await f.adapter.readCliOAuth()).toMatchObject({
      store: 'file',
      refreshToken: 'refresh-secret',
      familyId,
    });
    const disk = await readFile(credentialPaths(f.stateDir).cliRecord, 'utf8');
    expect(disk).not.toContain('refresh-secret');
    expect(disk).not.toMatch(/email|accountId|\/home\//);
  });

  it('stores CLI access, refresh and expiry together outside the non-secret record', async () => {
    const f = await fixture();
    await f.adapter.putCliOAuth(
      {
        issuer: 'https://auth.mnemonik.ai',
        clientId: 'cli',
        scopes: ['offline_access'],
        familyId,
        lastRotationTime: '2026-09-11T00:00:00.000Z',
      },
      {
        accessToken: 'access-secret',
        refreshToken: 'refresh-secret',
        accessExpiresAt: '2026-09-11T00:15:00.000Z',
      }
    );
    const record = await readFile(credentialPaths(f.stateDir).cliRecord, 'utf8');
    expect(record).not.toMatch(/access-secret|refresh-secret|00:15:00/);
    expect(await f.adapter.readCliOAuth()).toMatchObject({
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      accessExpiresAt: '2026-09-11T00:15:00.000Z',
    });
  });

  it('coalesces two expired CLI callers and persists before either receives access', async () => {
    let now = Date.parse('2026-09-11T00:15:00.000Z');
    const f = await fixture({ now: () => now });
    await f.adapter.putCliOAuth(
      {
        issuer: 'https://auth.mnemonik.ai',
        clientId: 'cli',
        scopes: ['offline_access'],
        familyId,
        lastRotationTime: '2026-09-11T00:00:00.000Z',
      },
      {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        accessExpiresAt: new Date(now).toISOString(),
      }
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const rotateCli = vi.fn(async () => {
      await gate;
      return { status: 200 as const, body: cliPair('next') };
    });
    const transport: CliCredentialTransport = { rotateCli };
    const work = vi.fn(async (accessToken: string) => ({ status: 200, body: accessToken }));
    const first = f.adapter.withCliCredential(transport, work);
    const second = f.adapter.withCliCredential(transport, work);
    await vi.waitFor(() => expect(rotateCli).toHaveBeenCalledTimes(1));
    release();
    expect(await Promise.all([first, second])).toEqual([
      { status: 200, body: 'access-next' },
      { status: 200, body: 'access-next' },
    ]);
    expect(await f.adapter.readCliOAuth()).toMatchObject({ refreshToken: 'refresh-next' });
    expect(await readFile(credentialPaths(f.stateDir).cliRecord, 'utf8')).not.toMatch(
      /access-next|refresh-next/
    );
    now += 1;
  });

  it('retries one lost CLI refresh response inside 60 seconds', async () => {
    let now = 1000;
    const f = await fixture({ now: () => now, sleep: async () => void (now += 1000) });
    await f.adapter.putCliOAuth(
      {
        issuer: 'https://auth.mnemonik.ai',
        clientId: 'cli',
        scopes: ['offline_access'],
        familyId,
        lastRotationTime: new Date(now).toISOString(),
      },
      {
        accessToken: 'old',
        refreshToken: 'predecessor',
        accessExpiresAt: new Date(0).toISOString(),
      }
    );
    const rotateCli = vi
      .fn()
      .mockRejectedValueOnce(new Error('lost'))
      .mockResolvedValueOnce({ status: 200, body: cliPair('replayed') });
    expect(await f.adapter.rotateCli({ rotateCli })).toMatchObject({
      accessToken: 'access-replayed',
      refreshToken: 'refresh-replayed',
    });
    expect(rotateCli.mock.calls.map(([credential]) => credential.refreshToken)).toEqual([
      'predecessor',
      'predecessor',
    ]);
  });

  it('reports ACTION_REQUIRED after the lost-response window without restoring a successor', async () => {
    let now = 1000;
    const f = await fixture({ now: () => now, sleep: async () => void (now += 60_001) });
    await f.adapter.putCliOAuth(
      {
        issuer: 'https://auth.mnemonik.ai',
        clientId: 'cli',
        scopes: ['offline_access'],
        familyId,
        lastRotationTime: new Date(now).toISOString(),
      },
      {
        accessToken: 'old',
        refreshToken: 'predecessor',
        accessExpiresAt: new Date(0).toISOString(),
      }
    );
    const rotateCli = vi.fn().mockRejectedValue(new Error('lost'));
    expect(await f.adapter.rotateCli({ rotateCli })).toMatchObject({
      status: 'ACTION_REQUIRED',
      reason: 'rotation_response_lost',
    });
    expect(rotateCli).toHaveBeenCalledTimes(1);
    expect(await f.adapter.readCliOAuth()).not.toMatchObject({ refreshToken: 'refresh-successor' });
  });

  it('persists a replacement before rotateFamily resolves', async () => {
    const f = await seedFamily();
    const next = pair('next');
    const transport: CredentialTransport = {
      rotateFamily: vi.fn(async () => ({ status: 200 as const, body: next })),
      revokeFamily: vi.fn(),
    };
    const result = await f.adapter.rotateFamily(familyId, transport);
    expect(result).toMatchObject({
      accessToken: next.access_token,
      refreshToken: next.refresh_token,
    });
    expect(await readFile(f.paths.secret, 'utf8')).toContain(next.refresh_token);
  });

  it('retries one lost response inside 60 seconds with the same predecessor', async () => {
    let now = 1_000;
    const f = await seedFamily({ now: () => now, sleep: async () => void (now += 1_000) });
    const next = pair('replayed');
    const rotateFamily = vi
      .fn()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce({ status: 200, body: next });
    const result = await f.adapter.rotateFamily(familyId, { rotateFamily, revokeFamily: vi.fn() });
    expect(result).toMatchObject({ refreshToken: next.refresh_token });
    expect(rotateFamily).toHaveBeenNthCalledWith(1, familyId, f.current.refresh_token);
    expect(rotateFamily).toHaveBeenNthCalledWith(2, familyId, f.current.refresh_token);
    expect(await f.adapter.readFamily(familyId)).toMatchObject({
      refreshToken: next.refresh_token,
    });
  });

  it('does not retry a lost response after 60 seconds and leaves the predecessor untouched', async () => {
    let now = 1_000;
    const f = await seedFamily({ now: () => now, sleep: async () => void (now += 60_001) });
    const rotateFamily = vi.fn().mockRejectedValue(new Error('response lost'));
    const result = await f.adapter.rotateFamily(familyId, { rotateFamily, revokeFamily: vi.fn() });
    expect(result).toMatchObject({ status: 'ACTION_REQUIRED', reason: 'rotation_response_lost' });
    expect(rotateFamily).toHaveBeenCalledTimes(1);
    expect(await f.adapter.readFamily(familyId)).toMatchObject({
      refreshToken: f.current.refresh_token,
    });
  });

  it('never presents a predecessor a third time when the one lost-response retry is unavailable', async () => {
    const f = await seedFamily();
    const rotateFamily = vi
      .fn()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce({ status: 503, body: { error: 'temporarily_unavailable' } });
    expect(
      await f.adapter.rotateFamily(familyId, { rotateFamily, revokeFamily: vi.fn() })
    ).toMatchObject({ status: 'ACTION_REQUIRED', reason: 'rotation_response_lost' });
    expect(rotateFamily).toHaveBeenCalledTimes(2);
  });

  it('reports invalid_grant as ACTION_REQUIRED without another request', async () => {
    const f = await seedFamily();
    const rotateFamily = vi.fn(async () => ({
      status: 400 as const,
      body: { error: 'invalid_grant' },
    }));
    expect(
      await f.adapter.rotateFamily(familyId, { rotateFamily, revokeFamily: vi.fn() })
    ).toMatchObject({ status: 'ACTION_REQUIRED', reason: 'invalid_grant' });
    expect(rotateFamily).toHaveBeenCalledTimes(1);
  });

  it('backs off 429 and 5xx without treating either as revocation', async () => {
    const sleeps: number[] = [];
    const f = await seedFamily({ sleep: async (ms) => void sleeps.push(ms), retryLimit: 2 });
    const next = pair('after-backoff');
    const rotateFamily = vi
      .fn()
      .mockResolvedValueOnce({ status: 429, body: { error: 'rate_limited' }, retryAfterMs: 15 })
      .mockResolvedValueOnce({ status: 503, body: { error: 'temporarily_unavailable' } })
      .mockResolvedValueOnce({ status: 200, body: next });
    expect(
      await f.adapter.rotateFamily(familyId, { rotateFamily, revokeFamily: vi.fn() })
    ).toMatchObject({ refreshToken: next.refresh_token });
    expect(sleeps).toEqual([15, 500]);
  });

  it('never returns a pair when persistence fails after a committed rotation', async () => {
    const f = await seedFamily();
    const failing = createCredentialAdapter({
      stateDir: f.stateDir,
      fault: (point) => {
        if (point === 'before_secret_rename') throw new Error('disk full');
      },
    });
    const next = pair('unpersisted');
    const result = await failing.rotateFamily(familyId, {
      rotateFamily: vi.fn(async () => ({ status: 200 as const, body: next })),
      revokeFamily: vi.fn(),
    });
    expect(result).toMatchObject({ status: 'ACTION_REQUIRED', reason: 'persistence_failed' });
    expect(result).not.toHaveProperty('accessToken');
    expect(await f.adapter.readFamily(familyId)).toMatchObject({
      refreshToken: f.current.refresh_token,
    });
    expect(
      (await readdir(dirname(f.paths.secret))).filter((name) => name.endsWith('.tmp'))
    ).toEqual([]);
  });

  it('coalesces concurrent rotation through the family lease', async () => {
    const f = await seedFamily();
    const next = pair('once');
    let persistReached!: () => void;
    let releasePersist!: () => void;
    const atPersist = new Promise<void>((resolve) => (persistReached = resolve));
    const persistGate = new Promise<void>((resolve) => (releasePersist = resolve));
    const firstAdapter = createCredentialAdapter({
      stateDir: f.stateDir,
      fault: async (point) => {
        if (point !== 'before_secret_rename') return;
        persistReached();
        await persistGate;
      },
    });
    const secondAdapter = createCredentialAdapter({ stateDir: f.stateDir });
    const rotateFamily = vi.fn(async () => ({ status: 200 as const, body: next }));
    const transport = { rotateFamily, revokeFamily: vi.fn() };
    const first = firstAdapter.rotateFamily(familyId, transport);
    await atPersist;
    const second = secondAdapter.rotateFamily(familyId, transport);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const requestsBeforeRelease = rotateFamily.mock.calls.length;
    releasePersist();
    expect(requestsBeforeRelease).toBe(1);
    expect(await Promise.all([first, second])).toEqual([
      expect.objectContaining({ refreshToken: next.refresh_token }),
      expect.objectContaining({ refreshToken: next.refresh_token }),
    ]);
    expect(rotateFamily).toHaveBeenCalledTimes(1);
  });

  it('rotates and retries protected work once after a 401', async () => {
    const f = await seedFamily();
    const next = pair('work');
    const transport = {
      rotateFamily: vi.fn(async () => ({ status: 200 as const, body: next })),
      revokeFamily: vi.fn(),
    };
    const work = vi
      .fn()
      .mockResolvedValueOnce({ status: 401, body: { error: 'invalid_token' } })
      .mockResolvedValueOnce({ status: 200, body: { ok: true } });
    expect(await f.adapter.withCredential(familyId, transport, work)).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(work.mock.calls.map(([token]) => token)).toEqual([
      f.current.access_token,
      next.access_token,
    ]);
  });

  it('rotates an expired family before handing a token to protected work', async () => {
    let now = Date.parse('2026-09-11T00:00:00.000Z');
    const expired = { ...pair('expired'), expires_in: 1 };
    const f = await seedFamily({ now: () => now }, expired);
    now += 1000;
    const next = pair('fresh');
    const transport = {
      rotateFamily: vi.fn(async () => ({ status: 200 as const, body: next })),
      revokeFamily: vi.fn(),
    };
    const work = vi.fn(async (accessToken: string) => ({ status: 200, body: accessToken }));

    await expect(f.adapter.withCredential(familyId, transport, work)).resolves.toEqual({
      status: 200,
      body: next.access_token,
    });
    expect(work).toHaveBeenCalledExactlyOnceWith(next.access_token);
  });
});

describe('root binding, revocation, and local removal', () => {
  it('keeps the root-binding key private and stable across adapter instances', async () => {
    const f = await fixture();
    const first = await f.adapter.hmacRootBinding(1, 'git@example.test:owner/repo');
    const secondAdapter = createCredentialAdapter({ stateDir: f.stateDir });
    expect(await secondAdapter.hmacRootBinding(1, 'git@example.test:owner/repo')).toEqual(first);
    expect(first).toEqual({ version: 1, hmac: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    expect(first).not.toHaveProperty('key');
    const paths = credentialPaths(f.stateDir);
    expect(await readFile(paths.rootRecord, 'utf8')).not.toMatch(/[A-Za-z0-9_-]{43}/);
    expect(await readFile(paths.rootSecret)).toHaveLength(32);
  });

  it('revokes remotely before deleting local family state', async () => {
    const f = await seedFamily();
    const revokeFamily = vi.fn(async () => ({ status: 200 as const, body: {} }));
    expect(await f.adapter.revokeFamily(familyId, { rotateFamily: vi.fn(), revokeFamily })).toEqual(
      { status: 'revoked', familyId }
    );
    expect(revokeFamily).toHaveBeenCalledWith(familyId, f.current.refresh_token);
    expect(await f.adapter.readFamily(familyId)).toBeNull();
  });

  it('forget deletes local state and reports server-side families it retained', async () => {
    const f = await seedFamily();
    await f.adapter.putCliOAuth(
      {
        issuer: 'https://auth.mnemonik.ai',
        clientId: 'cli',
        scopes: ['offline_access'],
        familyId: '87654321-4321-4321-8321-210987654321',
        lastRotationTime: '2026-09-11T00:00:00.000Z',
      },
      'cli-refresh'
    );
    expect(await f.adapter.forget()).toEqual({
      status: 'forgotten',
      retainedServerSide: {
        cliFamilyId: '87654321-4321-4321-8321-210987654321',
        componentFamilyIds: [familyId],
      },
    });
    expect(await f.adapter.readFamily(familyId)).toBeNull();
    expect(await f.adapter.readCliOAuth()).toBeNull();
  });
});
