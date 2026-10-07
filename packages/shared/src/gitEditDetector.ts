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
 *
 * Two additions (2026-09-19), both found by a session that made eleven
 * commits in a worktree and was never asked to checkpoint:
 * - The snapshot holds one dirty set PER repository root. A session that
 *   moves between the main checkout and a worktree used to reset the snapshot
 *   on every move, absorbing whatever was dirty at that moment as pre-existing
 *   and never crediting it.
 * - A shell call whose command contains `git commit` is credited with the
 *   files that commit changed. An edit-and-commit in one command leaves the
 *   tree clean by the time it is observed, so the dirty diff sees nothing.
 *   HEAD is recorded per root at every observation; only commits made since
 *   the last observation count, and never a merge.
 *
 * Three more (2026-10-07), found by a session whose push was gated a dozen
 * times for edits it never made:
 * - A nested repository or worktree directory is not an edit. `git status`
 *   lists one as a single `dir/` entry when its parent does not ignore it, so
 *   creating a worktree under the checkout counted as a file edit.
 * - A shell call that runs a git command importing other content (merge,
 *   cherry-pick, rebase, pull, am, revert, reset, stash pop/apply) credits
 *   nothing: what it leaves dirty or commits was written elsewhere.
 * - A pending report for a path whose repository directory no longer exists
 *   (a removed worktree) is dropped, not re-sent: the files are gone because
 *   the checkout was removed, not because this session deleted them.
 *
 * Each report also carries where the edit happened (`editScope`): the git
 * worktree and repository of the file, or a mark that the file lies outside
 * the project's repository (/tmp, another repository, a `.git` directory). The
 * server counts only project edits, and gates a push on the uncheckpointed
 * files it carries (`describeHandoffs`).
 */

import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

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

interface RootSnapshot {
  paths: string[];
  head?: string;
}

interface DirtySnapshot {
  v: 2;
  roots: Record<string, RootSnapshot>;
}

/** The pre-2026-09-19 shape: one root, one list. Read once, written as v2. */
interface LegacyDirtySnapshot {
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
    if (statusCode.startsWith('R') || statusCode.startsWith('C')) i++;
    // With --untracked-files=all every untracked FILE is listed on its own; the
    // only entry that ends in a slash is a nested repository or worktree, which
    // git never descends into. Its appearance is a checkout, not an edit.
    if (entry.endsWith('/')) continue;
    paths.push(join(root, entry.slice(3)));
    if (paths.length > MAX_SNAPSHOT_PATHS) return null;
  }
  return { root, paths };
}

/**
 * Git commands that bring content written elsewhere into the working tree.
 * What a merge (squash included), cherry-pick, rebase, pull, am, revert, reset
 * or stash pop/apply leaves dirty or commits is not this session's edit.
 * Classifying the command is coarse on purpose: a shell call that also edits a
 * file in the same command is credited nothing, which errs toward silence
 * (the next edit to that file is still credited).
 */
const GIT_CONTENT_IMPORT_RE =
  /\bgit\s+(?:-C\s+\S+\s+)?(?:merge|cherry-pick|rebase|pull|am|revert|reset|stash\s+(?:pop|apply))\b/;

/** HEAD of the repo at cwd, or undefined before the first commit. */
function currentHead(cwd: string): string | undefined {
  return (
    runGit(cwd, ['rev-parse', '--verify', '-q', 'HEAD'], GIT_REV_PARSE_TIMEOUT_MS)?.trim() ||
    undefined
  );
}

/**
 * Files changed by the commits made between two heads, or by HEAD alone when
 * there is no earlier head. Empty when any of those commits is a merge: a
 * merge brings in other people's files and none of them is this session's
 * edit. `git commit --amend` orphans the old head, so the range is still the
 * one new commit and the diff is the amended change.
 */
function committedPaths(cwd: string, root: string, from: string | undefined, to: string): string[] {
  const range = from && from !== to ? `${from}..${to}` : to;
  const parents = runGit(
    cwd,
    from ? ['log', '--format=%P', range] : ['log', '--format=%P', '-1', to],
    GIT_STATUS_TIMEOUT_MS
  );
  if (parents === null) return [];
  const lines = parents.split('\n').filter(Boolean);
  if (lines.length === 0 || lines.some((line) => line.includes(' '))) return [];
  const names = from
    ? runGit(cwd, ['diff', '--name-only', '-z', from, to], GIT_STATUS_TIMEOUT_MS)
    : runGit(cwd, ['show', '--name-only', '-z', '--format=', to], GIT_STATUS_TIMEOUT_MS);
  if (names === null) return [];
  return names
    .split('\0')
    .filter(Boolean)
    .map((name) => join(root, name));
}

/**
 * Replace `file` whole: write a temporary file beside it, then rename it into
 * place. Hook processes for one session run concurrently (parallel tool calls)
 * and each rewrites the snapshot and the retry retryState; a plain writeFileSync
 * truncates first, so a reader could see an empty or partial file and two
 * writers could interleave into corrupt JSON. A rename is atomic on the same
 * file system: a reader sees the old file or the new one. Concurrent writers
 * still race (the last rename wins), which costs at most a re-sent report.
 */
