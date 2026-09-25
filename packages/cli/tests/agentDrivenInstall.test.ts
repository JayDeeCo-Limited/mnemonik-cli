import { execFile as execFileCallback } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { resolveProjectIdentity, serializeReadiness } from '@mnemonik/shared';
import type { SetupTransport } from '@mnemonik/local-setup';

const scanner = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock('../src/scanner/enable.js', async (original) => ({
  ...(await original<typeof import('../src/scanner/enable.js')>()),
  prepareScanner: scanner.prepare,
}));

import { joinedInstall, type RepositoryOutcome, type WaitAnswer } from '../src/install/journey.js';
import { Output } from '../src/output.js';
import { projectExecutor, type ProjectExecutor } from '../src/project.js';
import { runCli, type CliDependencies } from '../src/router.js';

const exec = promisify(execFileCallback);
const homes: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

const uuid = (seed: string) => {
  const hex = createHash('sha256').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/** A server that links any named project, creates the rest, and is full for one folder. */
function transport(full: string): SetupTransport {
  return {
    issueSetupRequest: vi.fn(async (input) =>
      input.projectId
        ? { status: 'complete' as const, projectId: input.projectId, displayName: 'linked' }
        : {
            status: 'project_setup_required' as const,
            state: 'missing',
            allowedActions: ['create', 'cancel'],
            requestId: randomUUID(),
          }
    ),
    consumeSetupRequest: vi.fn(async (input) =>
      input.displayName === full
        ? {
            status: 'ACTION_REQUIRED' as const,
            state: 'project_limit_reached',
            allowedActions: ['upgrade', 'cancel'],
            used: 11,
            limit: 11,
            tier: 'pro',
          }
        : {
            status: 'complete' as const,
            projectId: uuid(input.displayName ?? 'new'),
            displayName: input.displayName ?? 'new',
          }
    ),
  };
}

function executor(stateDir: string, scopeKey: string, full: string): ProjectExecutor {
  const resolver = {
    resolveProjectIdentity: ((cwd, options) =>
      resolveProjectIdentity(cwd, {
        ...options,
        selectedRoot: true,
      })) as typeof resolveProjectIdentity,
  };
  return projectExecutor({
    resolver,
    transport: transport(full),
    scopeKey,
    stateDir,
    bindContext: async (root) => ({
      deviceRootContext: {
        algorithmVersion: 1,
        hash: createHash('sha256').update(root).digest('hex'),
      },
      repositoryFingerprint: null,
    }),
  });
}

/**
 * Fifteen ticked folders, as on the Linux server run of L-103: seven Git
 * repositories and two plain folders with their own project ids, one copy of a
 * repository that names the same project, two identity files with no project
 * id, one new repository, one unreadable identity file, and one new folder the
 * plan has no room for.
 */
async function fifteen() {
  const home = await mkdtemp(join(tmpdir(), 'agent-driven-install-'));
  homes.push(home);
  const projects = join(home, 'Projects');
  const stateDir = join(home, 'state');
  const roots: string[] = [];
  const add = async (name: string, git: boolean, identity?: unknown) => {
    const path = join(projects, name);
    await mkdir(path, { recursive: true });
    if (git) await exec('git', ['init', '--quiet'], { cwd: path });
    if (identity !== undefined)
      await writeFile(join(path, '.mnemonik.json'), JSON.stringify(identity) + '\n');
    roots.push(path);
    return path;
  };
  const ids = new Map<string, string>();
  for (let index = 1; index <= 7; index++) {
    const name = `repo-${index}`;
    ids.set(name, uuid(name));
    await add(name, true, { schemaVersion: 1, projectId: uuid(name) });
  }
  for (const name of ['notes', 'site']) {
    ids.set(name, uuid(name));
    await add(name, false, { schemaVersion: 1, projectId: uuid(name) });
  }
  await add('repo-1-copy', true, { schemaVersion: 1, projectId: uuid('repo-1') });
  await add('no-id-a', true, { schemaVersion: 1 });
  await add('no-id-b', false, { schemaVersion: 1, projectName: 'b' });
  await add('fresh', true);
  for (const name of ['no-id-a', 'no-id-b', 'fresh']) ids.set(name, uuid(name));
  const broken = await add('broken', true);
  await writeFile(join(broken, '.mnemonik.json'), '{ not json');
  await add('one-too-many', false);
  return { home, stateDir, roots, ids };
}

async function install(
  f: { home: string; stateDir: string },
  roots: string[],
  project: ProjectExecutor,
  extra: Array<[string, string | true]> = [],
  prepare?: (options: { timeout?: () => Promise<string> }) => Promise<void>
): Promise<{ code: number; text: string }> {
  scanner.prepare.mockImplementation(
    async (options: { timeout?: () => Promise<string> }, work: (p: unknown) => unknown) => {
      await prepare?.(options);
      return work({
        roots: [...roots],
        exclusions: [],
        files: [],
        apply: async () => serializeReadiness({ installation: { conditions: [] } }),
        projectExecutor: async () => project,
        rollback: vi.fn(),
        complete: vi.fn(),
      });
    }
  );
  let text = '';
  const code = await joinedInstall(
    new Map<string, string | true>([
      ['non-interactive', true],
      ['apply', true],
      ['accept-indexing', true],
      ['components', 'scanner'],
      ['no-browser', true],
      ['scan-roots', roots.join(',')],
      ...extra,
    ]),
    {
      home: f.home,
      cwd: f.home,
      input: Readable.from(''),
      installStateDir: f.stateDir,
      projectStateDir: f.stateDir,
      projectExecutor: project,
      preflight: { nodeVersion: '24.21.0', fetch: async () => Response.json({}) },
      grantFetch: async (url: string | URL) =>
        new URL(String(url)).pathname === '/api/v1/install-sessions/current'
          ? Response.json({ error: 'active_session_not_found' }, { status: 404 })
          : Response.json({ status: 'completed' }),
    } as unknown as CliDependencies,
    new Output({ write: (chunk) => void (text += chunk) }),
    async () => 'owner',
    async () => ({
      stateDir: f.stateDir,
      account: 'owner',
      getCliBearer: async () => 'cli-token',
      now: () => 0,
      sleep: async () => {},
    })
  );
  return { code, text };
}

it('connects every folder with its own project id and says why each other one was left out', async () => {
  const f = await fifteen();
  // Three of them were connected earlier the same day, under another sign-in.
  const earlier = executor(f.stateDir, 'owner:earlier-device', 'one-too-many');
  for (const name of ['repo-1', 'repo-2', 'notes'])
    expect(
      await earlier.ensureProject({
        cwd: join(f.home, 'Projects', name),
        allowCreate: true,
        allowNestedInherit: false,
      })
    ).toMatchObject({ status: 'done' });

  const project = executor(f.stateDir, 'owner:device', 'one-too-many');
  const run = await install(f, f.roots, project, [['json', true]]);
  const result = JSON.parse(run.text.trim().split('\n').at(-1)!) as {
    repositories: RepositoryOutcome[];
  };
  const outcome = new Map(result.repositories.map((entry) => [basename(entry.folder), entry]));

  expect(result.repositories).toHaveLength(15);
  for (const [name, id] of f.ids)
    expect(outcome.get(name), name).toMatchObject({ outcome: 'connected', projectId: id });
  expect(outcome.get('repo-1-copy')).toMatchObject({
    outcome: 'not_connected',
    reason: 'duplicate_project_id',
    action:
      'repo-1-copy was not connected. It belongs to the same project as repo-1, which is already connected.',
  });
  expect(outcome.get('broken')).toMatchObject({
    outcome: 'not_connected',
    reason: 'malformed',
    action:
      'broken was not connected. Its project file cannot be read. Delete the .mnemonik.json file in that folder, then run the command again.',
  });
  expect(outcome.get('one-too-many')).toMatchObject({
    outcome: 'not_connected',
    reason: 'project_limit_reached',
    action: expect.stringContaining('one-too-many was not connected.'),
  });
  for (const [name, id] of f.ids)
    expect(
      JSON.parse(await readFile(join(f.home, 'Projects', name, '.mnemonik.json'), 'utf8')).projectId
    ).toBe(id);

  // The same run for a person: every left-out folder is named with its reason.
  const again = await install(f, f.roots, project);
  expect(again.text).toContain('Connected 12 project folders.');
  expect(again.text).toContain(
    'repo-1-copy was not connected. It belongs to the same project as repo-1, which is already connected.'
  );
  expect(again.text).toContain('broken was not connected. Its project file cannot be read.');
  expect(again.text).toContain('one-too-many was not connected.');
}, 60_000);

it.each([
  [[['retry', true]] as Array<[string, true]>, ['retry', 'skip']],
  [[['skip', true]] as Array<[string, true]>, ['skip', 'skip']],
  [[] as Array<[string, true]>, ['skip', 'skip']],
])(
  'answers an indexing wait that ran out from %j',
  async (extra, expected) => {
    const f = await fifteen();
    const project = executor(f.stateDir, 'owner:device', 'one-too-many');
    const answers: string[] = [];
    const run = await install(
      f,
      f.roots.slice(0, 1),
      project,
      [['json', true], ...extra],
      async (options) => {
        answers.push((await options.timeout?.()) ?? 'none');
        answers.push((await options.timeout?.()) ?? 'none');
      }
    );
    const result = JSON.parse(run.text.trim().split('\n').at(-1)!) as { waits: WaitAnswer[] };

    expect(answers).toEqual(expected);
    expect(result.waits).toEqual(expected.map((answer) => ({ step: 'indexing_start', answer })));
    // Nobody is at the terminal, so the Retry/Skip menu is never drawn.
    expect(run.text).not.toContain('arrow keys');
    expect(run.text.trim().split('\n')).toHaveLength(1);
  },
  30_000
);

it.each([
  [[], '--accept-indexing', 'Do you want automatic project indexing?'],
  [
    ['--accept-indexing'],
    '--hosts',
    'Which coding tools should Mnemonik connect: Claude Code, Codex or Cursor?',
  ],
  [
    ['--accept-indexing', '--hosts=codex'],
    '--scan-roots',
    'Which folder holds your projects? You will choose which of them to index at the approval link.',
  ],
  [
    ['--accept-indexing', '--hosts=codex', '--scan-roots=/repo'],
    '--apply',
    'Go ahead and make these changes?',
  ],
  [
    ['--without-scanner'],
    '--accept-limited',
    'Set up Mnemonik without automatic project indexing?',
  ],
])(
  'a piped install given %j stops for %s with the question for the person',
  async (flags, flag, question) => {
    let authorizations = 0;
    const run = async (json: boolean) => {
      let stdout = '';
      let stderr = '';
      const code = await runCli(['install', ...flags, ...(json ? ['--json'] : [])], {
        input: Readable.from([]),
        stdout: { write: (chunk) => void (stdout += chunk) },
        stderr: { write: (chunk) => void (stderr += chunk) },
        cliAuth: {
          getCliBearer: async () => {
            authorizations++;
            return 'cli';
          },
          signIn: async () => {},
          logout: async () => {},
        },
      });
      return { code, stdout, stderr };
    };
    const text = await run(false);
    expect(text.code).toBe(3);
    expect(text.stderr.split('\n').slice(0, 2)).toEqual([
      `Missing required consent flag: ${flag}`,
      `Ask the person: ${question}`,
    ]);
    const json = await run(true);
    expect(json.code).toBe(3);
    expect(JSON.parse(json.stdout)).toMatchObject({
      status: 'action_required',
      reason: 'consent_required',
      flag,
      question,
      answers: expect.arrayContaining([expect.objectContaining({ answer: expect.any(String) })]),
    });
    expect(authorizations).toBe(0);
  }
);
