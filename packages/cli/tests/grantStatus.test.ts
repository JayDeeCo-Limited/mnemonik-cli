import { expect, it, vi } from 'vitest';
import {
  bindInstalledHostGrants,
  grantTransport,
  matchHostGrant,
  type AccountGrant,
} from '../src/auth/status.js';
import { waitForHost } from '../src/install/hosts.js';
import { SimulatedHostAdapter } from '../src/install/adapters.js';
import { createHostAdapter } from '../../codex-hooks/dist/adapter.js';
import { createHostAdapter as createGrokAdapter } from '../../grok-hooks/dist/adapter.js';
import { writeChanges } from '@mnemonik/shared/testing/host-adapter-conformance';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const grant: AccountGrant = {
  id: 'grant-cursor',
  clientId: 'registered-cursor',
  clientName: 'Cursor',
  softwareId: null,
  scopes: ['mcp:use'],
  resource: 'https://api.mnemonik.dev/mcp',
  createdAt: new Date(1000).toISOString(),
  activatedAt: new Date(1000).toISOString(),
  lastUsedAt: null,
};
const cliGrant: AccountGrant = {
  ...grant,
  id: 'cli',
  resource: 'https://api.mnemonik.dev/',
  scopes: ['install:manage', 'components:manage'],
  deviceInstallationId: 'installation',
  createdAt: new Date(0).toISOString(),
};
const connected = { authenticatedTools: true, declarationPresent: true };

it.each([
  ['revoked', undefined],
  ['different grant', { id: 'another-grant' }],
  ['different host', { clientName: 'Codex' }],
  ['different resource', { resource: 'https://api.mnemonik.dev/' }],
  ['missing scope', { scopes: ['offline_access'] }],
  ['not activated', { activatedAt: null }],
  ['different installation', { deviceInstallationId: 'elsewhere' }],
] satisfies Array<[string, Partial<AccountGrant> | undefined]>)(
  'maintenance rejects a %s grant even when the native listing is connected',
  async (_reason, change) => {
    const adapter = new SimulatedHostAdapter('cursor', {
      path: '/unused',
      content: Buffer.from('{}'),
      staging: 'inactive',
      requestedScope: 'user',
      effectiveScope: 'user',
      version: '1',
      artifactDigest: 'a',
    });
    const verify = vi.spyOn(adapter, 'verify').mockResolvedValue({
      ...connected,
      grant: {
        id: grant.id,
        account: 'owner',
        scopes: grant.scopes,
      },
    });
    const launch = vi.spyOn(adapter, 'launch');
    const sleep = vi.fn();
    const approveHost = vi.fn();
    const list = vi.fn(async () => ({
      account: 'owner',
      deviceInstallationId: 'here',
      grants: change ? [{ ...grant, ...change }] : [],
    }));
    await expect(
      waitForHost(
        adapter,
        {
          component: 'mcp',
          scope: 'user',
          runtimeEntry: '',
          runtimeRoot: '',
          credentialFamily: '',
        },
        'cursor',
        {
          stateDir: '/unused',
          account: 'owner',
          sleep,
          grants: { list, approveHost, revoke: vi.fn() },
        },
        { id: grant.id, account: 'owner', scopes: grant.scopes },
        'update'
      )
    ).rejects.toThrow('host_grant_unverified');
    expect(verify).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledOnce();
    expect(launch).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
    expect(approveHost).not.toHaveBeenCalled();
  }
);

it('binds only activated grants for installed hosts created within this installation window', async () => {
  const approveHost = vi.fn(async () => 'installation');
  const listing = {
    account: 'owner',
    deviceInstallationId: 'installation',
    grants: [
      cliGrant,
      { ...grant },
      { ...grant, id: 'older', createdAt: new Date(-1000).toISOString() },
      { ...grant, id: 'inactive', activatedAt: null },
      { ...grant, id: 'elsewhere', deviceInstallationId: 'other' },
      { ...grant, id: 'uninstalled', clientName: 'Codex' },
      { ...grant, id: 'resource', resource: 'https://other.example/mcp' },
      { ...grant, id: 'scope', scopes: [] },
    ],
  };
  const transport = { list: async () => listing, approveHost, revoke: async () => {} };
  await bindInstalledHostGrants(listing, ['cursor'], transport);
  expect(approveHost.mock.calls).toEqual([['grant-cursor']]);
  approveHost.mockClear();
  await bindInstalledHostGrants(
    { ...listing, grants: [{ ...grant, deviceInstallationId: null }] },
    ['cursor'],
    transport
  );
  expect(approveHost).not.toHaveBeenCalled();
});

