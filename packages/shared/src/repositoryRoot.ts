import { lstat, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readIdentityFile, type ProjectIdentityFile } from './projectIdentityFile.js';

export interface RepositoryBoundary {
  path: string;
  kind: 'directory' | 'file';
}

export type RepositoryRootResult =
  | {
      kind: 'git';
      root: string;
      commonDir: string;
      isLinkedWorktree: boolean;
      nested: RepositoryBoundary[];
    }
  | { kind: 'plain'; root: string }
  | { kind: 'git_unavailable'; detail: string };

type ResolvedRepository = Exclude<RepositoryRootResult, { kind: 'git_unavailable' }>;

type ResolvedBase = {
  root: string;
  repository: ResolvedRepository;
  nested: RepositoryBoundary[];
};

export type ProjectIdentityResolution =
  | (ResolvedBase & { kind: 'ok'; identity: ProjectIdentityFile })
  | (ResolvedBase & { kind: 'absent' })
  | (ResolvedBase & { kind: 'unknown_version'; version: unknown; path: string })
  | (ResolvedBase & { kind: 'malformed'; detail: string; path: string })
  | (ResolvedBase & { kind: 'nested'; parentIdentity?: ProjectIdentityFile })
  | (ResolvedBase & {
      kind: 'conflict';
      rootIdentity: ProjectIdentityFile;
      nestedIdentity: ProjectIdentityFile;
    })
  | { kind: 'git_unavailable'; detail: string };

const GIT_TIMEOUT_MS = 2_000;
const GIT_ENV_KEYS = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERPROFILE',
] as const;

function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of GIT_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.LC_ALL = 'C';
  return env;
}

function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, encoding: 'utf8', env: gitEnvironment() },
      (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stdout, stderr }));
        else resolvePromise({ stdout, stderr });
      }
    );
  });
}

async function boundaryAt(path: string): Promise<RepositoryBoundary | undefined> {
  try {
    const stat = await lstat(join(path, '.git'));
    if (stat.isDirectory()) return { path, kind: 'directory' };
    if (stat.isFile()) return { path, kind: 'file' };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
  }
  return undefined;
}

async function confirmedBoundaryAt(path: string): Promise<RepositoryBoundary | undefined> {
  const boundary = await boundaryAt(path);
  if (!boundary) return undefined;
  try {
    const { stdout } = await runGit(path, ['rev-parse', '--git-dir']);
    return stdout.trim() ? boundary : undefined;
  } catch {
    return undefined;
  }
}

