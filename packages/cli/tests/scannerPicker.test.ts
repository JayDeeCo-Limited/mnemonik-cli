import { execFile as execFileCallback } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fsCalls = vi.hoisted(() => ({ readFile: vi.fn(), open: vi.fn(), readdir: vi.fn() }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  fsCalls.readFile.mockImplementation(actual.readFile);
  fsCalls.open.mockImplementation(actual.open);
  fsCalls.readdir.mockImplementation(actual.readdir);
  return {
    ...actual,
    readFile: fsCalls.readFile,
    open: fsCalls.open,
    readdir: fsCalls.readdir,
  };
});

import { resolveProjectIdentity } from '@mnemonik/shared';
import { Output } from '../src/output.js';
import { journeyAnswers } from '../src/screens/journey.js';
import { parseScannerSelection } from '../../../src/server/scannerDisclosure.js';
import {
  DIRECTORY_LIMIT,
  REPOSITORY_LIMIT,
  classifyRepository,
  discoverRepositories,
  scannerCandidates,
} from '../src/scanner/discover.js';
import {
  consentDraft,
  renderScannerStatus,
  runScannerBoundaryPicker,
  reviewScannerProjects,
  runScannerPicker,
  SCANNER_SELECTION_LIMIT,
  SCANNER_SELECTION_LIMIT_MESSAGE,
  scannerRootsParameter,
  type ScannerPickerResult,
} from '../src/scanner/picker.js';

const execFile = promisify(execFileCallback);
const created: string[] = [];
const uuid = (digit: string) =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;

async function temporaryDirectory(): Promise<string> {
  const path = await fs.mkdtemp(join(tmpdir(), 'mnemonik-root-picker-'));
  created.push(path);
  return path;
}

async function git(path: string, remote?: string): Promise<void> {
  await fs.mkdir(path, { recursive: true });
  await execFile('git', ['init', '--quiet', path]);
  if (remote) await execFile('git', ['-C', path, 'remote', 'add', 'origin', remote]);
}

async function identity(path: string, projectId: string, schemaVersion = 1): Promise<void> {
  await fs.writeFile(
    join(path, '.mnemonik.json'),
    JSON.stringify({ schemaVersion, projectId, projectName: 'fixture' }) + '\n'
  );
}

const capture = () => ({
  text: '',
  write(chunk: string) {
    this.text += chunk;
  },
});

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })));
  vi.restoreAllMocks();
  fsCalls.readFile.mockClear();
  fsCalls.open.mockClear();
  fsCalls.readdir.mockClear();
});

