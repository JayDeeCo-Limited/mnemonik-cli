import diagnosticsChannel from 'node:diagnostics_channel';
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
};
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
export function hookDeadlineMs(host) {
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
export function withHookTimeout(ms) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms);
    return { signal: ac.signal, cleanup: () => clearTimeout(timer) };
}
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
export const HOOK_HEDGE_SHARE = 0.65;
/** Below this much budget left, a second request cannot complete a round trip. */
export const HOOK_SECOND_ATTEMPT_MIN_MS = 300;
/** Sent on every request: 1 for the first, 2 for the hedge. */
export const HOOK_ATTEMPT_HEADER = 'x-mnemonik-hook-attempt';
/**
 * Sent on both requests with the same value. The server keeps the first
 * request's answer for a few seconds under this id and hands it to the second,
 * so an answer decided by one request is delivered through either, and nothing
 * is counted twice (src/server/hookReplay.ts).
 */
export const HOOK_REQUEST_ID_HEADER = 'x-mnemonik-hook-request-id';
/**
 * Sent on every request: how many milliseconds the caller will still wait. The
 * server fits its own work inside this less the return trip, so it never
 * decides an answer the client will not be there to receive.
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
export function withHookVersion(init, runtime, version) {
    const raw = init.headers;
    if (raw && typeof raw === 'object' && !(raw instanceof Headers) && !Array.isArray(raw)) {
        // A plain record is copied with its property descriptors, not its values:
        // the hedged hook client's budget header is a getter read when the
        // request is sent, after the credential is read (hedgedHookRequest).
        const headers = Object.defineProperties({}, Object.getOwnPropertyDescriptors(raw));
        for (const name of Object.keys(headers)) {
            if (name.toLowerCase() === HOOK_VERSION_HEADER)
                delete headers[name];
        }
        headers[HOOK_VERSION_HEADER] = `${runtime}/${version}`;
        return { ...init, headers };
    }
    const headers = new Headers(raw);
    headers.set(HOOK_VERSION_HEADER, `${runtime}/${version}`);
    return { ...init, headers: Object.fromEntries(headers.entries()) };
}
/**
 * Sent on every request by a hedging client (hedgedHookRequest). Its budget
 * header is what the whole call still has; clients v7.149 to v7.151 sent the
 * first attempt's own 1.3 s cut-off instead, so a server that sees no marker
 * assumes the whole-call 2 s budget rather than trusting that header.
 */
export const HOOK_HEDGED_HEADER = 'x-mnemonik-hook-hedged';
/**
 * Sent on the second request only: what had become of the first when the second
 * left. `pending; sent=812` (still waiting, its body finished sending 812 ms
 * earlier), `pending; sent=none` (it had not finished sending, so the client
 * itself was slow), `gateway; sent=<ms>` (the edge answered 502/503/504/52x) or
 * `transport; sent=<ms>` (the connection failed). The server uses it to count
 * requests the network lost on the way in, which is what the edge alarm reads
 * (src/server/hookReplay.ts, hookEdgeMetrics.ts).
 */
export const HOOK_FIRST_ATTEMPT_HEADER = 'x-mnemonik-hook-first-attempt';
/**
 * Set by the server on a reply that is not an answer: the request found the
 * other request of the same call still working on it and could not wait any
 * longer. The client keeps waiting for the other request.
 */
export const HOOK_REPLAY_HEADER = 'x-mnemonik-hook-replay';
export const HOOK_REPLAY_PENDING = 'pending';
export function formatHookFirstAttempt(first) {
    return `${first.state}; sent=${first.sentAgoMs === null ? 'none' : Math.max(0, Math.round(first.sentAgoMs))}`;
}
export function parseHookFirstAttempt(value) {
    if (typeof value !== 'string')
        return null;
    const match = /^(pending|gateway|transport); sent=(none|\d{1,6})$/.exec(value.trim());
    if (!match)
        return null;
    return {
        state: match[1],
        sentAgoMs: match[2] === 'none' ? null : Number(match[2]),
    };
}
/** Statuses that mean the request did not reach, or was not served by, the application. */
export function isRetryableHookStatus(status) {
    return (status === 408 ||
        status === 502 ||
        status === 503 ||
        status === 504 ||
        (status >= 520 && status <= 527) ||
        status === 530);
}
/** Timeouts and connection failures. A parse error or a bug in the caller is not transient. */
export function isTransientHookFetchError(error) {
    if (!(error instanceof Error))
        return false;
    if (error.name === 'AbortError' || error.name === 'TimeoutError')
        return true;
    // undici reports a connection failure as TypeError('fetch failed') and a body
    // cut off mid-transfer as TypeError('terminated'). Any other TypeError is a bug.
    return (error instanceof TypeError &&
        (error.message === 'fetch failed' || error.message === 'terminated'));
}
/**
 * When the first request finished sending its body, read from Node's fetch
 * (undici) diagnostics channels. Matched by the request id header, so other
 * requests the process makes at the same time are ignored. Reports null when
 * the channels are unavailable or the body never finished sending; nothing
 * depends on it except the HOOK_FIRST_ATTEMPT_HEADER the server counts.
 */
