import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { grantHost, grantTransport, type AccountGrant } from '../src/auth/status.js';
import { codexTrustAction, waitForHost } from '../src/install/hosts.js';
import { SimulatedHostAdapter } from '../src/install/adapters.js';

const grant: AccountGrant = {
  id: 'host',
  clientId: 'https://claude.ai/oauth/claude-code-client-metadata',
  clientName: null,
  softwareId: null,
  scopes: ['mcp:use'],
  resource: 'https://api.mnemonik.dev/mcp',
  createdAt: new Date().toISOString(),
  activatedAt: new Date().toISOString(),
  lastUsedAt: null,
  deviceInstallationId: null,
};
it('renders trust instructions for the detected Codex surface', () => {
  expect(codexTrustAction('/usr/local/bin/codex')).toBe(
    'Run the codex command in a terminal and use its hook trust prompt to allow the Mnemonik hooks; then quit and reopen Codex.'
  );
  expect(codexTrustAction('/Applications/ChatGPT.app/Contents/Resources/codex')).toBe(
    "Open the ChatGPT app and use the 'Hooks need review' notice at startup to review and allow the Mnemonik hooks. If the notice does not appear, restart the app once."
  );
  expect(
    codexTrustAction('C:\\Users\\Jo\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe')
  ).toContain("'Hooks need review'");
});
it('recognises the captured Claude Code and Codex CIMD documents without DCR names', () => {
  for (const host of ['claude-code', 'codex'] as const) {
    const document = JSON.parse(
      readFileSync(`../../tests/fixtures/oauth-clients/${host}.json`, 'utf8')
    );
    expect(grantHost({ ...grant, clientId: document.client_id })).toBe(host);
  }
  expect(grantHost({ ...grant, clientId: 'https://claude.ai.evil.test/client' })).toBeUndefined();
});
it('approves a fresh unbound host once, records the installation, then skips approval and native launch', async () => {
  const calls: string[] = [];
  let installation: string | null = null;
  const transport = grantTransport(
    async () => 'cli-token',
    async (url, init) => {
      calls.push(`${init?.method} ${new URL(String(url)).pathname}`);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer cli-token');
      if (init?.method === 'POST') {
        expect(init.body).toBeUndefined();
        installation = 'machine-a';
        return Response.json({ id: grant.id, deviceInstallationId: installation });
      }
      return Response.json({
        account: 'owner',
        deviceInstallationId: 'machine-a',
        grants: [{ ...grant, deviceInstallationId: installation }],
      });
    }
  );
  const adapter = new SimulatedHostAdapter('claude-code', {
    path: '/unused',
    content: Buffer.from('{}'),
    staging: 'inactive',
    requestedScope: 'user',
    effectiveScope: 'user',
    version: '1',
    artifactDigest: 'a',
  });
  adapter.verify = async () => ({ authenticatedTools: true, declarationPresent: true });
  adapter.launch = vi.fn(async () => 'native sign-in');
  const approveHost = vi.fn(async () => true);
  const target = {
    component: 'mcp' as const,
    scope: 'user' as const,
    runtimeEntry: '',
    runtimeRoot: '',
    credentialFamily: '',
  };
  const deps = {
    stateDir: '/unused',
    account: 'owner',
    grants: transport,
    approveHost,
    now: () => 0,
  };
  const first = await waitForHost(adapter, target, 'claude-code', deps);
  expect(first.grant).toEqual({
    id: 'host',
    account: 'owner',
    scopes: ['mcp:use'],
    installationId: 'machine-a',
  });
  expect(await waitForHost(adapter, target, 'claude-code', deps, first.grant)).toEqual(first);
  expect(calls).toEqual([
    'GET /api/v1/auth/grants',
    'GET /api/v1/auth/grants',
    'POST /api/v1/auth/grants/host/approve-host',
    'GET /api/v1/auth/grants',
  ]);
  expect(approveHost).toHaveBeenCalledTimes(1);
  expect(adapter.launch).toHaveBeenCalledTimes(1);
});

