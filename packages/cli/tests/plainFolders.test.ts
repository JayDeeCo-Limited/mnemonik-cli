import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { serializeReadiness, resolveProjectIdentity } from '@mnemonik/shared';
import { createProjectSetupExecutor, type SetupTransport } from '@mnemonik/local-setup';

const scanner = vi.hoisted(() => ({ prepare: vi.fn(), update: vi.fn(), enable: vi.fn() }));
vi.mock('../src/scanner/enable.js', async (original) => ({
  ...(await original<typeof import('../src/scanner/enable.js')>()),
  prepareScanner: scanner.prepare,
  updateScannerRoots: scanner.update,
  enableScanner: scanner.enable,
}));

import { joinedInstall } from '../src/install/journey.js';
import { Output } from '../src/output.js';
import { runCli, type CliDependencies } from '../src/router.js';
import { runScannerPicker } from '../src/scanner/picker.js';

const exec = promisify(execFile);
const homes: string[] = [];
const created = '77777777-7777-4777-8777-777777777777';

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

const capture = () => ({
  text: '',
  write(chunk: string) {
    this.text += chunk;
  },
});

/** A server that wants a new device confirmed once, and knows only the projects it was told about. */
function transportFor(reachable: Set<string>): SetupTransport {
  const confirmed = new Set<string>();
  return {
    issueSetupRequest: vi.fn(async ({ projectId }) =>
      projectId
        ? confirmed.has(projectId)
          ? { status: 'complete' as const, projectId, displayName: 'project' }
          : reachable.has(projectId)
            ? {
                status: 'project_setup_required' as const,
                state: 'confirmation_required',
                requestId: '99999999-9999-4999-8999-999999999999',
                allowedActions: ['link', 'create', 'cancel'],
                candidates: [{ projectId, displayName: 'project' }],
              }
            : {
                status: 'project_setup_required' as const,
                state: 'not_found',
                allowedActions: ['switch_account', 'ask_owner', 'ignore', 'cancel'],
              }
        : {
            status: 'project_setup_required' as const,
            state: 'missing',
            requestId: '99999999-9999-4999-8999-999999999999',
            allowedActions: ['create', 'cancel'],
          }
    ),
    consumeSetupRequest: vi.fn(async ({ action, projectId }) => {
      const resulting = action === 'link' ? projectId! : created;
      confirmed.add(resulting);
      return { status: 'complete' as const, projectId: resulting, displayName: 'project' };
    }),
  };
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'plain-folders-'));
  homes.push(home);
  const stateDir = join(home, 'state');
  const reachable = new Set<string>();
  const executor = {
    resolveProjectIdentity: (cwd: string) => resolveProjectIdentity(cwd, { selectedRoot: true }),
    ...createProjectSetupExecutor({
      resolver: { resolveProjectIdentity },
      transport: transportFor(reachable),
      scopeKey: 'owner:device',
      stateDir,
      bindContext: async () => ({
        deviceRootContext: { algorithmVersion: 1, hash: 'c'.repeat(64) },
        repositoryFingerprint: null,
      }),
    }),
  };
  const stdout = capture();
  const stderr = capture();
  return { home, stateDir, reachable, executor, stdout, stderr };
}

/** A folder with a project file already names its project; nothing else is needed. */
async function folder(
  home: string,
  name: string,
  options: { git?: boolean; projectId?: string } = {}
): Promise<string> {
  const path = join(home, 'Projects', name);
  await mkdir(path, { recursive: true });
  if (options.git) await exec('git', ['init', '--quiet'], { cwd: path });
  if (options.projectId)
    await writeFile(
      join(path, '.mnemonik.json'),
      `${JSON.stringify({ schemaVersion: 1, projectId: options.projectId })}\n`
    );
  return path;
}

async function scannerState(stateDir: string): Promise<void> {
  await mkdir(join(stateDir, 'scanner'), { recursive: true });
  await writeFile(
    join(stateDir, 'scanner/state.json'),
    JSON.stringify({
      schemaVersion: 1,
      config: { roots: [], exclusions: [], serverUrl: 'https://api.mnemonik.dev' },
      consent: { userId: 'owner', roots: [], exclusions: [], disclosureVersion: '2026.09.1' },
      paused: false,
      pauseIntervals: [],
    })
  );
}

function addDeps(
  f: Awaited<ReturnType<typeof fixture>>,
  overrides: Partial<CliDependencies> = {}
): CliDependencies {
  return {
    home: f.home,
    cwd: f.home,
    installStateDir: f.stateDir,
    projectStateDir: f.stateDir,
    input: Readable.from('\n'),
    stdout: f.stdout,
    stderr: f.stderr,
    cliAuth: {
      signIn: vi.fn(),
      getCliBearer: async () => 'cli-token',
      logout: async () => undefined,
    },
    projectExecutor: f.executor,
    getCliBearer: async () => 'cli-token',
    projectTransport: {
      getDefaultOwner: async () => 'personal',
      readProjectState: async () => ({ state: 'access' }),
    },
    ...overrides,
  } as CliDependencies;
}