async function boundariesBetween(cwd: string, root: string): Promise<RepositoryBoundary[]> {
  const boundaries: RepositoryBoundary[] = [];
  let directory = cwd;
  while (directory !== root) {
    const boundary = await confirmedBoundaryAt(directory);
    if (boundary) boundaries.push(boundary);
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return boundaries;
}

async function containingRepository(root: string): Promise<RepositoryBoundary | undefined> {
  let directory = dirname(root);
  while (true) {
    const boundary = await confirmedBoundaryAt(directory);
    if (boundary) return boundary;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

async function canonicalBoundaryRoot(boundary: RepositoryBoundary): Promise<string> {
  if (boundary.kind === 'directory') return boundary.path;
  const pointer = /^gitdir:\s*(.+)\s*$/im.exec(
    await readFile(join(boundary.path, '.git'), 'utf8')
  )?.[1];
  if (!pointer) return boundary.path;
  const gitDir = resolve(boundary.path, pointer);
  try {
    const commonDir = resolve(gitDir, (await readFile(join(gitDir, 'commondir'), 'utf8')).trim());
    return dirname(commonDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return boundary.path;
    throw error;
  }
}

export async function resolveRepositoryRoot(cwd: string): Promise<RepositoryRootResult> {
  const absoluteCwd = resolve(cwd);
  try {
    const { stdout } = await runGit(absoluteCwd, [
      'rev-parse',
      '--show-toplevel',
      '--git-common-dir',
    ]);
    const [rootLine, commonLine, ...extra] = stdout.trim().split(/\r?\n/);
    if (!rootLine || !commonLine || extra.length) {
      return { kind: 'git_unavailable', detail: 'git rev-parse returned an unexpected response' };
    }
    const root = resolve(rootLine);
    const commonDir = resolve(root, commonLine);
    const isLinkedWorktree = commonDir !== join(root, '.git');
    const nested = await boundariesBetween(absoluteCwd, root);
    if (!isLinkedWorktree && (await containingRepository(root))) {
      const boundary = await boundaryAt(root);
      if (boundary) nested.push(boundary);
    }
    return {
      kind: 'git',
      root,
      commonDir,
      isLinkedWorktree,
      nested,
    };
  } catch (error) {
    const failure = error as Error & { code?: string | number; stderr?: string };
    if (failure.code === 128 && /not a git repository/i.test(failure.stderr ?? failure.message)) {
      return { kind: 'plain', root: absoluteCwd };
    }
    return { kind: 'git_unavailable', detail: failure.message };
  }
}

async function readPlainIdentity(start: string): Promise<{
  root: string;
  result: Awaited<ReturnType<typeof readIdentityFile>>;
}> {
  const home = resolve(homedir());
  let directory = start;
  while (true) {
    const result = await readIdentityFile(directory);
    if (result.kind !== 'absent') return { root: directory, result };
    if (directory === home) break;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return { root: start, result: { kind: 'absent' } };
}

function withBase(
  repository: ResolvedRepository,
  root: string,
  nested: RepositoryBoundary[]
): ResolvedBase {
  return { root, repository, nested };
}

export async function resolveProjectIdentity(
  cwd: string,
  options: { allowNestedInherit?: boolean; selectedRoot?: boolean } = {}
): Promise<ProjectIdentityResolution> {
  const resolved = await resolveRepositoryRoot(cwd);
  // Git is optional. When the git command cannot answer, the folder is still a folder.
  const repository: ResolvedRepository =
    resolved.kind === 'git_unavailable' ? { kind: 'plain', root: resolve(cwd) } : resolved;

  if (repository.kind === 'plain') {
    const { root, result } = options.selectedRoot
      ? { root: repository.root, result: await readIdentityFile(repository.root, options) }
      : await readPlainIdentity(repository.root);
    const base = withBase(repository, root, []);
    if (result.kind === 'ok') return { ...base, ...result };
    if (result.kind === 'unknown_version') return { ...base, ...result, path: root };
    if (result.kind === 'malformed') return { ...base, ...result, path: root };
    return { ...base, kind: 'absent' };
  }

  const ownRoot = repository.isLinkedWorktree ? dirname(repository.commonDir) : repository.root;
  const outer = repository.isLinkedWorktree
    ? undefined
    : await containingRepository(repository.root);
  const own = await readIdentityFile(ownRoot, options);
  if (!outer || options.selectedRoot || own.kind === 'ok') {
    const base = withBase(repository, ownRoot, repository.nested);
    if (own.kind === 'ok') return { ...base, ...own };
    if (own.kind === 'unknown_version') return { ...base, ...own, path: ownRoot };
    if (own.kind === 'malformed') return { ...base, ...own, path: ownRoot };
    return { ...base, kind: 'absent' };
  }

  const nested = repository.nested;
  const parentRoot = await canonicalBoundaryRoot(outer);
  const parent = await readIdentityFile(parentRoot);
  const base = withBase(repository, parentRoot, nested);

  if (own.kind === 'unknown_version') return { ...base, ...own, path: ownRoot };
  if (own.kind === 'malformed') return { ...base, ...own, path: ownRoot };
  if (parent.kind === 'unknown_version') return { ...base, ...parent, path: parentRoot };
  if (parent.kind === 'malformed') return { ...base, ...parent, path: parentRoot };
  if (!options.allowNestedInherit) {
    return {
      ...base,
      kind: 'nested',
      ...(parent.kind === 'ok' ? { parentIdentity: parent.identity } : {}),
    };
  }
  if (parent.kind === 'ok') return { ...base, kind: 'ok', identity: parent.identity };
  return { ...base, kind: 'absent' };
}
