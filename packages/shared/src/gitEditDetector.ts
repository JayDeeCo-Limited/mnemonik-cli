/**
 * Shell-write classification via filesystem observation, not command parsing.
 *
 * Permissive/auto-approve modes steer agents toward the shell for file work on
 * every host, and a shell payload carries a command string, not a file path -
 * so post-shell events reached the server with no edit to report and the
 * session's filesEdited/ideEditCount stayed empty, silencing every edit-gated
 * signal (checkpoint pressure above all). Parsing the command text for written
 * paths was considered and rejected (decision 2026-08-19: shell semantics make
 * path extraction guesswork). What git reports about the working tree is not
 * guesswork.
 *
 * Mechanism: snapshot the set of dirty paths (`git status --porcelain -uall`)
 * at session start, and after each shell call diff the current set against the
 * snapshot. Paths that are newly dirty were written between the two
 * observations. The caller reports those paths, then adds only confirmed paths
 * to the snapshot. Only additions count - a commit or stash SHRINKS the set,
 * and saving work is not new work. Edit tool writes are unioned into the
 * snapshot by each host's edit handler so they are never re-credited to the
 * next shell call.
 *
 * Host-agnostic by construction: the caller owns session identity and passes
 * the absolute path of its own private snapshot file. An empty `snapshotFile`
 * is the caller's "no usable session identity" signal and every entry point
 * no-ops on it - a synthesized or fallback id must never own a snapshot.
 * Because the diff rolls the snapshot forward, it is idempotent: a host with
 * no post-shell event may call it from several carrier events and each new
 * write is still reported exactly once.
 *
 * Known limits, accepted by design:
 * - A file already dirty at baseline that the shell modifies again is not
 *   re-reported (set membership, not content, is compared).
 * - Any working-tree change between two observations is credited to the shell
 *   call, including background processes. For "does this session have unsaved
 *   work" that is the right signal.
 * - Only the repo containing cwd is observed. Not a git repo -> report nothing
 *   rather than guess.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Bounded so a pathological repo cannot stall the hook's PostToolUse turn. */
const GIT_REV_PARSE_TIMEOUT_MS = 400;
const GIT_STATUS_TIMEOUT_MS = 800;
/** T5, the widest volume tier, needs 15 files; 25 keeps tier semantics intact. */
const MAX_REPORTED_PATHS_PER_CALL = 25;
/**
 * A dirty set larger than this is not agent work (mass generation, a missing
 * .gitignore). Classification is skipped rather than flooding filesEdited.
 */
const MAX_SNAPSHOT_PATHS = 2000;

interface DirtySnapshot {
  v: 1;
  root: string;
  paths: string[];
}

function runGit(cwd: string, args: string[], timeout: number): string | null {
  try {
    // --no-optional-locks is a TOP-LEVEL git option: passed after the
    // subcommand git exits 129 and every observation silently reports nothing.
    return execFileSync('git', ['--no-optional-locks', '-C', cwd, ...args], {
      timeout,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/**
 * The current dirty set as absolute paths, or null when cwd is not inside a
 * git repo, git is unavailable, a bound is exceeded, or the set is too large
 * to be agent work.
 */
export function listGitDirtyPaths(cwd: string): { root: string; paths: string[] } | null {
  const rootOut = runGit(cwd, ['rev-parse', '--show-toplevel'], GIT_REV_PARSE_TIMEOUT_MS);
  const root = rootOut?.trim();
  if (!root) return null;
  const statusOut = runGit(
    cwd,
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    GIT_STATUS_TIMEOUT_MS
  );
  if (statusOut === null) return null;
  const paths: string[] = [];
  const tokens = statusOut.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (!entry || entry.length < 4) continue;
    // "XY <path>"; a rename/copy entry is followed by the ORIGINAL path as its
    // own NUL token - consume it so it is never misread as a status entry.
    const statusCode = entry.slice(0, 2);
    paths.push(join(root, entry.slice(3)));
    if (statusCode.startsWith('R') || statusCode.startsWith('C')) i++;
    if (paths.length > MAX_SNAPSHOT_PATHS) return null;
  }
  return { root, paths };
}

function readSnapshot(snapshotFile: string): DirtySnapshot | null {
  try {
    const parsed = JSON.parse(readFileSync(snapshotFile, 'utf8')) as DirtySnapshot;
    if (parsed?.v !== 1 || typeof parsed.root !== 'string' || !Array.isArray(parsed.paths)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeSnapshot(snapshotFile: string, root: string, paths: string[]): void {
  try {
    mkdirSync(dirname(snapshotFile), { recursive: true, mode: 0o700 });
    writeFileSync(snapshotFile, JSON.stringify({ v: 1, root, paths } satisfies DirtySnapshot), {
      mode: 0o600,
    });
  } catch {
    // Best-effort: a missing snapshot degrades to "report nothing", never to a
    // wrong report.
  }
}

/** Session start: baseline the dirty set so pre-existing dirt is never reported. */
export function captureGitDirtyBaseline(snapshotFile: string, cwd: string): void {
  if (!snapshotFile) return;
  const current = listGitDirtyPaths(cwd);
  if (!current) return;
  writeSnapshot(snapshotFile, current.root, current.paths);
}

/**
 * After a shell call: paths newly dirty since the last observation, capped.
 * Leaves additions pending until the caller confirms them with
 * addPathsToGitDirtySnapshot. Without a usable baseline it establishes one and
 * reports nothing - degrading toward silence, never toward a false edit.
 */
export function diffGitDirtySnapshot(snapshotFile: string, cwd: string): string[] {
  if (!snapshotFile) return [];
  const current = listGitDirtyPaths(cwd);
  if (!current) return [];
  const baseline = readSnapshot(snapshotFile);
  if (!baseline || baseline.root !== current.root) {
    writeSnapshot(snapshotFile, current.root, current.paths);
    return [];
  }
  const known = new Set(baseline.paths);
  const additions = current.paths.filter((path) => !known.has(path));
  writeSnapshot(
    snapshotFile,
    current.root,
    current.paths.filter((path) => known.has(path))
  );
  return additions.slice(0, MAX_REPORTED_PATHS_PER_CALL);
}

/**
 * After an edit tool: fold tool-reported edits into the snapshot so the next
 * shell diff does not re-credit them. Only when a baseline exists - seeding a
 * partial snapshot would make later diffs report pre-existing dirt.
 */
export function addPathsToGitDirtySnapshot(snapshotFile: string, paths: string[]): void {
  if (!snapshotFile || paths.length === 0) return;
  const snapshot = readSnapshot(snapshotFile);
  if (!snapshot) return;
  const known = new Set(snapshot.paths);
  const additions = paths.filter((p) => !known.has(p));
  if (additions.length === 0) return;
  writeSnapshot(snapshotFile, snapshot.root, [...snapshot.paths, ...additions]);
}
