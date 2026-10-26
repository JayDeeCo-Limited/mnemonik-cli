/**
 * Gate telemetry rides the next injections request instead of its own.
 *
 * Why: every PreToolUse a hook gated used to end with an awaited POST
 * /api/v1/hooks/gate-fired, a whole extra round trip (about 220 ms from New
 * Zealand to us-east-1) after the decision was already made, because the host
 * waits for the hook process to exit. Measured on 26 October 2026 it was about
 * 30% of a PreToolUse hook's process time on an idle machine, and one in three
 * hook requests the server received. The event is telemetry: who gated what,
 * how, and the action observation for credit capture. Nothing on the agent's
 * path waits for it.
 *
 * So the hook writes the event to a small per-session folder (synchronous, no
 * network) and the next injections request of the same session claims the
 * events and carries them as `gateEvents`; the server records them exactly as
 * the gate-fired route does. A request that gets no answer puts its events
 * back for the next one; each event carries an id the server records once, so
 * a request that was recorded but whose answer was lost does not count twice.
 * Events still queued when a session goes idle for GATE_OUTBOX_MAX_AGE_MS are
 * dropped, and the folder holds at most GATE_OUTBOX_CAP events (the oldest
 * go first), so a server that stays unreachable cannot grow it without
 * bound. Temporary and claimed files a killed hook process left behind are
 * swept after GATE_OUTBOX_STRAY_MS. Never throws.
 *
 * One file per event, written to a temporary name and renamed into the folder,
 * and claimed by renaming it again: a reader never sees half an event, two
 * hook processes never claim the same one, and a writer racing a reader never
 * loses its event.
 */
/** The per-session folder name (pass it to the host's session state path helper). */
export declare const GATE_OUTBOX_FILE = "gate-outbox";
/** The most events one request carries; the server accepts the same. */
export declare const GATE_OUTBOX_MAX_EVENTS = 32;
/** Events older than this are dropped rather than reported: the session went idle. */
export declare const GATE_OUTBOX_MAX_AGE_MS: number;
/** The most events the folder holds; past it the oldest are dropped. */
export declare const GATE_OUTBOX_CAP = 500;
/**
 * A temporary or claimed file older than this belongs to a hook process that
 * was killed between two renames (a live one holds it for milliseconds).
 */
export declare const GATE_OUTBOX_STRAY_MS: number;
export interface QueuedGateEvent {
    /** Unique per event; the server records each id once. */
    id: string;
    tool: string;
    mode: string;
    outcome: string;
    /** Epoch ms when the gate fired; the server stores it as the event's time. */
    at: number;
    host?: string;
    cwd?: string;
    projectId?: string;
    projectRoot?: string;
    actionObservation?: unknown;
}
export declare function queueGateEvent(folder: string, event: Omit<QueuedGateEvent, 'id'>): boolean;
/**
 * Claim every queued event of this session, oldest first, at most
 * GATE_OUTBOX_MAX_EVENTS (the rest wait for the next request).
 */
export declare function takeGateEvents(folder: string, now?: number): QueuedGateEvent[];
/** Put back events a request could not deliver, so the next request carries them. */
export declare function returnGateEvents(folder: string, events: readonly QueuedGateEvent[]): void;
//# sourceMappingURL=gateOutbox.d.ts.map