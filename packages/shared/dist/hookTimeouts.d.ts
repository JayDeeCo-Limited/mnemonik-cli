/**
 * Hook dispatcher HTTP timeout budgets + AbortSignal helper.
 *
 * Single source of truth for the timeouts used by the three host-side
 * hook dispatcher packages (`@mnemonik/claude-code-hooks`,
 * `@mnemonik/codex-hooks`, `@mnemonik/cursor-hooks`). Before the
 * 2026-05-16 audit Finding #7 cross-cutting cleanup, each package
 * declared its own copy of these constants and a near-identical
 * `withTimeout` helper - coordinating a budget change required three
 * synchronised edits with no enforcement that the values matched.
 *
 * Surface is intentionally minimal: small constants + a single helper
 * function. No fetch wrappers here - request shaping stays per-package
 * because each host expresses its hook payloads differently.
 */
/**
 * Snapshot / file-context / policy-reminder / injections fetch budget. Critical-path.
 *
 * The bootstrap digest is delivered over `injections`, so it rides this 2s
 * budget. That is intentional and sufficient: on a warm cache
 * (HooksDispatcher.buildBootstrapDigestPayload) delivery is a Redis GET plus
 * render; on a cold cache the delivery path awaits buildColdFloorDigest - a
 * parallel Promise.all of cheap DB reads raced under a 1500ms sub-budget -
 * and may return an enriched floor digest. The static `session_bootstrap`
 * directive is the fallback only when the floor is entirely empty (or the
 * floor fetch times out). A full synthesis build is fired in the background
 * (fire-and-forget) and never awaited, so delivery never blocks on LLM work.
 *
 * Invariant: no endpoint on a hook's critical path may await an LLM synthesis
 * call; client timeouts here cover Redis/DB reads and the bounded cold floor.
 */
export declare const FETCH_TIMEOUT_MS = 2000;
/** Telemetry fan-out budget. Drop the metric rather than hold the user. */
export declare const TELEMETRY_TIMEOUT_MS = 500;
/** PostToolUse / track-ide-edit budget. Faster than FETCH because it's fire-and-forget. */
export declare const POST_TOOL_TIMEOUT_MS = 1500;
/**
 * beforeMCPExecution gate budget. This is the ONLY synchronous, user-facing
 * gate - the user waits on it before every MCP tool call - so it fails open
 * faster than the background critical fetch (FETCH_TIMEOUT_MS = 2000). A
 * precheck slower than 1s is not worth blocking the tool call for; on a
 * degraded server we drop the gate rather than stall the user.
 */
export declare const MCP_PRECHECK_TIMEOUT_MS = 1000;
/**
 * PreCompact snapshot POST budget (Claude Code and Cursor; Grok keeps a pinned
 * copy). Independent of FETCH_TIMEOUT_MS: the snapshot is the one hook call
 * whose server work is a write the compaction depends on.
 */
export declare const PRECOMPACT_TIMEOUT_MS = 4000;
/**
 * The timeout each host is installed with for every Mnemonik hook event: the
 * host kills the hook at this. The installers write these values (seconds =
 * value / 1000), so a hook event's worst case is checked against the number
 * the host actually enforces (tests/HookEventBudgets.test.ts).
 */
export declare const HOST_HOOK_TIMEOUT_MS: {
    readonly claude_code: 5000;
    readonly copilot: 5000;
    readonly codex: 5000;
    readonly grok: 5000;
    readonly cursor: 30000;
};
export type HookHost = keyof typeof HOST_HOOK_TIMEOUT_MS;
/**
 * Time every hook event keeps free below its host's timeout: Node start-up,
 * project identity on a healthy git, local file I/O, writing the answer.
 * Reading stdin has its own bound below. An event's summed worst case must
 * fit the rest.
 */
export declare const HOOK_TIMEOUT_MARGIN_MS = 500;
/**
 * The longest a hook waits for its host to finish writing and close stdin
 * (readHookStdin). Hosts write the payload at spawn and close the pipe; one
 * that never closes it would otherwise hold the hook until the host kills it.
 * On expiry the hook works with what arrived, or fails open.
 */
export declare const HOOK_STDIN_TIMEOUT_MS = 500;
/** The latest an event's own work may run to, measured from process start. */
export declare function hookDeadlineMs(host: HookHost): number;
/**
 * Spawn an `AbortController` tied to a timeout. Returns the signal plus a
 * `cleanup` function the caller MUST invoke (in `finally`) to clear the
 * timer when the request finishes naturally - otherwise the timer leaks
 * for the timeout duration.
 *
 * Identical signature to the inlined `withTimeout` that each hook package
 * used before this consolidation; call sites swap their local import for
 * `import { withHookTimeout } from '@mnemonik/shared'` and nothing else
 * changes.
 */
