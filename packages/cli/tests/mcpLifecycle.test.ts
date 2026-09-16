import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCli } from '../src/router.js';
import { connectHost, runHosts } from '../src/install/hosts.js';
import { readOwnership } from '../src/install/ownership.js';
import { grantTransport, matchHostGrant, type AccountGrant } from '../src/auth/status.js';
import { hostFixture, packedHosts } from './fixtures/hostRuntime.js';
import { hostOrder } from '../src/install/adapters.js';

let packed: Awaited<ReturnType<typeof packedHosts>>;
const homes: string[] = [];
beforeAll(async () => {
  packed = await packedHosts();
}, 120_000);
afterAll(async () => {
  await rm(packed.root, { recursive: true, force: true });
});
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
async function fixture() {
  const f = await hostFixture(packed.sources);
  homes.push(f.home);
  const calls: { path: string; method: string }[] = [];
  const grants: AccountGrant[] = hostOrder.map((host) => ({
    id: `grant-${host}`,
    clientId: `registered-${host}`,
    clientName: host === 'claude-code' ? 'Claude Code' : host,
    softwareId: null,
    scopes: ['mcp:use', 'offline_access'],
    resource: 'https://api.mnemonik.dev/mcp',
    createdAt: '2026-09-11T00:00:00Z',
    activatedAt: '2026-09-11T00:01:00Z',
    lastUsedAt: null,
  }));
  let account = 'owner';
  f.deps.grants = grantTransport(
    async () => 'fixture-cli-bearer',
    async (input, init) => {
      expect(init?.headers).toEqual({ authorization: 'Bearer fixture-cli-bearer' });
      const path = new URL(String(input)).pathname;
      calls.push({ path, method: init?.method ?? 'GET' });
      if (init?.method === 'POST') {
        const id = path.split('/').at(-2);
        if (path.endsWith('/approve-host')) {
          const grant = grants.find((g) => g.id === id)!;
          grant.deviceInstallationId = 'installation';
          return Response.json({ id, deviceInstallationId: 'installation' });
        }
        grants.splice(
          grants.findIndex((g) => g.id === id),
          1
        );
        return Response.json({});
      }
      return Response.json({
        account,
        deviceInstallationId: 'installation',
        grants: [
          {
            ...grants[0]!,
            id: 'cli',
            clientId: 'mnemonik-cli',
            clientName: 'Mnemonik CLI',
            resource: 'https://api.mnemonik.dev/',
            scopes: ['install:manage', 'components:manage'],
            deviceInstallationId: 'installation',
            createdAt: '2026-09-10T00:00:00Z',
          },
          ...grants,
        ],
      });
    }
  );
  return {
    ...f,
    calls,
    grants,
    setAccount: (value: string) => {
      account = value;
    },
  };
}
const cliAuth = {
  getCliBearer: async () => 'fixture',
  signIn: async () => {},
  logout: async () => {},
};
const quiet = { write() {} };

it('installs eight component targets; Codex MCP-only uninstall keeps seven and their declarations', async () => {
  const f = await fixture();
  const output: string[] = [];
  expect(
    await runCli(
      [
        'install',
        '--components',
        'hooks,mcp',
        '--hosts',
        hostOrder.join(','),
        '--integration-scope',
        'user',
        '--non-interactive',
        '--accept-limited',
        '--apply',
        '--json',
      ],
      {
        hostManagement: f.deps,
        home: f.home,
        cwd: f.projectRoot,
        cliAuth,
        stdout: { write: (text) => output.push(String(text)) },
      }
    )
  ).toBe(3);
  expect(
    JSON.parse(output.join('')).targets.find((target: { target: string }) =>
      target.target.startsWith('cursor:mcp:')
    )
  ).toMatchObject({ status: 'READY' });
  const before = (await readOwnership(f.deps.stateDir)).targets;
  expect(before).toHaveLength(8);
  expect(
    before
      .filter((t) => t.component === 'mcp')
      .map((t) => t.grant?.id)
      .sort()
  ).toEqual(f.grants.map((g) => g.id).sort());
  const codex = before.find((t) => t.host === 'codex' && t.component === 'mcp')!;
  const otherFiles = await Promise.all(
    before
      .filter((t) => t.id !== codex.id)
      .map(async (t) => ({ path: t.profilePath, bytes: await readFile(t.profilePath) }))
  );
  await runCli(
    ['uninstall', '--component', 'mcp', '--host', 'codex', '--non-interactive', '--confirm'],
    {
      hostManagement: f.deps,
      stdout: quiet,
    }
  );
  expect((await readOwnership(f.deps.stateDir)).targets).toHaveLength(7);
  expect(await readFile(codex.profilePath, 'utf8')).not.toContain('mcp_servers.mnemonik');
  expect(await readFile(codex.profilePath, 'utf8')).toContain('hooks = true');
  for (const file of otherFiles) expect(await readFile(file.path)).toEqual(file.bytes);
  // Eight real runtime installs from packed tarballs plus the hook credential
  // issuance take about two minutes alone and longer beside other workers.
}, 300_000);

