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
export declare function editScope(filePath: string, cwd: string, anchorDir?: string): EditScope;
/** One handoff in a shell command. */
export interface HandoffTarget {
    /** Where it runs: null means the event's cwd. */
    directory: string | null;
    /** For a git push: the revisions whose new commits it sends. Absent for other handoffs. */
    revisions?: string[];
}
/**
 * The handoffs a shell command performs. Empty when it hands nothing off.
 * Quoted text and here-document bodies are data, not commands; a `git push`
 * that only deletes refs or is a dry run is not a handoff. `cd <dir>` before
 * the handoff, and `git -C <dir>`, move it; a directory that cannot be known
 * from the text (`cd ~`, `cd $X`, `cd -`) falls back to the event's cwd.
 */
export declare function parseHandoffCommand(toolName: string, command: string): HandoffTarget[];
/** Most commits and files a push description carries. */
/**
 * Bounds of a push description. Past any of them the description says only
 * the repository, and the server falls back to every uncheckpointed edit in
 * it: a description must never be partial, because a partial one could leave
 * an edited file out and quiet the gate. The server's request schema accepts
 * exactly these bounds, so a description can never fail the whole request.
 */
export declare const HANDOFF_LIMITS: {
    readonly commits: 200;
    readonly files: 500;
    readonly pathLength: 1024;
    readonly handoffs: 10;
};
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
/**
 * Per handoff in a shell command, what it carries: its repository and, for a
 * git push, the files its new commits change. The server gates the handoff
 * only when one of those files was edited by the session (any of its agents)
 * after its last checkpoint. Empty when the command hands nothing off. A
 * description that cannot be complete omits `files`, and the server then
 * gates on every uncheckpointed edit in the repository.
 */
export declare function describeHandoffs(toolName: string, command: string, cwd: string): HandoffDescription[];
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