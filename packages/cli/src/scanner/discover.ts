import { execFile } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { access, lstat, readdir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, parse, relative, resolve } from 'node:path';
import {
  resolveProjectIdentity,
  selectRemote,
  type ProjectIdentityResolution,
  type RepositoryFingerprint,
  type RepositoryRemote,
} from '@mnemonik/shared';

export const DIRECTORY_LIMIT = 10_000;
export const DISCOVERY_DEPTH = 3;
export const REPOSITORY_LIMIT = 200;

export type RepositoryState =
  'existing_project' | 'remote_setup' | 'not_set_up' | 'action_required';

export interface DiscoveredRepository {
  path: string;
  state: RepositoryState;
  nonGitSelected?: true;
  fingerprint?: RepositoryFingerprint;
  reason?: Exclude<ProjectIdentityResolution['kind'], 'ok' | 'absent'>;
}

export interface ScannerCandidate {
  path: string;
  name: string;
  kind: 'git' | 'folder';
}

export type DiscoveryResult = {
  status: 'complete' | 'list_truncated';
  displayRoot: string;
  root: string;
  directoriesVisited: number;
  repositories: DiscoveredRepository[];
  truncated: boolean;
  omitted: number;
};

interface DiscoveryOptions {
  directoryLimit?: number;
  maxDepth?: number;
  canonicalizePath?: (path: string) => Promise<string>;
  resolveIdentity?: typeof resolveProjectIdentity;
  readDirectory?: (path: string) => Promise<Dirent[]>;
  readRemotes?: (path: string) => Promise<RepositoryRemote[]>;
}

const gitEnvironment = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { LC_ALL: 'C' };
  for (const key of ['PATH', 'HOME', 'LANG', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE'])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
};

function git(path: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      args,
      { cwd: path, timeout: 2_000, encoding: 'utf8', env: gitEnvironment() },
      (error, stdout) => (error ? reject(error) : resolvePromise(stdout))
    );
  });
}

async function repositoryRemotes(path: string): Promise<RepositoryRemote[]> {
  let names: string[];
  try {
    names = (await git(path, ['remote'])).split(/\r?\n/u).filter(Boolean);
  } catch {
    return [];
  }
  return Promise.all(
    names.map(async (name) => {
      const urls = async (extra: string[]) => {
        try {
          return (await git(path, ['remote', 'get-url', '--all', ...extra, name]))
            .split(/\r?\n/u)
            .filter(Boolean);
        } catch {
          return [];
        }
      };
      return { name, fetchUrls: await urls([]), pushUrls: await urls(['--push']) };
    })
  );
}

export async function classifyRepository(
  path: string,
  options: Pick<DiscoveryOptions, 'canonicalizePath' | 'resolveIdentity' | 'readRemotes'> = {}
): Promise<DiscoveredRepository> {
  const canonical = await (options.canonicalizePath ?? realpath)(path);
  const resolution = await (options.resolveIdentity ?? resolveProjectIdentity)(canonical);
  const resolvedPath =
    resolution.kind === 'git_unavailable'
      ? canonical
      : await (options.canonicalizePath ?? realpath)(
          resolution.repository.kind === 'git' ? resolution.repository.root : resolution.root
        );
  if (resolution.kind === 'ok') {
    return { path: resolvedPath, state: 'existing_project' };
  }
  const nonGit =
    resolution.kind !== 'git_unavailable' && resolution.repository.kind === 'plain'
      ? { nonGitSelected: true as const }
      : {};
  if (resolution.kind !== 'absent') {
    return { path: resolvedPath, state: 'action_required', reason: resolution.kind, ...nonGit };
  }
  if (resolution.repository.kind === 'git') {
    const selection = selectRemote(await (options.readRemotes ?? repositoryRemotes)(resolvedPath));
    if (selection.status === 'fingerprint') {
      return {
        path: resolvedPath,
        state: 'remote_setup',
        fingerprint: {
          algorithmVersion: selection.fingerprint.algorithmVersion,
          hash: selection.fingerprint.hash,
        },
      };
    }
  }
  return {
    path: resolvedPath,
    state: 'not_set_up',
    ...nonGit,
  };
}