function watchFirstRequestSent(requestId, clock) {
    let sentAt = null;
    let request = null;
    const onCreate = (message) => {
        const candidate = message?.request;
        if (request || !candidate)
            return;
        if (String(candidate.headers ?? '').includes(requestId))
            request = candidate;
    };
    const onBodySent = (message) => {
        if (sentAt === null && request && message?.request === request) {
            sentAt = clock();
        }
    };
    try {
        diagnosticsChannel.subscribe('undici:request:create', onCreate);
        diagnosticsChannel.subscribe('undici:request:bodySent', onBodySent);
    }
    catch {
        return { sentAt: () => null, stop: () => undefined };
    }
    return {
        sentAt: () => sentAt,
        stop: () => {
            try {
                diagnosticsChannel.unsubscribe('undici:request:create', onCreate);
                diagnosticsChannel.unsubscribe('undici:request:bodySent', onBodySent);
            }
            catch {
                // Nothing to undo.
            }
        },
    };
}
/**
 * Send one hook call as up to two hedged requests inside `budgetMs` (see
 * HOOK_HEDGE_SHARE). `send` performs one request with the headers and signal it
 * is given; `parse` reads an answer. Returns the first answer, null when no
 * request answered in time or the answer was an error status, and rejects only
 * when `send` or `parse` fails in a way that is not a transport failure.
 */
export function hedgedHookRequest(budgetMs, send, parse, clock = Date.now) {
    const startedAt = clock();
    const deadline = startedAt + budgetMs;
    const requestId = globalThis.crypto.randomUUID();
    const sent = watchFirstRequestSent(requestId, clock);
    const controllers = [];
    return new Promise((resolve, reject) => {
        let settled = false;
        let running = 0;
        let secondStarted = false;
        let firstFailure = null;
        let hedgeTimer;
        const finish = (value, error, winner) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(deadlineTimer);
            clearTimeout(hedgeTimer);
            sent.stop();
            // Cancel whatever is still in flight; the request that answered is done.
            for (const controller of controllers)
                if (controller !== winner)
                    controller.abort();
            if (error !== undefined)
                reject(error);
            else
                resolve(value);
        };
        const deadlineTimer = setTimeout(() => finish(null), budgetMs);
        const startSecond = () => {
            if (settled || secondStarted)
                return secondStarted;
            if (deadline - clock() < HOOK_SECOND_ATTEMPT_MIN_MS)
                return false;
            secondStarted = true;
            clearTimeout(hedgeTimer);
            launch(2);
            return true;
        };
        const launch = (attemptNumber) => {
            const controller = new AbortController();
            controllers.push(controller);
            const now = clock();
            const headers = {
                [HOOK_ATTEMPT_HEADER]: String(attemptNumber),
                [HOOK_REQUEST_ID_HEADER]: requestId,
                [HOOK_HEDGED_HEADER]: '1',
            };
            // Read when the request is actually built (after the credential read or
            // rotation and the conversation lock), not when the attempt starts, so
            // the server's deadline does not include time already spent here.
            Object.defineProperty(headers, HOOK_BUDGET_HEADER, {
                enumerable: true,
                get: () => String(Math.max(0, Math.floor(deadline - clock()))),
            });
            if (attemptNumber === 2) {
                const sentAt = sent.sentAt();
                headers[HOOK_FIRST_ATTEMPT_HEADER] = formatHookFirstAttempt({
                    state: firstFailure ?? 'pending',
                    sentAgoMs: sentAt === null ? null : now - sentAt,
                });
            }
            running += 1;
            void (async () => {
                let outcome;
                try {
                    const response = await send(headers, controller.signal);
                    if (isRetryableHookStatus(response.status))
                        outcome = { final: false, kind: 'gateway' };
                    else if (response.headers.get(HOOK_REPLAY_HEADER) === HOOK_REPLAY_PENDING)
                        outcome = { final: false, kind: 'pending' };
                    else if (!response.ok)
                        outcome = { final: true, value: null };
                    else
                        outcome = { final: true, value: await parse(response) };
                }
                catch (error) {
                    if (!settled && !isTransientHookFetchError(error)) {
                        running -= 1;
                        finish(null, error);
                        return;
                    }
                    outcome = { final: false, kind: 'transport' };
                }
                running -= 1;
                if (settled)
                    return;
                if (outcome.final) {
                    finish(outcome.value, undefined, controller);
                    return;
                }
                // Not an answer. The first request's failure starts the second at once;
                // with no request left running there is no answer to wait for.
                if (attemptNumber === 1) {
                    if (outcome.kind !== 'pending')
                        firstFailure = outcome.kind;
                    startSecond();
                }
                if (running === 0)
                    finish(null);
            })();
        };
        launch(1);
        hedgeTimer = setTimeout(startSecond, Math.floor(budgetMs * HOOK_HEDGE_SHARE));
    });
}
//# sourceMappingURL=hookTimeouts.js.map