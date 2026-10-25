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
export const FETCH_TIMEOUT_MS = 2000;

/** Telemetry fan-out budget. Drop the metric rather than hold the user. */
export const TELEMETRY_TIMEOUT_MS = 500;

/** PostToolUse / track-ide-edit budget. Faster than FETCH because it's fire-and-forget. */
export const POST_TOOL_TIMEOUT_MS = 1500;

/**
 * beforeMCPExecution gate budget. This is the ONLY synchronous, user-facing
 * gate - the user waits on it before every MCP tool call - so it fails open
 * faster than the background critical fetch (FETCH_TIMEOUT_MS = 2000). A
 * precheck slower than 1s is not worth blocking the tool call for; on a
 * degraded server we drop the gate rather than stall the user.
 */
export const MCP_PRECHECK_TIMEOUT_MS = 1000;

/**
 * PreCompact snapshot POST budget (Claude Code and Cursor; Grok keeps a pinned
 * copy). Independent of FETCH_TIMEOUT_MS: the snapshot is the one hook call
 * whose server work is a write the compaction depends on.
 */
export const PRECOMPACT_TIMEOUT_MS = 4000;

/**
 * The timeout each host is installed with for every Mnemonik hook event: the
 * host kills the hook at this. The installers write these values (seconds =
 * value / 1000), so a hook event's worst case is checked against the number
 * the host actually enforces (tests/HookEventBudgets.test.ts).
 */
export const HOST_HOOK_TIMEOUT_MS = {
  claude_code: 5000,
  copilot: 5000,
  codex: 5000,
  grok: 5000,
  cursor: 30_000,
} as const;
export type HookHost = keyof typeof HOST_HOOK_TIMEOUT_MS;

/**
 * Time every hook event keeps free below its host's timeout: Node start-up,
 * project identity on a healthy git, local file I/O, writing the answer.
 * Reading stdin has its own bound below. An event's summed worst case must
 * fit the rest.
 */
export const HOOK_TIMEOUT_MARGIN_MS = 500;

/**
 * The longest a hook waits for its host to finish writing and close stdin
 * (readHookStdin). Hosts write the payload at spawn and close the pipe; one
 * that never closes it would otherwise hold the hook until the host kills it.
 * On expiry the hook works with what arrived, or fails open.
 */
export const HOOK_STDIN_TIMEOUT_MS = 500;

/** The latest an event's own work may run to, measured from process start. */
export function hookDeadlineMs(host: HookHost): number {
  return HOST_HOOK_TIMEOUT_MS[host] - HOOK_TIMEOUT_MARGIN_MS - HOOK_STDIN_TIMEOUT_MS;
}

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
export function withHookTimeout(ms: number): { signal: AbortSignal; cleanup: () => void } {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, cleanup: () => clearTimeout(timer) };
}

/**
 * One second attempt on the main hook call (POST /api/v1/hooks/injections).
 *
 * Why it exists: on 24 October 2026 about a third of one machine's hook calls
 * were lost for 50 minutes to a stall between Cloudflare and one load-balancer
 * node. The server had accepted those requests and was waiting for a body that
 * never finished arriving. A second request opens a new connection and
 * normally lands on a healthy path. The call is idempotent by design (the
 * injection bus dedups on the server), so repeating it is safe.
 *
 * Shape: the whole call, both attempts included, still ends inside `budgetMs`,
 * so the budget every hook event is checked against (tests/HookEventBudgets
 * .test.ts) and the host's kill limit do not move. The first attempt gets
 * HOOK_FIRST_ATTEMPT_SHARE of the budget; the second gets whatever is left.
 * A first attempt that fails fast leaves the second nearly the whole budget.
 *
 * What is retried: a timeout, a connection error, and the gateway statuses
 * that mean the request never reached the application (408, 502, 503, 504 and
 * Cloudflare's 52x). Nothing else is: a 4xx or a 500 repeats exactly, and a
 * response that arrives is final.
 *
 * Nothing is queued or stored on the client. A call that fails twice is dropped,
 * as before. The server keeps an answer for 15 s so the second attempt can have
 * it when the first attempt gave up on an answer that was already decided.
 */