export async function discoverRepositories(
  parentPath: string,
  options: DiscoveryOptions = {}
): Promise<DiscoveryResult> {
  const canonicalize = options.canonicalizePath ?? realpath;
  const root = await canonicalize(parentPath);
  const maxDepth = options.maxDepth ?? DISCOVERY_DEPTH;
  const limit = options.directoryLimit ?? DIRECTORY_LIMIT;
  const readDirectory = options.readDirectory ?? ((path) => readdir(path, { withFileTypes: true }));
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  const repositories: DiscoveredRepository[] = [];
  const repositoryPaths = new Set<string>();
  let omitted = 0;
  let directoriesVisited = 0;
  const result = (status: DiscoveryResult['status'], truncated: boolean): DiscoveryResult => ({
    status,
    displayRoot: parentPath,
    root,
    directoriesVisited,
    repositories: repositories.sort((left, right) => left.path.localeCompare(right.path)),
    truncated: truncated || omitted > 0,
    omitted,
  });

  while (queue.length) {
    if (directoriesVisited >= limit) return result('list_truncated', true);
    const directory = queue.shift();
    if (!directory) break;
    const stat = await lstat(directory.path).catch(() => undefined);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) continue;
    const canonical = await canonicalize(directory.path).catch(() => undefined);
    if (!canonical) continue;
    const fromRoot = relative(root, canonical);
    if (
      fromRoot === '..' ||
      fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
      isAbsolute(fromRoot)
    )
      continue;
    directoriesVisited++;
    let entries: Dirent[];
    try {
      entries = await readDirectory(canonical);
    } catch {
      continue;
    }
    const gitBoundary = entries.find(
      (entry) => entry.name === '.git' && (entry.isDirectory() || entry.isFile())
    );
    const identityBoundary = entries.some(
      (entry) => entry.name === '.mnemonik.json' && entry.isFile()
    );
    if (gitBoundary || identityBoundary) {
      const repository = await classifyRepository(canonical, {
        canonicalizePath: canonicalize,
        resolveIdentity: options.resolveIdentity,
        readRemotes: repositories.length < REPOSITORY_LIMIT ? options.readRemotes : async () => [],
      });
      if (!repositoryPaths.has(repository.path)) {
        repositoryPaths.add(repository.path);
        if (repositories.length < REPOSITORY_LIMIT) repositories.push(repository);
        else omitted++;
      }
    }
    if (directory.depth >= maxDepth) continue;
    const children = entries
      .filter(
        (entry) =>
          !entry.name.startsWith('.') &&
          entry.name !== 'node_modules' &&
          entry.isDirectory() &&
          !entry.isSymbolicLink()
      )
      .map((entry) => ({ path: join(canonical, entry.name), depth: directory.depth + 1 }))
      .sort((left, right) => left.path.localeCompare(right.path));
    queue.push(...children);
  }

  return result('complete', false);
}

export async function scannerCandidates(boundary: string): Promise<{
  boundary: string;
  candidates: ScannerCandidate[];
  repositories: DiscoveredRepository[];
  omitted: number;
}> {
  const discovered = await discoverRepositories(boundary);
  return {
    boundary: discovered.root,
    repositories: discovered.repositories,
    omitted: discovered.omitted,
    candidates: discovered.repositories.map((repository) => ({
      path: repository.path,
      name: repositoryName(discovered.root, repository.path),
      kind: repository.nonGitSelected ? 'folder' : 'git',
    })),
  };
}

export async function guessDiscoveryBoundary(cwd: string, home: string): Promise<string> {
  const current = resolve(cwd);
  const unsafe = current === resolve(home) || current === parse(current).root;
  if (!unsafe && (await discoverRepositories(cwd).catch(() => undefined))?.repositories.length)
    return cwd;
  for (const name of ['Projects', 'projects', 'code', 'src', 'dev', 'repos']) {
    const candidate = join(home, name);
    if (
      await access(candidate).then(
        () => true,
        () => false
      )
    )
      return candidate;
  }
  return unsafe ? '' : cwd;
}

export const repositoryName = (root: string, path: string): string =>
  relative(root, path) || basename(resolve(path));

export const repositoryStateLabel = (state: RepositoryState): string =>
  ({
    existing_project: 'Existing project',
    remote_setup: 'Set up from its Git remote',
    not_set_up: 'Not set up yet',
    action_required: 'Action required',
  })[state];