it('repair accepts an intact declaration with its live bound grant without launch or sleep', async () => {
  const adapter = new SimulatedHostAdapter('claude-code', {
    path: '/unused',
    content: Buffer.from('{}'),
    staging: 'inactive',
    requestedScope: 'user',
    effectiveScope: 'user',
    version: '1',
    artifactDigest: 'a',
  });
  adapter.verify = vi.fn(async () => ({ declarationPresent: true, authenticatedTools: false }));
  adapter.launch = vi.fn(async () => 'native sign-in');
  let clock = 0;
  const sleep = vi.fn(async (ms: number) => {
    clock += ms;
  });
  const recorded = {
    id: grant.id,
    account: 'owner',
    scopes: ['mcp:use'],
    installationId: 'machine-a',
  };
  const result = await waitForHost(
    adapter,
    { component: 'mcp', scope: 'user', runtimeEntry: '', runtimeRoot: '', credentialFamily: '' },
    'claude-code',
    {
      stateDir: '/unused',
      account: 'owner',
      now: () => clock,
      sleep,
      timeout: async () => 'skip',
      grants: {
        list: async () => ({
          account: 'owner',
          deviceInstallationId: 'machine-a',
          grants: [{ ...grant, deviceInstallationId: 'machine-a' }],
        }),
        approveHost: vi.fn(),
        revoke: vi.fn(),
      },
    },
    recorded,
    'repair'
  );
  expect(result.grant).toEqual(recorded);
  expect(adapter.launch).not.toHaveBeenCalled();
  expect(sleep).not.toHaveBeenCalled();
});

it.each(['claude-code', 'cursor'] as const)(
  'repair with a revoked %s grant reports action after one inspection',
  async (host) => {
    const adapter = new SimulatedHostAdapter(host, {
      path: '/unused',
      content: Buffer.from('{}'),
      staging: 'inactive',
      requestedScope: 'user',
      effectiveScope: 'user',
      version: '1',
      artifactDigest: 'a',
    });
    adapter.verify = vi.fn(async () => ({ declarationPresent: true, authenticatedTools: false }));
    adapter.launch = vi.fn(async () => 'native sign-in');
    const instruction = vi.fn();
    let clock = 0;
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });
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
        host,
        {
          stateDir: '/unused',
          account: 'owner',
          now: () => clock,
          sleep,
          instruction,
          timeout: async () => 'skip',
          grants: {
            list: async () => ({
              account: 'owner',
              deviceInstallationId: 'machine-a',
              grants: [],
            }),
            approveHost: vi.fn(),
            revoke: vi.fn(),
          },
        },
        { id: grant.id, account: 'owner', scopes: ['mcp:use'], installationId: 'machine-a' },
        'repair'
      )
    ).rejects.toThrow('host_grant_unverified');
    expect(adapter.verify).toHaveBeenCalledOnce();
    expect(adapter.launch).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  }
);

it.each([false, true])(
  'maintenance enables Cursor once and checks the result (still disabled: %s)',
  async (disabled) => {
    const adapter = new SimulatedHostAdapter('cursor', {
      path: '/unused',
      content: Buffer.from('{}'),
      staging: 'inactive',
      requestedScope: 'user',
      effectiveScope: 'user',
      version: '1',
      artifactDigest: 'a',
    });
    const verify = vi
      .spyOn(adapter, 'verify')
      .mockResolvedValueOnce({
        declarationPresent: true,
        authenticatedTools: false,
        enableRequired: true,
      })
      .mockResolvedValue({
        declarationPresent: true,
        authenticatedTools: false,
        enableRequired: disabled,
      });
    const enable = vi.fn(async () => 'Enable Mnemonik in Cursor.');
    const launch = vi.spyOn(adapter, 'launch');
    const sleep = vi.fn();
    let clock = 0;
    const result = waitForHost(
      Object.assign(adapter, { enable }),
      { component: 'mcp', scope: 'user', runtimeEntry: '', runtimeRoot: '', credentialFamily: '' },
      'cursor',
      {
        stateDir: '/unused',
        account: 'owner',
        sleep,
        now: () => (clock += 120_000),
        grants: {
          list: async () => ({
            account: 'owner',
            grants: [{ ...grant, clientName: 'Cursor', clientId: 'cursor' }],
          }),
          approveHost: vi.fn(),
          revoke: vi.fn(),
        },
      },
      { id: grant.id, account: 'owner', scopes: ['mcp:use'] },
      'update'
    );
    if (disabled) await expect(result).rejects.toThrow('host_enable_required');
    else expect((await result).grant?.id).toBe(grant.id);
    expect(enable).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledTimes(2);
    expect(launch).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  }
);
