import { lstat, readdir, realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { stateDirectory } from '@mnemonik/local-setup';
import type { ProjectIdentityResolution, RepositoryRootResult } from '@mnemonik/shared';

export type RootDecision =
  | { allowed: true; root: string; reason: string; nonGit: boolean }
  | { allowed: false; root: string; reason: string };

const within = (path: string, parent: string, platform: NodeJS.Platform): boolean => {
  const candidate = platform === 'win32' ? path.toLowerCase() : path;
  const boundary = platform === 'win32' ? parent.toLowerCase() : parent;
  return (
    candidate === boundary ||
    candidate.startsWith(`${boundary}${platform === 'win32' ? '\\' : '/'}`)
  );
};

async function canonical(path: string, platform: NodeJS.Platform): Promise<string> {
  const paths = platform === 'win32' ? win32 : posix;
  const absolute = paths.resolve(path);
  if (platform !== process.platform) return absolute;
  return realpath(path).catch(() => absolute);
}

/**
 * Repository shape of a candidate root from what is on disk: a `.git` directory
 * or file (a linked worktree) makes it a git repository; anything else is a
 * plain folder. Every root-picking path must use this before evaluateRoot, so
 * that a repository which happens to contain other repositories is never
 * mistaken for a broad workspace parent.
 */
export async function repositoryAt(
  candidate: string
): Promise<Extract<RepositoryRootResult, { kind: 'git' | 'plain' }>> {
  const marker = await lstat(join(candidate, '.git')).catch(() => undefined);
  return marker?.isDirectory() || marker?.isFile()
    ? {
        kind: 'git',
        root: candidate,
        commonDir: join(candidate, '.git'),
        isLinkedWorktree: false,
        nested: [],
      }
    : { kind: 'plain', root: candidate };
}

/** A folder that holds two or more projects, by either marker, is a parent of projects. */
async function broadWorkspace(root: string): Promise<boolean> {
  let projects = 0;
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    for (const name of ['.git', '.mnemonik.json']) {
      const marker = await lstat(join(root, entry.name, name)).catch(() => undefined);
      if (marker?.isDirectory() || marker?.isFile()) {
        projects += 1;
        break;
      }
    }
    if (projects >= 2) return true;
  }
  return false;
}

export async function evaluateRoot(
  resolution: ProjectIdentityResolution,
  options: {
    cwd: string;
    home?: string;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
  }
): Promise<RootDecision> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const paths = platform === 'win32' ? win32 : posix;
  const root = await canonical('root' in resolution ? resolution.root : options.cwd, platform);
  const home = await canonical(options.home ?? homedir(), platform);
  const temporary = await canonical(tmpdir(), platform);
  const state = await canonical(stateDirectory(platform, env, home), platform);
  if (root === paths.parse(root).root) return { allowed: false, root, reason: 'filesystem_root' };
  if (root === home) return { allowed: false, root, reason: 'home_directory' };
  if (root === temporary) return { allowed: false, root, reason: 'temporary_directory' };
  if (within(root, state, platform))
    return { allowed: false, root, reason: 'mnemonik_state_directory' };
  if (
    platform === 'win32' &&
    [
      env.LOCALAPPDATA ?? paths.join(home, 'AppData', 'Local'),
      env.APPDATA ?? paths.join(home, 'AppData', 'Roaming'),
    ].some((directory) => within(root, paths.resolve(directory), platform))
  )
    return { allowed: false, root, reason: 'user_data_directory' };
  if (
    ['.claude', '.codex', '.cursor', '.grok', '.copilot', '.mnemonik'].some((name) =>
      within(root, paths.join(home, name), platform)
    )
  )
    return { allowed: false, root, reason: 'host_config_directory' };
  const nonGit = 'repository' in resolution && resolution.repository.kind === 'plain';
  if (nonGit && (await broadWorkspace(root)))
    return { allowed: false, root, reason: 'broad_workspace_parent' };
  return {
    allowed: true,
    root,
    reason: nonGit ? 'explicit_non_git' : resolution.kind,
    nonGit,
  };
}
