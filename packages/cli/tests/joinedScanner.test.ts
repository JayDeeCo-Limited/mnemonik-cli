import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { ReadableStream } from 'node:stream/web';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { serializeReadiness, isReadinessDocument } from '@mnemonik/shared';
import { createProjectSetupExecutor, recordPath } from '@mnemonik/local-setup';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { joinedInstall } from '../src/install/journey.js';
import { Output } from '../src/output.js';
import type { Journal } from '../src/install/journal.js';
import type { PreparedScanner } from '../src/scanner/enable.js';
import { ScannerServiceLimited } from '../src/scanner/service.js';
import { releaseBytes } from '../src/runtime/releaseSource.js';

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  discover: vi.fn(),
  classify: vi.fn(),
  status: vi.fn(),
  runtime: vi.fn(),
  fingerprint: vi.fn(),
}));
vi.mock('../src/scanner/enable.js', async (original) => ({
  ...(await original<typeof import('../src/scanner/enable.js')>()),
  prepareScanner: mocks.prepare,
}));
vi.mock('../src/scanner/discover.js', async (original) => ({
  ...(await original<typeof import('../src/scanner/discover.js')>()),
  discoverRepositories: mocks.discover,
  classifyRepository: mocks.classify,
}));
vi.mock('../src/status.js', async (original) => ({
  ...(await original<typeof import('../src/status.js')>()),
  collectStatusDocument: mocks.status,
}));
vi.mock('../src/project.js', async (original) => ({
  ...(await original<typeof import('../src/project.js')>()),
  createRealProjectRuntime: mocks.runtime,
  repositoryFingerprint: mocks.fingerprint,
}));
const homes: string[] = [];
const complete = vi.fn();
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

it('does not show repository progress between the folder question and its answer', async () => {
  const home = await mkdtemp(join(tmpdir(), 'joined-scanner-question-'));
  homes.push(home);
  const stateDir = join(home, 'state');
  let text = '';
  mocks.prepare.mockImplementation(async (options) => {
    options.output.line('Where do your projects live? [~/projects]');
    options.output.line('FOLDER ANSWER RECEIVED');
    throw new Error('question_probe_complete');
  });
  mocks.status.mockResolvedValue({
    ...serializeReadiness({ installation: { conditions: [] } }),
    cliCredential: { present: true, diagnostics: [] },
  });

  await joinedInstall(
    new Map<string, string | true>([
      ['components', 'scanner'],
      ['accept-indexing', true],
      ['apply', true],
    ]),
    {
      home,
      cwd: home,
      input: Object.assign(Readable.from([]), { isTTY: true }),
      installStateDir: stateDir,
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
      launcher: { platform: 'linux' },
    },
    new Output({ isTTY: true, write: (chunk) => void (text += chunk) }),
    async () => 'owner',
    async () => ({ stateDir, account: 'owner', now: () => 0, sleep: async () => {} })
  );

  const between = text.slice(
    text.indexOf('Where do your projects live?'),
    text.indexOf('FOLDER ANSWER RECEIVED')
  );
  expect(between).not.toContain('Connecting your project folders');
});

