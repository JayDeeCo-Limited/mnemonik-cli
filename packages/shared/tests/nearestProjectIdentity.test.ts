import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  resolveNearestProjectIdentity,
  resolveProjectIdentity,
  resolveRepositoryRoot,
} from '../src/repositoryRoot.js';

const OUTER = '11111111-1111-4111-8111-111111111111';
const INNER = '22222222-2222-4222-8222-222222222222';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  });
}

async function identityFile(dir: string, projectId: string, projectName: string): Promise<void> {
  await writeFile(
    join(dir, '.mnemonik.json'),
    JSON.stringify({ schemaVersion: 1, projectId, projectName })
  );
}

async function repository(): Promise<{ base: string; project: string }> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'nearest-identity-')));
  const project = join(base, 'project');
  await mkdir(join(project, 'src', 'deep'), { recursive: true });
  git(project, 'init', '-q');
  await identityFile(project, OUTER, 'outer');
  await writeFile(join(project, 'src', 'deep', 'file.txt'), 'x');
  git(project, 'add', '.');
  git(project, 'commit', '-qm', 'init');
  return { base, project };
}

async function projectOf(cwd: string): Promise<{ id?: string; root?: string; kind: string }> {
  const result = await resolveNearestProjectIdentity(cwd);
  return {
    kind: result.kind,
    ...(result.kind === 'ok' ? { id: result.identity.projectId, root: result.root } : {}),
  };
}

