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
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, } from 'node:fs';
import { join } from 'node:path';
/** The per-session folder name (pass it to the host's session state path helper). */
export const GATE_OUTBOX_FILE = 'gate-outbox';
/** The most events one request carries; the server accepts the same. */
export const GATE_OUTBOX_MAX_EVENTS = 32;
/** Events older than this are dropped rather than reported: the session went idle. */
export const GATE_OUTBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** The most events the folder holds; past it the oldest are dropped. */
export const GATE_OUTBOX_CAP = 500;
/**
 * A temporary or claimed file older than this belongs to a hook process that
 * was killed between two renames (a live one holds it for milliseconds).
 */
export const GATE_OUTBOX_STRAY_MS = 10 * 60 * 1000;
function write(folder, event) {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const name = `${String(event.at).padStart(15, '0')}-${event.id}.json`;
    const temporary = join(folder, `.${name}.tmp`);
    writeFileSync(temporary, JSON.stringify(event), { mode: 0o600 });
    renameSync(temporary, join(folder, name));
}
const unlinkQuietly = (path) => {
    try {
        unlinkSync(path);
    }
    catch {
        // Already gone.
    }
};
/** Event file names, oldest first (names start with the zero-padded time). */
function queuedNames(folder) {
    return readdirSync(folder)
        .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
        .sort();
}
/** Drop the oldest events past GATE_OUTBOX_CAP. */
function enforceCap(folder) {
    try {
        const names = queuedNames(folder);
        for (const name of names.slice(0, Math.max(0, names.length - GATE_OUTBOX_CAP)))
            unlinkQuietly(join(folder, name));
    }
    catch {
        // Telemetry.
    }
}
export function queueGateEvent(folder, event) {
    try {
        write(folder, { ...event, id: randomUUID() });
        enforceCap(folder);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Claim every queued event of this session, oldest first, at most
 * GATE_OUTBOX_MAX_EVENTS (the rest wait for the next request).
 */
export function takeGateEvents(folder, now = Date.now()) {
    let entries;
    try {
        entries = readdirSync(folder);
    }
    catch {
        return [];
    }
    // Sweep what killed hook processes left between renames.
    for (const name of entries) {
        if (!name.startsWith('.') || !(name.endsWith('.tmp') || name.endsWith('.claimed')))
            continue;
        const path = join(folder, name);
        try {
            if (now - statSync(path).mtimeMs > GATE_OUTBOX_STRAY_MS)
                unlinkQuietly(path);
        }
        catch {
            // Gone meanwhile.
        }
    }
    const names = entries.filter((name) => name.endsWith('.json') && !name.startsWith('.')).sort();
    const events = [];
    for (const name of names) {
        if (events.length >= GATE_OUTBOX_MAX_EVENTS)
            break;
        const claimed = join(folder, `.${name}.${process.pid}.claimed`);
        try {
            renameSync(join(folder, name), claimed);
        }
        catch {
            continue; // Another hook process of this session took it.
        }
        try {
            const event = JSON.parse(readFileSync(claimed, 'utf8'));
            if (typeof event?.id === 'string' &&
                typeof event.tool === 'string' &&
                typeof event.mode === 'string' &&
                typeof event.outcome === 'string' &&
                typeof event.at === 'number' &&
                now - event.at <= GATE_OUTBOX_MAX_AGE_MS)
                events.push(event);
        }
        catch {
            // Unreadable; dropped.
        }
        finally {
            unlinkQuietly(claimed);
        }
    }
    return events;
}
/** Put back events a request could not deliver, so the next request carries them. */
export function returnGateEvents(folder, events) {
    for (const event of events) {
        try {
            write(folder, event);
        }
        catch {
            // Lost; telemetry.
        }
    }
    enforceCap(folder);
}
//# sourceMappingURL=gateOutbox.js.map