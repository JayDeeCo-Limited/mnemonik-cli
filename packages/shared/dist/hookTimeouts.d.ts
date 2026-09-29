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
//# sourceMappingURL=hookTimeouts.d.ts.map