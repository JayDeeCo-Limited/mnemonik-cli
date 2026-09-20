import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { hostPackageImports, hostOrder } from '../src/install/adapters.js';
import { readOwnership } from '../src/install/ownership.js';
import { saveInstallation } from '../src/installation.js';
import { joinedInstall } from '../src/install/journey.js';
import { Output } from '../src/output.js';
import { hostFixture, packedHosts } from './fixtures/hostRuntime.js';
import { serializeReadiness } from '@mnemonik/shared';

const scanner = vi.hoisted(() => ({ prepare: vi.fn(), status: vi.fn() }));
vi.mock('../src/scanner/enable.js', async (original) => ({
  ...(await original<typeof import('../src/scanner/enable.js')>()),
  prepareScanner: scanner.prepare,
}));
vi.mock('../src/status.js', async (original) => ({
  ...(await original<typeof import('../src/status.js')>()),
  collectStatusDocument: scanner.status,
}));

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

it('installs hooks and MCP declarations for four editors without launching or listing grants', async () => {
  const fixture = await hostFixture(packed.sources);
  homes.push(fixture.home);
  await saveInstallation(fixture.deps.stateDir, '11111111-1111-4111-8111-111111111111');
  const launch = vi.fn(async () => {
    throw new Error('editor_login_must_not_launch');
  });
  const list = vi.fn(async () => {
    throw new Error('editor_grants_must_not_be_listed');
  });
  fixture.deps.grants = { list, revoke: vi.fn() };
  fixture.deps.imports = Object.fromEntries(
    hostOrder.map((host) => [
      host,
      async (runtime: Parameters<(typeof hostPackageImports)[typeof host]>[0]) => {
        const module = await hostPackageImports[host](runtime);
        return {
          createHostAdapter: (deps: Parameters<typeof module.createHostAdapter>[0]) => {
            const configured = module.createHostAdapter(deps);
            return {
              ...configured,
              launch,
              verify: async (target?: Parameters<typeof configured.verify>[0]) => ({
                ...(await configured.verify(target)),
                trustPending: false,
              }),
            };
          },
        };
      },
    ])
  ) as unknown as typeof hostPackageImports;
  scanner.prepare.mockImplementation(async (_options, work) =>
    work({
      roots: [],
      exclusions: [],
      files: [],
      session: { id: 'active-session' },
      apply: async () => serializeReadiness({ installation: { conditions: [] } }),
      rollback: async () => {},
      complete: async () => {},
    })
  );
  scanner.status.mockResolvedValue(serializeReadiness({ installation: { conditions: [] } }));

  let stdout = '';
  const completionFetch = vi.fn(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/v1/install-sessions/current')
        return Response.json({ id: 'active-session' });
      if (path === '/api/v1/install-sessions/active-session/complete' && init?.method === 'POST')
        return Response.json({ status: 'completed' });
      throw new Error(`unexpected_install_request:${path}`);
    }
  );
  const exit = await joinedInstall(
    new Map<string, string | true>([
      ['hosts', hostOrder.join(',')],
      ['components', 'hooks,mcp,scanner'],
      ['accept-scanner', true],
      ['apply', true],
    ]),
    {
      home: fixture.home,
      cwd: fixture.projectRoot,
      installStateDir: fixture.deps.stateDir,
      grantFetch: completionFetch,
      projectExecutor: {
        stage: async () => ({ status: 'staged' as const }),
        apply: async () => ({ status: 'done' as const, projectId: 'unused' }),
        rollback: async () => {},
      } as any,
      preflight: {
        nodeVersion: '24.21.0',
        pathExists: async () => false,
        fetch: async () => Response.json({}),
        resolveIdentity: async () => ({
          kind: 'absent',
          root: fixture.projectRoot,
          repository: { kind: 'plain', root: fixture.projectRoot },
          nested: [],
        }),
      },
    },
    new Output({ write: (chunk) => (stdout += chunk) }),
    async () => 'owner',
    async () => fixture.deps
  );

  expect(exit, stdout).toBe(0);
  expect(launch).not.toHaveBeenCalled();
  expect(list).not.toHaveBeenCalled();
  expect(
    stdout.match(/Your editors will ask you to sign in to Mnemonik the first time you use it\./g)
  ).toHaveLength(1);
  const targets = (await readOwnership(fixture.deps.stateDir)).targets;
  expect(targets).toHaveLength(8);
  const declarations = await Promise.all(
    targets
      .filter((target) => target.component === 'mcp')
      .map((target) => readFile(target.profilePath, 'utf8'))
  );
  expect(declarations.every((raw) => raw.includes('x-mnemonik-installation-id'))).toBe(true);
  const grok = declarations.find((raw) => raw.includes('x-mcp-session-id'))!;
  const headerLines = grok.match(/^headers\s*=.*$/gm) ?? [];
  expect(headerLines).toHaveLength(1);
  expect(headerLines[0]).toContain('x-mnemonik-installation-id');
}, 300_000);
