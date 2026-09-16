import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const ROOT_ID = '11111111-1111-4111-8111-111111111111';
const NESTED_ID = '22222222-2222-4222-8222-222222222222';

async function git(cwd, ...args) {
  await exec('git', args, { cwd, env: { ...process.env, LC_ALL: 'C' } });
}

async function initRepo(path) {
  await mkdir(path, { recursive: true });
  await git(path, 'init', '--initial-branch=main');
  await git(path, 'config', 'user.email', 'identity-fixture@example.invalid');
  await git(path, 'config', 'user.name', 'Identity Fixture');
}

async function identity(path, projectId, projectName = 'fixture') {
  await writeFile(
    join(path, '.mnemonik.json'),
    JSON.stringify({
      schemaVersion: 1,
      projectId,
      projectName,
      repositoryFingerprint: { algorithmVersion: 1, hash: 'fixture-hash' },
    })
  );
}

async function fixture(run) {
  const path = await mkdtemp(join(tmpdir(), 'mnemonik-identity-'));
  try {
    await run(path);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}

export function runIdentityFixtureSuite(register, adapter) {
  register('linked worktree resolves to the main root and identity', () =>
    fixture(async (base) => {
      const main = join(base, 'main');
      const worktree = join(base, 'linked');
      await initRepo(main);
      await identity(main, ROOT_ID, 'main');
      await git(main, 'add', '.mnemonik.json');
      await git(main, 'commit', '-m', 'fixture identity');
      await git(main, 'worktree', 'add', '-b', 'fixture-linked', worktree);
      await identity(worktree, NESTED_ID, 'wrong-worktree-copy');
      await mkdir(join(worktree, 'src'));

      const repository = await adapter.resolveRoot(join(worktree, 'src'));
      assert.equal(repository.kind, 'git');
      assert.equal(repository.root, worktree);
      assert.equal(repository.commonDir, join(main, '.git'));
      assert.equal(repository.isLinkedWorktree, true);

      const result = await adapter.resolve(join(worktree, 'src'));
      assert.equal(result.kind, 'ok');
      assert.equal(result.root, main);
      assert.equal(result.identity.projectId, ROOT_ID);
      assert.equal(result.identity.projectName, 'main');
      assert.deepEqual(result.identity.repositoryFingerprint, {
        algorithmVersion: 1,
        hash: 'fixture-hash',
      });
    })
  );

  register('git repository selection ignores inherited GIT_* variables', () =>
    fixture(async (base) => {
      const local = join(base, 'local');
      const other = join(base, 'other');
      await initRepo(local);
      await identity(local, ROOT_ID, 'local');
      await initRepo(other);
      await identity(other, NESTED_ID, 'other');

      const savedGitDir = process.env.GIT_DIR;
      const savedGitWorkTree = process.env.GIT_WORK_TREE;
      process.env.GIT_DIR = join(other, '.git');
      process.env.GIT_WORK_TREE = other;
      try {
        const result = await adapter.resolve(local);
        assert.equal(result.kind, 'ok');
        assert.equal(result.root, local);
        assert.equal(result.identity.projectId, ROOT_ID);
      } finally {
        if (savedGitDir === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = savedGitDir;
        if (savedGitWorkTree === undefined) delete process.env.GIT_WORK_TREE;
        else process.env.GIT_WORK_TREE = savedGitWorkTree;
      }
    })
  );

  register('identity file symlinks are malformed and never followed', () =>
    fixture(async (base) => {
      const local = join(base, 'local');
      const other = join(base, 'other');
      await initRepo(local);
      await initRepo(other);
      await identity(other, NESTED_ID, 'other');
      await symlink(join(other, '.mnemonik.json'), join(local, '.mnemonik.json'));

      const read = await adapter.read(local);
      assert.equal(read.kind, 'malformed');
      assert.equal(read.detail, 'symlink');
      const result = await adapter.resolve(local);
      assert.equal(result.kind, 'malformed');
      assert.equal(result.detail, 'symlink');
      assert.equal(result.root, local);
    })
  );

  register('nested repository with its own identity is a conflict', () =>
    fixture(async (base) => {
      const main = join(base, 'main');
      const nested = join(main, 'vendor', 'nested');
      await initRepo(main);
      await identity(main, ROOT_ID, 'main');
      await initRepo(nested);
      await identity(nested, NESTED_ID, 'nested');

      const result = await adapter.resolve(nested);
      assert.equal(result.kind, 'conflict');
      assert.equal(result.root, main);
      assert.equal(result.rootIdentity.projectId, ROOT_ID);
      assert.equal(result.nestedIdentity.projectId, NESTED_ID);
      assert.ok(result.nested.some((entry) => entry.path === nested));
      if (adapter.find) assert.equal(await adapter.find(nested), null);
    })
  );

  register('nested repository inherits only with allowNestedInherit', () =>
    fixture(async (base) => {
      const main = join(base, 'main');
      const nested = join(main, 'packages', 'nested');
      await initRepo(main);
      await identity(main, ROOT_ID, 'main');
      await initRepo(nested);

      const unresolved = await adapter.resolve(nested);
      assert.equal(unresolved.kind, 'nested');
      assert.equal(unresolved.parentIdentity?.projectId, ROOT_ID);
      assert.ok(unresolved.nested.some((entry) => entry.path === nested));
      if (adapter.find) assert.equal(await adapter.find(nested), null);

      const inherited = await adapter.resolve(nested, { allowNestedInherit: true });
      assert.equal(inherited.kind, 'ok');
      assert.equal(inherited.root, main);
      assert.equal(inherited.identity.projectId, ROOT_ID);
    })
  );

  register('a rejected .git file is not a containing repository boundary', () =>
    fixture(async (base) => {
      const fakeParent = join(base, 'fake-parent');
      const repository = join(fakeParent, 'repository');
      await mkdir(fakeParent, { recursive: true });
      await writeFile(join(fakeParent, '.git'), 'not a gitdir pointer');
      await identity(fakeParent, ROOT_ID, 'fake-parent');
      await initRepo(repository);
      await identity(repository, NESTED_ID, 'repository');

      const result = await adapter.resolve(repository);
      assert.equal(result.kind, 'ok');
      assert.equal(result.root, repository);
      assert.equal(result.identity.projectId, NESTED_ID);
    })
  );

  register('schemaVersion 2 is unknown and preserved', () =>
    fixture(async (base) => {
      const text = JSON.stringify({ schemaVersion: 2, projectId: ROOT_ID });
      await writeFile(join(base, '.mnemonik.json'), text);
      assert.deepEqual(adapter.parse(text), { kind: 'unknown_version', version: 2 });
      assert.deepEqual(await adapter.read(base), { kind: 'unknown_version', version: 2 });
      const resolved = await adapter.resolve(base);
      assert.equal(resolved.kind, 'unknown_version');
      assert.equal(resolved.version, 2);
      assert.equal(resolved.root, base);
      if (adapter.find) assert.equal(await adapter.find(base), null);
      assert.equal(await readFile(join(base, '.mnemonik.json'), 'utf8'), text);
    })
  );

  register('v0 identity without schemaVersion is unknown', () =>
    fixture(async (base) => {
      const text = JSON.stringify({ projectId: ROOT_ID, projectName: 'v0' });
      await writeFile(join(base, '.mnemonik.json'), text);
      const parsed = adapter.parse(text);
      assert.equal(parsed.kind, 'unknown_version');
      assert.equal(parsed.version, undefined);
      const read = await adapter.read(base);
      assert.equal(read.kind, 'unknown_version');
      assert.equal(read.version, undefined);
      const resolved = await adapter.resolve(base);
      assert.equal(resolved.kind, 'unknown_version');
      assert.equal(resolved.version, undefined);
      if (adapter.find) assert.equal(await adapter.find(base), null);
    })
  );

  register('malformed JSON is malformed', () =>
    fixture(async (base) => {
      const text = '{ not json';
      await writeFile(join(base, '.mnemonik.json'), text);
      assert.equal(adapter.parse(text).kind, 'malformed');
      assert.equal((await adapter.read(base)).kind, 'malformed');
      const resolved = await adapter.resolve(base);
      assert.equal(resolved.kind, 'malformed');
      assert.equal(resolved.root, base);
      if (adapter.find) assert.equal(await adapter.find(base), null);
    })
  );

  register('folder outside git is plain', () =>
    fixture(async (base) => {
      const repository = await adapter.resolveRoot(base);
      assert.deepEqual(repository, { kind: 'plain', root: base });
    })
  );

  register('plain folders use the nearest ancestor identity', () =>
    fixture(async (base) => {
      const nearer = join(base, 'projects', 'nearest');
      const nested = join(nearer, 'src', 'feature');
      await identity(base, ROOT_ID, 'outer');
      await mkdir(nested, { recursive: true });
      await identity(nearer, NESTED_ID, 'nearest');

      const result = await adapter.resolve(nested);
      assert.equal(result.kind, 'ok');
      assert.equal(result.root, nearer);
      assert.equal(result.identity.projectId, NESTED_ID);
    })
  );

  register('plain folder identity search does not walk above the user home', () =>
    fixture(async (base) => {
      const home = join(base, 'home');
      const nested = join(home, 'projects', 'plain', 'src');
      await identity(base, ROOT_ID, 'above-home');
      await mkdir(nested, { recursive: true });

      const savedHome = process.env.HOME;
      process.env.HOME = home;
      try {
        const result = await adapter.resolve(nested);
        assert.equal(result.kind, 'absent');
        assert.equal(result.root, nested);
      } finally {
        if (savedHome === undefined) delete process.env.HOME;
        else process.env.HOME = savedHome;
      }
    })
  );

  register('missing git binary is git_unavailable and hooks fail closed', () =>
    fixture(async (base) => {
      const emptyPath = join(base, 'empty-path');
      await mkdir(emptyPath);
      const savedPath = process.env.PATH;
      process.env.PATH = emptyPath;
      try {
        const repository = await adapter.resolveRoot(base);
        assert.equal(repository.kind, 'git_unavailable');
        assert.match(repository.detail, /git|ENOENT/i);
        if (adapter.find) assert.equal(await adapter.find(base), null);
      } finally {
        if (savedPath === undefined) delete process.env.PATH;
        else process.env.PATH = savedPath;
      }
    })
  );
}
