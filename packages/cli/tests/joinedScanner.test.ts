import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { serializeReadiness, isReadinessDocument } from '@mnemonik/shared';
import { recordPath } from '@mnemonik/local-setup';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { joinedInstall } from '../src/install/journey.js';
import { Output } from '../src/output.js';
import type { Journal } from '../src/install/journal.js';
import type { PreparedScanner } from '../src/scanner/enable.js';

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  discover: vi.fn(),
  status: vi.fn(),
  runtime: vi.fn(),
}));
vi.mock('../src/scanner/enable.js', async (original) => ({
  ...(await original<typeof import('../src/scanner/enable.js')>()),
  prepareScanner: mocks.prepare,
}));
vi.mock('../src/scanner/discover.js', () => ({ discoverRepositories: mocks.discover }));
vi.mock('../src/status.js', async (original) => ({
  ...(await original<typeof import('../src/status.js')>()),
  collectStatusDocument: mocks.status,
}));
vi.mock('../src/project.js', async (original) => ({
  ...(await original<typeof import('../src/project.js')>()),
  createRealProjectRuntime: mocks.runtime,
}));
const homes: string[] = [];
const complete = vi.fn();
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

it.each([
  ['unresolved project', 'prepared'],
  ['scanner failure', 'prepared'],
  ['unresolved project', 'http'],
])(
  '%s via %s preserves completed hosts and finishes the joined journey with exit 3',
  async (failure, upload) => {
    const home = await mkdtemp(join(tmpdir(), 'joined-scanner-'));
    homes.push(home);
    const stateDir = join(home, 'state');
    const hostFile = join(home, 'host.json');
    const scannerFile = join(home, 'scanner.json');
    const unresolved = join(home, 'foreign-project');
    const identity = join(unresolved, '.mnemonik.json');
    await mkdir(unresolved);
    await writeFile(identity, '{"projectId":"foreign"}\r\n');
    let journal!: Journal;
    const apply = vi.fn(async (current: Journal) => {
      await current.commit(
        await current.plan(scannerFile, Buffer.from('scanner installed'), {
          kind: 'runtime',
          group: 'scanner:test',
        })
      );
      if (failure === 'scanner failure') throw new Error('service_start_failed');
      return serializeReadiness({ installation: { conditions: [] } });
    });
    const rollback = vi.fn(async (current: Journal) => {
      for (const target of current.data.targets.filter((t) => t.group === 'scanner:test'))
        await current.restore(target);
    });
    mocks.prepare.mockImplementation(
      async (options, work: (plan: PreparedScanner) => Promise<void>) => {
        journal = options.journal;
        // Completed host writes are already in this same journal at the scanner boundary.
        await journal.commit(
          await journal.plan(hostFile, Buffer.from('host installed'), {
            kind: 'host',
            group: 'claude-code:hooks:user',
          })
        );
        return work({
          roots: [home],
          exclusions: [],
          files: [scannerFile],
          session: { id: 'session' },
          apply,
          rollback,
          complete,
        } as unknown as PreparedScanner);
      }
    );
    mocks.discover.mockResolvedValue({
      repositories:
        failure === 'unresolved project'
          ? [
              { path: unresolved, state: 'existing_project' },
              { path: home, state: 'not_set_up' },
            ]
          : [],
    });
    const executor = {
      stage: vi.fn(async ({ cwd }: { cwd: string }) => {
        if (cwd === unresolved)
          return { status: 'action_required', reason: 'project_access_denied' };
        const path = recordPath(cwd, stateDir);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, '{}');
        return { status: 'staged' };
      }),
      apply: vi.fn(async () => ({ status: 'done', projectId: 'registered-project' })),
      rollback: vi.fn(),
    };
    mocks.status.mockImplementation(async (input) => ({
      ...serializeReadiness({ installation: { conditions: input.installationConditions } }),
      cliCredential: { store: 'credential-manager', present: true },
    }));
    let text = '';
    const code = await joinedInstall(
      new Map<string, string | true>([
        ['json', true],
        ['apply', true],
        ['accept-scanner', true],
        ['scan-roots', home],
      ]),
      {
        home,
        cwd: home,
        installStateDir: stateDir,
        preflight: {
          nodeVersion: '24.21.0',
          pathExists: async () => false,
          fetch: async () => new Response('{}'),
          resolveIdentity: async () => ({
            kind: 'absent',
            root: home,
            repository: { kind: 'plain', root: home },
            nested: [],
          }),
        },
        projectExecutor: executor as any,
        grantFetch: async (_url, init) => {
          complete(JSON.parse(String(init?.body)).readiness);
          return Response.json({ status: 'completed' });
        },
      },
      new Output({
        write: (chunk) => {
          text += chunk;
        },
      }),
      async () => 'owner',
      async () => ({
        stateDir,
        account: 'owner',
        ...(upload === 'http' ? { getCliBearer: async () => 'fixture' } : {}),
        now: () => 0,
        sleep: async () => {},
      })
    );
    expect(code).toBe(3);
    expect(complete).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        installation: expect.objectContaining({
          state: failure === 'unresolved project' ? 'ACTION_REQUIRED' : 'LIMITED',
        }),
      })
    );
    expect(isReadinessDocument(complete.mock.calls[0]?.[0])).toBe(true);
    expect(journal.data.phase).toBe('complete');
    expect(await readFile(hostFile, 'utf8')).toBe('host installed');
    expect(apply).toHaveBeenCalledOnce();
    if (failure === 'unresolved project') {
      expect(rollback).not.toHaveBeenCalled();
      expect(executor.apply).toHaveBeenCalledOnce();
      expect(await readFile(identity, 'utf8')).toBe('{"projectId":"foreign"}\r\n');
      expect(await readFile(scannerFile, 'utf8')).toBe('scanner installed');
      const document = JSON.parse(text);
      expect(document.installation.state).toBe('ACTION_REQUIRED');
      expect(document.installation.reasons).toContain(`project_setup_required: ~/foreign-project`);
      expect(document.projects).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            identityFile: '~/foreign-project/.mnemonik.json',
            summary: expect.objectContaining({ state: 'ACTION_REQUIRED' }),
          }),
        ])
      );
    } else {
      expect(rollback).toHaveBeenCalledOnce();
      await expect(readFile(scannerFile)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(text).toContain('service_start_failed');
    }
  }
);