it('connected listing binds only an authenticated account grant; mismatch leaves an unbound resumable target', async () => {
  const f = await fixture();
  const selection = { ...f.selections[0]!, component: 'mcp' as const };
  const result = await runHosts('install', [selection], f.deps);
  expect(result.results[0]!.reason).toBe('hooks_not_verified');
  let target = (await readOwnership(f.deps.stateDir)).targets[0]!;
  expect(target.grant?.account).toBe('owner');
  const status = await matchHostGrant(
    { authenticatedTools: true, declarationPresent: true },
    'claude-code',
    'owner',
    f.deps.grants!,
    0
  );
  expect(status).toMatchObject({
    authenticatedTools: true,
    grant: { id: 'grant-claude-code', account: 'owner' },
  });
  await expect(
    matchHostGrant(
      { authenticatedTools: true, declarationPresent: true },
      'claude-code',
      'owner',
      f.deps.grants!,
      Date.parse('2026-09-12T00:00:00Z')
    )
  ).resolves.toMatchObject({ grant: { id: target.grant?.id } });
  expect(
    (
      await matchHostGrant(
        { authenticatedTools: true, declarationPresent: true },
        'claude-code',
        'owner',
        f.deps.grants!,
        Date.parse('2026-09-12T00:00:00Z'),
        target.grant
      )
    ).grant?.id
  ).toBe(target.grant?.id);
  f.setAccount('different-account');
  const mismatch = await connectHost(target, f.deps);
  expect(mismatch).toMatchObject({ status: 'ACTION_REQUIRED', reason: 'host_account_mismatch' });
  target = (await readOwnership(f.deps.stateDir)).targets[0]!;
  expect(target.grant).toBeUndefined();
  expect(await readFile(target.profilePath, 'utf8')).toContain('https://api.mnemonik.dev/mcp');
}, 60_000);

it('auth logout revokes only the chosen host through the grant-id route and auth status shows raw unknown names', async () => {
  const f = await fixture();
  f.grants.push({ ...f.grants[0]!, id: 'unknown', clientName: 'Unknown client' });
  const out: string[] = [];
  await runCli(['auth', 'status', '--json'], {
    hostManagement: f.deps,
    stdout: {
      write: (s) => {
        out.push(String(s));
      },
    },
  });
  expect(JSON.parse(out.join('')).grants.at(-1).host).toBe('Unknown client');
  expect(
    await runCli(['auth', 'logout', '--host', 'claude-code', '--confirm', '--json'], {
      hostManagement: f.deps,
      stdout: quiet,
    })
  ).toBe(0);
  expect(f.calls.filter((c) => c.method === 'POST')).toEqual([
    { method: 'POST', path: '/api/v1/auth/grants/grant-claude-code/revoke' },
  ]);
  expect(f.grants.map((g) => g.id).sort()).toEqual([
    'grant-codex',
    'grant-cursor',
    'grant-grok',
    'unknown',
  ]);
});

it('connect cursor does not stage or plan; two-minute timeout offers retry/skip and retains config', async () => {
  const f = await fixture();
  await runHosts(
    'install',
    [{ ...f.selections.find((s) => s.host === 'cursor')!, component: 'mcp' }],
    f.deps
  );
  const target = (await readOwnership(f.deps.stateDir)).targets[0]!;
  const before = await readFile(target.profilePath);
  const clock = f.deps.now!();
  await writeFile(
    join(f.bin, 'cursor'),
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "3.20.17"; else echo "Cursor Desktop"; fi\n',
    { mode: 0o700 }
  );
  const timeout = vi.fn(async () => 'skip' as const);
  const imports = f.deps.imports;
  expect(imports).toBeUndefined();
  const { hostPackageImports } = await import('../src/install/adapters.js');
  let launches = 0;
  f.deps.imports = {
    ...hostPackageImports,
    cursor: async (runtime) => {
      const mod = await hostPackageImports.cursor(runtime);
      return {
        createHostAdapter: (deps) => {
          const adapter = mod.createHostAdapter(deps);
          const launch = adapter.launch;
          adapter.plan = async () => {
            throw new Error('connect_must_not_plan');
          };
          adapter.launch = async () => {
            launches++;
            return launch();
          };
          return adapter;
        },
      };
    },
  };
  f.deps.timeout = timeout;
  const messages: string[] = [];
  expect(
    await runCli(['connect', 'cursor', '--approve-host', '--json'], {
      hostManagement: f.deps,
      cliAuth,
      stdout: {
        write: (text) => {
          messages.push(String(text));
        },
      },
    })
  ).toBe(3);
  expect(f.deps.now!() - clock, messages.join(' ')).toBe(120_000);
  expect(timeout).toHaveBeenCalledExactlyOnceWith('cursor');
  expect(launches).toBe(1);
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(join(f.deps.stateDir, 'install'));
  const journals = await Promise.all(
    entries.map(async (e) =>
      JSON.parse(await readFile(join(f.deps.stateDir, 'install', e, 'journal.json'), 'utf8'))
    )
  );
  expect(journals.some((j) => j.targets.length === 0)).toBe(true);
  expect(await readFile(target.profilePath)).toEqual(before);
}, 60_000);

it('Cursor Desktop without an activated grant stays actionable with the Customize instruction', async () => {
  const f = await fixture();
  const selection = f.selections.find((s) => s.host === 'cursor')!;
  await runHosts('install', [{ ...selection, component: 'hooks' }], f.deps);
  f.grants.find((grant) => grant.clientName === 'cursor')!.activatedAt = null;
  const result = await runHosts('install', [{ ...selection, component: 'mcp' }], f.deps);
  expect(result.results[0]).toMatchObject({
    status: 'ACTION_REQUIRED',
    reason: 'host_verification_timeout',
  });
  expect(result.reports.join(' ')).toContain(
    'Open Cursor Settings, click Open Customize, then MCPs'
  );
  expect(await readFile(join(f.home, '.cursor/mcp.json'), 'utf8')).toContain(
    'https://api.mnemonik.dev/mcp'
  );
}, 60_000);
