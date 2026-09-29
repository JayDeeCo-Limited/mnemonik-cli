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
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
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
    paths.push(join(root, entry.slice(3)));
    if (statusCode.startsWith('R') || statusCode.startsWith('C')) i++;
    if (paths.length > MAX_SNAPSHOT_PATHS) return null;
  }
  return { root, paths };
}

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