async function install(
  f: Awaited<ReturnType<typeof fixture>>,
  roots: string[]
): Promise<{ code: number; text: string; connected: string[] }> {
  let connected: string[] = [];
  scanner.prepare.mockImplementation(async (_options, work) =>
    work({
      roots: [...roots],
      exclusions: [],
      files: [],
      session: { id: 'session' },
      apply: async (_journal: unknown, applied: string[]) => {
        connected = [...applied];
        return serializeReadiness({ installation: { conditions: [] } });
      },
      rollback: vi.fn(),
      complete: vi.fn(),
    })
  );
  let text = '';
  const code = await joinedInstall(
    new Map<string, string | true>([
      ['non-interactive', true],
      ['apply', true],
      ['accept-indexing', true],
      ['no-browser', true],
      ['scan-roots', roots.join(',')],
    ]),
    {
      home: f.home,
      cwd: f.home,
      input: Readable.from(''),
      installStateDir: f.stateDir,
      projectStateDir: f.stateDir,
      projectExecutor: f.executor,
      preflight: { nodeVersion: '24.21.0', fetch: async () => Response.json({}) },
      grantFetch: async () => Response.json({ status: 'completed' }),
    } as unknown as CliDependencies,
    new Output({ write: (chunk) => void (text += chunk) }),
    async () => 'owner',
    async () => ({ stateDir: f.stateDir, account: 'owner', now: () => 0, sleep: async () => {} })
  );
  return { code, text, connected };
}

const identityOf = async (path: string): Promise<string> =>
  JSON.parse(await readFile(join(path, '.mnemonik.json'), 'utf8')).projectId;

it('connects twelve Git folders and five plain folders alike, and counts all seventeen', async () => {
  const f = await fixture();
  const roots: string[] = [];
  for (let index = 0; index < 17; index++) {
    const suffix = index.toString(16).padStart(2, '0');
    const projectId = `111111${suffix}-1111-4111-8111-1111111111${suffix}`;
    f.reachable.add(projectId);
    roots.push(await folder(f.home, `project-${index}`, { git: index < 12, projectId }));
  }

  const result = await install(f, roots);

  expect(result.connected).toEqual(roots);
  expect(result.text).toContain('Connected 17 project folders.');
  expect(result.text).not.toContain('was not connected');
  expect(await identityOf(roots[16]!)).toBe('11111110-1111-4111-8111-111111111110');
}, 30_000);

it('connects a plain folder that already holds a project file, with no extra flag', async () => {
  const f = await fixture();
  const projectId = '22222222-2222-4222-8222-222222222222';
  f.reachable.add(projectId);
  const path = await folder(f.home, 'bolt-interval-timer', { projectId });
  await scannerState(f.stateDir);
  scanner.update.mockResolvedValue({ status: 'updated', state: { config: { roots: [path] } } });

  expect(await runCli(['add', path, '--non-interactive', '--apply'], addDeps(f))).toBe(0);

  expect(scanner.update).toHaveBeenCalledWith(expect.objectContaining({ add: [path] }));
  expect(await identityOf(path)).toBe(projectId);
  const text = `${f.stdout.text}${f.stderr.text}`;
  expect(text).not.toContain('You can create a new project');
  expect(text).not.toContain('Allowed actions');
});

it('connects a folder that an earlier project link already finished', async () => {
  const f = await fixture();
  const projectId = '44444444-4444-4444-8444-444444444444';
  f.reachable.add(projectId);
  const path = await folder(f.home, 'linked-already', { projectId });
  await scannerState(f.stateDir);
  scanner.update.mockResolvedValue({ status: 'updated', state: { config: { roots: [path] } } });

  expect(
    await runCli(
      ['project', 'link', projectId, path, '--apply', '--non-interactive', '--json'],
      addDeps(f)
    )
  ).toBe(0);
  f.stdout.text = '';

  expect(await runCli(['add', path, '--non-interactive', '--apply'], addDeps(f))).toBe(0);

  expect(await identityOf(path)).toBe(projectId);
});

it('accepts the old --non-git flag on add and ignores it', async () => {
  const f = await fixture();
  const path = await folder(f.home, 'notes');
  await scannerState(f.stateDir);
  scanner.update.mockResolvedValue({ status: 'updated', state: { config: { roots: [path] } } });

  expect(await runCli(['add', path, '--non-git', '--non-interactive', '--apply'], addDeps(f))).toBe(
    0
  );

  expect(f.stderr.text).not.toContain('Unknown flag');
  expect(await identityOf(path)).toBe(created);
});

