import { access, mkdir, mkdtemp, readdir, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { joinedInstall } from '../src/install/journey.js';
import { Output } from '../src/output.js';
import type { HostDependencies, HostSelection } from '../src/install/hosts.js';
const run = vi.hoisted(() => vi.fn());
vi.mock('../src/install/hosts.js', async (original) => ({
  ...(await original<typeof import('../src/install/hosts.js')>()),
  runHosts: run,
}));
const homes: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

it('configures only the three launch editors when retired editors are also installed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'joined-no-grok-'));
  homes.push(home);
  vi.stubEnv('PATH', join(home, '.local/bin'));
  await Promise.all(
    ['.claude', '.codex', '.cursor', '.grok', '.copilot'].map((name) =>
      mkdir(join(home, name), { recursive: true })
    )
  );
  let selected: HostSelection[] = [];
  run.mockImplementationOnce(
    async (_command: string, selections: HostSelection[], deps: HostDependencies) => {
      selected = selections;
      const data = {
        state: 'READY',
        phase: 'complete',
        runId: 'run',
        components: [],
        roots: [],
        projects: [],
        targets: [],
        reports: [],
      };
      await deps.afterHosts?.({ data } as never, [], async () => {});
      return { journal: data, results: [], reports: [] };
    }
  );
  const fetcher = vi.fn(async (_url: unknown, init?: Parameters<typeof fetch>[1]) =>
    init?.method === 'POST'
      ? Response.json({ status: 'completed' })
      : Response.json({ id: 'active-session' })
  );
  let text = '';

  expect(
    await joinedInstall(
      new Map<string, string | true>([
        ['components', 'hooks,mcp'],
        ['without-scanner', true],
        ['accept-limited', true],
        ['apply', true],
        ['non-interactive', true],
      ]),
      {
        cwd: home,
        home,
        installStateDir: home,
        grantFetch: fetcher,
        preflight: {
          nodeVersion: '24.21.0',
          fetch: async () => Response.json({}),
          pathExists: async (path) =>
            access(path).then(
              () => true,
              () => false
            ),
          resolveIdentity: async () => ({
            kind: 'absent',
            root: home,
            repository: { kind: 'plain', root: home },
            nested: [],
          }),
        },
      },
      new Output({ write: (chunk) => void (text += chunk) }),
      async () => 'owner',
      async () => ({ stateDir: home, account: 'owner', getCliBearer: async () => 'fixture' })
    )
  ).toBe(3);
  expect(text).toContain('3 editors configured');
  expect([...new Set(selected.map(({ host }) => host))]).toEqual([
    'claude-code',
    'codex',
    'cursor',
  ]);
  expect(selected).toHaveLength(6);
  expect(await readdir(join(home, '.grok'))).toEqual([]);
  expect(await readdir(join(home, '.copilot'))).toEqual([]);
});
it.each([
  ['READY', 0, undefined, undefined],
  ['LIMITED', 0, undefined, 'https://app.mnemonik.ai/settings/devices'],
  [
    'LIMITED',
    7,
    'https://mnemonik-api.devops.jaydeeco.com/mcp',
    'https://mnemonik-app.devops.jaydeeco.com/settings/devices',
  ],
  ['ACTION_REQUIRED', 0, undefined, undefined],
  ['FAILED', 0, undefined, undefined],
  ['READY', 0, undefined, undefined, true, false],
  ['READY', 0, undefined, undefined, true, true],
] as const)(
  'posts the terminal %s receipt with %s problems, platform and versions without a scanner plan',
  async (state, count, apiResource, _consoleUrl, foreign?: boolean, foreignOnPath?: boolean) => {
    if (apiResource) vi.stubEnv('MNEMONIK_API_RESOURCE', apiResource);
    const home = await mkdtemp(join(tmpdir(), 'joined-completion-'));
    homes.push(home);
    const onPath = foreignOnPath || (state === 'LIMITED' && count === 0);
    vi.stubEnv('PATH', onPath ? join(home, '.local/bin') : '/usr/bin');
    const launcher = join(home, '.local/bin/mnemonik');
    if (foreign) {
      await mkdir(join(home, '.local/bin'), { recursive: true });
      await writeFile(launcher, '#!/bin/sh\necho foreign\n', { mode: 0o755 });
    }
    const reasons =
      state === 'LIMITED'
        ? [...Array.from({ length: count }, (_, i) => `reason ${i}`), 'dev_release_source']
        : [];
    run.mockResolvedValue({
      journal: { state, phase: 'complete', runId: 'run' },
      results: [],
      reports: reasons,
    });
    const fetcher = vi.fn(async (_url: any, init?: Parameters<typeof fetch>[1]) =>
      init?.method === 'POST'
        ? Response.json({ status: 'completed' })
        : Response.json({ id: 'active-session' })
    );
    const flags = new Map<string, string | true>([
      ['hosts', 'codex'],
      ['components', 'hooks'],
      ['apply', true],
      ['json', true],
      ['without-scanner', true],
      ['accept-limited', true],
    ]);
    if (state === 'READY' || state === 'LIMITED' || foreign) flags.delete('json');
    let text = '';
    const code = await joinedInstall(
      flags,
      {
        cwd: home,
        home,
        installStateDir: home,
        grantFetch: fetcher,
        preflight: {
          nodeVersion: '24.21.0',
          pathExists: async () => false,
          execFile: async () => {
            throw Object.assign(new Error('not found'), { code: 'ENOENT' });
          },
          fetch: async () => Response.json({}),
          resolveIdentity: async () => ({
            kind: 'absent',
            root: home,
            repository: { kind: 'plain', root: home },
            nested: [],
          }),
        },
      },
      new Output({
        write: (chunk) => {
          text += chunk;
        },
      }),
      async () => 'owner',
      async () => ({ stateDir: home, account: 'owner', getCliBearer: async () => 'fixture' })
    );
    expect(code).toBe(foreign ? 3 : state === 'READY' ? 0 : state === 'FAILED' ? 1 : 3);
    if (foreign) {
      expect(await readFile(launcher, 'utf8')).toBe('#!/bin/sh\necho foreign\n');
      expect(text).toContain('Indexing was skipped. Run mnemonik install to set it up later.');
      expect(text).toContain('~/.local/bin/mnemonik');
      expect(text).toContain('Move the existing');
      expect(text).not.toContain('Launcher:');
    } else if (state === 'READY' || state === 'LIMITED') {
      expect(await readFile(launcher, 'utf8')).toContain('runtimes/bootstrap/dist/bin.js');
      expect((await stat(launcher)).mode & 0o777).toBe(0o755);
    }
    if (state === 'LIMITED' && !onPath) expect(text).toContain('new terminal after that');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1]![0])).toContain(
      '/install-sessions/active-session/complete'
    );
    const body = JSON.parse(String(fetcher.mock.calls[1]![1]?.body));
    expect(body.readiness).toMatchObject({
      installation: { state: foreign ? 'ACTION_REQUIRED' : state },
      platform: process.platform,
      versions: { cli: expect.any(String), hosts: [] },
    });
    if (foreign) {
      expect(body.readiness.installation.reasons).toEqual([
        expect.stringContaining('launcher_not_ours'),
      ]);
      expect(body.readiness.installation.actions).toEqual([
        expect.stringContaining('Move the existing'),
      ]);
    }
    if (!flags.has('json')) expect(text.match(/One step is left in each editor/g)).toHaveLength(1);
    if (state === 'LIMITED') {
      expect(text).toContain('Indexing was skipped. Run mnemonik install to set it up later.');
      expect(text).not.toContain('thing left');
      expect(body.readiness.installation.reasons).toEqual(reasons);
      for (const reason of reasons) expect(text).not.toContain(reason);
    }
  }
);