it.each([
  ['unresolved project', 'prepared'],
  ['scanner failure', 'prepared'],
  ['scanner stalled download', 'prepared'],
  ['scanner limited', 'prepared'],
  ['systemd_linger_required', 'prepared'],
  ['systemd_session_unavailable', 'prepared'],
  ['mac_authorization_failed', 'prepared'],
  ['unresolved project', 'http'],
])(
  '%s via %s preserves completed hosts and finishes the joined journey with exit 3',
  async (failure, upload) => {
    const sessionFailure =
      failure.endsWith('_required') ||
      failure.endsWith('_unavailable') ||
      failure === 'mac_authorization_failed';
    const human =
      sessionFailure || failure === 'scanner limited' || failure === 'scanner stalled download';
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
    let stalledDownloadMs: number | undefined;
    const apply = vi.fn(async (current: Journal) => {
      await current.commit(
        await current.plan(scannerFile, Buffer.from('scanner installed'), {
          kind: 'runtime',
          group: 'scanner:test',
        })
      );
      if (sessionFailure) throw new ScannerServiceLimited(failure);
      if (failure === 'scanner failure') throw new Error('service_start_failed');
      if (failure === 'scanner stalled download') {
        const started = Date.now();
        try {
          await releaseBytes(
            'https://github.com/JayDeeCo-Limited/mnemonik-cli/releases/download/scanner-v1.2.3/scanner',
            async (_url, options) => {
              const signal = options?.signal;
              return new Response(
                new ReadableStream({
                  start(controller) {
                    controller.enqueue(Uint8Array.of(1));
                    signal?.addEventListener('abort', () => controller.error(signal.reason), {
                      once: true,
                    });
                  },
                })
              );
            },
            10
          );
        } finally {
          stalledDownloadMs = Date.now() - started;
        }
      }
      if (failure === 'scanner limited')
        throw new ScannerServiceLimited('windows_task_creation_failed', 'Access is denied.');
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
          roots: failure === 'unresolved project' ? [unresolved, home] : [home],
          exclusions: [],
          files: [scannerFile],
          session: { id: 'session' },
          apply,
          rollback,
          complete,
        } as unknown as PreparedScanner);
      }
    );
    mocks.classify.mockImplementation(async (path) => ({
      path,
      state: path === unresolved ? 'existing_project' : 'not_set_up',
    }));
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
      resolveProjectIdentity: vi.fn(async (cwd: string) => ({
        kind: 'ok',
        root: cwd,
        repository: { kind: 'plain', root: cwd },
        identity: { projectId: '55555555-5555-4555-8555-555555555555' },
      })),
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
      cliCredential: { store: 'credential-manager', present: true, diagnostics: [] },
    }));
    let text = '';
    const code = await joinedInstall(
      new Map<string, string | true>([
        ...(human ? [] : ([['json', true]] as Array<[string, true]>)),
        ['components', 'scanner'],
        ['apply', true],
        ['accept-scanner', true],
        ['scan-roots', home],
      ]),
      {
        home,
        cwd: home,
        ...(human ? { input: Object.assign(Readable.from('\n'), { isTTY: true }) } : {}),
        installStateDir: stateDir,
        preflight: {
          nodeVersion: '24.21.0',
          ...(failure === 'scanner limited' ? { platform: 'win32' as const } : {}),
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
    if (!human) {
      expect(complete).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          installation: expect.objectContaining({
            state: failure === 'unresolved project' ? 'ACTION_REQUIRED' : 'LIMITED',
          }),
        })
      );
      expect(isReadinessDocument(complete.mock.calls[0]?.[0])).toBe(true);
    }
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
      expect(document.installation.reasons).toEqual([
        expect.stringMatching(/^project_setup_required: .+: ~\/foreign-project$/),
      ]);
      expect(document.projects).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            identityFile: '~/foreign-project/.mnemonik.json',
            summary: expect.objectContaining({ state: 'ACTION_REQUIRED' }),
          }),
        ])
      );
    } else if (sessionFailure) {
      expect(rollback).toHaveBeenCalledOnce();
      const limited = new ScannerServiceLimited(failure);
      expect(text).toContain(limited.summary);
      expect(text).toContain(limited.action);
      expect(text).not.toContain('[COPY REVIEW REQUIRED]');
      if (failure === 'systemd_linger_required')
        expect(text).toContain('sudo loginctl enable-linger');
      if (failure === 'systemd_session_unavailable')
        expect(text).toContain('enable systemd user services');
      if (failure === 'mac_authorization_failed')
        expect(text).toContain('the password was not accepted');
    } else if (failure === 'scanner failure') {
      expect(rollback).toHaveBeenCalledOnce();
      await expect(readFile(scannerFile)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(text).toContain('service_start_failed');
    } else if (failure === 'scanner stalled download') {
      expect(rollback).toHaveBeenCalledOnce();
      await expect(readFile(scannerFile)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(stalledDownloadMs).toBeGreaterThanOrEqual(8);
      expect(stalledDownloadMs).toBeLessThan(250);
      expect(journal.data.state).toBe('LIMITED');
      expect(text).toContain('Background indexing could not be started.');
      expect(text).toContain('Run mnemonik install to try again.');
      expect(text).not.toContain('✓ Repositories connected');
      expect(text).not.toContain('✓ Installation finished');
      expect(text).not.toMatch(/^\s*\d+\.\s+mnemonik install\s*$/mu);
    } else {
      expect(rollback).toHaveBeenCalledOnce();
      expect(text).not.toContain('Authorize the Mnemonik MCP connection');
      expect(text).toContain('Background indexing could not be started.');
    }
  }
);