describe('repository discovery', () => {
  it('selects Git and resolved identity folders by default while skipping hidden folders', async () => {
    const home = await temporaryDirectory();
    const cwd = join(home, 'empty');
    const boundary = join(home, 'Projects');
    const app = join(boundary, 'app');
    const notes = join(boundary, 'notes');
    await fs.mkdir(cwd);
    await git(app);
    await fs.mkdir(notes);
    await identity(notes, uuid('1'));
    await git(join(boundary, 'node_modules', 'dependency'));
    await git(join(boundary, '.hidden', 'private'));

    const discovered = await scannerCandidates(boundary);
    expect(discovered.candidates).toEqual([
      { path: app, name: 'app', kind: 'git' },
      { path: notes, name: 'notes', kind: 'git' },
    ]);

    const stream = capture();
    const picked = await runScannerBoundaryPicker({
      input: Readable.from('\n'),
      output: new Output(stream, undefined, { home }),
      currentProject: cwd,
      currentFolder: cwd,
      home,
      protectedPaths: [],
    });
    expect(picked).toMatchObject({
      boundary,
      roots: [],
      exclusions: [],
      candidates: discovered.candidates,
      repositories: [
        { path: app, state: 'not_set_up', selected: true },
        { path: notes, state: 'existing_project', selected: true },
      ],
    });
    expect(stream.text).toBe('Where do your projects live? [~/Projects]\n');
  });

  it('lists a git repository with descendant identities and a nested git repository only once', async () => {
    const boundary = await temporaryDirectory();
    const repository = join(boundary, 'devops');
    const nested = join(repository, 'dokploy-mcp-server');
    await git(repository);
    await identity(repository, uuid('1'));
    await fs.mkdir(join(repository, 'home-agent'));
    await identity(join(repository, 'home-agent'), uuid('2'));
    await git(nested);

    const discovered = await scannerCandidates(boundary);

    expect(discovered.candidates).toEqual([
      { path: repository, name: 'devops', kind: 'git' },
      { path: nested, name: 'devops/dokploy-mcp-server', kind: 'git' },
    ]);
  });

  it('never guesses the home folder and asks again when it is entered', async () => {
    const home = await temporaryDirectory();
    const boundary = join(home, 'Projects');
    const app = join(boundary, 'app');
    await git(app);
    const stream = capture();

    const picked = await runScannerBoundaryPicker({
      input: Readable.from(`${home}\n${boundary}\n`),
      output: new Output(stream, undefined, { home }),
      currentProject: home,
      currentFolder: home,
      home,
      protectedPaths: [],
    });

    expect(picked).toMatchObject({ boundary });
    expect(stream.text).toBe(
      [
        'Where do your projects live? [~/Projects]',
        'Choose a project folder inside your home folder.',
        'Where do your projects live? [~/Projects]',
        '',
      ].join('\n')
    );
    expect(stream.text).not.toContain('[~]\n');
    expect(stream.text).not.toContain('[/]\n');
  });

  it('explains a missing or empty projects folder and asks again', async () => {
    const home = await temporaryDirectory();
    const empty = join(home, 'empty');
    const boundary = join(home, 'Projects');
    await fs.mkdir(empty);
    await git(join(boundary, 'app'));
    const stream = capture();

    const picked = await runScannerBoundaryPicker({
      input: Readable.from(`${join(home, 'missing')}\n${empty}\n${boundary}\n`),
      output: new Output(stream, undefined, { home }),
      currentProject: home,
      currentFolder: home,
      home,
      protectedPaths: [],
    });

    expect(picked).toMatchObject({ boundary });
    expect(stream.text).toContain('That folder does not exist. Choose another folder.\n');
    expect(stream.text).toContain('No repositories were found there. Choose another folder.\n');
    expect(stream.text.match(/Where do your projects live\?/gu)).toHaveLength(3);
  });

  it('keeps the next menu alive after an editable project-folder answer', async () => {
    const home = await temporaryDirectory();
    const boundary = join(home, 'x');
    await git(join(boundary, 'app'));
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
    const stream = capture();
    const output = new Output(stream, undefined, { home });
    const answers = journeyAnswers(input, output);
    const picker = runScannerBoundaryPicker as (
      options: Parameters<typeof runScannerBoundaryPicker>[0] & {
        readAnswer: () => Promise<string | undefined>;
      }
    ) => ReturnType<typeof runScannerBoundaryPicker>;

    const picked = picker({
      input,
      output,
      currentProject: join(boundary, 'app'),
      currentFolder: join(boundary, 'app'),
      home,
      protectedPaths: [],
      readAnswer: answers.text,
    });
    await vi.waitFor(() => expect(stream.text).toContain('Where do your projects live?'));
    input.write('~/wrong');
    input.write('\b\b\b\b\b');
    input.write('x\r');
    await expect(
      Promise.race([picked, new Promise((resolve) => setTimeout(resolve, 500))])
    ).resolves.toMatchObject({ boundary });
    expect(stream.text).toContain('~/wrong\b \b\b \b\b \b\b \b\b \bx\n');

    const choice = answers.choose(['Install and upload', 'Back', 'Cancel']);
    let settled = false;
    void choice.then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(settled).toBe(false);
    input.write('\u001b[B\r');
    await expect(choice).resolves.toBe('Back');
    answers.close();
  });

  it('resolves a leading tilde against the home folder', async () => {
    const home = await temporaryDirectory();
    const boundary = join(home, 'x');
    await git(join(boundary, 'app'));

    const picked = await runScannerBoundaryPicker({
      input: Readable.from('~/x\n'),
      output: new Output(capture(), undefined, { home }),
      currentProject: join(boundary, 'app'),
      currentFolder: join(boundary, 'app'),
      home,
      protectedPaths: [],
    });

    expect(picked).toMatchObject({ boundary });
  });

  it('finds real repositories through depth 3, nested roots separately, and never follows links or reads source', async () => {
    const parent = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await git(join(parent, 'one'));
    await git(join(parent, 'one', 'nested'));
    await git(join(parent, 'group', 'two'));
    await git(join(parent, 'a', 'b', 'three'));
    await git(join(parent, 'a', 'b', 'three', 'nested'));
    await git(join(parent, 'a', 'b', 'c', 'four'));
    await git(outside);
    await execFile('git', [
      '-C',
      outside,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'fixture',
    ]);
    await execFile('git', [
      '-C',
      outside,
      'worktree',
      'add',
      '--quiet',
      '--detach',
      join(parent, 'file-boundary'),
    ]);
    await fs.symlink(outside, join(parent, 'linked'), 'dir');
    await fs.writeFile(join(parent, 'source.ts'), 'never open me');
    fsCalls.readFile.mockClear();
    fsCalls.open.mockClear();

    const result = await discoverRepositories(parent);

    expect(result.status).toBe('complete');
    expect(result.repositories.map((row) => row.path)).toEqual(
      [
        join(parent, 'a', 'b', 'three'),
        join(parent, 'group', 'two'),
        join(parent, 'file-boundary'),
        join(parent, 'one'),
        join(parent, 'one', 'nested'),
      ].sort()
    );
    expect(result.repositories.some((row) => row.path === outside)).toBe(false);
    expect(
      fsCalls.readFile.mock.calls.every(([path]) =>
        /(?:\.git|\.mnemonik\.json)(?:[/\\]|$)/u.test(String(path))
      )
    ).toBe(true);
    expect(
      fsCalls.open.mock.calls.every(([path]) =>
        /(?:\.git|\.mnemonik\.json)(?:[/\\]|$)/u.test(String(path))
      )
    ).toBe(true);
  });

  it('returns a named truncation result when the directory ceiling is reached', async () => {
    const parent = await temporaryDirectory();
    expect(DIRECTORY_LIMIT).toBe(10_000);
    for (let index = 0; index < 11; index++)
      await fs.mkdir(join(parent, `directory-${String(index).padStart(5, '0')}`));
    const result = await discoverRepositories(parent, { directoryLimit: 10 });
    expect(result).toMatchObject({ status: 'list_truncated', directoriesVisited: 10 });
  });

  it('shows 200 repositories and counts the ones left out', async () => {
    const parent = await temporaryDirectory();
    expect(REPOSITORY_LIMIT).toBe(200);
    for (let index = 0; index < 201; index++)
      await fs.mkdir(join(parent, `repo-${String(index).padStart(3, '0')}`, '.git'), {
        recursive: true,
      });
    const reads: string[] = [];
    const result = await discoverRepositories(parent, {
      readDirectory: async (path) => {
        reads.push(path);
        return fs.readdir(path, { withFileTypes: true });
      },
      resolveIdentity: async (path) => ({
        kind: 'absent',
        root: path,
        repository: {
          kind: 'git',
          root: path,
          commonDir: join(path, '.git'),
          isLinkedWorktree: false,
          nested: [],
        },
        nested: [],
      }),
      readRemotes: async () => [],
    });

    expect(result.repositories).toHaveLength(200);
    expect(result.truncated).toBe(true);
    expect(result.omitted).toBe(1);
    expect(reads).toContain(join(parent, 'repo-200'));
  });

  it('tells the person how many repositories were left out and how to add them', async () => {
    const home = await temporaryDirectory();
    const boundary = join(home, 'Projects');
    await fs.mkdir(boundary);
    const stream = capture();
    const repositories = Array.from({ length: 200 }, (_, index) => ({
      path: join(boundary, `repo-${String(index).padStart(3, '0')}`),
      state: 'not_set_up' as const,
    }));

    await runScannerBoundaryPicker({
      input: Readable.from(`${boundary}\n`),
      output: new Output(stream, undefined, { home }),
      currentProject: home,
      currentFolder: home,
      home,
      protectedPaths: [],
      discover: async () => ({
        status: 'complete',
        displayRoot: boundary,
        root: boundary,
        directoriesVisited: 201,
        repositories,
        truncated: true,
        omitted: 1,
      }),
    });

    expect(stream.text).toContain(
      '1 repository was left out and can be added later with mnemonik add <folder>.\n'
    );
  });

  it.runIf(process.platform !== 'win32')(
    'rechecks a queued directory before a symlink swap can escape the root',
    async () => {
      const parent = await temporaryDirectory();
      const outside = await temporaryDirectory();
      const queued = join(parent, 'queued');
      await fs.mkdir(queued);
      await fs.mkdir(join(outside, '.git'));
      const reads: string[] = [];
      const result = await discoverRepositories(parent, {
        readDirectory: async (path) => {
          reads.push(path);
          const entries = await fs.readdir(path, { withFileTypes: true });
          if (path === parent) {
            await fs.rm(queued, { recursive: true });
            await fs.symlink(outside, queued, 'dir');
          }
          return entries;
        },
      });

      expect(reads).not.toContain(queued);
      expect(result.repositories).toEqual([]);
    }
  );
});