export declare function withHookTimeout(ms: number): {
    signal: AbortSignal;
    cleanup: () => void;
};
/**
 * The main hook call (POST /api/v1/hooks/injections) is hedged: when the first
 * request has not answered by HOOK_HEDGE_SHARE of the budget, a second request
 * starts beside it on a fresh connection, and whichever answers first is used.
 *
 * Why a second request at all: on 24 October 2026 about a third of one
 * machine's hook calls were lost for 50 minutes to a stall between Cloudflare
 * and one load-balancer node. The server had accepted those requests and was
 * waiting for a body that never finished arriving. A second request opens a new
 * connection and normally lands on a healthy path.
 *
 * Why it is a hedge and not a retry: v7.149.0 abandoned the first request at
 * 65% of the budget and then retried. Every hook process opens its own
 * connection (DNS, TCP and TLS from the user's machine to Cloudflare), and the
 * credential is read before the request leaves, so on 25 October that first
 * request had often been on the wire for only a few hundred milliseconds when
 * it was abandoned. Answers that were merely slow were thrown away, half the
 * calls on the owner's machine needed two requests, about 8% lost both, and the
 * load balancer counted each abandoned request as a client close (ELB 460). A
 * hedge never abandons an answer that is on its way: the first request keeps
 * running to the end of the budget.
 *
 * Both requests share one deadline, `budgetMs` from the call, so the budget
 * every hook event is checked against (tests/HookEventBudgets.test.ts) and the
 * host's kill limit do not move. A first request that fails fast (a connection
 * error or a gateway status) starts the second at once instead of at the hedge
 * point.
 *
 * What counts as an answer: any response other than a gateway status (408, 502,
 * 503, 504, Cloudflare's 52x) and other than the server's "the first request is
 * still working" reply (HOOK_REPLAY_HEADER: pending). A 4xx or a 500 is an
 * answer (null to the caller): repeating it would repeat the failure.
 *
 * The server de-duplicates the two requests by HOOK_REQUEST_ID_HEADER
 * (src/server/hookReplay.ts): the second request is handed the first one's
 * answer, or waits for it, and nothing is counted twice. Nothing is queued or
 * stored on the client; a call with no answer by the deadline is dropped.
 */
export declare const HOOK_HEDGE_SHARE = 0.65;
/** Below this much budget left, a second request cannot complete a round trip. */
export declare const HOOK_SECOND_ATTEMPT_MIN_MS = 300;
/** Sent on every request: 1 for the first, 2 for the hedge. */
export declare const HOOK_ATTEMPT_HEADER = "x-mnemonik-hook-attempt";
/**
 * Sent on both requests with the same value. The server keeps the first
 * request's answer for a few seconds under this id and hands it to the second,
 * so an answer decided by one request is delivered through either, and nothing
 * is counted twice (src/server/hookReplay.ts).
 */
export declare const HOOK_REQUEST_ID_HEADER = "x-mnemonik-hook-request-id";
/**
 * Sent on every request: how many milliseconds the caller will still wait. The
 * server fits its own work inside this less the return trip, so it never
 * decides an answer the client will not be there to receive.
 */
export declare const HOOK_BUDGET_HEADER = "x-mnemonik-hook-budget-ms";
/**
 * Sent on every hook request: the hook runtime that sent it and its version,
 * as `<runtime>/<version>` (for example `claude-code/0.9.50`). The server
 * refuses hook runtimes older than a minimum it is configured with and tells
 * the agent how to update (src/server/hookVersionFloor.ts), instead of the
 * old runtime failing open and recall stopping silently.
 */
export declare const HOOK_VERSION_HEADER = "x-mnemonik-hook-version";
/** `init` with the hook-version header added; the caller's headers are kept. */
export declare function withHookVersion<T extends {
    headers?: unknown;
}>(init: T, runtime: string, version: string): T;
/**
 * Sent on every request by a hedging client (hedgedHookRequest). Its budget
 * header is what the whole call still has; clients v7.149 to v7.151 sent the
 * first attempt's own 1.3 s cut-off instead, so a server that sees no marker
 * assumes the whole-call 2 s budget rather than trusting that header.
 */
export declare const HOOK_HEDGED_HEADER = "x-mnemonik-hook-hedged";
/**
 * Sent on the second request only: what had become of the first when the second
 * left. `pending; sent=812` (still waiting, its body finished sending 812 ms
 * earlier), `pending; sent=none` (it had not finished sending, so the client
 * itself was slow), `gateway; sent=<ms>` (the edge answered 502/503/504/52x) or
 * `transport; sent=<ms>` (the connection failed). The server uses it to count
 * requests the network lost on the way in, which is what the edge alarm reads
 * (src/server/hookReplay.ts, hookEdgeMetrics.ts).
 */
export declare const HOOK_FIRST_ATTEMPT_HEADER = "x-mnemonik-hook-first-attempt";
/**
 * Set by the server on a reply that is not an answer: the request found the
 * other request of the same call still working on it and could not wait any
 * longer. The client keeps waiting for the other request.
 */
export declare const HOOK_REPLAY_HEADER = "x-mnemonik-hook-replay";
export declare const HOOK_REPLAY_PENDING = "pending";
export type HookFirstAttemptState = 'pending' | 'gateway' | 'transport';
export interface HookFirstAttempt {
    state: HookFirstAttemptState;
    /** Milliseconds since the first request finished sending its body; null when it had not. */
    sentAgoMs: number | null;
}
export declare function formatHookFirstAttempt(first: HookFirstAttempt): string;
export declare function parseHookFirstAttempt(value: unknown): HookFirstAttempt | null;
/** Statuses that mean the request did not reach, or was not served by, the application. */
export declare function isRetryableHookStatus(status: number): boolean;
/** Timeouts and connection failures. A parse error or a bug in the caller is not transient. */
export declare function isTransientHookFetchError(error: unknown): boolean;
/**
 * Send one hook call as up to two hedged requests inside `budgetMs` (see
 * HOOK_HEDGE_SHARE). `send` performs one request with the headers and signal it
 * is given; `parse` reads an answer. Returns the first answer, null when no
 * request answered in time or the answer was an error status, and rejects only
 * when `send` or `parse` fails in a way that is not a transport failure.
 */
export declare function hedgedHookRequest<T>(budgetMs: number, send: (headers: Record<string, string>, signal: AbortSignal) => Promise<Response>, parse: (response: Response) => Promise<T>, clock?: () => number): Promise<T | null>;
//# sourceMappingURL=hookTimeouts.d.ts.map