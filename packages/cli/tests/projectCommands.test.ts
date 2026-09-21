import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Owner, SetupTransport } from '@mnemonik/local-setup';
import { resolveProjectIdentity, type ProjectIdentityResolution } from '@mnemonik/shared';
import { projectExecutor } from '../src/project.js';
import { evaluateRoot } from '../src/project/eligibility.js';
import { runCli, type CliDependencies } from '../src/router.js';

const exec = promisify(execFile);
const dirs: string[] = [];
const oldId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const otherId = '33333333-3333-4333-8333-333333333333';

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const capture = () => ({
  text: '',
  write(chunk: string) {
    this.text += chunk;
  },
});

async function baseFixture() {
  const base = await mkdtemp(join(tmpdir(), 'mnemonik-project-command-'));
  dirs.push(base);
  const home = join(base, 'home');
  const root = join(base, 'repo');
  const stateDir = join(base, 'state');
  await mkdir(home);
  await mkdir(root);
  const stdout = capture();
  const stderr = capture();
  return { base, home, root, stateDir, stdout, stderr };
}

async function gitRoot(root: string): Promise<void> {
  await exec('git', ['init', '--quiet'], { cwd: root });
}

function commandDeps(
  fixture: Awaited<ReturnType<typeof baseFixture>>,
  options: {
    resolution?: ProjectIdentityResolution;
    transport?: SetupTransport;
    serverState?: 'access' | 'archived' | 'deleted' | 'suspended' | 'mismatch';
    defaultOwner?: Owner;
    input?: string;
  } = {}
): CliDependencies {
  const resolver = options.resolution
    ? { resolveProjectIdentity: vi.fn(async () => options.resolution!) }
    : { resolveProjectIdentity };
  const transport =
    options.transport ??
    ({
      issueSetupRequest: vi.fn(async (input) =>
        input.projectId
          ? { status: 'complete' as const, projectId: input.projectId, displayName: 'linked' }
          : {
              status: 'project_setup_required' as const,
              state: 'missing',
              allowedActions: ['link', 'create', 'cancel'],
              requestId: randomUUID(),
            }
      ),
      consumeSetupRequest: vi.fn(async (input) => ({
        status: 'complete' as const,
        projectId: input.projectId ?? projectId,
        displayName: 'repo',
      })),
    } satisfies SetupTransport);
  return {
    cwd: fixture.root,
    home: fixture.home,
    input: Readable.from(options.input ?? 'y\n'),
    stdout: fixture.stdout,
    stderr: fixture.stderr,
    projectExecutor: projectExecutor({
      resolver,
      transport,
      scopeKey: 'user:device',
      bindContext: async () => ({
        deviceRootContext: { algorithmVersion: 1, hash: 'a'.repeat(64) },
        repositoryFingerprint: { algorithmVersion: 1, hash: 'b'.repeat(64) },
      }),
      stateDir: fixture.stateDir,
    }),
    projectResolver: resolver,
    projectStateDir: fixture.stateDir,
    getCliBearer: async () => 'secret-bearer',
    projectTransport: {
      getDefaultOwner: async () => options.defaultOwner ?? 'personal',
      readProjectState: vi.fn(async () => ({ state: options.serverState ?? 'access' })),
    },
  } as CliDependencies;
}

async function commandRecords(stateDir: string): Promise<unknown[]> {
  const root = join(stateDir, 'project-commands');
  const scopes = await readdir(root).catch(() => []);
  const records = await Promise.all(
    scopes.flatMap(async (scope) => {
      const directory = join(root, scope);
      return Promise.all(
        (await readdir(directory)).map(async (name) =>
          JSON.parse(await readFile(join(directory, name), 'utf8'))
        )
      );
    })
  );
  return records.flat();
}

