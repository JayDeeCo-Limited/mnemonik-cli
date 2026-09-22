import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SimulatedSecretStore, credentialPaths } from '@mnemonik/credentials';
import { createCliCredentials, cliCredentialStatus } from '../src/auth/credentials.js';
import { Readable } from 'node:stream';
import { createCliAuth } from '../src/auth/index.js';
import { grantTransport } from '../src/auth/status.js';
import { collectStatusDocument, renderStatusSummaries } from '../src/status.js';
import { enableScanner } from '../src/scanner/enable.js';
import { Output } from '../src/output.js';

const store = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock('@mnemonik/credentials', async (original) => {
  const actual = await original<typeof import('@mnemonik/credentials')>();
  return {
    ...actual,
    createLocalCredentialAdapter: (
      options: import('@mnemonik/credentials').CredentialAdapterOptions
    ) =>
      actual.createLocalCredentialAdapter({
        ...options,
        secretStore: store.current as SimulatedSecretStore,
      }),
  };
});
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it.each(['keychain', 'credential-manager', 'secret-service', 'file'] as const)(
  'CLI helper selects %s and doctor displays the observed store',
  async (kind) => {
    const stateDir = await mkdtemp(join(tmpdir(), 'cli-store-'));
    dirs.push(stateDir);
    store.current = Object.assign(new SimulatedSecretStore(kind !== 'file'), {
      kind: kind === 'file' ? 'keychain' : kind,
    });
    const credentials = createCliCredentials({ stateDir });
    await credentials.putCliOAuth(
      {
        issuer: 'issuer',
        clientId: 'cli',
        familyId: 'cli',
        scopes: [],
        lastRotationTime: new Date().toISOString(),
      },
      {
        accessToken: 'private-token',
        refreshToken: 'private-refresh',
        accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      }
    );
    const set = vi.spyOn(store.current as SimulatedSecretStore, 'set');
    const getBearer = async () => {
      const bearer = await createCliAuth({ credentialOptions: { stateDir } }).getCliBearer();
      if (typeof bearer !== 'string') throw new Error(bearer.reason);
      return bearer;
    };
    expect(await getBearer()).toBe('private-token');
    await grantTransport(getBearer, async () =>
      Response.json({ account: 'owner', grants: [] })
    ).list();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error('stop_after_credential_read');
    });
    await expect(
      enableScanner({
        stateDir,
        cwd: stateDir,
        input: Readable.from(''),
        output: new Output({ write() {} }),
        nonInteractive: true,
        fetch,
      })
    ).rejects.toThrow('stop_after_credential_read');
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/install-sessions/current'),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer private-token' }),
      })
    );
    const status = await cliCredentialStatus({ stateDir });
    const document = await collectStatusDocument({
      stateDir,
      cwd: stateDir,
      input: Readable.from(''),
      preflight: {
        status: 'ready',
        node: { supported: true, version: '24' },
        os: 'test',
        hosts: [],
        project: { resolution: 'absent' },
        network: { reachable: true, discoveryUrl: '' },
      },
      scannerStatus: async () => ({ roots: [], exclusions: [], repositories: [] }),
      projectHookConditions: [],
    });
    expect(document.cliCredential).toEqual(status);
    expect(document.installation.state).toBe('READY');
    expect(status).toMatchObject({ store: kind, present: true });
    expect(JSON.stringify(status)).not.toContain('private-token');
    const line = vi.fn();
    renderStatusSummaries(
      {
        installation: { state: 'READY', reasons: [], actions: [] },
        cliCredential: status,
      } as never,
      { line },
      { diagnostics: true }
    );
    expect(line.mock.calls.flat().join('\n')).toContain(`store=${kind} present=true`);
    expect(set).not.toHaveBeenCalled();
  }
);

it('keeps unavailable-keychain detail in auth status but not human installation status', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'cli-session-store-'));
  dirs.push(stateDir);
  store.current = Object.assign(new SimulatedSecretStore(), { kind: 'keychain' });
  await createCliCredentials({ stateDir }).putCliOAuth(
    {
      issuer: 'issuer',
      clientId: 'cli',
      familyId: 'cli',
      scopes: [],
      lastRotationTime: new Date().toISOString(),
    },
    'gui-refresh'
  );
  store.current = Object.assign(new SimulatedSecretStore(false), { kind: 'keychain' });
  const { runCli } = await import('../src/router.js');
  // Human installation status reads a machine, so give it one: an unreachable
  // keychain is the only thing wrong here.
  const { ensureLauncher } = await import('../src/launcher.js');
  const hook = join(stateDir, 'hook.js');
  await writeFile(hook, '// hook');
  await mkdir(join(stateDir, '.claude'), { recursive: true });
  await writeFile(
    join(stateDir, '.claude/settings.json'),
    JSON.stringify({
      hooks: {
        start: [{ command: `node ${JSON.stringify(hook)} --mnemonik-owner=claude-code-hooks` }],
      },
    })
  );
  await writeFile(
    join(stateDir, '.claude.json'),
    JSON.stringify({ mcpServers: { mnemonik: { type: 'http' } } })
  );
  await ensureLauncher({ home: stateDir, stateDir });
  for (const [args, code, installationConditions] of [
    [['auth', 'status'], 3, undefined],
    // A folder that is not a project reports the machine, and the machine is well.
    [['status'], 0, undefined],
    [['status'], 1, [{ kind: 'selected_component_failed' as const, reason: 'Scanner failed.' }]],
  ] as const) {
    let text = '';
    expect(
      await runCli([...args], {
        installStateDir: stateDir,
        installationConditions,
        cwd: stateDir,
        home: stateDir,
        cliAuth: createCliAuth({ credentialOptions: { stateDir } }),
        stdout: {
          write(chunk) {
            text += chunk;
          },
        },
        stderr: {
          write(chunk) {
            text += chunk;
          },
        },
        preflight: {
          nodeVersion: '24.21.0',
          platform: 'linux',
          pathExists: async () => false,
          fetch: async () => new Response('{}'),
          resolveIdentity: async () => ({
            kind: 'absent',
            root: stateDir,
            repository: { kind: 'plain', root: stateDir },
            nested: [],
          }),
        },
        scannerStatus: async () => ({ roots: [], exclusions: [], repositories: [] }),
      })
    ).toBe(code);
    const detail =
      'Not signed in in this session. The sign-in is in the login keychain; run mnemonik auth login here or use Terminal.';
    if (args[0] === 'auth') expect(text).toContain(detail);
    else expect(text).not.toContain(detail);
    expect(text).not.toMatch(/runtime_failed|gui-refresh/);
  }
  await expect(readFile(credentialPaths(stateDir).cliSecret)).rejects.toMatchObject({
    code: 'ENOENT',
  });
});