test('a subfolder of an ordinary git checkout resolves the repository root (common dir is relative to cwd)', async () => {
  const { base, project } = await repository();
  try {
    const sub = join(project, 'src', 'deep');
    const root = await resolveRepositoryRoot(sub);
    assert.equal(root.kind, 'git');
    assert.equal(root.kind === 'git' && root.isLinkedWorktree, false);
    assert.equal(root.kind === 'git' && root.commonDir, join(project, '.git'));
    assert.deepEqual(await projectOf(sub), { kind: 'ok', id: OUTER, root: project });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a subfolder with its own identity file is its own project; the nearest file wins', async () => {
  const { base, project } = await repository();
  try {
    const inner = join(project, 'src');
    await identityFile(inner, INNER, 'inner');
    assert.deepEqual(await projectOf(join(inner, 'deep')), { kind: 'ok', id: INNER, root: inner });
    const own = await resolveNearestProjectIdentity(inner);
    assert.equal(own.kind === 'ok' && own.repository.kind, 'plain');
    assert.deepEqual(await projectOf(project), { kind: 'ok', id: OUTER, root: project });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a git clone inside a project without its own identity file belongs to that project', async () => {
  const { base, project } = await repository();
  try {
    const clone = join(project, 'vendor', 'upstream');
    await mkdir(join(clone, 'lib'), { recursive: true });
    git(clone, 'init', '-q');
    assert.deepEqual(await projectOf(join(clone, 'lib')), { kind: 'ok', id: OUTER, root: project });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a git clone inside a project with its own identity file is its own project', async () => {
  const { base, project } = await repository();
  try {
    const clone = join(project, 'vendor', 'upstream');
    await mkdir(join(clone, 'lib'), { recursive: true });
    git(clone, 'init', '-q');
    await identityFile(clone, INNER, 'upstream');
    const result = await resolveNearestProjectIdentity(join(clone, 'lib'));
    assert.equal(result.kind, 'ok');
    assert.equal(result.kind === 'ok' && result.identity.projectId, INNER);
    assert.equal(result.kind === 'ok' && result.repository.kind, 'git');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a worktree outside the project folder, without a committed identity file, belongs to its main checkout', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'nearest-identity-wt-')));
  const project = join(base, 'project');
  try {
    await mkdir(project, { recursive: true });
    git(project, 'init', '-q');
    await writeFile(join(project, 'README'), 'x');
    git(project, 'add', 'README');
    git(project, 'commit', '-qm', 'init');
    // Identity file left uncommitted, so the worktree copy has none of its own.
    await identityFile(project, OUTER, 'outer');
    const worktree = join(base, 'elsewhere', 'any-name');
    git(project, 'worktree', 'add', '-q', worktree);
    await mkdir(join(worktree, 'sub'), { recursive: true });
    assert.deepEqual(await projectOf(join(worktree, 'sub')), {
      kind: 'ok',
      id: OUTER,
      root: project,
    });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a folder with no identity file anywhere above it is not a project', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'nearest-identity-none-')));
  try {
    await mkdir(join(base, 'a', 'b'), { recursive: true });
    git(join(base, 'a'), 'init', '-q');
    assert.equal((await projectOf(join(base, 'a', 'b'))).kind, 'absent');
    assert.equal((await projectOf(base)).kind, 'absent');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('the walk stops at the home folder, inside a git repository too', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'nearest-identity-home-')));
  const savedHome = process.env.HOME;
  try {
    const home = join(base, 'home');
    const repo = join(home, 'code', 'repo');
    await mkdir(join(repo, 'src'), { recursive: true });
    git(repo, 'init', '-q');
    await identityFile(base, OUTER, 'above-home');
    process.env.HOME = home;
    const result = await resolveNearestProjectIdentity(join(repo, 'src'));
    assert.equal(result.kind, 'absent');
    assert.equal(result.kind === 'absent' && result.root, repo);
    // An identity file in the home folder itself is still read.
    await identityFile(home, INNER, 'home');
    assert.deepEqual(await projectOf(join(repo, 'src')), { kind: 'ok', id: INNER, root: home });
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    await rm(base, { recursive: true, force: true });
  }
});

test('works with a git older than 2.31, which has no --path-format', async () => {
  if (process.platform === 'win32') return;
  const { base, project } = await repository();
  const savedPath = process.env.PATH;
  try {
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const bin = join(base, 'old-git');
    await mkdir(bin);
    // git < 2.31 echoes an unknown rev-parse option back as an answer line.
    await writeFile(
      join(bin, 'git'),
      `#!/bin/sh\ncase "$*" in *--path-format*) echo "--path-format=absolute";; esac\nexec "${realGit}" "$@"\n`
    );
    await chmod(join(bin, 'git'), 0o755);
    const worktree = join(base, 'elsewhere', 'feature');
    git(project, 'worktree', 'add', '-q', worktree);
    const inner = join(project, 'src');
    await identityFile(inner, INNER, 'inner');
    process.env.PATH = `${bin}:${savedPath ?? ''}`;

    const sub = await resolveRepositoryRoot(join(project, 'src', 'deep'));
    assert.equal(sub.kind, 'git');
    assert.equal(sub.kind === 'git' && sub.root, project);
    assert.equal(sub.kind === 'git' && sub.commonDir, join(project, '.git'));
    assert.equal(sub.kind === 'git' && sub.isLinkedWorktree, false);
    const linked = await resolveRepositoryRoot(join(worktree, 'src'));
    assert.equal(linked.kind === 'git' && linked.isLinkedWorktree, true);
    assert.equal(linked.kind === 'git' && linked.commonDir, join(project, '.git'));
    assert.deepEqual(await projectOf(join(inner, 'deep')), { kind: 'ok', id: INNER, root: inner });
    assert.deepEqual(await projectOf(join(worktree, 'src')), {
      kind: 'ok',
      id: OUTER,
      root: project,
    });
  } finally {
    process.env.PATH = savedPath;
    await rm(base, { recursive: true, force: true });
  }
});

test('a named folder is read exactly, even inside another project; a worktree top names its main checkout', async () => {
  const { base, project } = await repository();
  try {
    const sub = join(project, 'src');
    const named = await resolveProjectIdentity(sub, { namedRoot: true });
    assert.equal(named.kind, 'absent');
    assert.equal(named.kind === 'absent' && named.root, sub);
    assert.equal(named.kind === 'absent' && named.repository.kind, 'plain');
    // The default read is the rule: the subfolder is in the project around it.
    assert.deepEqual(await projectOf(sub), { kind: 'ok', id: OUTER, root: project });

    const worktree = join(base, 'elsewhere', 'feature');
    git(project, 'worktree', 'add', '-q', worktree);
    const top = await resolveProjectIdentity(worktree, { namedRoot: true });
    assert.equal(top.kind, 'ok');
    assert.equal(top.kind === 'ok' && top.root, project);
    assert.equal(
      top.kind === 'ok' && top.repository.kind === 'git' && top.repository.isLinkedWorktree,
      false
    );
    const inside = await resolveProjectIdentity(join(worktree, 'src'), { namedRoot: true });
    assert.equal(inside.kind, 'absent');
    assert.equal(inside.kind === 'absent' && inside.root, join(worktree, 'src'));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a configuration-only identity file in a subfolder names no project: the walk passes it', async () => {
  const { base, project } = await repository();
  try {
    const sub = join(project, 'tools');
    await mkdir(join(sub, 'lib'), { recursive: true });
    await writeFile(join(sub, '.mnemonik.json'), JSON.stringify({ schemaVersion: 1 }));
    assert.deepEqual(await projectOf(join(sub, 'lib')), { kind: 'ok', id: OUTER, root: project });
    // An unreadable file still answers as itself.
    await writeFile(join(sub, '.mnemonik.json'), '{ not json');
    assert.equal((await projectOf(join(sub, 'lib'))).kind, 'malformed');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
