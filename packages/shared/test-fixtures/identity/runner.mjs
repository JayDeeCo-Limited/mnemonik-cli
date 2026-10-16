import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const ROOT_ID = '11111111-1111-4111-8111-111111111111';
const NESTED_ID = '22222222-2222-4222-8222-222222222222';

async function git(cwd, ...args) {
  await exec('git', args, { cwd, env: { ...process.env, LC_ALL: 'C' } });
}

async function commitAll(path, message = 'fixture') {
  await git(path, 'add', '-A');
  await git(path, 'commit', '-q', '-m', message);
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
  // Real path: resolvers compare with the real paths git prints (macOS /var -> /private/var).
  const path = await realpath(await mkdtemp(join(tmpdir(), 'mnemonik-identity-')));
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
      // The project folder is the main checkout, so its repository is reported.
      assert.equal(result.repository.kind, 'git');
      assert.equal(result.repository.root, main);
      assert.equal(result.repository.isLinkedWorktree, false);
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

  register('nested repository uses its own valid identity across consumers', () =>
    fixture(async (base) => {
      const main = join(base, 'main');
      const nested = join(main, 'vendor', 'nested');
      await initRepo(main);
      await identity(main, ROOT_ID, 'main');
      await initRepo(nested);
      await identity(nested, NESTED_ID, 'nested');

      const result = await adapter.resolve(nested);
      assert.equal(result.kind, 'ok');
      assert.equal(result.root, nested);
      assert.equal(result.identity.projectId, NESTED_ID);
      assert.ok(result.nested.some((entry) => entry.path === nested));
      if (adapter.find) assert.equal((await adapter.find(nested)).projectId, NESTED_ID);
    })
  );

  register('a nested clone without its own identity file belongs to the project around it', () =>
    fixture(async (base) => {
      const main = join(base, 'main');
      const nested = join(main, 'packages', 'nested');
      await initRepo(main);
      await identity(main, ROOT_ID, 'main');
      await initRepo(nested);
      await mkdir(join(nested, 'lib'));

      for (const cwd of [nested, join(nested, 'lib')]) {
        const resolved = await adapter.resolve(cwd);
        assert.equal(resolved.kind, 'ok');
        assert.equal(resolved.root, main);
        assert.equal(resolved.identity.projectId, ROOT_ID);
        if (adapter.find) assert.equal((await adapter.find(cwd)).projectId, ROOT_ID);
      }
    })
  );

  register('a subfolder of a repository belongs to the repository project', () =>
    fixture(async (base) => {
      const main = join(base, 'main');
      const deep = join(main, 'src', 'deep');
      await initRepo(main);
      await identity(main, ROOT_ID, 'main');
      await mkdir(deep, { recursive: true });

      const resolved = await adapter.resolve(deep);
      assert.equal(resolved.kind, 'ok');
      assert.equal(resolved.root, main);
      assert.equal(resolved.identity.projectId, ROOT_ID);
      assert.equal(resolved.repository.kind, 'git');
      if (adapter.find) assert.equal((await adapter.find(deep)).projectId, ROOT_ID);
    })
  );

  register('a plain subfolder with its own identity file is its own project', () =>
    fixture(async (base) => {
      const main = join(base, 'main');
      const sub = join(main, 'home-agent');
      await initRepo(main);
      await identity(main, ROOT_ID, 'main');
      await mkdir(join(sub, 'src'), { recursive: true });
      await identity(sub, NESTED_ID, 'home-agent');

      const resolved = await adapter.resolve(join(sub, 'src'));
      assert.equal(resolved.kind, 'ok');
      assert.equal(resolved.root, sub);
      assert.equal(resolved.identity.projectId, NESTED_ID);
      // The project folder is not the repository's top, so it is a plain folder.
      assert.equal(resolved.repository.kind, 'plain');
      if (adapter.find) assert.equal((await adapter.find(sub)).projectId, NESTED_ID);
      const parent = await adapter.resolve(main);
      assert.equal(parent.root, main);
      assert.equal(parent.identity.projectId, ROOT_ID);
    })
  );

  register('a worktree kept inside its repository belongs to the main checkout', () =>
    fixture(async (base) => {
      const main = join(base, 'main');
      const worktree = join(main, '.claude', 'worktrees', 'feature');
      await initRepo(main);
      await identity(main, ROOT_ID, 'main');
      await commitAll(main);
      await git(main, 'worktree', 'add', '-q', '-b', 'fixture-inside', worktree);
      // The committed identity file is checked out into the worktree's top;
      // a different copy there still does not override the main checkout.
      await identity(worktree, NESTED_ID, 'wrong-worktree-copy');
      await mkdir(join(worktree, 'src'));

      for (const cwd of [worktree, join(worktree, 'src')]) {
        const resolved = await adapter.resolve(cwd);
        assert.equal(resolved.kind, 'ok');
        assert.equal(resolved.root, main);
        assert.equal(resolved.identity.projectId, ROOT_ID);
        if (adapter.find) assert.equal((await adapter.find(cwd)).projectId, ROOT_ID);
      }
    })
  );

  register('a project folder inside a worktree is its own project', () =>
    fixture(async (base) => {
      const main = join(base, 'main');
      const worktree = join(base, 'elsewhere', 'feature');
      await initRepo(main);
      await identity(main, ROOT_ID, 'main');
      await commitAll(main);
      await git(main, 'worktree', 'add', '-q', '-b', 'fixture-project-inside', worktree);
      const project = join(worktree, 'tools', 'agent');
      await mkdir(join(project, 'src'), { recursive: true });
      await identity(project, NESTED_ID, 'agent');

      const resolved = await adapter.resolve(join(project, 'src'));
      assert.equal(resolved.kind, 'ok');
      assert.equal(resolved.root, project);
      assert.equal(resolved.identity.projectId, NESTED_ID);
      assert.equal(resolved.repository.kind, 'plain');
      const beside = await adapter.resolve(join(worktree, 'tools'));
      assert.equal(beside.root, main);
      assert.equal(beside.identity.projectId, ROOT_ID);
    })
  );

  register('a submodule is its own project only with its own identity file', () =>
    fixture(async (base) => {
      const upstream = join(base, 'upstream');
      const main = join(base, 'main');
      await initRepo(upstream);
      await writeFile(join(upstream, 'README'), 'upstream');
      await commitAll(upstream);
      await initRepo(main);
      await identity(main, ROOT_ID, 'main');
      // The layout `git submodule add` makes (its git directory kept under the
      // parent's .git/modules), without the submodule shell script.
      const sub = join(main, 'sub');
      await mkdir(join(main, '.git', 'modules'));
      await git(
        main,
        'clone',
        '-q',
        `--separate-git-dir=${join(main, '.git', 'modules', 'sub')}`,
        upstream,
        sub
      );

      const repository = await adapter.resolveRoot(sub);
      assert.equal(repository.kind, 'git');
      assert.equal(repository.root, sub);
      assert.equal(repository.isLinkedWorktree, false);
      assert.equal(repository.commonDir, join(main, '.git', 'modules', 'sub'));

      const inherited = await adapter.resolve(sub);
      assert.equal(inherited.kind, 'ok');
      assert.equal(inherited.root, main);
      assert.equal(inherited.identity.projectId, ROOT_ID);

      await identity(sub, NESTED_ID, 'sub');
      const own = await adapter.resolve(sub);
      assert.equal(own.kind, 'ok');
      assert.equal(own.root, sub);
      assert.equal(own.identity.projectId, NESTED_ID);
      assert.equal(own.repository.kind, 'git');
      if (adapter.find) assert.equal((await adapter.find(sub)).projectId, NESTED_ID);
    })
  );

  register(
    'a nested clone or submodule inside a linked worktree belongs to the main checkout',
    () =>
      fixture(async (base) => {
        const upstream = join(base, 'upstream');
        const main = join(base, 'main');
        const worktree = join(base, 'elsewhere', 'feature');
        await initRepo(upstream);
        await writeFile(join(upstream, 'README'), 'upstream');
        await commitAll(upstream);
        await initRepo(main);
        await identity(main, ROOT_ID, 'main');
        await commitAll(main);
        await git(main, 'worktree', 'add', '-q', '-b', 'fixture-nested-in-worktree', worktree);
        await identity(worktree, NESTED_ID, 'wrong-worktree-copy');
        const clone = join(worktree, 'libs', 'clone');
        await mkdir(join(clone, 'src'), { recursive: true });
        await git(clone, 'init', '-q');
        const sub = join(worktree, 'sub');
        await mkdir(join(main, '.git', 'worktrees', 'feature', 'modules'), { recursive: true });
        await git(
          worktree,
          'clone',
          '-q',
          `--separate-git-dir=${join(main, '.git', 'worktrees', 'feature', 'modules', 'sub')}`,
          upstream,
          sub
        );

        for (const cwd of [join(clone, 'src'), sub]) {
          const resolved = await adapter.resolve(cwd);
          assert.equal(resolved.kind, 'ok', cwd);
          assert.equal(resolved.root, main, cwd);
          assert.equal(resolved.identity.projectId, ROOT_ID, cwd);
          if (adapter.find) assert.equal((await adapter.find(cwd)).projectId, ROOT_ID);
        }
      })
  );

  register('worktrees of a bare repository belong to the folder holding it', () =>
    fixture(async (base) => {
      const seed = join(base, 'seed');
      const project = join(base, 'bareproj');
      const bare = join(project, '.bare');
      const worktree = join(project, 'main');
      await initRepo(seed);
      await writeFile(join(seed, 'README'), 'seed');
      await commitAll(seed);
      await mkdir(project);
      await git(project, 'clone', '-q', '--bare', seed, bare);
      await writeFile(join(project, '.git'), 'gitdir: ./.bare\n');
      await git(project, 'worktree', 'add', '-q', worktree, 'main');
      await mkdir(join(worktree, 'src'));

      // No identity file yet: a new project would be made in the folder
      // holding the bare repository, never inside the git directory.
      const absent = await adapter.resolve(join(worktree, 'src'));
      assert.equal(absent.kind, 'absent');
      assert.equal(absent.root, project);

      await identity(project, ROOT_ID, 'bareproj');
      const resolved = await adapter.resolve(join(worktree, 'src'));
      assert.equal(resolved.kind, 'ok');
      assert.equal(resolved.root, project);
      assert.equal(resolved.identity.projectId, ROOT_ID);
      if (adapter.find) assert.equal((await adapter.find(worktree)).projectId, ROOT_ID);
    })
  );

  register('a repository with a separate git directory is not a worktree', () =>
    fixture(async (base) => {
      const main = join(base, 'main');
      const separate = join(main, 'separate');
      await initRepo(main);
      await identity(main, ROOT_ID, 'main');
      await mkdir(separate);
      await mkdir(join(base, 'gitdirs'));
      await git(separate, 'init', '-q', `--separate-git-dir=${join(base, 'gitdirs', 'separate')}`);
      await identity(separate, NESTED_ID, 'separate');

      const repository = await adapter.resolveRoot(separate);
      assert.equal(repository.kind, 'git');
      assert.equal(repository.root, separate);
      assert.equal(repository.isLinkedWorktree, false);
      const resolved = await adapter.resolve(separate);
      assert.equal(resolved.kind, 'ok');
      assert.equal(resolved.root, separate);
      assert.equal(resolved.identity.projectId, NESTED_ID);
    })
  );

  register('a symlinked path resolves as the real folder it points to', () =>
    fixture(async (base) => {
      const main = join(base, 'main');
      const worktree = join(base, 'elsewhere', 'feature');
      const links = join(base, 'links');
      await initRepo(main);
      await identity(main, ROOT_ID, 'main');
      await mkdir(join(main, 'src', 'deep'), { recursive: true });
      await writeFile(join(main, 'src', 'deep', 'file'), 'x');
      await commitAll(main);
      await git(main, 'worktree', 'add', '-q', '-b', 'fixture-symlink', worktree);
      await identity(worktree, NESTED_ID, 'wrong-worktree-copy');
      await mkdir(links);
      await symlink(main, join(links, 'root'));
      await symlink(join(main, 'src'), join(links, 'sub'));
      await symlink(worktree, join(links, 'worktree'));

      for (const link of ['root', 'sub', 'worktree']) {
        const resolved = await adapter.resolve(join(links, link));
        assert.equal(resolved.kind, 'ok', link);
        assert.equal(resolved.root, main, link);
        assert.equal(resolved.identity.projectId, ROOT_ID, link);
        if (adapter.find) assert.equal((await adapter.find(join(links, link))).projectId, ROOT_ID);
      }
      const repository = await adapter.resolveRoot(join(links, 'sub', 'deep'));
      assert.equal(repository.root, main);
      assert.equal(repository.isLinkedWorktree, false);
      const linked = await adapter.resolveRoot(join(links, 'worktree'));
      assert.equal(linked.root, worktree);
      assert.equal(linked.isLinkedWorktree, true);
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

  register(
    'missing git binary is git_unavailable; the plain walk still finds the identity file',
    () =>
      fixture(async (base) => {
        const emptyPath = join(base, 'empty-path');
        const project = join(base, 'project');
        const sub = join(project, 'src');
        await mkdir(emptyPath);
        await initRepo(project);
        await identity(project, ROOT_ID, 'project');
        await mkdir(sub);
        const bare = join(base, 'bare');
        await mkdir(bare);
        const savedPath = process.env.PATH;
        process.env.PATH = emptyPath;
        try {
          const repository = await adapter.resolveRoot(base);
          assert.equal(repository.kind, 'git_unavailable');
          assert.match(repository.detail, /git|ENOENT/i);
          if (adapter.find) assert.equal(await adapter.find(bare), null);
          const resolved = await adapter.resolve(sub);
          assert.equal(resolved.kind, 'ok');
          assert.equal(resolved.root, project);
          assert.equal(resolved.identity.projectId, ROOT_ID);
          if (adapter.find) assert.equal((await adapter.find(sub)).projectId, ROOT_ID);
        } finally {
          if (savedPath === undefined) delete process.env.PATH;
          else process.env.PATH = savedPath;
        }
      })
  );
}