it.each([true, false])('reports fresh launcher status (json=%s)', async (json) => {
  const home = await mkdtemp(join(tmpdir(), 'joined-project-read-'));
  homes.push(home);
  const stateDir = join(home, 'state');
  const input = new Readable({ read() {} });
  input.push('Recommended\n');
  const projectId = '89844947-48a2-4c2b-805d-157be6441f13';
  await writeFile(join(home, '.mnemonik.json'), JSON.stringify({ schemaVersion: 1, projectId }));
  const transport = { readProjectState: vi.fn(async () => ({ state: 'access' })) };
  mocks.runtime.mockResolvedValue({ executor: {}, transport });
  mocks.discover.mockResolvedValue({ repositories: [] });
  mocks.prepare.mockImplementation(async (_options, work) =>
    work({
      roots: [home],
      exclusions: [],
      files: [],
      session: { id: 'session' },
      apply: async () => serializeReadiness({ installation: { conditions: [] } }),
      rollback: vi.fn(),
      complete,
    })
  );
  const actual = await vi.importActual<typeof import('../src/status.js')>('../src/status.js');
  mocks.status.mockImplementation(actual.collectStatusDocument);
  let text = '';
  await joinedInstall(
    new Map<string, string | true>([
      ...(json ? [['json', true] as [string, true]] : []),
      ['apply', true],
      ['accept-scanner', true],
      ['scan-roots', home],
    ]),
    {
      home,
      cwd: home,
      input,
      installStateDir: stateDir,
      preflight: {
        nodeVersion: '24.21.0',
        pathExists: async () => false,
        fetch: async () => new Response('{}'),
      },
      grantFetch: async () => Response.json({ status: 'completed' }),
    },
    new Output({
      write: (chunk) => {
        text += chunk;
      },
    }),
    async () => 'owner',
    async () => ({
      stateDir,
      account: 'owner',
      getCliBearer: async () => 'fixture',
      now: () => 0,
      sleep: async () => {},
    })
  );
  expect(transport.readProjectState).toHaveBeenCalledWith(projectId, 'fixture', null);
  if (!json) {
    expect(text).toContain('Launcher: present and ours;');
    expect(text).not.toContain('Launcher: missing;');
    return;
  }
  const document = JSON.parse(text);
  expect(document.launcher.ownership).toBe('ours');
  expect(document.projects[0].projectId).toBe(projectId);
  expect(document.projects[0].summary.reasons).not.toContain(
    'Project access has not been verified.'
  );
});