it('a fully flagged piped install proceeds without terminal questions', async () => {
  const home = await mkdtemp(join(tmpdir(), 'joined-piped-'));
  homes.push(home);
  vi.stubEnv('PATH', join(home, '.local/bin'));
  run.mockResolvedValue({
    journal: { state: 'READY', phase: 'complete', runId: 'run' },
    results: [],
    reports: [],
  });
  let text = '';
  const authorize = vi.fn(async () => 'owner');
  const code = await joinedInstall(
    new Map<string, string | true>([
      ['hosts', 'codex'],
      ['components', 'hooks,mcp'],
      ['without-scanner', true],
      ['accept-limited', true],
      ['apply', true],
    ]),
    {
      cwd: home,
      home,
      input: Readable.from([]),
      installStateDir: home,
      preflight: {
        nodeVersion: '24.21.0',
        fetch: async () => Response.json({}),
        resolveIdentity: async () => ({
          kind: 'absent',
          root: home,
          repository: { kind: 'plain', root: home },
          nested: [],
        }),
      },
    },
    new Output({ write: (chunk) => void (text += chunk) }),
    authorize,
    async () => ({ stateDir: home, account: 'owner' })
  );

  expect(code).toBe(0);
  expect(authorize).toHaveBeenCalledOnce();
  expect(text).not.toMatch(/arrow keys|Recommended|Customize/iu);
  expect(await readFile(join(home, 'indexing-skipped'), 'utf8')).toBe('indexing was skipped\n');
});

it('bounds a black-holed final report and still prints a late installation failure', async () => {
  const home = await mkdtemp(join(tmpdir(), 'joined-completion-timeout-'));
  homes.push(home);
  vi.stubEnv('PATH', '/usr/bin');
  run.mockRejectedValue(new Error('late failure'));
  const fetcher = vi.fn(
    (_url: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
      new Promise<Response>(() => undefined)
  );
  let text = '';
  const install = joinedInstall(
    new Map<string, string | true>([
      ['hosts', 'codex'],
      ['components', 'hooks'],
      ['apply', true],
      ['non-interactive', true],
      ['without-scanner', true],
      ['accept-limited', true],
    ]),
    {
      cwd: home,
      home,
      installStateDir: home,
      grantFetch: fetcher,
      preflight: {
        nodeVersion: '24.21.0',
        pathExists: async () => false,
        execFile: async () => {
          throw Object.assign(new Error('not found'), { code: 'ENOENT' });
        },
        fetch: async () => Response.json({}),
        resolveIdentity: async () => ({
          kind: 'absent',
          root: home,
          repository: { kind: 'plain', root: home },
          nested: [],
        }),
      },
    },
    new Output({
      write: (chunk) => {
        text += chunk;
      },
    }),
    async () => 'owner',
    async () => ({ stateDir: home, account: 'owner', getCliBearer: async () => 'fixture' })
  );

  await expect(
    Promise.race([
      install,
      delay(5_000).then(() => {
        throw new Error('installation did not return after the final-report deadline');
      }),
    ])
  ).resolves.toBe(3);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  expect(text).toContain('  Configuring your editors\n');
  expect(text).toContain('Installation stopped. Details:');
  expect(text).not.toContain('final installation status could not be uploaded');
}, 7_000);
