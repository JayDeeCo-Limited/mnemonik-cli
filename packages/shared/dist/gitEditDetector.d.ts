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
/**
 * The current dirty set as absolute paths, or null when cwd is not inside a
 * git repo, git is unavailable, a bound is exceeded, or the set is too large
 * to be agent work.
 */
export declare function listGitDirtyPaths(cwd: string): {
    root: string;
    paths: string[];
} | null;
/** Session start: baseline the dirty set so pre-existing dirt is never reported. */
export declare function captureGitDirtyBaseline(snapshotFile: string, cwd: string): void;
/**
 * After a shell call: paths newly dirty since the last observation of this
 * repo, plus, when `command` contains `git commit`, the paths that commit
 * changed. Capped. Leaves additions pending until the caller confirms them
 * with addPathsToGitDirtySnapshot. A repo with no baseline yet gets one and
 * reports nothing - degrading toward silence, never toward a false edit.
 */
export declare function diffGitDirtySnapshot(snapshotFile: string, cwd: string, command?: string): string[];
/**
 * After an edit tool: fold tool-reported edits into the snapshot so the next
 * shell diff does not re-credit them. Only when a baseline exists for the
 * repo that holds the path - seeding a partial snapshot would make later diffs
 * report pre-existing dirt.
 */
export declare function addPathsToGitDirtySnapshot(snapshotFile: string, paths: string[]): void;
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
export declare function editFingerprint(path: string, cwd?: string): string | undefined;
export declare const EDIT_REPORT_RETRY: {
    /** Total time one hook event may spend on edit reports. */
    readonly budgetMs: 1500;
    /** One report's own ceiling (the shared POST_TOOL_TIMEOUT_MS). */
    readonly attemptTimeoutMs: 1500;
    /** Reports in flight at once. */
    readonly concurrency: 4;
    readonly maxAttempts: 5;
    /** Backoff after the second failure; doubles per failure after that. */
    readonly backoffBaseMs: 5000;
    readonly backoffMaxMs: number;
    /** A path pending longer than this since its first attempt is dropped. */
    readonly expiryMs: number;
    /** Pause after an event in which every attempt timed out. */
    readonly hungServerPauseMs: 15000;
    readonly rateLimitDefaultMs: 30000;
    readonly rateLimitMaxMs: number;
    /** Oldest pending paths beyond this are dropped. */
    readonly maxPending: 200;
};
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
export declare function editReportBudgetMs(deadlineMs: number, reserveMs: number, elapsedMs?: number): number;
/** What one edit report achieved, as the sending host classifies it. */
export type EditReportResult = {
    kind: 'confirmed';
} | {
    kind: 'transient';
    detail: string;
    timedOut?: boolean;
} | {
    kind: 'permanent';
    detail: string;
} | {
    kind: 'rate_limited';
    retryAfterMs?: number;
};
/**
 * Classify an HTTP answer to track-ide-edit. `body` is the parsed JSON, if any.
 * `retryable: true` marks a failure that says nothing lasting (see above); an
 * older server never sends it, so its `{ ok: false }` stays permanent.
 */
export declare function classifyEditReportResponse(status: number, body: unknown, retryAfter?: string | null): EditReportResult;
/** Paths whose report is pending and due now (retry on any hook event). */
export declare function pendingEditReports(snapshotFile: string, now?: number): string[];
/**
 * Report edited paths under the bounded retry policy: this event's new paths
 * plus every pending path now due. Call once per hook event (pass `paths: []`
 * to deliver only pending ones). Confirmed and dropped paths join the dirty
 * snapshot; the rest stay pending for a later event.
 */
export declare function reportEditsWithinBudget(options: {
    snapshotFile: string;
    paths: readonly string[];
    send: (path: string, signal: AbortSignal) => Promise<EditReportResult>;
    budgetMs?: number;
    now?: () => number;
    log?: (message: string) => void;
}): Promise<{
    confirmed: string[];
    dropped: string[];
    deferred: string[];
}>;
//# sourceMappingURL=gitEditDetector.d.ts.map