describe('repository states', () => {
  it('maps identity, remote-only, bare, v0, and nested conflict states', async () => {
    const root = await temporaryDirectory();
    const existing = join(root, 'existing');
    const remote = join(root, 'remote');
    const bare = join(root, 'bare');
    const legacy = join(root, 'legacy');
    const malformed = join(root, 'malformed');
    const outer = join(root, 'outer');
    const conflict = join(outer, 'nested');
    await git(existing);
    await identity(existing, uuid('1'));
    await git(remote, 'git@github.com:mnemonik/remote.git');
    await fs.mkdir(bare);
    await git(legacy);
    await identity(legacy, uuid('2'), 0);
    await git(malformed);
    await fs.writeFile(join(malformed, '.mnemonik.json'), '{');
    await git(outer);
    await identity(outer, uuid('3'));
    await git(conflict);
    await identity(conflict, uuid('4'));

    expect((await classifyRepository(existing)).state).toBe('existing_project');
    expect((await classifyRepository(remote)).state).toBe('remote_setup');
    expect((await classifyRepository(bare)).state).toBe('not_set_up');
    expect(await classifyRepository(legacy)).toMatchObject({
      state: 'action_required',
      reason: 'unknown_version',
    });
    expect(await classifyRepository(malformed)).toMatchObject({
      state: 'action_required',
      reason: 'malformed',
    });
    expect(await classifyRepository(conflict)).toMatchObject({
      state: 'action_required',
      reason: 'conflict',
    });
  });
});

