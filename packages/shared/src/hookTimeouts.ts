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
