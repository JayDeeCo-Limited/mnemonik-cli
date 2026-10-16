/**
 * One rule everywhere (owner, 2026-10-16): a folder's project is the nearest
 * `.mnemonik.json` above it; git repositories are not boundaries, except that
 * a linked worktree belongs to its main checkout. The hooks, `project status`,
 * `project ensure` (the hooks' setup handoff) and the local-setup executor
 * must name the same project and the same root for every folder, or the
 * handoff binds one root and the CLI acts on another.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createProjectSetupExecutor, type SetupTransport } from '@mnemonik/local-setup';
import { resolveProjectIdentity } from '@mnemonik/shared';
import { findProjectIdentityDetailed } from '@mnemonik/shared/hook-runtime';
import { projectExecutor, rootIssueContext } from '../src/project.js';
import { runCli, type CliDependencies } from '../src/router.js';

const exec = promisify(execFile);
const MAIN = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';
const CLONE = '33333333-3333-4333-8333-333333333333';

let base = '';
let main = '';
const folders: Record<string, string> = {};

const git = (cwd: string, ...args: string[]) =>
  exec('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
    },
  });

const identity = (dir: string, projectId: string) =>
  writeFile(join(dir, '.mnemonik.json'), JSON.stringify({ schemaVersion: 1, projectId }));

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'mnemonik-identity-parity-')));
  main = join(base, 'devops');
  await mkdir(join(main, 'src', 'deep'), { recursive: true });
  await git(main, 'init', '-q');
  await identity(main, MAIN);
  await writeFile(join(main, 'src', 'deep', 'file'), 'x');
  // A plain subfolder that is its own project (home-agent inside devops).
  await mkdir(join(main, 'home-agent', 'lib'), { recursive: true });
  await identity(join(main, 'home-agent'), AGENT);
  await git(main, 'add', '-A');
  await git(main, 'commit', '-qm', 'init');
  // Nested clones: one without an identity file, one with its own.
  for (const name of ['plain-clone', 'own-clone']) {
    await mkdir(join(main, 'vendor', name, 'lib'), { recursive: true });
    await git(join(main, 'vendor', name), 'init', '-q');
  }
  await identity(join(main, 'vendor', 'own-clone'), CLONE);
  // Worktrees inside and outside the repository; the inside one gets a wrong copy.
  await git(main, 'worktree', 'add', '-q', '-b', 'inside', join(main, '.claude', 'worktrees', 'x'));
  await identity(join(main, '.claude', 'worktrees', 'x'), CLONE);
  await git(main, 'worktree', 'add', '-q', '-b', 'outside', join(base, 'elsewhere', 'y'));
  await mkdir(join(base, 'links'));
  await symlink(join(main, 'src'), join(base, 'links', 'src'));

  Object.assign(folders, {
    root: main,
    subfolder: join(main, 'src', 'deep'),
    'identity file in a plain subfolder': join(main, 'home-agent', 'lib'),
    'nested clone without its own file': join(main, 'vendor', 'plain-clone', 'lib'),
    'nested clone with its own file': join(main, 'vendor', 'own-clone', 'lib'),
    'worktree inside the repository': join(main, '.claude', 'worktrees', 'x', 'src', 'deep'),
    'worktree outside the repository': join(base, 'elsewhere', 'y', 'src'),
    'project folder inside a worktree': join(base, 'elsewhere', 'y', 'home-agent', 'lib'),
    'symlink to a subfolder': join(base, 'links', 'src', 'deep'),
  });
});

afterAll(() => rm(base, { recursive: true, force: true }));

const expected: Record<string, { projectId: string; root: () => string }> = {
  root: { projectId: MAIN, root: () => main },
  subfolder: { projectId: MAIN, root: () => main },
  'identity file in a plain subfolder': { projectId: AGENT, root: () => join(main, 'home-agent') },
  'nested clone without its own file': { projectId: MAIN, root: () => main },
  'nested clone with its own file': {
    projectId: CLONE,
    root: () => join(main, 'vendor', 'own-clone'),
  },
  'worktree inside the repository': { projectId: MAIN, root: () => main },
  'worktree outside the repository': { projectId: MAIN, root: () => main },
  'project folder inside a worktree': {
    projectId: AGENT,
    root: () => join(base, 'elsewhere', 'y', 'home-agent'),
  },
  'symlink to a subfolder': { projectId: MAIN, root: () => main },
};

function executorFor(stateDir: string) {
  const bound: string[] = [];
  const issued: Array<string | undefined> = [];
  const transport: SetupTransport = {
    issueSetupRequest: vi.fn(async (input) => {
      issued.push(input.projectId);
      return { status: 'ACTION_REQUIRED' as const, state: 'stop_here', allowedActions: [] };
    }),
    consumeSetupRequest: vi.fn(),
  } as unknown as SetupTransport;
  const dependencies = {
    resolver: { resolveProjectIdentity },
    transport,
    scopeKey: 'user:device',
    bindContext: async (root: string) => {
      bound.push(root);
      return {
        deviceRootContext: { algorithmVersion: 1 as const, hash: 'a'.repeat(64) },
        repositoryFingerprint: null,
      };
    },
    stateDir,
  };
  return {
    bound,
    issued,
    local: createProjectSetupExecutor(dependencies),
    cli: projectExecutor(dependencies),
  };
}

describe('hooks, CLI and local setup name the same project for the same folder', () => {
  it.each(Object.keys(expected))('%s', async (name) => {
    const folder = folders[name]!;
    const want = { projectId: expected[name]!.projectId, root: expected[name]!.root() };

    // The hooks' resolver.
    const hook = await findProjectIdentityDetailed(folder);
    expect(hook.kind).toBe('ok');
    const hookRoot = hook.kind === 'ok' ? hook.root : undefined;
    expect({
      projectId: hook.kind === 'ok' ? hook.identity.projectId : null,
      root: hookRoot,
    }).toEqual(want);

    // The CLI's executor-level read, used by init/setup/link without a path and by ensure.
    const stateDir = join(base, 'state', name.replaceAll(' ', '-'));
    const { bound, issued, local, cli } = executorFor(stateDir);
    const read = await cli.resolveProjectIdentity(folder);
    expect({
      projectId: read.kind === 'ok' ? read.identity.projectId : null,
      root: 'root' in read ? read.root : null,
    }).toEqual(want);

    // `project status <folder> --json`.
    const stdout = {
      text: '',
      write(chunk: string) {
        this.text += chunk;
      },
    };
    const deps = {
      cwd: folder,
      home: join(base, 'home'),
      input: Readable.from(''),
      stdout,
      stderr: { write() {} },
      projectStateDir: stateDir,
      getCliBearer: async () => undefined,
    } as unknown as CliDependencies;
    expect(await runCli(['project', 'status', folder, '--json'], deps)).toBe(0);
    const status = JSON.parse(stdout.text) as { resolvedRoot: string; projectId: string };
    expect({ projectId: status.projectId, root: status.resolvedRoot }).toEqual(want);

    // The local-setup executor, from the folder and from the hook's bound root
    // (the setup handoff runs `project ensure` with its cwd set to that root).
    for (const cwd of [folder, hookRoot!]) {
      await local.ensureProject({ cwd, allowCreate: false });
    }
    expect(bound).toEqual([want.root, want.root]);
    expect(issued).toEqual([want.projectId, want.projectId]);
  });
});

describe('the CLI sends a Git fingerprint only for the top of a repository', () => {
  const hmacRootBinding = async () => ({ version: 1 as const, hmac: 'aGVsbG8' });

  it('omits it for a subproject folder inside the repository', async () => {
    await git(main, 'remote', 'add', 'origin', 'https://example.invalid/devops.git').catch(
      () => undefined
    );
    const fingerprint = vi.fn(async () => ({ algorithmVersion: 1 as const, hash: 'f'.repeat(64) }));
    const sub = await rootIssueContext(join(main, 'home-agent'), {
      hmacRootBinding,
      resolveIdentity: resolveProjectIdentity,
      fingerprint,
    });
    expect(fingerprint).not.toHaveBeenCalled();
    expect(sub.evidence.repositoryFingerprint).toBeNull();
    expect(sub.context).toMatchObject({
      rootKind: 'selected_non_git',
      identityState: 'valid',
      projectId: AGENT,
    });

    // The repository's own top still sends one, from the real remote.
    const top = await rootIssueContext(main, {
      hmacRootBinding,
      resolveIdentity: resolveProjectIdentity,
    });
    expect(top.evidence.repositoryFingerprint).toMatchObject({ algorithmVersion: 1 });
    expect(top.context).toMatchObject({ rootKind: 'git', projectId: MAIN });
  });
});