describe('scanner picker and consent', () => {
  it.each([
    ['home', homedir(), process.platform, homedir(), 'home_directory'],
    ['literal temp', '/tmp', process.platform, homedir(), 'temporary_directory'],
    ['OS temp', tmpdir(), process.platform, homedir(), 'temporary_directory'],
    ['filesystem root', parse(process.cwd()).root, process.platform, homedir(), 'filesystem_root'],
    ['Windows drive root', 'C:\\', 'win32', 'C:\\Users\\alice', 'filesystem_root'],
    ['Windows home', 'C:\\Users\\alice', 'win32', 'C:\\Users\\alice', 'home_directory'],
    [
      'Claude config',
      join(homedir(), '.claude'),
      process.platform,
      homedir(),
      'host_config_directory',
    ],
    [
      'Codex config',
      join(homedir(), '.codex'),
      process.platform,
      homedir(),
      'host_config_directory',
    ],
    [
      'Cursor config',
      join(homedir(), '.cursor'),
      process.platform,
      homedir(),
      'host_config_directory',
    ],
    ['Grok config', join(homedir(), '.grok'), process.platform, homedir(), 'host_config_directory'],
    [
      'Windows Claude config',
      'C:\\Users\\alice\\.claude',
      'win32',
      'C:\\Users\\alice',
      'host_config_directory',
    ],
    [
      'Windows Codex config',
      'C:\\Users\\alice\\.codex',
      'win32',
      'C:\\Users\\alice',
      'host_config_directory',
    ],
    [
      'Windows Cursor config',
      'C:\\Users\\alice\\.cursor',
      'win32',
      'C:\\Users\\alice',
      'host_config_directory',
    ],
    [
      'Windows Grok config',
      'C:\\Users\\alice\\.grok',
      'win32',
      'C:\\Users\\alice',
      'host_config_directory',
    ],
  ] as const)(
    'refuses %s before picker discovery reads',
    async (_label, root, platform, home, reason) => {
      const currentProject = await temporaryDirectory();
      const discover = vi.fn();
      const canonicalizePath = vi.fn(async () => {
        throw new Error('picker canonicalization must not run');
      });
      const stream = capture();
      fsCalls.readdir.mockClear();
      const result = await runScannerPicker({
        input: Readable.from(`3\n${root}\n`),
        output: new Output(stream),
        currentProject,
        currentFolder: currentProject,
        home,
        platform,
        discover,
        canonicalizePath,
      });

      expect(result).toEqual({ status: 'cancelled', reason });
      expect(discover).not.toHaveBeenCalled();
      expect(canonicalizePath).not.toHaveBeenCalled();
      expect(fsCalls.readdir).not.toHaveBeenCalled();
      expect(stream.text).toContain('choose a project folder');
    }
  );

  it('refuses a broad workspace parent before picker discovery reads', async () => {
    const root = await temporaryDirectory();
    await Promise.all(
      ['one', 'two'].map((name) => fs.mkdir(join(root, name, '.git'), { recursive: true }))
    );
    const discover = vi.fn();
    const result = await runScannerPicker({
      input: Readable.from(`3\n${root}\n`),
      output: new Output(capture()),
      currentProject: join(root, 'one'),
      currentFolder: root,
      discover,
    });

    expect(result).toEqual({ status: 'cancelled', reason: 'broad_workspace_parent' });
    expect(discover).not.toHaveBeenCalled();
  });

  it('auto-excludes protected descendants without reading or listing their repositories', async () => {
    const parent = await temporaryDirectory();
    const protectedPath = join(parent, 'credential-store');
    const visible = join(parent, 'visible');
    await git(visible);
    await git(join(protectedPath, 'hidden'));
    const stream = capture();

    const picked = await runScannerPicker({
      input: Readable.from('2\n\n'),
      output: new Output(stream),
      currentProject: visible,
      currentFolder: parent,
      protectedPaths: [protectedPath],
    });

    if ('status' in picked) throw new Error('expected selected roots');
    expect(picked.exclusions).toEqual([protectedPath]);
    expect(picked.repositories.map((row) => row.path)).toEqual([visible]);
    expect(consentDraft(picked).exclusions).toEqual([protectedPath]);
    expect(stream.text).toContain(`Mnemonik will never read ${protectedPath}`);
    expect(stream.text).not.toContain('hidden');
  });

  it('refuses a root at or inside a protected path before discovery', async () => {
    const parent = await temporaryDirectory();
    const protectedPath = join(parent, 'credential-store');
    const inside = join(protectedPath, 'nested');
    await fs.mkdir(inside, { recursive: true });
    const discover = vi.fn();
    const stream = capture();

    const result = await runScannerPicker({
      input: Readable.from(`3\n${inside}\n`),
      output: new Output(stream),
      currentProject: parent,
      currentFolder: parent,
      protectedPaths: [protectedPath],
      discover,
    });

    expect(result).toEqual({ status: 'cancelled', reason: 'protected_path' });
    expect(stream.text).toContain(`inside protected path ${protectedPath}`);
    expect(discover).not.toHaveBeenCalled();
  });

  it('refuses when automatic protected exclusions alone exceed the consent bound', async () => {
    const parent = await temporaryDirectory();
    const protectedPaths = Array.from({ length: 33 }, (_, index) =>
      join(parent, `protected-${index}`)
    );
    const stream = capture();
    const result = await runScannerPicker({
      input: Readable.from('2\n'),
      output: new Output(stream),
      currentProject: parent,
      currentFolder: parent,
      protectedPaths,
      discover: vi.fn(),
    });

    expect(result).toEqual({ status: 'cancelled', reason: 'protected_exclusion_limit' });
    expect(stream.text).toContain('choose a narrower folder');
  });

  it('records every unchecked repository, including an existing project, as an exclusion', async () => {
    const parent = await temporaryDirectory();
    const first = join(parent, 'p', 'existing');
    const second = join(parent, 'p', 'remote');
    const third = join(parent, 'p', 'new');
    await git(first);
    await identity(first, uuid('5'));
    await git(second, 'https://github.com/mnemonik/remote.git');
    await git(third);
    const stream = capture();

    const picked = await runScannerPicker({
      input: Readable.from('2\n1,3\n'),
      output: new Output(stream),
      currentProject: first,
      currentFolder: parent,
    });

    if ('status' in picked) throw new Error('expected selected roots');
    expect(picked.repositories.filter((row) => !row.selected).map((row) => row.path)).toEqual([
      first,
      second,
    ]);
    expect(consentDraft(picked)).toEqual({ roots: [parent], exclusions: [first, second] });
    expect(parseScannerSelection(scannerRootsParameter(picked))).toEqual({
      roots: [parent],
      exclusions: [first, second],
    });
  });

  it('emits consent at 32 exclusions and refuses 33 roots or exclusions', () => {
    const paths = Array.from({ length: SCANNER_SELECTION_LIMIT + 1 }, (_, index) =>
      join('/work', `repo-${index}`)
    );
    const picked = (roots: string[], exclusions: string[]): ScannerPickerResult => ({
      roots,
      exclusions,
      repositories: [],
    });
    expect(
      parseScannerSelection(scannerRootsParameter(picked(['/work'], paths.slice(0, 32))))
    ).toEqual({ roots: ['/work'], exclusions: paths.slice(0, 32) });
    expect(() => consentDraft(picked(['/work'], paths))).toThrow(SCANNER_SELECTION_LIMIT_MESSAGE);
    expect(() => consentDraft(picked(paths, []))).toThrow(SCANNER_SELECTION_LIMIT_MESSAGE);
  });

  it('offers narrower folder, current project, and Back instead of drafting 33 exclusions', async () => {
    const root = '/work';
    const repositories = Array.from({ length: 32 }, (_, index) => ({
      path: join(root, `repo-${index}`),
      state: 'not_set_up' as const,
    }));
    const stream = capture();
    const result = await runScannerPicker({
      input: Readable.from(`2\n${repositories.map((_row, index) => index + 1).join(',')}\n3\n`),
      output: new Output(stream),
      currentProject: join(root, 'current'),
      currentFolder: root,
      protectedPaths: [join(root, 'protected')],
      canonicalizePath: async (path) => path,
      discover: async (path) => ({
        status: 'complete',
        displayRoot: path,
        root: path,
        directoriesVisited: 1,
        repositories,
        truncated: true,
        omitted: 0,
      }),
    });
    expect(result).toEqual({ status: 'cancelled', reason: 'selection_limit_back' });
    expect(stream.text).toContain(SCANNER_SELECTION_LIMIT_MESSAGE);
    expect(stream.text).toContain('32 shown; choose a narrower folder to see the rest');
    expect(stream.text).toContain('1. Choose a narrower folder');
    expect(stream.text).toContain('2. Watch only this project');
    expect(stream.text).toContain('3. Back');
  });

  it('requires explicit confirmation for another non-git path', async () => {
    const current = await temporaryDirectory();
    const plain = await temporaryDirectory();
    const refused = await runScannerPicker({
      input: Readable.from(`3\n${plain}\nno\n`),
      output: new Output(capture()),
      currentProject: current,
      currentFolder: dirname(current),
    });
    expect(refused).toMatchObject({ status: 'cancelled', reason: 'non_git_not_confirmed' });

    const accepted = await runScannerPicker({
      input: Readable.from(`3\n${plain}\nyes\n\n`),
      output: new Output(capture()),
      currentProject: current,
      currentFolder: dirname(current),
    });
    if ('status' in accepted) throw new Error('expected selected roots');
    expect(accepted).toMatchObject({ roots: [plain] });
    expect(accepted.repositories[0]).toMatchObject({ state: 'not_set_up', selected: true });
  });

  it('still confirms a non-git root when it contains a Git repository', async () => {
    const current = await temporaryDirectory();
    const plain = await temporaryDirectory();
    await git(join(plain, 'child'));
    const result = await runScannerPicker({
      input: Readable.from(`3\n${plain}\nno\n`),
      output: new Output(capture()),
      currentProject: current,
      currentFolder: dirname(current),
    });
    expect(result).toEqual({ status: 'cancelled', reason: 'non_git_not_confirmed' });
  });

  it('keeps a Windows path as typed on screen while using its canonical path', async () => {
    const canonical = await temporaryDirectory();
    const repository = join(canonical, 'repo');
    await git(repository);
    const typed = 'C:\\Users\\Sam\\code';
    const stream = capture();
    const result = await runScannerPicker({
      input: Readable.from(`3\n${typed}\nyes\n\n`),
      output: new Output(stream),
      currentProject: repository,
      currentFolder: canonical,
      canonicalizePath: async (path) => (path === typed ? canonical : fs.realpath(path)),
    });
    if ('status' in result) throw new Error('expected selected roots');
    expect(stream.text).toContain(`1 repositories under ${typed} will be indexed`);
    expect(result.roots).toEqual([canonical]);
  });

  it('matches the 80-column golden transcript', async () => {
    const root = await temporaryDirectory();
    await git(join(root, 'p', 'acme-api'));
    await identity(join(root, 'p', 'acme-api'), uuid('6'));
    await git(join(root, 'p', 'acme-web'), 'git@github.com:acme/web.git');
    await git(join(root, 'p', 'third'));
    const stream = capture();
    await runScannerPicker({
      input: Readable.from('2\n\n'),
      output: new Output(stream),
      currentProject: join(root, 'p', 'acme-api'),
      currentFolder: root,
    });
    expect(stream.text.replaceAll(root, '<folder>')).toBe(
      await fs.readFile(
        join(import.meta.dirname, 'fixtures', 'scanner-screen-80.golden.txt'),
        'utf8'
      )
    );
  });
});