describe('native Windows project root eligibility', () => {
  const home = 'C:\\Users\\alice';
  const options = {
    cwd: home,
    home,
    platform: 'win32' as const,
    env: {
      LOCALAPPDATA: `${home}\\AppData\\Local`,
      APPDATA: `${home}\\AppData\\Roaming`,
    },
    nonGitSelected: true,
  };

  it.each([
    ['D:\\', 'filesystem_root'],
    [`${home}\\AppData\\Local`, 'user_data_directory'],
    [`c:\\users\\ALICE\\appdata\\roaming\\Vendor`, 'user_data_directory'],
    [`${home}\\AppData\\Local\\Mnemonik\\credentials`, 'mnemonik_state_directory'],
  ])('refuses %s', async (root, reason) => {
    await expect(
      evaluateRoot(
        { kind: 'absent', root, repository: { kind: 'plain', root }, nested: [] },
        options
      )
    ).resolves.toMatchObject({ allowed: false, reason });
  });
});

describe('project init', () => {
  it.each([
    ['home_directory', 'home'],
    ['temporary_directory', 'temp'],
    ['host_config_directory', 'host'],
    ['broad_workspace_parent', 'broad'],
    ['non_git_selection_required', 'plain'],
  ])('refuses %s without writing', async (reason, kind) => {
    const f = await baseFixture();
    if (kind === 'home') f.root = f.home;
    if (kind === 'temp') f.root = tmpdir();
    if (kind === 'host') {
      f.root = join(f.home, '.codex');
      await mkdir(f.root);
    }
    if (kind === 'broad') {
      await Promise.all(
        ['one', 'two'].map(async (name) => {
          await mkdir(join(f.root, name, '.git'), { recursive: true });
        })
      );
    }
    const deps = commandDeps(f, {
      resolution: {
        kind: 'absent',
        root: f.root,
        repository: { kind: 'plain', root: f.root },
        nested: [],
      },
    });
    expect(await runCli(['project', 'init', '--json', '--non-interactive', '--apply'], deps)).toBe(
      3
    );
    expect(JSON.parse(f.stdout.text)).toMatchObject({ state: reason });
    expect(await readdir(f.stateDir).catch(() => [])).toEqual([]);
  });

  it('records explicit non-git selection and proceeds', async () => {
    const f = await baseFixture();
    const deps = commandDeps(f, {
      resolution: {
        kind: 'absent',
        root: f.root,
        repository: { kind: 'plain', root: f.root },
        nested: [],
      },
    });
    expect(
      await runCli(['project', 'init', '--non-git', '--json', '--non-interactive', '--apply'], deps)
    ).toBe(0);
    const setupScope = (await readdir(join(f.stateDir, 'project-setup')))[0]!;
    const journal = JSON.parse(
      await readFile(join(f.stateDir, 'project-setup', setupScope), 'utf8')
    );
    expect(journal.nonGitSelected).toBe(true);
    expect(await commandRecords(f.stateDir)).toHaveLength(1);
  });

  it.each([
    ['one exact fingerprint', [projectId], 0],
    ['a name-only candidate', [projectId], 1],
    ['two candidates', [projectId, otherId], 2],
  ])('%s never turns name alone into authority', async (_name, ids, expectedExit) => {
    const f = await baseFixture();
    await gitRoot(f.root);
    const transport: SetupTransport = {
      issueSetupRequest: vi.fn(async () =>
        ids.length === 1 && expectedExit === 0
          ? { status: 'complete' as const, projectId: ids[0]!, displayName: 'repo' }
          : {
              status: 'project_setup_required' as const,
              state: ids.length === 1 ? 'confirmation_required' : 'ambiguous',
              allowedActions: ['link', 'create', 'cancel'],
              requestId: randomUUID(),
              candidates: ids.map((id) => ({ projectId: id, displayName: 'repo' })),
            }
      ),
      consumeSetupRequest: vi.fn(),
    };
    const deps = commandDeps(f, { transport });
    const code = await runCli(['project', 'init', '--json', '--non-interactive', '--apply'], deps);
    expect(code).toBe(expectedExit === 0 ? 0 : 3);
    if (expectedExit) {
      expect(JSON.parse(f.stdout.text).candidates).toHaveLength(ids.length);
      expect(f.stdout.text).not.toContain('requestId');
      expect(await readFile(join(f.root, '.mnemonik.json')).catch(() => null)).toBeNull();
    } else {
      expect(JSON.parse(await readFile(join(f.root, '.mnemonik.json'), 'utf8')).projectId).toBe(
        projectId
      );
    }
    expect(transport.consumeSetupRequest).not.toHaveBeenCalled();
  });

  it('prints the project count and limit when creation is refused', async () => {
    const f = await baseFixture();
    await gitRoot(f.root);
    const deps = commandDeps(f, {
      transport: {
        issueSetupRequest: vi.fn(async () => ({
          status: 'project_setup_required' as const,
          state: 'missing',
          allowedActions: ['create', 'cancel'],
          requestId: randomUUID(),
        })),
        consumeSetupRequest: vi.fn(async () => ({
          status: 'ACTION_REQUIRED' as const,
          state: 'project_limit_reached',
          allowedActions: ['retry', 'cancel'],
          used: 1,
          limit: 1,
        })),
      },
    });
    expect(await runCli(['project', 'init', '--non-interactive', '--apply'], deps)).toBe(3);
    expect(f.stdout.text + f.stderr.text).toContain('Projects: 1 used, limit 1');
  });

  it.each(['nested', 'conflict'] as const)(
    'shows the %s boundary and only the documented choices before writing',
    async (kind) => {
      const f = await baseFixture();
      await gitRoot(f.root);
      const base = {
        root: f.root,
        repository: {
          kind: 'git' as const,
          root: join(f.root, 'nested'),
          commonDir: join(f.root, 'nested', '.git'),
          isLinkedWorktree: false,
          nested: [{ path: join(f.root, 'nested'), kind: 'directory' as const }],
        },
        nested: [{ path: join(f.root, 'nested'), kind: 'directory' as const }],
      };
      const resolution: ProjectIdentityResolution =
        kind === 'conflict'
          ? {
              ...base,
              kind,
              rootIdentity: { schemaVersion: 1, projectId },
              nestedIdentity: { schemaVersion: 1, projectId: otherId },
            }
          : { ...base, kind, parentIdentity: { schemaVersion: 1, projectId } };
      const deps = commandDeps(f, { resolution });
      const ensure = vi.spyOn(deps.projectExecutor!, 'ensureProject');
      expect(await runCli(['project', 'init'], deps)).toBe(3);
      expect(f.stdout.text).toContain(`Root: ${resolution.root}`);
      expect(f.stdout.text).toContain(`Identity: ${join(resolution.root, '.mnemonik.json')}`);
      expect(f.stdout.text).toContain(
        'Use the parent project identity; Set up the nested project separately; Choose the main checkout or worktree identity; cancel'
      );
      expect(ensure).not.toHaveBeenCalled();
      expect(await readFile(join(f.root, '.mnemonik.json')).catch(() => null)).toBeNull();
    }
  );

  it('ignores an inaccessible repository, keeps agent ensure silent, and offers to clear', async () => {
    const f = await baseFixture();
    await gitRoot(f.root);
    await writeFile(
      join(f.root, '.mnemonik.json'),
      JSON.stringify({ schemaVersion: 1, projectId })
    );
    const denied = {
      status: 'ACTION_REQUIRED' as const,
      state: 'not_found',
      allowedActions: ['switch_account', 'ask_owner', 'ignore', 'cancel'],
    };
    const transport: SetupTransport = {
      issueSetupRequest: vi.fn(async () => denied),
      consumeSetupRequest: vi.fn(),
    };
    const deps = commandDeps(f, { transport, input: 'yes\n' });
    deps.input = new Readable({
      read() {
        process.nextTick(() => {
          this.push('yes\n');
          this.push(null);
        });
      },
    });
    const ignoredCode = await runCli(['project', 'init'], deps);
    expect(transport.issueSetupRequest).toHaveBeenCalledTimes(2);
    expect(ignoredCode, f.stdout.text).toBe(0);
    expect(f.stdout.text).toContain('Repository ignored on this device');

    f.stdout.text = '';
    expect(await runCli(['project', 'status', '--json'], deps)).toBe(0);
    expect(JSON.parse(f.stdout.text)).toMatchObject({ executorState: 'ignored' });

    f.stdout.text = '';
    expect(await runCli(['project', 'ensure', '--agent', '--json'], deps)).toBe(0);
    expect(JSON.parse(f.stdout.text)).toMatchObject({ status: 'ignored', root: f.root });
    expect(f.stdout.text).not.toContain('ACTION_REQUIRED');

    f.stdout.text = '';
    const revisit = commandDeps(f, { transport, input: 'no\n' });
    revisit.input = new Readable({
      read() {
        process.nextTick(() => {
          this.push('no\n');
          this.push(null);
        });
      },
    });
    expect(await runCli(['project', 'init'], revisit)).toBe(0);
    expect(f.stdout.text).toContain(`Root: ${f.root}`);
    expect(f.stdout.text).toContain(`Identity: ${join(f.root, '.mnemonik.json')}`);
    expect(f.stdout.text).toContain('Clear this repository ignore and continue?');

    await writeFile(
      join(f.root, '.mnemonik.json'),
      JSON.stringify({ schemaVersion: 1, projectId: otherId })
    );
    f.stdout.text = '';
    expect(await runCli(['project', 'ensure', '--agent', '--json'], revisit)).toBe(3);
    expect(JSON.parse(f.stdout.text)).toMatchObject({
      status: 'ACTION_REQUIRED',
      state: 'identity_changed',
    });
  });

  it.each([
    ['saved', undefined],
    ['explicit', `team:${otherId}`],
  ])('uses a %s team owner without inferring from membership', async (_kind, ownerFlag) => {
    const f = await baseFixture();
    await gitRoot(f.root);
    const deps = commandDeps(f, { defaultOwner: { teamId: otherId } });
    const args = ['project', 'init', '--json', '--non-interactive', '--apply'];
    if (ownerFlag) args.push('--owner', ownerFlag);
    expect(await runCli(args, deps)).toBe(0);
    expect(((await commandRecords(f.stateDir))[0] as { chosenOwner: string }).chosenOwner).toBe(
      `team:${otherId}`
    );
  });
});