it('creates and connects a plain folder that has no project file', async () => {
  const f = await fixture();
  const path = await folder(f.home, 'sketches');
  await scannerState(f.stateDir);
  scanner.update.mockResolvedValue({ status: 'updated', state: { config: { roots: [path] } } });

  expect(await runCli(['add', path, '--non-interactive', '--apply'], addDeps(f))).toBe(0);

  expect(await identityOf(path)).toBe(created);
});

it('refuses the home folder and says why', async () => {
  const f = await fixture();
  await scannerState(f.stateDir);

  expect(await runCli(['add', f.home, '--non-interactive', '--apply'], addDeps(f))).toBe(3);

  expect(`${f.stdout.text}${f.stderr.text}`).toContain('home folder');
  expect(scanner.update).not.toHaveBeenCalled();
});

it('still refuses a protected folder and says why', async () => {
  const f = await fixture();
  const secrets = join(f.home, '.ssh');
  await mkdir(secrets, { recursive: true });
  const output = new Output({ write: (chunk) => void (f.stdout.text += chunk) });

  const picked = await runScannerPicker({
    input: Readable.from(`3\n${secrets}\n`),
    output,
    currentProject: f.home,
    currentFolder: f.home,
    home: f.home,
  });

  expect(picked).toMatchObject({ status: 'cancelled' });
  expect(f.stdout.text).toContain(secrets);
});

it('names the folder and the reason when its project cannot be reached', async () => {
  const f = await fixture();
  const path = await folder(f.home, 'archived-thing', {
    projectId: '33333333-3333-4333-8333-333333333333',
  });
  await scannerState(f.stateDir);

  expect(await runCli(['add', path, '--non-interactive', '--apply'], addDeps(f))).toBe(3);

  const text = `${f.stdout.text}${f.stderr.text}`;
  expect(text).toContain('archived-thing was not connected.');
  expect(text).toContain('project this account cannot open');
  expect(text).not.toMatch(/[a-z]+_[a-z]+/u);
  expect(scanner.update).not.toHaveBeenCalled();
});

it('does not report a relink that did not happen', async () => {
  const f = await fixture();
  const first = '55555555-5555-4555-8555-555555555555';
  const second = '66666666-6666-4666-8666-666666666666';
  f.reachable.add(first);
  f.reachable.add(second);
  const path = await folder(f.home, 'moved-project', { projectId: first });
  expect(await runCli(['project', 'setup', path, '--apply', '--non-interactive'], addDeps(f))).toBe(
    0
  );
  f.stdout.text = '';

  const code = await runCli(
    ['project', 'link', second, path, '--replace', '--apply', '--non-interactive'],
    addDeps(f)
  );

  expect(code).not.toBe(0);
  expect(await identityOf(path)).toBe(first);
  expect(`${f.stdout.text}${f.stderr.text}`).not.toContain(first);
});

it('refuses the home folder through project init with the same sentences', async () => {
  const f = await fixture();

  expect(
    await runCli(['project', 'init', f.home, '--apply', '--non-interactive'], addDeps(f))
  ).toBe(3);

  const text = `${f.stdout.text}${f.stderr.text}`;
  expect(text).toContain('was not connected. Mnemonik does not index your whole home folder.');
  expect(text).toContain('Choose a single project folder');
  expect(text).not.toMatch(/[a-z]+_[a-z]+/u);
});

it('offers plain sentences when the named project cannot be opened', async () => {
  const f = await fixture();
  const path = await folder(f.home, 'someone-elses', {
    projectId: '77777777-7777-4777-8777-777777777771',
  });

  expect(await runCli(['project', 'setup', path, '--apply', '--non-interactive'], addDeps(f))).toBe(
    3
  );

  const text = `${f.stdout.text}${f.stderr.text}`;
  expect(text).not.toContain('You can this machine needs attention');
  expect(text).not.toContain('Allowed actions');
  expect(text).toContain('You can sign in to the account that owns that project.');
  expect(text).toContain("You can ask the project's owner to add you.");
});

it('connects a plain folder on a machine where git cannot run', async () => {
  const f = await fixture();
  const path = await folder(f.home, 'no-git-here');
  await scannerState(f.stateDir);
  scanner.update.mockResolvedValue({ status: 'updated', state: { config: { roots: [path] } } });
  const withoutGit = join(f.home, 'empty-path');
  await mkdir(withoutGit, { recursive: true });
  const previous = process.env.PATH;
  process.env.PATH = withoutGit;
  try {
    expect(await runCli(['add', path, '--non-interactive', '--apply'], addDeps(f))).toBe(0);
  } finally {
    process.env.PATH = previous;
  }

  expect(await identityOf(path)).toBe(created);
});
