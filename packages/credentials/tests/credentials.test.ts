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
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SecureFiles } from '../src/storage.js';
import { PassThrough } from 'node:stream';
import type { provisionComponentFamily } from '../../../src/server/oauth/components.js';
import {
  CredentialError,
  SimulatedSecretStore,
  createCredentialAdapter,
  credentialPaths,
  fetchWithHookCredential,
  osSecretStore,
  stateDirectory,
  windowsCurrentUserAcl,
  type ComponentCredentialResponse,
  type CliCredentialTransport,
  type CredentialTransport,
  type HookCredential,
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

/** A barrier a test opens explicitly; `reached` resolves once the paused side arrives. */
function barrier() {
  let arrive!: () => void;
  let open!: () => void;
  const reached = new Promise<void>((resolve) => (arrive = resolve));
  const gate = new Promise<void>((resolve) => (open = resolve));
  return { reached, open, pause: () => (arrive(), gate) };
}
/** Lets a paused lease holder's rival reach its lease wait (or, unleased, its request). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

/** The server accepts only the family's current refresh token, as components.ts does. */
function familyServer(initial: string) {
  const state = { current: initial, revoked: false, generation: 0 };
  const refused = { status: 400, body: { error: 'invalid_grant' } };
  return {
    state,
    rotate: (token: string) => {
      if (state.revoked || token !== state.current) return refused;
      const next = pair(`generation-${++state.generation}`);
      state.current = next.refresh_token;
      return { status: 200 as const, body: next };
    },
    revoke: (token: string) => {
      if (state.revoked || token !== state.current) return refused;
      state.revoked = true;
      return { status: 200 as const, body: {} };
    },
  };
}

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
      secretRef: expect.stringMatching(/^mnemonik\.credentials\.v1:cli-oauth:[0-9a-f]{32}$/),
    });
    await expect(readFile(f.paths.cliSecret)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(secretStore.values.size).toBe(1);
    await adapter.removeCliOAuth();
    await adapter.removeCliOAuth();
    expect(secretStore.values.size).toBe(0);
  });

  describe('OS-store references are namespaced by state directory', () => {
    const metadata = {
      issuer: 'https://auth.mnemonik.ai',
      clientId: 'cli',
      familyId: 'cli',
      scopes: [],
      lastRotationTime: '2026-09-11T00:00:00.000Z',
    };
    const legacyRef = 'mnemonik.credentials.v1:cli-oauth';
    const encoded = (refreshToken: string) =>
      Buffer.from(
        JSON.stringify({
          accessToken: '',
          refreshToken,
          accessExpiresAt: new Date(0).toISOString(),
        })
      ).toString('base64');

    it('two state directories sharing one OS store keep their own CLI credentials', async () => {
      const secretStore = new SimulatedSecretStore();
      const a = await fixture({ secretStore });
      const b = await fixture({ secretStore });
      await a.adapter.putCliOAuth(metadata, 'refresh-a');
      await b.adapter.putCliOAuth(metadata, 'refresh-b');
      expect(await a.adapter.readCliOAuth()).toMatchObject({ refreshToken: 'refresh-a' });
      expect(await b.adapter.readCliOAuth()).toMatchObject({ refreshToken: 'refresh-b' });
      const refs = [a, b].map(
        (f) => JSON.parse(readFileSync(f.paths.cliRecord, 'utf8')).secretRef as string
      );
      expect(refs[0]).toMatch(/^mnemonik\.credentials\.v1:cli-oauth:[0-9a-f]{32}$/);
      expect(refs[0]).not.toBe(refs[1]);
      // The same directory named another way resolves to the same entry.
      const again = createCredentialAdapter({
        stateDir: join(a.stateDir, '..', 'state'),
        secretStore,
      });
      expect(await again.readCliOAuth()).toMatchObject({ refreshToken: 'refresh-a' });
      await again.putCliOAuth(metadata, 'refresh-a2');
      expect(JSON.parse(readFileSync(a.paths.cliRecord, 'utf8')).secretRef).toBe(refs[0]);
    });

    it('a legacy record keeps reading and rewriting its un-namespaced entry', async () => {
      const secretStore = new SimulatedSecretStore();
      const f = await fixture({ secretStore });
      await mkdir(dirname(f.paths.cliRecord), { recursive: true, mode: 0o700 });
      await writeFile(
        f.paths.cliRecord,
        JSON.stringify({
          schemaVersion: 1,
          kind: 'cli-oauth',
          ...metadata,
          store: 'os',
          secretRef: legacyRef,
        }),
        { mode: 0o600 }
      );
      secretStore.values.set(legacyRef, encoded('legacy'));
      expect(await f.adapter.readCliOAuth()).toMatchObject({ refreshToken: 'legacy' });
      await f.adapter.putCliOAuth(metadata, 'legacy-next');
      expect(JSON.parse(await readFile(f.paths.cliRecord, 'utf8')).secretRef).toBe(legacyRef);
      expect([...secretStore.values.keys()]).toEqual([legacyRef]);
    });

    it('a legacy OS-backed family rotates in place under its stored reference', async () => {
      const secretStore = new SimulatedSecretStore();
      const f = await seedFamily({ secretStore });
      const ref = `mnemonik.credentials.v1:component:${familyId}`;
      const record = JSON.parse(await readFile(f.paths.record, 'utf8'));
      delete record.secretFile;
      await writeFile(f.paths.record, JSON.stringify({ ...record, store: 'os', secretRef: ref }));
      secretStore.values.set(
        ref,
        Buffer.from(
          JSON.stringify({ accessToken: 'a', refreshToken: f.current.refresh_token })
        ).toString('base64')
      );
      await rm(f.paths.secret);
      const next = pair('legacy-next');
      expect(
        await f.adapter.rotateFamily(familyId, {
          rotateFamily: async () => ({ status: 200, body: next }),
          revokeFamily: vi.fn(),
        })
      ).toMatchObject({ refreshToken: next.refresh_token });
      expect(JSON.parse(await readFile(f.paths.record, 'utf8')).secretRef).toBe(ref);
      expect([...secretStore.values.keys()]).toEqual([ref]);
    });

    it('forget removes only its own namespaced OS entry left without a record', async () => {
      const secretStore = new SimulatedSecretStore();
      const a = await fixture({ secretStore });
      const b = await fixture({ secretStore });
      await a.adapter.putCliOAuth(metadata, 'refresh-a');
      await b.adapter.putCliOAuth(metadata, 'refresh-b');
      const own = JSON.parse(await readFile(a.paths.cliRecord, 'utf8')).secretRef as string;
      // A crash after the OS write and before the record write leaves the entry unowned.
      await rm(a.paths.cliRecord);
      secretStore.values.set(legacyRef, encoded('unattributable'));
      expect(secretStore.values.has(own)).toBe(true);

      expect(await a.adapter.forget()).toEqual({
        status: 'forgotten',
        retainedServerSide: { componentFamilyIds: [] },
      });
      expect(secretStore.values.has(own)).toBe(false);
      expect(secretStore.values.get(legacyRef)).toBe(encoded('unattributable'));
      expect(await b.adapter.readCliOAuth()).toMatchObject({ refreshToken: 'refresh-b' });
    });
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

  it('a new sign-in waits for a CLI rotation holding the lease instead of being overwritten', async () => {
    const f = await fixture();
    const metadata = {
      issuer: 'https://auth.mnemonik.ai',
      clientId: 'cli',
      scopes: ['offline_access'],
      familyId,
      lastRotationTime: '2026-09-11T00:00:00.000Z',
    };
    await f.adapter.putCliOAuth(metadata, {
      accessToken: 'old-access',
      refreshToken: 'old-grant',
      accessExpiresAt: new Date(0).toISOString(),
    });
    const persist = barrier();
    const rotation = createCredentialAdapter({
      stateDir: f.stateDir,
      fault: async (point) => {
        if (point === 'before_secret_rename') await persist.pause();
      },
    }).rotateCli({ rotateCli: async () => ({ status: 200, body: cliPair('old-grant-next') }) });
    await persist.reached;
    let settled = false;
    const signIn = createCredentialAdapter({ stateDir: f.stateDir })
      .putCliOAuth(metadata, {
        accessToken: 'new-access',
        refreshToken: 'new-grant',
        accessExpiresAt: new Date(0).toISOString(),
      })
      .finally(() => (settled = true));
    await settle();
    expect(settled).toBe(false);
    persist.open();

    expect(await rotation).toMatchObject({ refreshToken: 'refresh-old-grant-next' });
    await signIn;
    expect(await f.adapter.readCliOAuth()).toMatchObject({ refreshToken: 'new-grant' });
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
    expect(rotateFamily).toHaveBeenCalledWith(familyId, f.current.refresh_token);
    expect(await readFile(f.paths.secret, 'utf8')).toContain(next.refresh_token);
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

  it('revokes the rotated grant when a rotation holds the family lease first', async () => {
    const f = await seedFamily();
    const server = familyServer(f.current.refresh_token);
    const persist = barrier();
    // The server has committed A->B; the rotating process has not yet persisted B.
    const rotating = createCredentialAdapter({
      stateDir: f.stateDir,
      fault: async (point) => {
        if (point === 'before_secret_rename') await persist.pause();
      },
    });
    const revoking = createCredentialAdapter({ stateDir: f.stateDir });
    const revokeFamily = vi.fn(async (_id: string, token: string) => server.revoke(token));
    const rotation = rotating.rotateFamily(familyId, {
      rotateFamily: async (_id, token) => server.rotate(token),
      revokeFamily: vi.fn(),
    });
    await persist.reached;
    const revocation = revoking.revokeFamily(familyId, { rotateFamily: vi.fn(), revokeFamily });
    await settle();
    expect(revokeFamily).not.toHaveBeenCalled();
    persist.open();

    expect(await rotation).toMatchObject({ refreshToken: server.state.current });
    expect(await revocation).toEqual({ status: 'revoked', familyId });
    expect(revokeFamily).toHaveBeenCalledExactlyOnceWith(
      familyId,
      pair('generation-1').refresh_token
    );
    expect(server.state.revoked).toBe(true);
    expect(await f.adapter.readFamily(familyId)).toBeNull();
    await expect(readFile(f.paths.secret)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('holds the family lease through remote revocation so a later rotation finds no family', async () => {
    const f = await seedFamily();
    const server = familyServer(f.current.refresh_token);
    const remote = barrier();
    const revoking = createCredentialAdapter({ stateDir: f.stateDir });
    const rotating = createCredentialAdapter({ stateDir: f.stateDir });
    const rotateFamily = vi.fn(async (_id: string, token: string) => server.rotate(token));
    // The revoke request carrying A is in flight when the second process starts rotating.
    const revocation = revoking.revokeFamily(familyId, {
      rotateFamily: vi.fn(),
      revokeFamily: async (_id, token) => {
        await remote.pause();
        return server.revoke(token);
      },
    });
    await remote.reached;
    const rotation = rotating.rotateFamily(familyId, { rotateFamily, revokeFamily: vi.fn() });
    await settle();
    expect(rotateFamily).not.toHaveBeenCalled();
    remote.open();

    expect(await revocation).toEqual({ status: 'revoked', familyId });
    expect(await rotation).toEqual({
      status: 'ACTION_REQUIRED',
      reason: 'family_missing',
      familyId,
    });
    expect(rotateFamily).not.toHaveBeenCalled();
    expect(server.state).toMatchObject({ revoked: true, generation: 0 });
    expect(await f.adapter.readFamily(familyId)).toBeNull();
  });

  it.each([
    ['rate limited', { status: 429, body: { error: 'rate_limited' } }, 'rate_limited'],
    ['unavailable', { status: 503, body: { error: 'temporarily_unavailable' } }, 'server_error'],
  ] as const)(
    'keeps the current family retryable when revocation is %s',
    async (_label, response, retry) => {
      const f = await seedFamily();
      const revokeFamily = vi.fn().mockResolvedValueOnce(response);
      const transport = { rotateFamily: vi.fn(), revokeFamily };
      expect(await f.adapter.revokeFamily(familyId, transport)).toEqual({
        status: 'RETRY_LATER',
        reason: retry,
        familyId,
      });
      expect(await f.adapter.readFamily(familyId)).toMatchObject({
        refreshToken: f.current.refresh_token,
      });
      // The lease was released: the retry proceeds at once and completes.
      revokeFamily.mockResolvedValueOnce({ status: 200, body: {} });
      expect(await f.adapter.revokeFamily(familyId, transport)).toEqual({
        status: 'revoked',
        familyId,
      });
      expect(await f.adapter.readFamily(familyId)).toBeNull();
    }
  );

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

  const cliMetadata = {
    issuer: 'https://auth.mnemonik.ai',
    clientId: 'cli',
    scopes: ['offline_access'],
    familyId: '87654321-4321-4321-8321-210987654321',
    lastRotationTime: '2026-09-11T00:00:00.000Z',
  };
  /** Forget must leave nothing of the family, the CLI credential or the root binding. */
  async function expectForgotten(f: Awaited<ReturnType<typeof seedFamily>>) {
    for (const path of [
      f.paths.record,
      f.paths.secret,
      f.paths.cliRecord,
      f.paths.cliSecret,
      f.paths.rootRecord,
      f.paths.rootSecret,
    ])
      await expect(stat(path), path).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await f.adapter.readFamily(familyId)).toBeNull();
    expect(await f.adapter.readCliOAuth()).toBeNull();
  }
  const forgotten = {
    status: 'forgotten',
    retainedServerSide: { cliFamilyId: cliMetadata.familyId, componentFamilyIds: [familyId] },
  };

  it('forget erases a quiet store, root binding and directories included', async () => {
    const f = await seedFamily();
    await f.adapter.putCliOAuth(cliMetadata, 'cli-refresh');
    await f.adapter.hmacRootBinding(1, 'root');
    expect(await f.adapter.forget()).toEqual(forgotten);
    await expectForgotten(f);
    await expect(stat(f.paths.root)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await f.adapter.forget()).toEqual({
      status: 'forgotten',
      retainedServerSide: { componentFamilyIds: [] },
    });
  });

  it('forget reads only family record files, never lease directories or temporaries', async () => {
    const f = await seedFamily();
    const families = dirname(f.paths.record);
    // Left by another family's lease holder and by an interrupted atomic write.
    await mkdir(join(families, `${'f'.repeat(64)}.json.lock`), { mode: 0o700 });
    await writeFile(`${f.paths.record}.interrupted.tmp`, '{', { mode: 0o600 });
    expect(await f.adapter.forget()).toEqual({
      status: 'forgotten',
      retainedServerSide: { componentFamilyIds: [familyId] },
    });
    expect(await f.adapter.readFamily(familyId)).toBeNull();
    await expect(stat(f.paths.secret)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('forget erases orphan family secrets and crash-left temporaries', async () => {
    const f = await fixture();
    const orphan = credentialPaths(f.stateDir, 'orphan-family');
    // A crash after the secret write and before the record write leaves these behind.
    await mkdir(dirname(orphan.secret), { recursive: true, mode: 0o700 });
    await writeFile(orphan.secret, '{"accessToken":"a","refreshToken":"r"}', { mode: 0o600 });
    const temporary = `${orphan.secret}.12345678-1234-4234-8234-123456789012.tmp`;
    await writeFile(temporary, '{"refreshToken":"partial"', { mode: 0o600 });
    expect(await f.adapter.forget()).toEqual({
      status: 'forgotten',
      retainedServerSide: { componentFamilyIds: [] },
    });
    for (const path of [orphan.secret, temporary])
      await expect(stat(path), path).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(f.paths.root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('forget waits for a family being provisioned instead of orphaning its record', async () => {
    const f = await fixture();
    const record = barrier();
    const provisioning = createCredentialAdapter({
      stateDir: f.stateDir,
      fault: async (point) => {
        if (point === 'before_record_rename') await record.pause();
      },
    }).putFamily('hook', pair('provisioned'));
    await record.reached;
    let settled = false;
    const forget = f.adapter.forget().finally(() => (settled = true));
    await settle();
    expect(settled).toBe(false);
    record.open();

    await provisioning;
    expect(await forget).toEqual({
      status: 'forgotten',
      retainedServerSide: { componentFamilyIds: [familyId] },
    });
    for (const path of [f.paths.record, f.paths.secret])
      await expect(stat(path), path).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await f.adapter.readFamily(familyId)).toBeNull();
  });

  it('forget erases CLI and root-binding orphans and crash-left temporaries', async () => {
    const f = await fixture();
    const uuid = '12345678-1234-4234-8234-123456789012';
    const leftovers = [
      f.paths.cliSecret,
      `${f.paths.cliSecret}.${uuid}.tmp`,
      `${f.paths.cliRecord}.${uuid}.tmp`,
      f.paths.rootSecret,
      `${f.paths.rootSecret}.${uuid}.tmp`,
      `${f.paths.rootRecord}.${uuid}.tmp`,
    ];
    for (const directory of [f.paths.records, f.paths.secrets])
      await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const path of leftovers) await writeFile(path, 'partial', { mode: 0o600 });
    expect(await f.adapter.forget()).toEqual({
      status: 'forgotten',
      retainedServerSide: { componentFamilyIds: [] },
    });
    for (const path of leftovers)
      await expect(stat(path), path).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(f.paths.root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('forget waits for a first sign-in mid-write instead of deleting its temporaries', async () => {
    const f = await fixture();
    const record = barrier();
    const signIn = createCredentialAdapter({
      stateDir: f.stateDir,
      fault: async (point) => {
        if (point === 'before_record_rename') await record.pause();
      },
    }).putCliOAuth(cliMetadata, 'first-sign-in');
    await record.reached;
    let settled = false;
    const forget = f.adapter.forget().finally(() => (settled = true));
    await settle();
    expect(settled).toBe(false);
    record.open();

    await signIn;
    expect(await forget).toEqual({
      status: 'forgotten',
      retainedServerSide: { cliFamilyId: cliMetadata.familyId, componentFamilyIds: [] },
    });
    await expectForgotten(Object.assign(f, { current: pair('unused') }));
  });

  it('revokes with an orphan secret whose record a crash never wrote, then removes it', async () => {
    const f = await seedFamily();
    await rm(f.paths.record);
    const revokeFamily = vi.fn(async () => ({ status: 200 as const, body: {} }));
    expect(await f.adapter.revokeFamily(familyId, { rotateFamily: vi.fn(), revokeFamily })).toEqual(
      { status: 'revoked', familyId }
    );
    expect(revokeFamily).toHaveBeenCalledExactlyOnceWith(familyId, f.current.refresh_token);
    await expect(stat(f.paths.secret)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps an orphan secret when the issuer refuses its revocation', async () => {
    const f = await seedFamily();
    await rm(f.paths.record);
    const revokeFamily = vi.fn(async () => ({ status: 403, body: { error: 'forbidden' } }));
    expect(await f.adapter.revokeFamily(familyId, { rotateFamily: vi.fn(), revokeFamily })).toEqual(
      { status: 'ACTION_REQUIRED', reason: 'forbidden', familyId }
    );
    expect((await stat(f.paths.secret)).isFile()).toBe(true);
  });

  /**
   * An orphan secret (no record) is removed only when the issuer confirms its grant is
   * revoked. The issuer answers 200 to any refresh token of a revoked grant (superseded or
   * expired included, src/server/oauth/components.ts), and invalid_grant only to a token that
   * names no revoked grant: an unknown token (another server, a purged payload) or a live
   * grant's expired or superseded one. That grant may be live, and the orphan is the only
   * local trace of it, so it is kept and reported ACTION_REQUIRED (review round 4 of CQ-020
   * replaced round 3's "invalid_grant means dead" rule). With a record, as before.
   */
  it('an orphan secret the issuer answers invalid_grant is kept: ACTION_REQUIRED', async () => {
    const f = await seedFamily();
    await rm(f.paths.record);
    const revokeFamily = vi.fn(async () => ({ status: 400, body: { error: 'invalid_grant' } }));
    expect(await f.adapter.revokeFamily(familyId, { rotateFamily: vi.fn(), revokeFamily })).toEqual(
      { status: 'ACTION_REQUIRED', reason: 'invalid_grant', familyId }
    );
    await expect(stat(f.paths.secret)).resolves.toBeTruthy();
  });

  it('an orphan secret whose grant the issuer already revoked is removed', async () => {
    const f = await seedFamily();
    await rm(f.paths.record);
    // The issuer answers 200 to any refresh token of a revoked grant.
    const revokeFamily = vi.fn(async () => ({ status: 200 as const, body: {} }));
    expect(await f.adapter.revokeFamily(familyId, { rotateFamily: vi.fn(), revokeFamily })).toEqual(
      { status: 'revoked', familyId }
    );
    await expect(stat(f.paths.secret)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a recorded family the issuer answers invalid_grant stays ACTION_REQUIRED and is kept', async () => {
    const f = await seedFamily();
    const revokeFamily = vi.fn(async () => ({ status: 400, body: { error: 'invalid_grant' } }));
    expect(await f.adapter.revokeFamily(familyId, { rotateFamily: vi.fn(), revokeFamily })).toEqual(
      { status: 'ACTION_REQUIRED', reason: 'invalid_grant', familyId }
    );
    expect(await f.adapter.readFamily(familyId)).toMatchObject({ refreshToken: 'mncr_old' });
  });

  it('forget waits for a rotation holding the family lease, then erases its successor', async () => {
    const f = await seedFamily();
    await f.adapter.putCliOAuth(cliMetadata, 'cli-refresh');
    await f.adapter.hmacRootBinding(1, 'root');
    const server = familyServer(f.current.refresh_token);
    const persist = barrier();
    const rotation = createCredentialAdapter({
      stateDir: f.stateDir,
      fault: async (point) => {
        if (point === 'before_secret_rename') await persist.pause();
      },
    }).rotateFamily(familyId, {
      rotateFamily: async (_id, token) => server.rotate(token),
      revokeFamily: vi.fn(),
    });
    await persist.reached;
    // The rotation's lease directory sits beside the record forget enumerates.
    expect((await stat(`${f.paths.record}.lock`)).isDirectory()).toBe(true);
    let settled = false;
    const forget = createCredentialAdapter({ stateDir: f.stateDir })
      .forget()
      .finally(() => (settled = true));
    await settle();
    expect(settled).toBe(false);
    persist.open();

    expect(await rotation).toMatchObject({ refreshToken: server.state.current });
    expect(await forget).toEqual(forgotten);
    await expectForgotten(f);
  });

  it('a rotation waiting behind forget rereads, finds no family and recreates nothing', async () => {
    const f = await seedFamily();
    await f.adapter.putCliOAuth(cliMetadata, 'cli-refresh');
    await f.adapter.hmacRootBinding(1, 'root');
    const server = familyServer(f.current.refresh_token);
    const erase = barrier();
    const actual = await import('node:fs/promises');
    // Pause forget inside the family erase, just before it removes the family secret.
    const forget = createCredentialAdapter({
      stateDir: f.stateDir,
      lstat: async (path) => {
        if (path === f.paths.secret) await erase.pause();
        return actual.lstat(path);
      },
    }).forget();
    await erase.reached;
    const rotateFamily = vi.fn(async (_id: string, token: string) => server.rotate(token));
    const rotation = createCredentialAdapter({ stateDir: f.stateDir }).rotateFamily(familyId, {
      rotateFamily,
      revokeFamily: vi.fn(),
    });
    await settle();
    expect(rotateFamily).not.toHaveBeenCalled();
    erase.open();

    expect(await forget).toEqual(forgotten);
    expect(await rotation).toEqual({
      status: 'ACTION_REQUIRED',
      reason: 'family_missing',
      familyId,
    });
    expect(rotateFamily).not.toHaveBeenCalled();
    await expectForgotten(f);
  });
});

describe('review follow-ups: hot-path root key, removal crash window, symlinked state', () => {
  const cli = {
    issuer: 'https://auth.mnemonik.ai',
    clientId: 'cli',
    scopes: ['offline_access'],
    familyId: '87654321-4321-4321-8321-210987654321',
    lastRotationTime: '2026-09-11T00:00:00.000Z',
  };
  const revoked = { status: 200 as const, body: {} };

  it('creates the root binding directories once; later root-key reads never ensure them', async () => {
    const f = await fixture();
    const ensureParent = vi.spyOn(SecureFiles.prototype, 'ensureParent');
    const first = await f.adapter.hmacRootBinding(1, 'root-a');
    expect(ensureParent).toHaveBeenCalled();
    ensureParent.mockClear();
    // The hook hot path: the same process and a fresh one (another hook run).
    const again = createCredentialAdapter({ stateDir: f.stateDir });
    for (let i = 0; i < 3; i++) {
      expect(await f.adapter.hmacRootBinding(1, 'root-a')).toEqual(first);
      expect(await again.hmacRootBinding(1, 'root-a')).toEqual(first);
    }
    expect(ensureParent).not.toHaveBeenCalled();
    // No lease directory is left behind by the reads either.
    const records = await readdir(dirname(credentialPaths(f.stateDir).rootRecord));
    expect(records.filter((name) => name.endsWith('.lock'))).toEqual([]);
  });

  it('a root key erased by forget is created afresh, directories first', async () => {
    const f = await fixture();
    const first = await f.adapter.hmacRootBinding(1, 'root-a');
    await f.adapter.forget();
    const ensureParent = vi.spyOn(SecureFiles.prototype, 'ensureParent');
    const second = await f.adapter.hmacRootBinding(1, 'root-a');
    expect(second).not.toEqual(first);
    expect(ensureParent).toHaveBeenCalled();
  });

  /** A crash between the two deletes of a removal: the second delete never happens. */
  function crashOnSecondDelete(f: Awaited<ReturnType<typeof fixture>>) {
    const remove = SecureFiles.prototype.remove;
    let deletes = 0;
    return vi.spyOn(SecureFiles.prototype, 'remove').mockImplementation(async function (
      this: SecureFiles,
      path: string
    ) {
      if (path.startsWith(f.stateDir) && !path.includes('.tmp') && ++deletes === 2)
        throw new Error('simulated crash');
      return remove.call(this, path);
    });
  }

  it('a crash mid sign-out leaves nothing that blocks sign-out or sign-in', async () => {
    const f = await fixture();
    await f.adapter.putCliOAuth(cli, 'refresh-1');
    const crash = crashOnSecondDelete(f);
    await expect(f.adapter.revokeCli({ revokeCli: vi.fn(async () => revoked) })).rejects.toThrow(
      'simulated crash'
    );
    crash.mockRestore();

    // Signed out on the server; locally nothing may pretend otherwise or wedge.
    expect(await f.adapter.readCliOAuth()).toBeNull();
    const revokeAgain = vi.fn(async () => revoked);
    expect(await f.adapter.revokeCli({ revokeCli: revokeAgain })).toMatchObject({
      reason: 'family_missing',
    });
    expect(revokeAgain).not.toHaveBeenCalled();
    await f.adapter.putCliOAuth(cli, 'refresh-2');
    expect(await f.adapter.readCliOAuth()).toMatchObject({ refreshToken: 'refresh-2' });
  });

  it('a crash mid family removal leaves an orphan secret that rollback can still revoke', async () => {
    const f = await seedFamily();
    const crash = crashOnSecondDelete(f);
    const transport = { rotateFamily: vi.fn(), revokeFamily: vi.fn(async () => revoked) };
    await expect(f.adapter.revokeFamily(familyId, transport)).rejects.toThrow('simulated crash');
    crash.mockRestore();

    expect(await f.adapter.readFamily(familyId)).toBeNull();
    expect(await f.adapter.revokeFamily(familyId, transport)).toEqual({
      status: 'revoked',
      familyId,
    });
    await expect(stat(f.paths.secret)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a record whose secret is gone (an older crash) is removed, not a permanent failure', async () => {
    const f = await seedFamily();
    await f.adapter.putCliOAuth(cli, 'refresh-1');
    await rm(f.paths.secret);
    await rm(f.paths.cliSecret);

    const cliRevoke = vi.fn(async () => revoked);
    expect(await f.adapter.revokeCli({ revokeCli: cliRevoke })).toMatchObject({
      status: 'ACTION_REQUIRED',
      reason: 'credential_secret_missing',
    });
    expect(cliRevoke).not.toHaveBeenCalled();
    expect(await f.adapter.revokeCli({ revokeCli: cliRevoke })).toMatchObject({
      reason: 'family_missing',
    });

    const transport = { rotateFamily: vi.fn(), revokeFamily: vi.fn(async () => revoked) };
    expect(await f.adapter.revokeFamily(familyId, transport)).toMatchObject({
      status: 'ACTION_REQUIRED',
      reason: 'credential_secret_missing',
    });
    expect(await f.adapter.revokeFamily(familyId, transport)).toMatchObject({
      reason: 'family_missing',
    });
    expect(transport.revokeFamily).not.toHaveBeenCalled();
    await expect(stat(f.paths.record)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(f.paths.cliRecord)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  /**
   * The configured state root's parent is canonicalized once (realpath), trusting the
   * directories above the root - a symlinked home (/home -> /data/home) or macOS /var -> /private/var must not
   * break every credential operation. Every component at or inside the canonical root is
   * still lstat()ed and a symbolic link there is refused, with the owner and mode checks.
   */
  it.skipIf(process.platform === 'win32')(
    'a state directory under a symlinked ancestor works and shares the canonical OS entry',
    async () => {
      const secretStore = new SimulatedSecretStore();
      const f = await fixture({ secretStore });
      await f.adapter.putCliOAuth(cli, 'refresh-real');
      const root = await f.adapter.hmacRootBinding(1, 'root');
      const link = join(f.parent, 'linked-parent');
      await symlink(f.parent, link, 'dir');
      const linked = createCredentialAdapter({ stateDir: join(link, 'state'), secretStore });

      expect(await linked.readCliOAuth()).toMatchObject({ refreshToken: 'refresh-real' });
      expect(await linked.hmacRootBinding(1, 'root')).toEqual(root);
      await linked.putCliOAuth(cli, 'refresh-linked');
      expect(secretStore.values.size).toBe(1);
      expect(await f.adapter.readCliOAuth()).toMatchObject({ refreshToken: 'refresh-linked' });
      await linked.putFamily('hook', pair('linked'));
      expect(await f.adapter.readFamily(familyId)).toMatchObject({ refreshToken: 'mncr_linked' });
    }
  );

  it.skipIf(process.platform === 'win32')(
    'a state root that is itself a symlink is refused, even when configured as one',
    async () => {
      const parent = await mkdtemp(join(tmpdir(), 'credentials-'));
      dirs.push(parent);
      const elsewhere = join(parent, 'elsewhere');
      await mkdir(elsewhere, { mode: 0o700 });
      const root = join(parent, 'state');
      await symlink(elsewhere, root, 'dir');
      const adapter = createCredentialAdapter({ stateDir: root });

      await expect(adapter.readCliOAuth()).rejects.toMatchObject({
        reason: 'symlink_rejected',
        message: expect.stringMatching(/state directory is a symbolic link/),
      });
      await expect(adapter.putCliOAuth(cli, 'refresh-0')).rejects.toMatchObject({
        reason: 'symlink_rejected',
      });
      expect(await readdir(elsewhere)).toEqual([]);
    }
  );

  it.skipIf(process.platform === 'win32')(
    'a symlink inside the state directory is still refused',
    async () => {
      const f = await fixture();
      await f.adapter.putCliOAuth(cli, 'refresh-real');
      const elsewhere = join(f.parent, 'elsewhere');
      await mkdir(elsewhere, { mode: 0o700 });
      const credentialsDir = dirname(dirname(f.paths.cliRecord));
      await rm(credentialsDir, { recursive: true, force: true });
      await symlink(elsewhere, credentialsDir, 'dir');

      await expect(f.adapter.readCliOAuth()).rejects.toMatchObject({ reason: 'symlink_rejected' });
      await expect(f.adapter.putCliOAuth(cli, 'refresh-2')).rejects.toMatchObject({
        reason: 'symlink_rejected',
      });
      expect(await readdir(elsewhere)).toEqual([]);
    }
  );

  it('a rotation backing off for Retry-After does not hold the lease while it waits', async () => {
    // Time is faked through the adapter's sleep: the Retry-After wait is a gate the test opens.
    const slept: number[] = [];
    let wake!: () => void;
    const f = await fixture({
      sleep: (ms: number) => {
        slept.push(ms);
        return new Promise<void>((resolve) => (wake = resolve));
      },
    });
    await f.adapter.putCliOAuth(cli, 'refresh-0');
    const rotateCli = vi
      .fn()
      .mockResolvedValueOnce({ status: 429, body: { error: 'slow_down' }, retryAfterMs: 30_000 })
      .mockResolvedValue({ status: 200, body: cliPair('late') });
    const rotation = f.adapter.rotateCli({ rotateCli });
    await vi.waitFor(() => expect(slept).toEqual([30_000]));

    // A sign-in during the back-off gets the lease at once (lockWaitMs 500, not 30 s).
    const signIn = createCredentialAdapter({ stateDir: f.stateDir, lockWaitMs: 500 });
    await signIn.putCliOAuth(cli, 'refresh-signed-in');
    wake();

    // The rotation rereads after reacquiring: the credential changed, so it is not rotated.
    expect(await rotation).toMatchObject({ refreshToken: 'refresh-signed-in' });
    expect(rotateCli).toHaveBeenCalledTimes(1);
  });

  it('a lost response is still retried once inside the lease (rotation_response_lost kept)', async () => {
    const f = await fixture({ sleep: async () => undefined });
    await f.adapter.putCliOAuth(cli, 'refresh-0');
    const rotateCli = vi.fn().mockRejectedValue(new Error('socket hang up'));
    expect(await f.adapter.rotateCli({ rotateCli })).toMatchObject({
      status: 'ACTION_REQUIRED',
      reason: 'rotation_response_lost',
    });
    expect(rotateCli).toHaveBeenCalledTimes(2);
  });
});

describe('fetchWithHookCredential: an unavailable credential says whether it is lasting', () => {
  const server = 'https://mnemonik.test';
  const target = `${server}/api/v1/session/track-ide-edit`;

  /** A hook family whose access token has expired, so the next call must rotate first. */
  async function expiredHookFamily() {
    const f = await seedFamily();
    const credentials = createCredentialAdapter({
      stateDir: f.stateDir,
      retryLimit: 0,
      lockWaitMs: 2_000,
      sleep: async () => undefined,
      now: () => Date.now() + 2 * 86_400_000,
    });
    return { familyId, server, credentials, unavailable: false } as unknown as HookCredential;
  }

  function stubRotation(rotate: () => Promise<Response>) {
    const fetchMock = vi.fn(async (url: unknown) =>
      String(url).endsWith('/rotate') ? rotate() : new Response('{"ok":true}', { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }
  afterEach(() => vi.unstubAllGlobals());
  const post = (credential: HookCredential) =>
    fetchWithHookCredential(credential, target, { method: 'POST', body: '{}' });

  it('a rotation answered 5xx is a transient 503 marker, and the family stays usable', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const credential = await expiredHookFamily();
    stubRotation(async () => new Response('{"error":"temporarily_unavailable"}', { status: 503 }));
    const response = await post(credential);
    expect(response.status).toBe(503);
    expect(response.headers.get('x-mnemonik-credential')).toBe('unavailable');
    expect(await response.json()).toEqual({
      ok: false,
      retryable: true,
      reason: 'credential_unavailable',
    });
    expect((credential as { unavailable: boolean }).unavailable).toBe(false);
  });

  it('a lost rotation response is transient too', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const credential = await expiredHookFamily();
    stubRotation(async () => {
      throw new TypeError('fetch failed');
    });
    const response = await post(credential);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ retryable: true });
  });

  it('invalid_grant is a lasting 403 refusal and later calls send nothing', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const credential = await expiredHookFamily();
    const fetchMock = stubRotation(
      async () => new Response('{"error":"invalid_grant"}', { status: 400 })
    );
    const first = await post(credential);
    expect(first.status).toBe(403);
    expect(await first.json()).toEqual({ ok: false });
    const second = await post(credential);
    expect(second.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("the caller's timeout covers a rotation waiting on another holder's lease", async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const credential = await expiredHookFamily();
    const { credentials } = credential as unknown as {
      credentials: ReturnType<typeof createCredentialAdapter>;
    };
    // Another hook process holds the family lease through a rotation that has not answered.
    const holder = barrier();
    const held = credentials.rotateFamily(familyId, {
      rotateFamily: async () => {
        await holder.pause();
        return { status: 503 as const, body: { error: 'temporarily_unavailable' } };
      },
      revokeFamily: vi.fn(),
    });
    await holder.reached;
    stubRotation(async () => new Response('{}', { status: 503 }));
    const started = Date.now();
    await expect(
      fetchWithHookCredential(credential, target, {
        method: 'POST',
        body: '{}',
        signal: AbortSignal.timeout(150),
      })
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    // Bounded by the caller's 150 ms, not by the adapter's 2 s lease wait.
    expect(Date.now() - started).toBeLessThan(1_000);
    holder.open();
    await held;
  });

  it('no credential at all is a lasting 403 refusal', async () => {
    const response = await post(null as unknown as HookCredential);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false });
  });
});