function writeFileWhole(file: string, data: string): void {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, data, { mode: 0o600 });
    renameSync(temporary, file);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Never written, or already renamed.
    }
    throw error;
  }
}

function readSnapshot(snapshotFile: string): DirtySnapshot | null {
  try {
    const parsed = JSON.parse(readFileSync(snapshotFile, 'utf8')) as
      DirtySnapshot | LegacyDirtySnapshot;
    if (parsed?.v === 1 && typeof parsed.root === 'string' && Array.isArray(parsed.paths)) {
      return { v: 2, roots: { [parsed.root]: { paths: parsed.paths } } };
    }
    if (parsed?.v !== 2 || typeof parsed.roots !== 'object' || parsed.roots === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Persist one root's list into the snapshot, keeping every other root. The
 * whole file stays under MAX_SNAPSHOT_PATHS: when the total would exceed it,
 * only the root being written survives.
 */
function writeRoot(snapshotFile: string, root: string, entry: RootSnapshot): void {
  try {
    const roots = { ...(readSnapshot(snapshotFile)?.roots ?? {}), [root]: entry };
    const total = Object.values(roots).reduce((sum, r) => sum + r.paths.length, 0);
    const snapshot: DirtySnapshot = {
      v: 2,
      roots: total > MAX_SNAPSHOT_PATHS ? { [root]: entry } : roots,
    };
    mkdirSync(dirname(snapshotFile), { recursive: true, mode: 0o700 });
    writeFileWhole(snapshotFile, JSON.stringify(snapshot));
  } catch {
    // Best-effort: a missing snapshot degrades to "report nothing", never to a
    // wrong report.
  }
}

/** The recorded root whose directory contains this absolute path, if any. */
function rootFor(snapshot: DirtySnapshot, path: string): string | undefined {
  return Object.keys(snapshot.roots)
    .filter((root) => path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`))
    .sort((x, y) => y.length - x.length)[0];
}

/** Session start: baseline the dirty set so pre-existing dirt is never reported. */
export function captureGitDirtyBaseline(snapshotFile: string, cwd: string): void {
  if (!snapshotFile) return;
  const current = listGitDirtyPaths(cwd);
  if (!current) return;
  writeRoot(snapshotFile, current.root, { paths: current.paths, head: currentHead(cwd) });
}

/**
 * After a shell call: paths newly dirty since the last observation of this
 * repo, plus, when `command` contains `git commit`, the paths that commit
 * changed. Capped. Leaves additions pending until the caller confirms them
 * with addPathsToGitDirtySnapshot. A repo with no baseline yet gets one and
 * reports nothing - degrading toward silence, never toward a false edit.
 */
export function diffGitDirtySnapshot(snapshotFile: string, cwd: string, command = ''): string[] {
  if (!snapshotFile) return [];
  const current = listGitDirtyPaths(cwd);
  if (!current) return [];
  const head = currentHead(cwd);
  const baseline = readSnapshot(snapshotFile)?.roots[current.root];
  if (!baseline) {
    writeRoot(snapshotFile, current.root, { paths: current.paths, head });
    return [];
  }
  if (GIT_CONTENT_IMPORT_RE.test(command)) {
    // Absorb: everything dirty now is known, nothing is credited.
    writeRoot(snapshotFile, current.root, { paths: current.paths, head });
    return [];
  }
  const known = new Set(baseline.paths);
  const additions = current.paths.filter((path) => !known.has(path));
  if (head && head !== baseline.head && /\bgit\s+commit\b/.test(command)) {
    for (const path of committedPaths(cwd, current.root, baseline.head, head))
      if (!known.has(path) && !additions.includes(path)) additions.push(path);
  }
  writeRoot(snapshotFile, current.root, {
    paths: current.paths.filter((path) => known.has(path)),
    head,
  });
  return additions.slice(0, MAX_REPORTED_PATHS_PER_CALL);
}

/**
 * After an edit tool: fold tool-reported edits into the snapshot so the next
 * shell diff does not re-credit them. Only when a baseline exists for the
 * repo that holds the path - seeding a partial snapshot would make later diffs
 * report pre-existing dirt.
 */
export function addPathsToGitDirtySnapshot(snapshotFile: string, paths: string[]): void {
  if (!snapshotFile || paths.length === 0) return;
  const snapshot = readSnapshot(snapshotFile);
  if (!snapshot) return;
  for (const path of paths) {
    const root = rootFor(snapshot, path);
    const entry = root ? snapshot.roots[root] : undefined;
    if (!root || !entry || entry.paths.includes(path)) continue;
    entry.paths = [...entry.paths, path];
    writeRoot(snapshotFile, root, entry);
  }
}

// - Where an edit happened -
//
// A session's hooks report every file the agent writes, wherever it is: a
// scratch note in /tmp, a file in another repository, a file in a subagent's own
// worktree. Only edits to the project's repository are project work, and a
// handoff (git push) hands off only the worktree it runs in. The host knows
// the git topology; the server does not. So each report says where the edit
// happened, and the server counts accordingly.

interface GitLocation {
  /** The worktree root: the nearest directory holding `.git`. */
  root: string;
  /** The repository's common directory: the same for every worktree of one repository. */
  commonDir: string;
}

/**
 * One process handles one hook event, and an event reports up to 25 paths,
 * mostly in the same few directories: remember each directory's answer.
 */
const gitLocationCache = new Map<string, GitLocation | 'none' | null>();

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The directory a `.git` FILE (a linked worktree or submodule) points at, or null. */
function gitDirFromFile(dotGitFile: string, root: string): string | null {
  try {
    const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGitFile, 'utf8'));
    return match?.[1] ? resolve(root, match[1].trim()) : null;
  } catch {
    return null;
  }
}

/** A linked worktree's git dir names its repository in `commondir`; otherwise it is its own. */
function commonDirOf(gitDir: string): string {
  try {
    const relative = readFileSync(join(gitDir, 'commondir'), 'utf8').trim();
    return relative ? resolve(gitDir, relative) : gitDir;
  } catch {
    return gitDir;
  }
}

/**
 * Git skips a `.git` that is not a repository (a stray empty `/tmp/.git` is
 * real): it must hold `HEAD`, and its repository must hold `objects`.
 */
function isGitDir(gitDir: string): boolean {
  try {
    return (
      statSync(join(gitDir, 'HEAD')).isFile() &&
      statSync(join(commonDirOf(gitDir), 'objects')).isDirectory()
    );
  } catch {
    return false;
  }
}

/**
 * The git location of a directory, found the way git finds it: the nearest
 * ancestor holding a valid `.git`. A `.git` directory is the repository; a `.git`
 * file (linked worktree) points at a git dir whose `commondir` names the
 * repository. 'none' when no ancestor holds `.git`; null when the file system
 * would not say (permissions), which callers treat as unknown, never as
 * "outside". Read from the file system rather than by running git: a hook
 * reports up to 25 paths inside a time budget, and a process per path would
 * spend it.
 */
function gitLocation(dir: string): GitLocation | 'none' | null {
  const cached = gitLocationCache.get(dir);
  if (cached !== undefined) return cached;
  let result: GitLocation | 'none' | null = 'none';
  for (let current = dir; ;) {
    const dotGit = join(current, '.git');
    let stat: ReturnType<typeof statSync> | undefined;
    try {
      stat = statSync(dotGit);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        result = null;
        break;
      }
    }
    if (stat?.isDirectory() && isGitDir(dotGit)) {
      result = { root: current, commonDir: canonicalPath(dotGit) };
      break;
    }
    if (stat?.isFile()) {
      const gitDir = gitDirFromFile(dotGit, current);
      if (gitDir && isGitDir(gitDir)) {
        result = { root: current, commonDir: canonicalPath(commonDirOf(gitDir)) };
        break;
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  gitLocationCache.set(dir, result);
  return result;
}

/** The deepest existing directory at or above `path` (a deleted file's parent may be gone). */
function nearestExistingDirectory(path: string): string {
  let current = path;
  for (;;) {
    try {
      if (statSync(current).isDirectory()) return current;
    } catch {
      // Missing: try the parent.
    }
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

function isWithin(path: string, dir: string): boolean {
  const base = dir.endsWith('/') ? dir : `${dir}/`;
  return path === dir || path.startsWith(base);
}

/** Where a reported edit happened, as sent to track-ide-edit. */
export interface EditScope {
  /** The git worktree root that holds the file. Absent when unknown or not in git. */
  editRoot?: string;
  /**
   * The repository (git common directory) that holds the file: the same for
   * every worktree of one repository, so an edit made in a subagent's worktree
   * still matches a push of the merged result from the main checkout.
   */
  editRepo?: string;
  /** The file is not project work: outside the project's repository, or inside `.git`. */
  outsideProject?: true;
}

/**
 * Where `filePath` lies relative to the project the agent works in.
 *
 * `anchorDir` is the project directory: the host's project root when it has
 * one (Claude Code's CLAUDE_PROJECT_DIR), else the event's cwd. A file is
 * project work when it is in the same git repository as the anchor (any of
 * its worktrees), or, when the anchor is not in git, inside the anchor.
 * Anything that cannot be determined is reported as unknown (no claim), so an
 * unreadable directory never hides an edit.
 */
export function editScope(filePath: string, cwd: string, anchorDir: string = cwd): EditScope {
  if (!filePath) return {};
  const absolute = isAbsolute(filePath) ? filePath : join(cwd, filePath);
  if (/(?:^|\/)\.git(?:\/|$)/.test(absolute)) return { outsideProject: true };
  const file = gitLocation(nearestExistingDirectory(dirname(absolute)));
  const anchor = anchorDir ? gitLocation(anchorDir) : null;
  const editRoot = file && file !== 'none' ? { editRoot: file.root, editRepo: file.commonDir } : {};
  if (file === null || anchor === null) return editRoot;
  if (anchor === 'none') {
    return isWithin(absolute, anchorDir) ? editRoot : { outsideProject: true };
  }
  if (file === 'none' || file.commonDir !== anchor.commonDir) return { outsideProject: true };
  return editRoot;
}

// - Which shell commands hand work off, and what they hand off -
//
// The server gates a handoff (git push, PR, deploy) on uncheckpointed work.
// It used to match handoff words anywhere in the command text and count every
// edit the session had ever reported. One parser, shared by the server and the
// hosts, now says which commands hand work off; the host, which has the
// repository, says what a push carries.

const SHELL_TOOLS = new Set(['bash', 'shell', 'terminal', 'run_terminal_command']);

/** One handoff in a shell command. */
export interface HandoffTarget {
  /** Where it runs: null means the event's cwd. */
  directory: string | null;
  /** For a git push: the revisions whose new commits it sends. Absent for other handoffs. */
  revisions?: string[];
}

/** Here-document bodies are data (a script being written, a commit message), never commands. */
function stripHereDocuments(command: string): string {
  const kept: string[] = [];
  let terminator: { word: string; stripTabs: boolean } | null = null;
  for (const line of command.split('\n')) {
    if (terminator) {
      const candidate = terminator.stripTabs ? line.replace(/^\t+/, '') : line;
      if (candidate.trim() === terminator.word) terminator = null;
      continue;
    }
    kept.push(line);
    const opener = /(?<!<)<<(?!<)(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(line);
    if (opener) terminator = { word: opener[3] ?? '', stripTabs: opener[1] === '-' };
  }
  return kept.join('\n');
}

/** Placeholder delimiters for quoted text: private-use code points, never typed in a command. */
const QUOTE_OPEN = '';
const QUOTE_CLOSE = '';

/**
 * Replace every quoted string with an opaque placeholder so handoff words
 * inside quotes (a grep pattern, a commit message) are never read as commands.
 * The quoted text is kept so a quoted directory or ref can be restored.
 */
function maskQuotes(text: string): { skeleton: string; quoted: string[] } {
  const quoted: string[] = [];
  let skeleton = '';
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === '\\' && i + 1 < text.length) {
      skeleton += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (char === "'" || char === '"') {
      let j = i + 1;
      let body = '';
      while (j < text.length && text[j] !== char) {
        if (char === '"' && text[j] === '\\' && j + 1 < text.length) {
          body += text[j + 1];
          j += 2;
          continue;
        }
        body += text[j];
        j += 1;
      }
      quoted.push(body);
      skeleton += `${QUOTE_OPEN}${quoted.length - 1}${QUOTE_CLOSE}`;
      i = j + 1;
      continue;
    }
    skeleton += char;
    i += 1;
  }
  return { skeleton, quoted };
}

function restoreQuoted(word: string, quoted: string[]): string {
  return word.replace(
    new RegExp(`${QUOTE_OPEN}(\\d+)${QUOTE_CLOSE}`, 'g'),
    (_match, index: string) => quoted[Number(index)] ?? ''
  );
}

/** Command separators; `&` only when it is not part of a redirection (2>&1, &>). */
const SEGMENT_SEPARATOR = /\|\||&&|;|\||\n|[()]|(?<![<>])&(?!>)/;

/** A token that is a redirection (2>&1, >file, >>, <); a bare operator takes the next token. */
const REDIRECTION = /^\d*(?:[<>]|&>)/;
const BARE_REDIRECTION = /^\d*(?:[<>]{1,2}|&>)&?$/;

/** Options of `git push` that take a separate value. */
const PUSH_OPTIONS_WITH_VALUE = new Set([
  '-o',
  '--push-option',
  '--repo',
  '--receive-pack',
  '--exec',
]);

/**
 * The revisions a `git push <args>` sends, or null when it sends no work:
 * only ref deletions (`--delete`, `-d`, `:ref` refspecs) or a dry run.
 */
function pushRevisions(args: string[]): string[] | null {
  const positional: string[] = [];
  const extra: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const arg = args[k] ?? '';
    if (REDIRECTION.test(arg)) {
      if (BARE_REDIRECTION.test(arg)) k += 1;
      continue;
    }
    if (arg === '--delete' || arg === '--dry-run') return null;
    if (/^-[A-Za-z]+$/.test(arg) && /[dn]/.test(arg.slice(1))) return null;
    if (arg === '--all' || arg === '--branches' || arg === '--mirror') extra.push('--branches');
    if (arg === '--tags') extra.push('--tags');
    if (arg.startsWith('-')) {
      if (PUSH_OPTIONS_WITH_VALUE.has(arg)) k += 1;
      continue;
    }
    positional.push(arg);
  }
  const refspecs = positional.slice(1);
  if (refspecs.length > 0 && refspecs.every((refspec) => refspec.startsWith(':'))) return null;
  const revisions: string[] = [];
  for (let k = 0; k < refspecs.length; k++) {
    const refspec = refspecs[k] ?? '';
    if (refspec === 'tag' && refspecs[k + 1]) {
      revisions.push(`refs/tags/${refspecs[k + 1]}`);
      k += 1;
      continue;
    }
    const source = refspec.replace(/^\+/, '').split(':')[0];
    if (source) revisions.push(source);
  }
  if (revisions.length === 0 && extra.length === 0) revisions.push('HEAD');
  return [...revisions, ...extra];
}

/** `git [global options] push <args>`: the push args and any `-C` directory, else null. */
function gitPush(words: string[]): { args: string[]; directory: string | null } | null {
  for (let i = 0; i < words.length; i++) {
    if (words[i] !== 'git' && !/\/git$/.test(words[i] ?? '')) continue;
    let j = i + 1;
    let directory: string | null = null;
    while (j < words.length && (words[j] ?? '').startsWith('-')) {
      const option = words[j];
      if (option === '-C' && j + 1 < words.length) {
        directory = words[j + 1] ?? null;
        j += 2;
        continue;
      }
      if (option === '-c' || /^--(?:git-dir|work-tree|namespace)$/.test(option ?? '')) {
        j += 2;
        continue;
      }
      j += 1;
    }
    if (words[j] === 'push') return { args: words.slice(j + 1), directory };
  }
  return null;
}

const OTHER_HANDOFFS = [
  /\bgh\s+(?:pr\s+(?:create|merge)|release\s+create)\b/,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?deploy\b/,
  /\b(?:vercel|wrangler|serverless|sls|sam|cdk|sst|fly|railway|netlify|dokploy)\s+deploy\b/,
  /\bterraform\s+apply\b/,
  /\bkubectl\s+apply\b/,
];

function joinDirectory(base: string | null, next: string): string {
  if (isAbsolute(next) || base === null) return next;
  return join(base, next);
}

/**
 * The handoffs a shell command performs. Empty when it hands nothing off.
 * Quoted text and here-document bodies are data, not commands; a `git push`
 * that only deletes refs or is a dry run is not a handoff. `cd <dir>` before
 * the handoff, and `git -C <dir>`, move it; a directory that cannot be known
 * from the text (`cd ~`, `cd $X`, `cd -`) falls back to the event's cwd.
 */
export function parseHandoffCommand(toolName: string, command: string): HandoffTarget[] {
  if (!SHELL_TOOLS.has(toolName.trim().toLowerCase())) return [];
  if (!command.trim()) return [];
  const { skeleton, quoted } = maskQuotes(stripHereDocuments(command));
  const targets: HandoffTarget[] = [];
  let directory: string | null = null;
  for (const segment of skeleton.split(SEGMENT_SEPARATOR)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    if (words[0] === 'cd' || words[0] === 'pushd') {
      const target = words[1] === undefined ? undefined : restoreQuoted(words[1], quoted);
      directory =
        target === undefined || target === '-' || target.startsWith('~') || target.includes('$')
          ? null
          : joinDirectory(directory, target);
      continue;
    }
    const push = gitPush(words);
    if (push) {
      const revisions = pushRevisions(push.args.map((arg) => restoreQuoted(arg, quoted)));
      if (revisions) {
        targets.push({
          directory: push.directory
            ? joinDirectory(directory, restoreQuoted(push.directory, quoted))
            : directory,
          revisions,
        });
      }
      continue;
    }
    if (OTHER_HANDOFFS.some((pattern) => pattern.test(segment.toLowerCase()))) {
      targets.push({ directory });
    }
  }
  return targets;
}

/** Most commits and files a push description carries. */
/**
 * Bounds of a push description. Past any of them the description says only
 * the repository, and the server falls back to every uncheckpointed edit in
 * it: a description must never be partial, because a partial one could leave
 * an edited file out and quiet the gate. The server's request schema accepts
 * exactly these bounds, so a description can never fail the whole request.
 */
export const HANDOFF_LIMITS = {
  commits: 200,
  files: 500,
  pathLength: 1024,
  handoffs: 10,
} as const;

/** What one handoff carries, as the host sends it to the server's handoff gate. */
export interface HandoffDescription {
  /** The repository (git common directory) it runs in. Absent when not in git or unknown. */
  repo?: string;
  /**
   * For a git push: the repository-relative paths changed by the commits it
   * sends (those on no remote-tracking ref). Absent when unknown, and for
   * other handoffs (a deploy ships the working tree, not commits).
   */
  files?: string[];
}

/** Marks the start of each commit in the `git log` output below. */
const COMMIT_MARKER = '\u001ecommit';

/**
 * Files changed by commits reachable from `revisions` and on no
 * remote-tracking ref, or undefined when that cannot be said in full: git
 * failed (a revision it does not know, a timeout), or the push is past a
 * bound in HANDOFF_LIMITS.
 */
function pushedFiles(dir: string, revisions: string[]): string[] | undefined {
  const out = runGit(
    dir,
    [
      'log',
      '--no-renames',
      '--name-only',
      // git refuses a raw control character in a format; %x1e is its escape.
      '--format=%x1ecommit',
      '-n',
      String(HANDOFF_LIMITS.commits + 1),
      ...revisions,
      '--not',
      '--remotes',
      '--',
    ],
    GIT_STATUS_TIMEOUT_MS
  );
  if (out === null) return undefined;
  const lines = out.split('\n').filter(Boolean);
  const commits = lines.filter((line) => line === COMMIT_MARKER).length;
  const files = [...new Set(lines.filter((line) => line !== COMMIT_MARKER))];
  if (
    commits > HANDOFF_LIMITS.commits ||
    files.length > HANDOFF_LIMITS.files ||
    files.some((path) => path.length > HANDOFF_LIMITS.pathLength)
  ) {
    return undefined;
  }
  return files;
}

/**
 * Per handoff in a shell command, what it carries: its repository and, for a
 * git push, the files its new commits change. The server gates the handoff
 * only when one of those files was edited by the session (any of its agents)
 * after its last checkpoint. Empty when the command hands nothing off. A
 * description that cannot be complete omits `files`, and the server then
 * gates on every uncheckpointed edit in the repository.
 */
export function describeHandoffs(
  toolName: string,
  command: string,
  cwd: string
): HandoffDescription[] {
  const targets = parseHandoffCommand(toolName, command);
  // More handoffs than the server accepts: describe none, and the server
  // judges each by every uncheckpointed edit.
  if (targets.length > HANDOFF_LIMITS.handoffs) return [];
  return targets.map((target) => {
    const dir = target.directory ? resolve(cwd, target.directory) : cwd;
    const location = gitLocation(dir);
    if (!location || location === 'none') return {};
    const files = target.revisions ? pushedFiles(dir, target.revisions) : undefined;
    return { repo: location.commonDir, ...(files ? { files } : {}) };
  });
}

/** Forget every recorded repository whose directory no longer exists. */
function pruneRemovedRoots(snapshotFile: string): void {
  const snapshot = readSnapshot(snapshotFile);
  if (!snapshot) return;
  const roots = Object.fromEntries(
    Object.entries(snapshot.roots).filter(([root]) => {
      try {
        return statSync(root).isDirectory();
      } catch {
        return false;
      }
    })
  );
  try {
    writeFileWhole(snapshotFile, JSON.stringify({ v: 2, roots } satisfies DirtySnapshot));
  } catch {
    // Best-effort: a stale root only costs a stat on the next event.
  }
}

/**
 * The recorded repository root holding `path` no longer exists: its worktree
 * was removed. A report for such a path is not an edit by this session.
 */
function recordedRootRemoved(snapshot: DirtySnapshot | null, path: string): boolean {
  if (!snapshot) return false;
  const root = rootFor(snapshot, path);
  if (!root) return false;
  try {
    return !statSync(root).isDirectory();
  } catch {
    return true;
  }
}

/** Largest file whose content is hashed for an edit fingerprint, in bytes. */
const EDIT_FINGERPRINT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * The fingerprint a host sends with an edit report: the first 32 hex chars of
 * the sha256 of the file's current content, 'absent' when the file does not
 * exist, undefined when it cannot be read, is not a regular file, or exceeds
 * EDIT_FINGERPRINT_MAX_BYTES (the report then carries none and counts as
 * before).
 *
 * Why: a report the server recorded but answered after the host's budget
 * stays unconfirmed here and the next carrier's diff re-sends it. The server
 * compares the fingerprint with the last one it recorded for the path, so the
 * re-send of unchanged content is not counted as a second edit, while any
 * further edit changes the content and is.
 */
export function editFingerprint(path: string, cwd = ''): string | undefined {
  const absolute = isAbsolute(path) ? path : join(cwd, path);
  try {
    const stat = statSync(absolute);
    if (!stat.isFile() || stat.size > EDIT_FINGERPRINT_MAX_BYTES) return undefined;
    return createHash('sha256').update(readFileSync(absolute)).digest('hex').slice(0, 32);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : undefined;
  }
}

// - Bounded edit-report retry -
//
// An edit report the server did not confirm stays pending so a later event
// can deliver it (CQ-033). Unbounded, that meant every later event re-sent
// every pending path one by one with a 1.5 s timeout each, forever: a hung or
// refusing server stalled each hook by ~1.5 s per pending path, past the
// host's hook timeout (Codex and Grok kill the hook at 5 s; Cursor at 30 s,
// where it also delayed the catastrophic-command deny check), and permanent
// refusals were retried for the life of the session. One policy for every
// host bounds it:
//
// - one call per hook event, inside a total time budget well under the
//   shortest host hook timeout; attempts run a few at a time, each capped by
//   the per-attempt timeout and by what is left of the budget;
// - per path: the first failure retries on the next event, later failures
//   back off exponentially; after EDIT_REPORT_RETRY.maxAttempts attempts, or
//   EDIT_REPORT_RETRY.expiryMs after the first, the path is dropped;
// - a permanent refusal (4xx other than 408/429, or `{ ok: false }`) drops
//   the path at once; an answer marked `retryable: true` is not a refusal:
//   the server could not check the credential (a database blip) or the hook's
//   own credential could not be used this time (fetchWithHookCredential's 503
//   marker), so it retries like any other transient failure; 429 pauses every
//   report until its Retry-After; an event whose every attempt timed out
//   pauses reports briefly (the server hangs);
// - a dropped path joins the dirty snapshot exactly as a confirmed one does,
//   so no later diff re-reports it, and the drop is logged at debug level.
//
// Pending state lives beside the dirty snapshot (`<snapshotFile>.retries`),
// per session. The host's caller runs its safety/deny logic before this.

export const EDIT_REPORT_RETRY = {
  /** Total time one hook event may spend on edit reports. */
  budgetMs: 1_500,
  /** One report's own ceiling (the shared POST_TOOL_TIMEOUT_MS). */
  attemptTimeoutMs: 1_500,
  /** Reports in flight at once. */
  concurrency: 4,
  maxAttempts: 5,
  /** Backoff after the second failure; doubles per failure after that. */
  backoffBaseMs: 5_000,
  backoffMaxMs: 5 * 60_000,
  /** A path pending longer than this since its first attempt is dropped. */
  expiryMs: 30 * 60_000,
  /** Pause after an event in which every attempt timed out. */
  hungServerPauseMs: 15_000,
  rateLimitDefaultMs: 30_000,
  rateLimitMaxMs: 5 * 60_000,
  /** Oldest pending paths beyond this are dropped. */
  maxPending: 200,
} as const;

/**
 * The edit-report budget a hook event can still afford (CQ-033 review). The
 * event's own work runs after its edit reports and the host kills the hook at
 * its installed timeout, so the reports get only what is left of `deadlineMs`
 * (the host timeout less a safety margin, measured from process start) after
 * the time this process has already spent and `reserveMs`, the worst case of
 * the event's own work still to come; capped at EDIT_REPORT_RETRY.budgetMs.
 * Zero means send nothing now: every path stays pending for a later, lighter
 * event. The per-event sums are pinned by tests/HookEventBudgets.test.ts.
 */
export function editReportBudgetMs(
  deadlineMs: number,
  reserveMs: number,
  elapsedMs: number = performance.now()
): number {
  return Math.max(
    0,
    Math.min(EDIT_REPORT_RETRY.budgetMs, Math.floor(deadlineMs - reserveMs - elapsedMs))
  );
}

/** What one edit report achieved, as the sending host classifies it. */
export type EditReportResult =
  | { kind: 'confirmed' }
  | { kind: 'transient'; detail: string; timedOut?: boolean }
  | { kind: 'permanent'; detail: string }
  | { kind: 'rate_limited'; retryAfterMs?: number };

/**
 * Classify an HTTP answer to track-ide-edit. `body` is the parsed JSON, if any.
 * `retryable: true` marks a failure that says nothing lasting (see above); an
 * older server never sends it, so its `{ ok: false }` stays permanent.
 */
export function classifyEditReportResponse(
  status: number,
  body: unknown,
  retryAfter?: string | null
): EditReportResult {
  const retryable = (body as { retryable?: unknown } | null | undefined)?.retryable === true;
  if (status >= 200 && status < 300) {
    const ok = (body as { ok?: unknown } | null | undefined)?.ok;
    if (ok === true) return { kind: 'confirmed' };
    if (ok === false && retryable) return { kind: 'transient', detail: 'ok:false retryable' };
    if (ok === false) return { kind: 'permanent', detail: 'ok:false' };
    return { kind: 'transient', detail: 'unreadable response' };
  }
  if (status === 429) {
    const seconds = retryAfter ? Number(retryAfter) : NaN;
    return {
      kind: 'rate_limited',
      ...(Number.isFinite(seconds) && seconds >= 0 ? { retryAfterMs: seconds * 1000 } : {}),
    };
  }
  if (status >= 400 && status < 500 && status !== 408 && !retryable) {
    return { kind: 'permanent', detail: `HTTP ${status}` };
  }
  return { kind: 'transient', detail: `HTTP ${status}` };
}

interface PendingReport {
  attempts: number;
  firstAt: number;
  nextAt: number;
}

interface RetryState {
  v: 1;
  pending: Record<string, PendingReport>;
  pausedUntil?: number;
}

function retryStateFile(snapshotFile: string): string {
  return `${snapshotFile}.retries`;
}

function readRetryState(snapshotFile: string): RetryState {
  if (!snapshotFile) return { v: 1, pending: {} };
  try {
    const parsed = JSON.parse(readFileSync(retryStateFile(snapshotFile), 'utf8')) as RetryState;
    if (parsed?.v === 1 && typeof parsed.pending === 'object' && parsed.pending !== null) {
      return parsed;
    }
  } catch {
    // Missing or unreadable: start empty.
  }
  return { v: 1, pending: {} };
}

function writeRetryState(snapshotFile: string, retryState: RetryState): void {
  if (!snapshotFile) return;
  try {
    mkdirSync(dirname(snapshotFile), { recursive: true, mode: 0o700 });
    writeFileWhole(retryStateFile(snapshotFile), JSON.stringify(retryState));
  } catch {
    // Best-effort: a lost retryState costs at most one extra attempt per path.
  }
}

/** Paths whose report is pending and due now (retry on any hook event). */
export function pendingEditReports(snapshotFile: string, now = Date.now()): string[] {
  const retryState = readRetryState(snapshotFile);
  if ((retryState.pausedUntil ?? 0) > now) return [];
  return Object.entries(retryState.pending)
    .filter(([, entry]) => entry.nextAt <= now)
    .map(([path]) => path);
}

async function attemptReport(
  path: string,
  send: (path: string, signal: AbortSignal) => Promise<EditReportResult>,
  timeoutMs: number
): Promise<EditReportResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<EditReportResult>((resolveTimeout) => {
    timer = setTimeout(() => {
      controller.abort();
      resolveTimeout({ kind: 'transient', detail: 'timeout', timedOut: true });
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      send(path, controller.signal).catch((error: unknown): EditReportResult => ({
        kind: 'transient',
        detail: error instanceof Error ? error.message : String(error),
        timedOut: controller.signal.aborted,
      })),
      timedOut,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Report edited paths under the bounded retry policy: this event's new paths
 * plus every pending path now due. Call once per hook event (pass `paths: []`
 * to deliver only pending ones). Confirmed and dropped paths join the dirty
 * snapshot; the rest stay pending for a later event.
 */
export async function reportEditsWithinBudget(options: {
  snapshotFile: string;
  paths: readonly string[];
  send: (path: string, signal: AbortSignal) => Promise<EditReportResult>;
  budgetMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}): Promise<{ confirmed: string[]; dropped: string[]; deferred: string[] }> {
  const now = options.now ?? Date.now;
  // Debug level: silent unless MNEMONIK_HOOK_DEBUG is set (hook stderr can
  // reach the host's UI).
  const log =
    options.log ??
    ((message: string) => {
      if (process.env.MNEMONIK_HOOK_DEBUG) process.stderr.write(`${message}\n`);
    });
  const policy = EDIT_REPORT_RETRY;
  const start = now();
  const deadline = start + (options.budgetMs ?? policy.budgetMs);
  const retryState = readRetryState(options.snapshotFile);
  const confirmed: string[] = [];
  const dropped: string[] = [];
  const drop = (path: string, why: string): void => {
    delete retryState.pending[path];
    dropped.push(path);
    log(`mnemonik: edit report for ${path} dropped (${why})`);
  };

  for (const [path, entry] of Object.entries(retryState.pending)) {
    if (start - entry.firstAt > policy.expiryMs) drop(path, 'expired');
  }
  for (const path of options.paths) {
    retryState.pending[path] ??= { attempts: 0, firstAt: start, nextAt: start };
  }
  const snapshot = readSnapshot(options.snapshotFile);
  let rootsRemoved = false;
  for (const path of Object.keys(retryState.pending)) {
    if (!recordedRootRemoved(snapshot, path)) continue;
    delete retryState.pending[path];
    rootsRemoved = true;
    log(`mnemonik: edit report for ${path} dropped (its repository was removed)`);
  }
  if (rootsRemoved) pruneRemovedRoots(options.snapshotFile);
  const due = [...new Set([...options.paths, ...Object.keys(retryState.pending)])].filter(
    (path) => retryState.pending[path] && retryState.pending[path].nextAt <= start
  );

  let queue = (retryState.pausedUntil ?? 0) > start ? [] : due;
  while (queue.length > 0) {
    const remaining = deadline - now();
    if (remaining <= 0) break;
    const wave = queue.slice(0, policy.concurrency);
    queue = queue.slice(policy.concurrency);
    const timeout = Math.min(policy.attemptTimeoutMs, remaining);
    const results = await Promise.all(
      wave.map(async (path) => [path, await attemptReport(path, options.send, timeout)] as const)
    );
    const at = now();
    let rateLimited = false;
    for (const [path, result] of results) {
      const entry = retryState.pending[path];
      if (!entry) continue;
      if (result.kind === 'confirmed') {
        delete retryState.pending[path];
        confirmed.push(path);
      } else if (result.kind === 'permanent') {
        drop(path, result.detail);
      } else if (result.kind === 'rate_limited') {
        rateLimited = true;
        const pause = Math.min(
          result.retryAfterMs ?? policy.rateLimitDefaultMs,
          policy.rateLimitMaxMs
        );
        retryState.pausedUntil = Math.max(retryState.pausedUntil ?? 0, at + pause);
        entry.nextAt = retryState.pausedUntil;
      } else {
        entry.attempts += 1;
        if (entry.attempts >= policy.maxAttempts) {
          drop(path, `${entry.attempts} attempts, last: ${result.detail}`);
        } else {
          entry.nextAt =
            entry.attempts <= 1
              ? at
              : at +
                Math.min(policy.backoffBaseMs * 2 ** (entry.attempts - 2), policy.backoffMaxMs);
        }
      }
    }
    if (rateLimited) break;
    if (results.every(([, result]) => result.kind === 'transient' && result.timedOut)) {
      retryState.pausedUntil = at + policy.hungServerPauseMs;
      break;
    }
  }

  const pendingPaths = Object.keys(retryState.pending);
  if (pendingPaths.length > policy.maxPending) {
    pendingPaths
      .sort((a, b) => (retryState.pending[a]?.firstAt ?? 0) - (retryState.pending[b]?.firstAt ?? 0))
      .slice(0, pendingPaths.length - policy.maxPending)
      .forEach((path) => drop(path, 'too many pending reports'));
  }
  if ((retryState.pausedUntil ?? 0) <= now()) delete retryState.pausedUntil;
  addPathsToGitDirtySnapshot(options.snapshotFile, [...confirmed, ...dropped]);
  writeRetryState(options.snapshotFile, retryState);
  const deferred = Object.keys(retryState.pending);
  return { confirmed, dropped, deferred };
}
