import { mkdir, mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { joinedInstall } from '../src/install/journey.js';
import { Output } from '../src/output.js';
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
  async (state, count, apiResource, consoleUrl, foreign?: boolean, foreignOnPath?: boolean) => {
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
      ['integration-scope', 'user'],
    ]);
    if (state === 'LIMITED' || foreign) flags.delete('json');
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
      expect(text).toContain('Done, with one thing left.');
      expect(text).toContain('Installation: Setup needs one action.');
      expect(text).toContain('Launcher: present and not ours;');
      expect(text).toContain('~/.local/bin/mnemonik');
      expect(text).toContain('Move the existing');
      expect(text).toContain('Status and devices:');
      expect(text).toContain('In this terminal: npx -y @mnemonik/cli@latest status');
      expect(text).not.toContain('On this machine: mnemonik status');
    } else if (state === 'READY' || state === 'LIMITED') {
      expect(await readFile(launcher, 'utf8')).toContain('runtimes/bootstrap/dist/bin.js');
      expect((await stat(launcher)).mode & 0o777).toBe(0o755);
    }
    if (state === 'LIMITED') {
      expect(text).toContain(
        onPath ? 'On this machine: mnemonik status' : 'npx -y @mnemonik/cli@latest status'
      );
      if (onPath) expect(text).not.toContain('In this terminal:');
      else expect(text).toContain('new terminal after that');
    }
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
    if (state === 'LIMITED') {
      expect(text).toContain(count ? `Done, with ${count} things left.` : '  Done.\n');
      expect(text).toContain(`Status and devices: ${consoleUrl}`);
      expect(body.readiness.installation.reasons).toEqual(reasons);
      for (const reason of reasons) expect(text).toContain(reason);
    }
  }
);