describe('review-time staging and later status', () => {
  const selection: ScannerPickerResult = {
    roots: ['/work'],
    exclusions: ['/work/excluded'],
    repositories: [
      { path: '/work/ready', state: 'remote_setup', selected: true },
      { path: '/work/excluded', state: 'existing_project', selected: false },
      { path: '/work/later', state: 'not_set_up', selected: true },
    ],
  };

  it('stages each selected repository once, never excluded repositories, without repository writes', async () => {
    const root = await temporaryDirectory();
    const selected = join(root, 'selected');
    const action = join(root, 'action');
    const excluded = join(root, 'excluded');
    await git(selected, 'git@github.com:acme/selected.git');
    await git(action);
    await git(excluded);
    const paths = [selected, action, excluded];
    const before = await Promise.all(paths.map((path) => fs.stat(path)));
    const stream = capture();
    const stage = vi.fn(async ({ cwd }: { cwd: string }) =>
      cwd === action
        ? { status: 'ACTION_REQUIRED' as const, state: 'missing', allowedActions: ['retry'] }
        : {
            status: 'staged' as const,
            operationId: uuid('7'),
            root: cwd,
            permissionStatus: 'private' as const,
          }
    );
    const picked: ScannerPickerResult = {
      roots: [root],
      exclusions: [excluded],
      repositories: [
        { path: selected, state: 'remote_setup', selected: true },
        { path: action, state: 'not_set_up', selected: true },
        { path: excluded, state: 'not_set_up', selected: false },
      ],
    };

    const handoff = await reviewScannerProjects(picked, { stage }, new Output(stream));

    expect(stage).toHaveBeenCalledTimes(2);
    expect(stage).toHaveBeenCalledWith({
      cwd: selected,
      allowCreate: true,
      allowNestedInherit: false,
    });
    expect(stage).toHaveBeenCalledWith({
      cwd: action,
      allowCreate: true,
      allowNestedInherit: false,
    });
    expect(stage.mock.calls.some(([options]) => options.cwd === excluded)).toBe(false);
    expect(handoff).toMatchObject({
      staged: [{ path: selected }],
      actionRequired: [{ path: action, result: { status: 'ACTION_REQUIRED' } }],
    });
    expect(stream.text).toBe(`${selected}  staged\n${action}  ACTION_REQUIRED\n`);
    const after = await Promise.all(paths.map((path) => fs.stat(path)));
    expect(after.map((stat) => stat.mtimeMs)).toEqual(before.map((stat) => stat.mtimeMs));
    expect(await resolveProjectIdentity(selected)).toMatchObject({ kind: 'absent' });
  });

  it('shows a later unregistered repository with its one safe action', () => {
    const stream = capture();
    renderScannerStatus(selection, new Output(stream));
    expect(stream.text).toContain('Not set up yet - mnemonik project init /work/later');
    expect(stream.text).not.toContain('mnemonik project init /work/ready');
  });
});