export const HOOK_FIRST_ATTEMPT_SHARE = 0.65;

/** Below this much budget left, a second attempt cannot complete a round trip. */
export const HOOK_SECOND_ATTEMPT_MIN_MS = 300;

/** Sent on every attempt so the server can count how many calls needed a second one. */
export const HOOK_ATTEMPT_HEADER = 'x-mnemonik-hook-attempt';

/**
 * Sent on both attempts with the same value. The server keeps the first
 * attempt's answer for a few seconds under this id and hands it to the second
 * attempt, so an answer decided after the first attempt gave up is delivered
 * rather than lost, and nothing is counted twice (src/server/hookReplay.ts).
 */
export const HOOK_REQUEST_ID_HEADER = 'x-mnemonik-hook-request-id';

/**
 * Sent on every attempt: how many milliseconds this attempt may still take.
 * The server never waits for a first attempt's answer longer than this less a
 * margin for the return trip, so it does not hold a request for a client that
 * has already given up.
 */
export const HOOK_BUDGET_HEADER = 'x-mnemonik-hook-budget-ms';

/**
 * Sent on every hook request: the hook runtime that sent it and its version,
 * as `<runtime>/<version>` (for example `claude-code/0.9.50`). The server
 * refuses hook runtimes older than a minimum it is configured with and tells
 * the agent how to update (src/server/hookVersionFloor.ts), instead of the
 * old runtime failing open and recall stopping silently.
 */
export const HOOK_VERSION_HEADER = 'x-mnemonik-hook-version';

/** `init` with the hook-version header added; the caller's headers are kept. */
export function withHookVersion<T extends { headers?: unknown }>(
  init: T,
  runtime: string,
  version: string
): T {
  const headers = new Headers(init.headers as ConstructorParameters<typeof Headers>[0]);
  headers.set(HOOK_VERSION_HEADER, `${runtime}/${version}`);
  return { ...init, headers: Object.fromEntries(headers.entries()) };
}

/** Statuses that mean the request did not reach, or was not served by, the application. */
export function isRetryableHookStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    (status >= 520 && status <= 527) ||
    status === 530
  );
}

/** Timeouts and connection failures. A parse error or a bug in the caller is not transient. */
export function isTransientHookFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
  // undici reports a connection failure as TypeError('fetch failed') and a body
  // cut off mid-transfer as TypeError('terminated'). Any other TypeError is a bug.
  return (
    error instanceof TypeError &&
    (error.message === 'fetch failed' || error.message === 'terminated')
  );
}

export type HookAttemptResult<T> = { done: true; value: T } | { done: false };

/**
 * Run `attempt` and, when it ends in a transient failure, run it once more
 * inside the rest of `budgetMs`. Returns the value of the attempt that
 * finished, or null when neither did. `attempt` returns `{ done: false }` for
 * a retryable response and throws for a transport failure; anything else it
 * returns is final.
 */
export async function withSecondAttempt<T>(
  budgetMs: number,
  attempt: (
    signal: AbortSignal,
    attemptNumber: 1 | 2,
    requestId: string,
    budgetMs: number
  ) => Promise<HookAttemptResult<T>>,
  clock: () => number = Date.now
): Promise<T | null> {
  const startedAt = clock();
  const requestId = globalThis.crypto.randomUUID();
  const run = async (attemptNumber: 1 | 2, timeoutMs: number): Promise<HookAttemptResult<T>> => {
    const { signal, cleanup } = withHookTimeout(timeoutMs);
    try {
      return await attempt(signal, attemptNumber, requestId, timeoutMs);
    } catch (error) {
      if (!isTransientHookFetchError(error)) throw error;
      return { done: false };
    } finally {
      cleanup();
    }
  };

  const first = await run(1, Math.floor(budgetMs * HOOK_FIRST_ATTEMPT_SHARE));
  if (first.done) return first.value;

  const remainingMs = budgetMs - (clock() - startedAt);
  if (remainingMs < HOOK_SECOND_ATTEMPT_MIN_MS) return null;
  const second = await run(2, Math.floor(remainingMs));
  return second.done ? second.value : null;
}