it.each([true, false])('reports fresh launcher status (json=%s)', async (json) => {
  const home = await mkdtemp(join(tmpdir(), 'joined-project-read-'));
  homes.push(home);
  const stateDir = join(home, 'state');
  const input = new Readable({ read() {} });
  input.push('\n');
  const projectId = '89844947-48a2-4c2b-805d-157be6441f13';
  await writeFile(join(home, '.mnemonik.json'), JSON.stringify({ schemaVersion: 1, projectId }));
  const transport = { readProjectState: vi.fn(async () => ({ state: 'access' })) };
  mocks.runtime.mockResolvedValue({ executor: {}, transport });
  mocks.classify.mockImplementation(async (path) => ({ path, state: 'existing_project' }));
  mocks.discover.mockResolvedValue({ repositories: [] });
  mocks.prepare.mockImplementation(async (_options, work) =>
    work({
      roots: [],
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
      ['components', 'scanner'],
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
    expect(text).not.toContain('Launcher:');
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

it('connects all three ticked repositories when two owned identities already exist', async () => {
  const home = await mkdtemp(join(tmpdir(), 'joined-existing-projects-'));
  homes.push(home);
  const stateDir = join(home, 'state');
  const first = join(home, 'first');
  const second = join(home, 'second');
  const fresh = join(home, 'fresh');
  const projectIds = new Map([
    [first, '11111111-1111-4111-8111-111111111111'],
    [second, '22222222-2222-4222-8222-222222222222'],
  ]);
  await Promise.all([mkdir(first), mkdir(second), mkdir(fresh)]);
  for (const [root, projectId] of projectIds)
    await writeFile(join(root, '.mnemonik.json'), JSON.stringify({ schemaVersion: 1, projectId }));
  mocks.classify.mockImplementation(async (path) => ({
    path,
    state: projectIds.has(path) ? 'existing_project' : 'not_set_up',
  }));
  mocks.prepare.mockImplementation(async (_options, work) =>
    work({
      roots: [first, second, fresh],
      exclusions: [],
      files: [],
      session: { id: 'session' },
      apply: async () => serializeReadiness({ installation: { conditions: [] } }),
      rollback: vi.fn(),
      complete,
    })
  );
  const executor = {
    resolveProjectIdentity: vi.fn(async (cwd: string) => ({
      kind: 'ok',
      root: cwd,
      repository: { kind: 'plain', root: cwd },
      identity: { projectId: projectIds.get(cwd) },
    })),
    stage: vi.fn(async (options: { cwd: string; intent?: { projectId: string } }) => {
      const existing = projectIds.get(options.cwd);
      if (existing && options.intent?.projectId !== existing)
        return {
          status: 'project_setup_required',
          state: 'confirmation_required',
          allowedActions: ['link', 'create', 'cancel'],
        };
      const projectId = existing ?? '33333333-3333-4333-8333-333333333333';
      const path = recordPath(options.cwd, stateDir);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        JSON.stringify({
          staged: {
            content: `${JSON.stringify({ schemaVersion: 1, projectId })}\n`,
            hash: 'fixture',
          },
        })
      );
      return { status: 'staged', projectId };
    }),
    apply: vi.fn(async (options: { cwd: string; intent?: { projectId: string } }) => {
      const existing = projectIds.get(options.cwd);
      if (existing && options.intent?.projectId !== existing)
        return { status: 'ACTION_REQUIRED', state: 'confirmation_required', allowedActions: [] };
      const projectId = existing ?? '33333333-3333-4333-8333-333333333333';
      await writeFile(
        join(options.cwd, '.mnemonik.json'),
        `${JSON.stringify({ schemaVersion: 1, projectId })}\n`
      );
      return { status: 'done', projectId };
    }),
    rollback: vi.fn(),
  };
  mocks.status.mockImplementation(async (input) => ({
    ...serializeReadiness({ installation: { conditions: input.installationConditions } }),
    cliCredential: { store: 'credential-manager', present: true, diagnostics: [] },
  }));
  let text = '';
  const code = await joinedInstall(
    new Map<string, string | true>([
      ['components', 'scanner'],
      ['apply', true],
      ['accept-scanner', true],
      ['scan-roots', home],
    ]),
    {
      home,
      cwd: home,
      input: Readable.from('Recommended\n'),
      installStateDir: stateDir,
      projectExecutor: executor as any,
      preflight: { nodeVersion: '24.21.0', fetch: async () => Response.json({}) },
      grantFetch: async () => Response.json({ status: 'completed' }),
    },
    new Output({ write: (chunk) => void (text += chunk) }),
    async () => 'owner',
    async () => ({ stateDir, account: 'owner', now: () => 0, sleep: async () => {} })
  );

  expect(code).toBe(0);
  expect(text).toContain('  ✓ Connected 3 project folders.');
  expect(text).not.toContain('mnemonik project init');
  expect(executor.apply).toHaveBeenCalledTimes(3);
});

it('leaves a fingerprint mismatch out while connecting a matching identity', async () => {
  const home = await mkdtemp(join(tmpdir(), 'joined-fingerprint-mismatch-'));
  homes.push(home);
  const stateDir = join(home, 'state');
  const matching = join(home, 'matching');
  const mismatch = join(home, 'mismatch');
  const matchingProjectId = '44444444-4444-4444-8444-444444444444';
  const mismatchProjectId = '55555555-5555-4555-8555-555555555555';
  const fingerprintA = { algorithmVersion: 1 as const, hash: 'a'.repeat(64) };
  const fingerprintB = { algorithmVersion: 1 as const, hash: 'b'.repeat(64) };
  await Promise.all([mkdir(matching), mkdir(mismatch)]);
  for (const [root, projectId] of [
    [matching, matchingProjectId],
    [mismatch, mismatchProjectId],
  ] as const)
    await writeFile(join(root, '.mnemonik.json'), JSON.stringify({ schemaVersion: 1, projectId }));
  const resolveProjectIdentity = vi.fn(async (cwd: string) => ({
    kind: 'ok' as const,
    root: cwd,
    repository: {
      kind: 'git' as const,
      root: cwd,
      commonDir: join(cwd, '.git'),
      isLinkedWorktree: false,
      nested: [],
    },
    nested: [],
    identity: {
      schemaVersion: 1 as const,
      projectId: cwd === matching ? matchingProjectId : mismatchProjectId,
    },
  }));
  const consumeSetupRequest = vi.fn(async () => ({
    status: 'complete' as const,
    projectId: mismatchProjectId,
    displayName: 'project',
  }));
  const local = createProjectSetupExecutor({
    resolver: { resolveProjectIdentity },
    scopeKey: 'owner:device',
    stateDir,
    bindContext: async (root) => ({
      deviceRootContext: { algorithmVersion: 1, hash: 'c'.repeat(64) },
      repositoryFingerprint: root === matching ? fingerprintA : fingerprintB,
    }),
    transport: {
      issueSetupRequest: vi.fn(async ({ repositoryFingerprint }) =>
        repositoryFingerprint?.hash === fingerprintA.hash
          ? { status: 'complete' as const, projectId: matchingProjectId, displayName: 'project' }
          : {
              status: 'project_setup_required' as const,
              state: 'fingerprint_mismatch',
              allowedActions: ['link', 'cancel'],
              requestId: '66666666-6666-4666-8666-666666666666',
            }
      ),
      consumeSetupRequest,
    },
  });
  const executor = { resolveProjectIdentity, ...local };
  const scannerApply = vi.fn(async () => serializeReadiness({ installation: { conditions: [] } }));
  mocks.classify.mockImplementation(async (path) => ({ path, state: 'existing_project' }));
  mocks.prepare.mockImplementation(async (_options, work) =>
    work({
      roots: [matching, mismatch],
      exclusions: [],
      files: [],
      session: { id: 'session' },
      apply: scannerApply,
      rollback: vi.fn(),
      complete,
    })
  );
  mocks.status.mockImplementation(async (input) => ({
    ...serializeReadiness({ installation: { conditions: input.installationConditions } }),
    cliCredential: { store: 'credential-manager', present: true, diagnostics: [] },
  }));
  let text = '';
  const code = await joinedInstall(
    new Map<string, string | true>([
      ['components', 'scanner'],
      ['apply', true],
      ['accept-scanner', true],
      ['scan-roots', home],
    ]),
    {
      home,
      cwd: home,
      input: Readable.from('\n'),
      installStateDir: stateDir,
      projectExecutor: executor,
      preflight: { nodeVersion: '24.21.0', fetch: async () => Response.json({}) },
      grantFetch: async () => Response.json({ status: 'completed' }),
    },
    new Output({ write: (chunk) => void (text += chunk) }),
    async () => 'owner',
    async () => ({ stateDir, account: 'owner', now: () => 0, sleep: async () => {} })
  );

  expect(code).toBe(3);
  expect(consumeSetupRequest).not.toHaveBeenCalled();
  expect(scannerApply).toHaveBeenCalledWith(expect.anything(), [matching]);
  expect(text).not.toContain('mnemonik project init');
  expect(text).toContain(
    'mismatch was not connected. Its Git remote does not match the repository this project was set up with.'
  );
  expect(text).not.toContain(home);
  expect(text).not.toContain('fingerprint_mismatch');
  expect(await readFile(join(matching, '.mnemonik.json'), 'utf8')).toContain(matchingProjectId);
  expect(await readFile(join(mismatch, '.mnemonik.json'), 'utf8')).toBe(
    JSON.stringify({ schemaVersion: 1, projectId: mismatchProjectId })
  );
});

it.each([
  {
    name: 'prefers a nested Git checkout over a shorter non-Git copy with the same project UUID',
    paths: ['w/devops', 'w/devops/dokploy-mcp-server'],
    expected: 'w/devops/dokploy-mcp-server',
    nonGit: 'w/devops',
  },
  {
    name: 'prefers a local-fingerprint match when ordering duplicate attempts',
    paths: ['w/a-copy', 'w/z-original'],
    expected: 'w/z-original',
    matchingFingerprint: 'w/z-original',
  },
])('$name', async ({ paths, expected, nonGit, matchingFingerprint }) => {
  const home = await mkdtemp(join(tmpdir(), 'joined-duplicate-project-'));
  homes.push(home);
  const stateDir = join(home, 'state');
  const roots = paths.map((path) => join(home, path));
  const selectedRoot = join(home, expected);
  const leftoverPath = paths.find((path) => path !== expected);
  if (!leftoverPath) throw new Error('duplicate fixture requires a leftover path');
  const projectId = '66666666-6666-4666-8666-666666666666';
  const storedFingerprint = { algorithmVersion: 1 as const, hash: 'a'.repeat(64) };
  await Promise.all(roots.map((root) => mkdir(root, { recursive: true })));
  for (const root of roots)
    await writeFile(join(root, '.mnemonik.json'), JSON.stringify({ schemaVersion: 1, projectId }));
  mocks.classify.mockImplementation(async (path) => ({
    path,
    state: 'existing_project',
  }));
  mocks.fingerprint.mockImplementation(async (path) =>
    matchingFingerprint && path === join(home, matchingFingerprint)
      ? storedFingerprint
      : { algorithmVersion: 1, hash: 'b'.repeat(64) }
  );
  const scannerApply = vi.fn(async () => serializeReadiness({ installation: { conditions: [] } }));
  mocks.prepare.mockImplementation(async (_options, work) =>
    work({
      roots,
      exclusions: [],
      files: [],
      session: { id: 'session' },
      apply: scannerApply,
      rollback: vi.fn(),
      complete,
    })
  );
  const executor = {
    resolveProjectIdentity: vi.fn(async (cwd: string) => ({
      kind: 'ok',
      root: cwd,
      repository:
        nonGit && cwd === join(home, nonGit)
          ? { kind: 'plain', root: cwd }
          : {
              kind: 'git',
              root: cwd,
              commonDir: join(cwd, '.git'),
              isLinkedWorktree: false,
              nested: [],
            },
      identity: {
        projectId,
        ...(matchingFingerprint ? { repositoryFingerprint: storedFingerprint } : {}),
      },
    })),
    stage: vi.fn(async ({ cwd }: { cwd: string }) => {
      const path = recordPath(cwd, stateDir);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        JSON.stringify({ staged: { content: JSON.stringify({ schemaVersion: 1, projectId }) } })
      );
      return { status: 'staged', projectId };
    }),
    apply: vi.fn(async () => ({ status: 'done', projectId })),
    rollback: vi.fn(),
  };
  mocks.status.mockImplementation(async (input) => ({
    ...serializeReadiness({ installation: { conditions: input.installationConditions } }),
    cliCredential: { store: 'credential-manager', present: true, diagnostics: [] },
  }));
  let text = '';
  const code = await joinedInstall(
    new Map<string, string | true>([
      ['components', 'scanner'],
      ['apply', true],
      ['accept-scanner', true],
      ['scan-roots', home],
    ]),
    {
      home,
      cwd: home,
      input: Readable.from('\n'),
      installStateDir: stateDir,
      projectExecutor: executor as any,
      preflight: { nodeVersion: '24.21.0', fetch: async () => Response.json({}) },
      grantFetch: async () => Response.json({ status: 'completed' }),
    },
    new Output({ write: (chunk) => void (text += chunk) }),
    async () => 'owner',
    async () => ({ stateDir, account: 'owner', now: () => 0, sleep: async () => {} })
  );

  expect(code).toBe(3);
  expect(executor.stage).toHaveBeenCalledTimes(1);
  expect(executor.stage).toHaveBeenCalledWith(expect.objectContaining({ cwd: selectedRoot }));
  expect(executor.apply).toHaveBeenCalledTimes(1);
  expect(scannerApply).toHaveBeenCalledWith(expect.anything(), [selectedRoot]);
  expect(text).toContain('  ✓ Connected 1 project folder.');
  expect(text).not.toContain('mnemonik project init');
  expect(text).toContain(
    `${leftoverPath.split('/').at(-1)} was not connected. It belongs to the same project as ${expected.split('/').at(-1)}, which is already connected.`
  );
  expect(text).not.toContain(home);
  expect(text).not.toContain('duplicate_project_id');
});

it('leaves one inaccessible identity for the person and reports it once', async () => {
  const home = await mkdtemp(join(tmpdir(), 'joined-foreign-project-'));
  homes.push(home);
  const stateDir = join(home, 'state');
  const root = join(home, 'foreign');
  const projectId = '44444444-4444-4444-8444-444444444444';
  await mkdir(root);
  await writeFile(join(root, '.mnemonik.json'), JSON.stringify({ schemaVersion: 1, projectId }));
  mocks.classify.mockResolvedValue({ path: root, state: 'existing_project' });
  mocks.prepare.mockImplementation(async (_options, work) =>
    work({
      roots: [root],
      exclusions: [],
      files: [],
      session: { id: 'session' },
      apply: async () => serializeReadiness({ installation: { conditions: [] } }),
      rollback: vi.fn(),
      complete,
    })
  );
  const executor = {
    resolveProjectIdentity: vi.fn(async () => ({
      kind: 'ok',
      root,
      repository: { kind: 'plain', root },
      identity: { projectId },
    })),
    stage: vi.fn(async () => ({
      status: 'project_setup_required',
      state: 'not_found',
      allowedActions: ['switch_account', 'ask_owner', 'ignore', 'cancel'],
    })),
    apply: vi.fn(),
    rollback: vi.fn(),
  };
  mocks.status.mockImplementation(async (input) => ({
    ...serializeReadiness({ installation: { conditions: input.installationConditions } }),
    cliCredential: { store: 'credential-manager', present: true, diagnostics: [] },
  }));
  let text = '';
  const code = await joinedInstall(
    new Map<string, string | true>([
      ['components', 'scanner'],
      ['apply', true],
      ['accept-scanner', true],
      ['scan-roots', home],
    ]),
    {
      home,
      cwd: home,
      input: Readable.from('Recommended\n'),
      installStateDir: stateDir,
      projectExecutor: executor as any,
      preflight: { nodeVersion: '24.21.0', fetch: async () => Response.json({}) },
      grantFetch: async () => Response.json({ status: 'completed' }),
    },
    new Output({ write: (chunk) => void (text += chunk) }),
    async () => 'owner',
    async () => ({ stateDir, account: 'owner', now: () => 0, sleep: async () => {} })
  );

  expect(code).toBe(3);
  expect(executor.stage).toHaveBeenCalledWith(
    expect.objectContaining({ intent: { action: 'link', projectId } })
  );
  expect(text).not.toContain('mnemonik project init');
  expect(executor.apply).not.toHaveBeenCalled();
});

it('keeps earlier projects and reports the skipped count when the plan limit is reached', async () => {
  const home = await mkdtemp(join(tmpdir(), 'joined-project-limit-'));
  homes.push(home);
  const stateDir = join(home, 'state');
  const app = join(home, 'app');
  const shop = join(home, 'shop');
  const docs = join(home, 'docs');
  const api = join(home, 'api');
  await Promise.all([mkdir(app), mkdir(shop), mkdir(docs), mkdir(api)]);
  let appliedRoots: string[] = [];
  mocks.classify.mockImplementation(async (path) => ({
    path,
    state: 'not_set_up',
  }));
  mocks.prepare.mockImplementation(async (options, work) =>
    work({
      roots: [app, shop, docs, api],
      exclusions: [],
      files: [],
      session: { id: 'session' },
      projectExecutor: async () => options.projectExecutor,
      apply: async () => {
        appliedRoots = [app, shop, docs, api].filter((root) =>
          options.journal.data.roots.includes(root)
        );
        return serializeReadiness({ installation: { conditions: [] } });
      },
      rollback: vi.fn(),
      complete,
    })
  );
  const executor = {
    stage: vi.fn(async ({ cwd }: { cwd: string }) => {
      if ([shop, docs, api].includes(cwd))
        return {
          status: 'ACTION_REQUIRED',
          state: 'project_limit_reached',
          allowedActions: ['retry', 'cancel'],
          used: 1,
          limit: 1,
          tier: 'free',
          existingProjectNames: ['acme'],
        };
      const path = recordPath(cwd, stateDir);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        JSON.stringify({ staged: { content: '{"projectId":"app"}\n', hash: 'fixture' } })
      );
      return { status: 'staged' };
    }),
    apply: vi.fn(async ({ cwd }: { cwd: string }) => {
      await writeFile(join(cwd, '.mnemonik.json'), '{"projectId":"app"}\n');
      return { status: 'done', projectId: 'app' };
    }),
    rollback: vi.fn(),
  };
  mocks.status.mockResolvedValue({
    ...serializeReadiness({ installation: { conditions: [] } }),
    cliCredential: { present: true, diagnostics: [] },
    launcher: { ownership: 'ours', path: 'mnemonik', onPath: true, action: '' },
  });
  let text = '';
  const code = await joinedInstall(
    new Map<string, string | true>([
      ['components', 'scanner'],
      ['apply', true],
      ['accept-scanner', true],
      ['scan-roots', home],
    ]),
    {
      home,
      cwd: home,
      input: Readable.from('\n'),
      installStateDir: stateDir,
      projectExecutor: executor as any,
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
      grantFetch: async () => Response.json({ status: 'completed' }),
    },
    new Output({ write: (chunk) => void (text += chunk) }),
    async () => 'owner',
    async () => ({
      stateDir,
      account: 'owner',
      getCliBearer: async () => 'fixture',
      now: () => 0,
      sleep: async () => {},
    })
  );

  expect(code).toBe(0);
  expect(appliedRoots).toEqual([app]);
  expect(executor.apply).toHaveBeenCalledOnce();
  expect(await readFile(join(app, '.mnemonik.json'), 'utf8')).toContain('app');
  await expect(readFile(join(shop, '.mnemonik.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(text).toContain('  ✓ Connected 1 project folder.');
  expect(text).toContain('shop and 2 more were not connected. The Free plan includes one project.');
  expect(text).toContain(
    'To connect more projects, upgrade your plan via the Mnemonik web console.'
  );
});

it.each([false, true])(
  'hands the TTY and signals to scanner apply, then restores answers for later questions (authorization rejected: %s)',
  async (rejected) => {
    const { PassThrough } = await import('node:stream');
    const home = await mkdtemp(join(tmpdir(), 'joined-scanner-tty-'));
    homes.push(home);
    const stateDir = join(home, 'state');
    let raw = false;
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: vi.fn((enabled: boolean) => {
        raw = enabled;
      }),
    });
    const sigintListeners = process.listenerCount('SIGINT');
    const sighupListeners = process.listenerCount('SIGHUP');
    let text = '';
    const output = new Output({
      isTTY: true,
      write: (chunk) => {
        text += chunk;
      },
    });
    const progressLine = output.progressLine.bind(output);
    const stops: ReturnType<typeof vi.fn>[] = [];
    vi.spyOn(output, 'progressLine').mockImplementation((message, animated) => {
      const progress = progressLine(message, animated);
      const stop = vi.fn(progress.stop);
      stops.push(stop);
      return { ...progress, stop };
    });
    let handoffVerified = false;
    let answersRestored = false;
    const apply = vi.fn(async () => {
      expect(raw).toBe(false);
      expect(input.isPaused()).toBe(true);
      expect(input.listenerCount('keypress')).toBe(0);
      expect(process.listenerCount('SIGINT')).toBe(sigintListeners);
      expect(process.listenerCount('SIGHUP')).toBe(sighupListeners);
      expect(stops.at(-1)).toHaveBeenCalled();
      input.write('fixture-password');
      await new Promise<void>((resolve) => globalThis.setImmediate(resolve));
      expect(input.readableLength).toBe('fixture-password'.length);
      input.read('fixture-password'.length); // The privileged reader consumes these bytes.
      expect(text).not.toContain('fixture-password');
      handoffVerified = true;
      if (rejected) throw new ScannerServiceLimited('mac_authorization_failed');
      return serializeReadiness({ installation: { conditions: [] } });
    });
    mocks.prepare.mockImplementation(async (options, work) => {
      expect(raw).toBe(true);
      await work({
        roots: [],
        exclusions: [],
        files: [],
        session: { id: 'session' },
        apply,
        rollback: vi.fn(),
        complete: vi.fn(),
      });
      expect(raw).toBe(true);
      expect(input.isPaused()).toBe(false);
      expect(input.listenerCount('keypress')).toBe(1);
      const answer = options.readAnswer();
      input.write('after\r');
      expect(await answer).toBe('after');
      answersRestored = true;
    });
    mocks.status.mockImplementation(async (options) => ({
      ...serializeReadiness({ installation: { conditions: options.installationConditions } }),
      cliCredential: { present: true, diagnostics: [] },
    }));
    expect(
      await joinedInstall(
        new Map<string, string | true>([
          ['components', 'scanner'],
          ['accept-indexing', true],
          ['apply', true],
          ['scan-roots', home],
        ]),
        {
          home,
          cwd: home,
          input,
          installStateDir: stateDir,
          projectExecutor: {} as never,
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
        output,
        async () => 'owner',
        async () => ({ stateDir, account: 'owner' })
      )
    ).toBe(rejected ? 3 : 0);
    expect(apply).toHaveBeenCalledOnce();
    expect(handoffVerified).toBe(true);
    expect(answersRestored).toBe(true);
    expect(raw).toBe(false);
    expect(input.isPaused()).toBe(true);
    expect(process.listenerCount('SIGINT')).toBe(sigintListeners);
  }
);