describe('project link and setup', () => {
  it('replaces a stale setup record when init applies the same folder', async () => {
    const f = await baseFixture();
    await gitRoot(f.root);
    const transport: SetupTransport = {
      issueSetupRequest: vi
        .fn()
        .mockResolvedValueOnce({
          status: 'project_setup_required' as const,
          state: 'confirmation_required',
          allowedActions: ['link', 'cancel'],
          candidates: [{ projectId, displayName: 'repo' }],
        })
        .mockResolvedValueOnce({
          status: 'project_setup_required' as const,
          state: 'missing',
          allowedActions: ['create', 'cancel'],
          requestId: randomUUID(),
        }),
      consumeSetupRequest: vi.fn(async () => ({
        status: 'complete' as const,
        projectId,
        displayName: 'repo',
      })),
    };
    const deps = commandDeps(f, { transport });
    expect(
      await runCli(
        ['project', 'setup', f.root, `--owner=team:${otherId}`, '--non-interactive', '--apply'],
        deps
      )
    ).toBe(3);
    f.stdout.text = '';
    f.stderr.text = '';

    expect(await runCli(['project', 'init', f.root, '--non-interactive', '--apply'], deps)).toBe(0);
    expect(f.stdout.text + f.stderr.text).not.toContain('operation_context_changed');
    expect(JSON.parse(await readFile(join(f.root, '.mnemonik.json'), 'utf8')).projectId).toBe(
      projectId
    );
  });

  it('requires mismatch confirmation and replacement, then rollback restores exact bytes', async () => {
    const f = await baseFixture();
    const before = Buffer.from(
      JSON.stringify({ schemaVersion: 1, projectId: oldId, projectName: 'old' }) + '\n'
    );
    await gitRoot(f.root);
    await writeFile(join(f.root, '.mnemonik.json'), before);
    const first = commandDeps(f, { serverState: 'mismatch' });
    expect(
      await runCli(['project', 'link', projectId, '--json', '--non-interactive', '--apply'], first)
    ).toBe(3);
    expect(JSON.parse(f.stdout.text)).toMatchObject({ state: 'fingerprint_mismatch' });
    expect(await readFile(join(f.root, '.mnemonik.json'))).toEqual(before);

    f.stdout.text = '';
    expect(
      await runCli(
        [
          'project',
          'link',
          projectId,
          '--confirm-mismatch',
          '--json',
          '--non-interactive',
          '--apply',
        ],
        first
      )
    ).toBe(3);
    expect(JSON.parse(f.stdout.text)).toMatchObject({ state: 'identity_exists' });

    f.stdout.text = '';
    expect(
      await runCli(
        [
          'project',
          'link',
          projectId,
          '--confirm-mismatch',
          '--replace',
          '--json',
          '--non-interactive',
          '--apply',
        ],
        first
      )
    ).toBe(0);
    expect(JSON.parse(await readFile(join(f.root, '.mnemonik.json'), 'utf8')).projectId).toBe(
      projectId
    );
    const intent = { action: 'link' as const, projectId, replace: true as const };
    await first.projectExecutor!.rollback({
      cwd: f.root,
      owner: 'personal',
      allowCreate: false,
      allowNestedInherit: false,
      intent,
    });
    expect(await readFile(join(f.root, '.mnemonik.json'))).toEqual(before);
  });

  it('setup shows its plan and does not stage non-interactively without --apply', async () => {
    const f = await baseFixture();
    await gitRoot(f.root);
    const deps = commandDeps(f);
    expect(await runCli(['project', 'setup', '--json', '--non-interactive'], deps)).toBe(3);
    expect(JSON.parse(f.stdout.text)).toMatchObject({
      state: 'apply_required',
      root: f.root,
      owner: 'personal',
      candidates: [],
    });
    expect(await readdir(join(f.stateDir, 'project-setup')).catch(() => [])).toEqual([]);
    expect(await commandRecords(f.stateDir)).toHaveLength(1);
  });

  it('asks separately for a non-git folder and the setup plan', async () => {
    const f = await baseFixture();
    const resolution = {
      kind: 'absent' as const,
      root: f.root,
      repository: { kind: 'plain' as const, root: f.root },
      nested: [],
    };
    const deps = commandDeps(f, { resolution, input: 'yes\nyes\n' });
    expect(await runCli(['project', 'setup'], deps)).toBe(0);
    expect(f.stdout.text).toContain('Use non-git folder');
    expect(f.stdout.text).toContain('Project plan');
    expect(f.stdout.text).toContain('Apply?');
  });
});

