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
function runGit(cwd, args, timeout) {
    try {
        // --no-optional-locks is a TOP-LEVEL git option: passed after the
        // subcommand git exits 129 and every observation silently reports nothing.
        return execFileSync('git', ['--no-optional-locks', '-C', cwd, ...args], {
            timeout,
            encoding: 'utf8',
            maxBuffer: 8 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
    }
    catch {
        return null;
    }
}
/**
 * The current dirty set as absolute paths, or null when cwd is not inside a
 * git repo, git is unavailable, a bound is exceeded, or the set is too large
 * to be agent work.
 */
export function listGitDirtyPaths(cwd) {
    const rootOut = runGit(cwd, ['rev-parse', '--show-toplevel'], GIT_REV_PARSE_TIMEOUT_MS);
    const root = rootOut?.trim();
    if (!root)
        return null;
    const statusOut = runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], GIT_STATUS_TIMEOUT_MS);
    if (statusOut === null)
        return null;
    const paths = [];
    const tokens = statusOut.split('\0');
    for (let i = 0; i < tokens.length; i++) {
        const entry = tokens[i];
        if (!entry || entry.length < 4)
            continue;
        // "XY <path>"; a rename/copy entry is followed by the ORIGINAL path as its
        // own NUL token - consume it so it is never misread as a status entry.
        const statusCode = entry.slice(0, 2);
        paths.push(join(root, entry.slice(3)));
        if (statusCode.startsWith('R') || statusCode.startsWith('C'))
            i++;
        if (paths.length > MAX_SNAPSHOT_PATHS)
            return null;
    }
    return { root, paths };
}
/** HEAD of the repo at cwd, or undefined before the first commit. */
function currentHead(cwd) {
    return (runGit(cwd, ['rev-parse', '--verify', '-q', 'HEAD'], GIT_REV_PARSE_TIMEOUT_MS)?.trim() ||
        undefined);
}
/**
 * Files changed by the commits made between two heads, or by HEAD alone when
 * there is no earlier head. Empty when any of those commits is a merge: a
 * merge brings in other people's files and none of them is this session's
 * edit. `git commit --amend` orphans the old head, so the range is still the
 * one new commit and the diff is the amended change.
 */
function committedPaths(cwd, root, from, to) {
    const range = from && from !== to ? `${from}..${to}` : to;
    const parents = runGit(cwd, from ? ['log', '--format=%P', range] : ['log', '--format=%P', '-1', to], GIT_STATUS_TIMEOUT_MS);
    if (parents === null)
        return [];
    const lines = parents.split('\n').filter(Boolean);
    if (lines.length === 0 || lines.some((line) => line.includes(' ')))
        return [];
    const names = from
        ? runGit(cwd, ['diff', '--name-only', '-z', from, to], GIT_STATUS_TIMEOUT_MS)
        : runGit(cwd, ['show', '--name-only', '-z', '--format=', to], GIT_STATUS_TIMEOUT_MS);
    if (names === null)
        return [];
    return names
        .split('\0')
        .filter(Boolean)
        .map((name) => join(root, name));
}
function readSnapshot(snapshotFile) {
    try {
        const parsed = JSON.parse(readFileSync(snapshotFile, 'utf8'));
        if (parsed?.v === 1 && typeof parsed.root === 'string' && Array.isArray(parsed.paths)) {
            return { v: 2, roots: { [parsed.root]: { paths: parsed.paths } } };
        }
        if (parsed?.v !== 2 || typeof parsed.roots !== 'object' || parsed.roots === null)
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
/**
 * Persist one root's list into the snapshot, keeping every other root. The
 * whole file stays under MAX_SNAPSHOT_PATHS: when the total would exceed it,
 * only the root being written survives.
 */
function writeRoot(snapshotFile, root, entry) {
    try {
        const roots = { ...(readSnapshot(snapshotFile)?.roots ?? {}), [root]: entry };
        const total = Object.values(roots).reduce((sum, r) => sum + r.paths.length, 0);
        const snapshot = {
            v: 2,
            roots: total > MAX_SNAPSHOT_PATHS ? { [root]: entry } : roots,
        };
        mkdirSync(dirname(snapshotFile), { recursive: true, mode: 0o700 });
        writeFileSync(snapshotFile, JSON.stringify(snapshot), { mode: 0o600 });
    }
    catch {
        // Best-effort: a missing snapshot degrades to "report nothing", never to a
        // wrong report.
    }
}
/** The recorded root whose directory contains this absolute path, if any. */
function rootFor(snapshot, path) {
    return Object.keys(snapshot.roots)
        .filter((root) => path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`))
        .sort((x, y) => y.length - x.length)[0];
}
/** Session start: baseline the dirty set so pre-existing dirt is never reported. */
export function captureGitDirtyBaseline(snapshotFile, cwd) {
    if (!snapshotFile)
        return;
    const current = listGitDirtyPaths(cwd);
    if (!current)
        return;
    writeRoot(snapshotFile, current.root, { paths: current.paths, head: currentHead(cwd) });
}
/**
 * After a shell call: paths newly dirty since the last observation of this
 * repo, plus, when `command` contains `git commit`, the paths that commit
 * changed. Capped. Leaves additions pending until the caller confirms them
 * with addPathsToGitDirtySnapshot. A repo with no baseline yet gets one and
 * reports nothing - degrading toward silence, never toward a false edit.
 */
export function diffGitDirtySnapshot(snapshotFile, cwd, command = '') {
    if (!snapshotFile)
        return [];
    const current = listGitDirtyPaths(cwd);
    if (!current)
        return [];
    const head = currentHead(cwd);
    const baseline = readSnapshot(snapshotFile)?.roots[current.root];
    if (!baseline) {
        writeRoot(snapshotFile, current.root, { paths: current.paths, head });
        return [];
    }
    const known = new Set(baseline.paths);
    const additions = current.paths.filter((path) => !known.has(path));
    if (head && head !== baseline.head && /\bgit\s+commit\b/.test(command)) {
        for (const path of committedPaths(cwd, current.root, baseline.head, head))
            if (!known.has(path) && !additions.includes(path))
                additions.push(path);
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
export function addPathsToGitDirtySnapshot(snapshotFile, paths) {
    if (!snapshotFile || paths.length === 0)
        return;
    const snapshot = readSnapshot(snapshotFile);
    if (!snapshot)
        return;
    for (const path of paths) {
        const root = rootFor(snapshot, path);
        const entry = root ? snapshot.roots[root] : undefined;
        if (!root || !entry || entry.paths.includes(path))
            continue;
        entry.paths = [...entry.paths, path];
        writeRoot(snapshotFile, root, entry);
    }
}
//# sourceMappingURL=gitEditDetector.js.map