it('binds a fresh native Codex OAuth listing before its first handshake', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-grant-'));
  try {
    await mkdir(join(home, '.codex'));
    await writeFile(
      join(home, '.codex/config.toml'),
      '[mcp_servers.mnemonik]\nurl = "https://api.mnemonik.dev/mcp"\n'
    );
    const adapter = createHostAdapter({
      env: { HOME: home },
      target: {
        component: 'mcp',
        scope: 'user',
        runtimeEntry: '',
        runtimeRoot: '',
        credentialFamily: '',
      },
      execFile: async (_file, args) => ({
        stdout:
          args[0] === '--version'
            ? 'codex-cli 0.145.0\n'
            : 'mnemonik  https://api.mnemonik.dev/mcp  -  enabled  OAuth\n',
        stderr: '',
      }),
    });
    const inspection = await adapter.verify();
    expect(inspection.authenticatedTools).toBe(true);
    let candidate = { ...grant, clientName: 'Codex', activatedAt: null };
    const transport = grantTransport(
      async () => 'fixture',
      async (_url, options) =>
        options?.method === 'POST'
          ? Response.json({ id: grant.id, deviceInstallationId: 'installation' })
          : Response.json({
              account: 'owner',
              deviceInstallationId: 'installation',
              grants: [cliGrant, candidate],
            })
    );
    const bound = (
      await matchHostGrant(
        inspection,
        'codex',
        'owner',
        transport,
        1000,
        undefined,
        async () => true
      )
    ).grant!;
    expect(bound.installationId).toBe('installation');
    expect(
      (await matchHostGrant(inspection, 'codex', 'owner', transport, 2000, bound)).grant
    ).toEqual(bound);
    expect((await matchHostGrant(inspection, 'codex', 'owner', transport, 2000)).grant?.id).toBe(
      grant.id
    );
    for (const clientName of ['Claude Code', 'Grok']) {
      candidate = { ...candidate, clientName };
      await expect(
        matchHostGrant(
          inspection,
          clientName === 'Grok' ? 'grok' : 'claude-code',
          'owner',
          transport,
          1000
        )
      ).rejects.toThrow('host_connection_pending');
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it.each(['grok', 'codex'] as const)(
  'connect recovers %s from the captured native listing without local grant records',
  async (host) => {
    const home = await mkdtemp(join(tmpdir(), 'native-recovery-'));
    try {
      const target = {
        component: 'mcp' as const,
        scope: 'user' as const,
        runtimeEntry: '',
        runtimeRoot: '',
        credentialFamily: '',
      };
      const adapter = (host === 'grok' ? createGrokAdapter : createHostAdapter)({
        env: { HOME: home },
        target,
        execFile: async (_file, args) => {
          if (args[0] === '--version')
            return {
              stdout: host === 'codex' ? 'codex-cli 0.145.0\n' : 'grok 1.0.25 (f7e67d6988e2)\n',
              stderr: '',
            };
          return {
            stdout:
              host === 'codex'
                ? 'mnemonik  https://api.mnemonik.dev/mcp  -  enabled  OAuth\n'
                : args.join(' ') === 'mcp doctor --json'
                  ? JSON.stringify({
                      servers: [
                        {
                          name: 'mnemonik',
                          transport: 'http',
                          target: 'https://api.mnemonik.dev/mcp',
                          source: 'config',
                          checks: [
                            { label: 'server started', passed: true, detail: '0.0s' },
                            { label: 'handshake OK', passed: true, detail: 'protocol 2025-11-25' },
                            { label: '3 tools discovered', passed: true, detail: '' },
                          ],
                          healthy: true,
                        },
                      ],
                      healthy_count: 1,
                      failing_count: 0,
                    })
                  : 'mnemonik: https://api.mnemonik.dev/mcp\n',
            stderr: '',
          };
        },
      });
      await writeChanges((await adapter.plan()).changes);
      const launch = vi.spyOn(adapter, 'launch');
      const approve = vi.fn(async () => true);
      const transport = {
        list: async () => ({
          account: 'owner',
          deviceInstallationId: 'installation',
          grants: [
            {
              ...grant,
              clientName: host,
              activatedAt: host === 'codex' ? null : grant.activatedAt,
              deviceInstallationId: host === 'codex' ? 'installation' : null,
            },
          ],
        }),
        approveHost: vi.fn(async () => 'installation'),
        revoke: vi.fn(),
      };
      const result = await waitForHost(adapter, target, host, {
        stateDir: home,
        account: 'owner',
        now: () => 2000,
        grants: transport,
        approveHost: approve,
      });
      expect(result.grant?.installationId).toBe('installation');
      expect(approve).toHaveBeenCalledTimes(host === 'grok' ? 1 : 0);
      expect(transport.approveHost).toHaveBeenCalledTimes(host === 'grok' ? 1 : 0);
      expect(launch).not.toHaveBeenCalled();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
);

it('refuses ambiguous stale, wrong-account, wrong-resource, unknown-client and unactivated grants; local records do not disambiguate', async () => {
  let account = 'owner';
  let grants = [grant, { ...grant, id: 'ambiguous' }];
  const transport = grantTransport(
    async () => 'fixture',
    async () => Response.json({ account, grants })
  );
  const recorded = { id: grant.id, account: 'owner', scopes: ['mcp:use'] };
  await expect(matchHostGrant(connected, 'cursor', 'owner', transport, 2000)).rejects.toThrow(
    'host_connection_pending'
  );
  await expect(
    matchHostGrant(connected, 'cursor', 'owner', transport, 2000, recorded)
  ).rejects.toThrow('host_connection_pending');
  account = 'other';
  await expect(
    matchHostGrant(connected, 'cursor', 'owner', transport, 0, recorded)
  ).rejects.toThrow('host_account_mismatch');
  account = 'owner';
  for (const changed of [
    { resource: 'https://api.mnemonik.dev/' },
    { clientName: 'Unknown' },
    { activatedAt: null },
    { scopes: [] },
    { id: 'other-grant' },
  ]) {
    grants = [
      { ...grant, ...changed },
      { ...grant, ...changed, id: 'ambiguous' },
    ];
    await expect(
      matchHostGrant(connected, 'cursor', 'owner', transport, 2000, recorded)
    ).rejects.toThrow('host_connection_pending');
  }
  grants = [];
  await expect(
    matchHostGrant(connected, 'cursor', 'owner', transport, 0, recorded)
  ).rejects.toThrow('host_connection_pending');
});

it('requires approval for recovered unbound grants and refuses another installation', async () => {
  let candidate = grant;
  const transport = {
    list: async () => ({
      account: 'owner',
      deviceInstallationId: 'here',
      grants: [candidate, { ...grant, id: 'ineligible', resource: 'https://other.test/mcp' }],
    }),
    approveHost: vi.fn(async () => 'here'),
    revoke: vi.fn(),
  };
  await expect(
    matchHostGrant(connected, 'cursor', 'owner', transport, 2000, undefined, async () => false)
  ).rejects.toThrow('host_grant_unbound');
  expect(transport.approveHost).not.toHaveBeenCalled();
  candidate = { ...grant, deviceInstallationId: 'elsewhere' };
  await expect(matchHostGrant(connected, 'cursor', 'owner', transport, 1000)).rejects.toThrow(
    'grant_bound_elsewhere'
  );
});

it.each(['record', 'listing'] as const)(
  'prefers an older grant bound to this installation by %s over a newer fresh grant',
  async (source) => {
    const prior = {
      ...grant,
      id: 'prior',
      ...(source === 'listing' ? { deviceInstallationId: 'here' } : {}),
    };
    const transport = {
      list: async () => ({
        account: 'owner',
        deviceInstallationId: 'here',
        grants: [prior, { ...grant, id: 'fresh', createdAt: new Date(3000).toISOString() }],
      }),
      approveHost: vi.fn(async () => 'here'),
      revoke: vi.fn(),
    };
    const recorded =
      source === 'record'
        ? { id: prior.id, account: 'owner', scopes: prior.scopes, installationId: 'here' }
        : undefined;
    expect(
      (await matchHostGrant(connected, 'cursor', 'owner', transport, 2000, recorded)).grant
    ).toMatchObject({ id: prior.id, installationId: 'here' });
    expect(transport.approveHost).not.toHaveBeenCalled();
  }
);

it('captures freshness before native login, and retry starts a new two-minute poll', async () => {
  const adapter = new SimulatedHostAdapter('cursor', {
    path: '/unused',
    content: Buffer.from('{}'),
    staging: 'inactive',
    requestedScope: 'user',
    effectiveScope: 'user',
    version: '1',
    artifactDigest: 'a',
  });
  let clock = 1000;
  let attempts = 0;
  adapter.launch = async () => {
    attempts++;
    clock += 500;
    return 'agent mcp login mnemonik';
  };
  adapter.verify = async () => ({ ...connected, authenticatedTools: attempts === 2 });
  const transport = grantTransport(
    async () => 'fixture',
    async () =>
      Response.json({
        account: 'owner',
        grants: [{ ...grant, createdAt: new Date(121_500).toISOString() }],
      })
  );
  const timeout = vi.fn(async () => 'retry' as const);
  const result = await waitForHost(
    adapter,
    { component: 'mcp', scope: 'user', runtimeEntry: '', runtimeRoot: '', credentialFamily: '' },
    'cursor',
    {
      stateDir: '/unused',
      account: 'owner',
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      timeout,
      grants: transport,
    }
  );
  expect(clock).toBe(122_000);
  expect(attempts).toBe(2);
  expect(timeout).toHaveBeenCalledExactlyOnceWith('cursor');
  expect(result.grant?.id).toBe(grant.id);
});

it('Codex connect waits when several grants in the installation window are unactivated', async () => {
  const adapter = new SimulatedHostAdapter('codex', {
    path: '/unused',
    content: Buffer.from('{}'),
    staging: 'inactive',
    requestedScope: 'user',
    effectiveScope: 'user',
    version: '1',
    artifactDigest: 'a',
  });
  adapter.verify = async () => connected;
  const launch = vi.spyOn(adapter, 'launch');
  let clock = 2000;
  const approveHost = vi.fn(async () => 'here');
  const instruction = vi.fn();
  const result = await waitForHost(
    adapter,
    { component: 'mcp', scope: 'user', runtimeEntry: '', runtimeRoot: '', credentialFamily: '' },
    'codex',
    {
      stateDir: '/unused',
      account: 'owner',
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      approveHost: async () => true,
      instruction,
      grants: {
        list: async () => ({
          account: 'owner',
          deviceInstallationId: 'here',
          grants: [
            { ...cliGrant, deviceInstallationId: 'here' },
            { ...grant, id: 'timed-out', clientName: 'Codex', activatedAt: null },
            {
              ...grant,
              id: 'retry',
              clientName: 'Codex',
              activatedAt: clock >= 4000 ? new Date(clock).toISOString() : null,
            },
          ],
        }),
        approveHost,
        revoke: vi.fn(),
      },
    }
  );
  expect(result.grant).toMatchObject({ id: 'retry', installationId: 'here', account: 'owner' });
  expect(clock).toBe(4000);
  expect(approveHost).toHaveBeenCalledExactlyOnceWith('retry');
  expect(launch).not.toHaveBeenCalled();
  expect(instruction).toHaveBeenCalledExactlyOnceWith('Codex is still finishing its connection.');
});

it('keeps unbound Codex grants pending without an installation sign-in window', async () => {
  const transport = {
    list: async () => ({
      account: 'owner',
      grants: [
        { ...grant, clientName: 'Codex' },
        { ...grant, id: 'other', clientName: 'Codex' },
      ],
    }),
    approveHost: vi.fn(async () => 'here'),
    revoke: vi.fn(),
  };
  await expect(
    matchHostGrant(connected, 'codex', 'owner', transport, 2000, undefined, async () => true)
  ).rejects.toThrow('host_connection_pending');
  expect(transport.approveHost).not.toHaveBeenCalled();
});

it('recovers the activated Windows Codex grant from this installation sign-in window', async () => {
  const installation = 'windows-installation';
  const active = {
    ...grant,
    id: 'active-codex',
    clientName: 'Codex',
    createdAt: '2026-09-13T05:25:43Z',
    activatedAt: '2026-09-13T05:31:22Z',
  };
  const pending = {
    ...active,
    id: 'pending-codex',
    createdAt: '2026-09-13T05:22:27Z',
    activatedAt: null,
  };
  const cli = {
    ...grant,
    id: 'cli',
    clientName: 'Mnemonik CLI',
    clientId: 'https://auth.example/oauth/clients/mnemonik-cli.json',
    resource: 'https://api.mnemonik.dev/',
    scopes: ['install:manage', 'components:manage'],
    deviceInstallationId: installation,
    createdAt: '2026-09-13T05:09:00Z',
  };
  const transport = {
    list: async () => ({
      account: 'owner',
      deviceInstallationId: installation,
      grants: [pending, active, cli],
    }),
    approveHost: vi.fn(async () => installation),
    revoke: vi.fn(),
  };
  const result = await matchHostGrant(
    connected,
    'codex',
    'owner',
    transport,
    Date.parse('2026-09-13T06:40:00Z'),
    undefined,
    async () => true,
    'recovered'
  );
  expect(result.grant).toMatchObject({ id: active.id, installationId: installation });
  expect(transport.approveHost).toHaveBeenCalledExactlyOnceWith(active.id);
  expect(transport.revoke).not.toHaveBeenCalled();
});

it('selects the newest activated Codex grant since the earliest sign-in on this installation', async () => {
  const codex = { ...grant, clientName: 'Codex' };
  const transport = {
    list: async () => ({
      account: 'owner',
      deviceInstallationId: 'installation',
      grants: [
        { ...cliGrant, createdAt: new Date(500).toISOString() },
        { ...cliGrant, id: 'later-cli', createdAt: new Date(5000).toISOString() },
        { ...cliGrant, id: 'other-installation', deviceInstallationId: 'elsewhere' },
        {
          ...codex,
          id: 'before-installation',
          createdAt: new Date(100).toISOString(),
          activatedAt: new Date(9000).toISOString(),
        },
        { ...codex, id: 'older-active' },
        { ...codex, id: 'newer-active', createdAt: new Date(2000).toISOString() },
        {
          ...codex,
          id: 'newest-pending',
          createdAt: new Date(3000).toISOString(),
          activatedAt: null,
        },
      ],
    }),
    approveHost: vi.fn(async () => 'installation'),
    revoke: vi.fn(),
  };
  const result = await matchHostGrant(
    connected,
    'codex',
    'owner',
    transport,
    10000,
    undefined,
    async () => true
  );
  expect(result.grant?.id).toBe('newer-active');
  expect(transport.approveHost).toHaveBeenCalledExactlyOnceWith('newer-active');
});

it('does not recover a Codex grant created before this installation even if activated later', async () => {
  const transport = {
    list: async () => ({
      account: 'owner',
      deviceInstallationId: 'installation',
      grants: [
        { ...cliGrant, createdAt: new Date(2000).toISOString() },
        { ...grant, clientName: 'Codex', activatedAt: new Date(4000).toISOString() },
      ],
    }),
    approveHost: vi.fn(async () => 'installation'),
    revoke: vi.fn(),
  };
  await expect(
    matchHostGrant(connected, 'codex', 'owner', transport, 3000, undefined, async () => true)
  ).rejects.toThrow('host_connection_pending');
  expect(transport.approveHost).not.toHaveBeenCalled();
});