describe('project status and command records', () => {
  it.each([
    'ok',
    'absent',
    'unknown_version',
    'malformed',
    'nested',
    'conflict',
    'git_unavailable',
  ] as const)('reports %s without invoking the executor or writing', async (kind) => {
    const f = await baseFixture();
    const base = {
      root: f.root,
      repository: { kind: 'plain' as const, root: f.root },
      nested: [],
    };
    const resolution = (
      kind === 'ok'
        ? { ...base, kind, identity: { schemaVersion: 1 as const, projectId } }
        : kind === 'unknown_version'
          ? { ...base, kind, version: 2, path: f.root }
          : kind === 'malformed'
            ? { ...base, kind, detail: 'bad', path: f.root }
            : kind === 'nested'
              ? { ...base, kind }
              : kind === 'conflict'
                ? {
                    ...base,
                    kind,
                    rootIdentity: { schemaVersion: 1 as const, projectId },
                    nestedIdentity: { schemaVersion: 1 as const, projectId: otherId },
                  }
                : kind === 'git_unavailable'
                  ? { kind, detail: 'missing git' }
                  : { ...base, kind }
    ) as ProjectIdentityResolution;
    const deps = commandDeps(f, { resolution });
    const ensure = vi.spyOn(deps.projectExecutor!, 'ensureProject');
    expect(await runCli(['project', 'status', '--json', '--non-interactive'], deps)).toBe(0);
    expect(JSON.parse(f.stdout.text)).toMatchObject({
      resolvedRoot: f.root,
      decisionReason: kind,
    });
    expect(ensure).not.toHaveBeenCalled();
    expect(await readdir(f.stateDir).catch(() => [])).toEqual([]);
  });

  it('reads an existing executor record without changing its files or command count', async () => {
    const f = await baseFixture();
    await gitRoot(f.root);
    const init = commandDeps(f);
    await runCli(['project', 'init', '--json', '--non-interactive', '--apply'], init);
    const setupName = (await readdir(join(f.stateDir, 'project-setup')))[0]!;
    const setupPath = join(f.stateDir, 'project-setup', setupName);
    const beforeStat = await stat(setupPath);
    const beforeCount = (await commandRecords(f.stateDir)).length;
    const resolution = await resolveProjectIdentity(f.root);
    const status = commandDeps(f, { resolution });
    f.stdout.text = '';
    const ensure = vi.spyOn(status.projectExecutor!, 'ensureProject');
    expect(await runCli(['project', 'status', '--json'], status)).toBe(0);
    expect(JSON.parse(f.stdout.text)).toMatchObject({ executorState: 'done', server: 'access' });
    expect(ensure).not.toHaveBeenCalled();
    expect((await stat(setupPath)).mtimeMs).toBe(beforeStat.mtimeMs);
    expect((await commandRecords(f.stateDir)).length).toBe(beforeCount);
  });

  it('lists a stale exact-path record as unreachable without treating it as identity', async () => {
    const f = await baseFixture();
    await gitRoot(f.root);
    expect(
      await runCli(['project', 'init', '--json', '--non-interactive', '--apply'], commandDeps(f))
    ).toBe(0);
    await rm(f.root, { recursive: true, force: true });
    f.stdout.text = '';
    const status = commandDeps(f);
    const ensure = vi.spyOn(status.projectExecutor!, 'ensureProject');

    expect(await runCli(['project', 'status', f.root, '--json'], status)).toBe(0);
    expect(JSON.parse(f.stdout.text)).toMatchObject({
      resolvedRoot: f.root,
      projectId: null,
      identity: 'git_unavailable',
      reachability: 'unreachable',
      executorState: 'unreachable',
    });
    expect(ensure).not.toHaveBeenCalled();
    expect(await readFile(join(f.root, '.mnemonik.json')).catch(() => null)).toBeNull();
  });

  it('stores six-field records, keeps 20, and emits prefixed digests through redaction', async () => {
    const f = await baseFixture();
    await gitRoot(f.root);
    for (let index = 0; index < 21; index++) {
      const run = commandDeps(f);
      expect(await runCli(['project', 'init', '--json', '--non-interactive', '--apply'], run)).toBe(
        0
      );
    }
    const records = (await commandRecords(f.stateDir)) as Array<Record<string, unknown>>;
    expect(records).toHaveLength(20);
    expect(Object.keys(records[0]!).sort()).toEqual(
      [
        'afterHash',
        'beforeHash',
        'chosenOwner',
        'decisionReason',
        'projectId',
        'resolvedRoot',
      ].sort()
    );
    const bytes = await readFile(join(f.root, '.mnemonik.json'));
    expect(records.at(-1)?.afterHash).toBe(
      `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    );
    expect(f.stdout.text).toContain('sha256:');
    expect(f.stdout.text).not.toContain('secret-bearer');
  });
});
