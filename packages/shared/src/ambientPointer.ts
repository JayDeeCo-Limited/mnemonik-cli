export const AMBIENT_ID_PREFIX_LENGTH = 8;

const MEMORY_UUID_SOURCE = '[0-9A-Fa-f]{8}-(?:[0-9A-Fa-f]{4}-){3}[0-9A-Fa-f]{12}';
const LEGACY_MEMORY_ID_SOURCE = `[0-9A-Za-z_-]{${AMBIENT_ID_PREFIX_LENGTH}}`;

/**
 * Words the memory-voice wording arm places between the dash and `memory_get`
 * ("to recall it in full:"). Optional, so the production pointer form parses
 * exactly as before.
 */
const FIRST_PERSON_POINTER_LEAD_SOURCE = '(?:to recall it in full:\\s*)?';

/**
 * What a recalled memory's line carries when memories learned later relate to
 * it (RETRIEVAL_LAYER §2.0.3): how many, and the closest one's id. It follows
 * the line's own `memory_get <id>` pointer and carries no text from the
 * later memory. The one place the wording lives: the renderer and the pattern
 * that finds (and sheds) it are both built from it. Agent-facing wording; it
 * changes only with the owner's approval.
 */
export const RECALL_LATER_MARKER =
  ' \u00b7 you learned {count} related {memories} later; closest: memory_get {laterId}';

/** The marker for one recalled memory: `laterCount` later related memories, `laterId` the closest. */
export function renderRecallLaterMarker(laterCount: number, laterId: string): string {
  return RECALL_LATER_MARKER.replace('{count}', String(laterCount))
    .replace('{memories}', laterCount === 1 ? 'memory' : 'memories')
    .replace('{laterId}', laterId);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Pattern source of one marker, derived from {@link RECALL_LATER_MARKER}; no capture groups. */
export const RECALL_LATER_MARKER_SOURCE = escapeRegExp(RECALL_LATER_MARKER)
  .replace(escapeRegExp('{count}'), '\\d+')
  .replace(escapeRegExp('{memories}'), 'memor(?:y|ies)')
  .replace(escapeRegExp('{laterId}'), `${MEMORY_UUID_SOURCE}(?![0-9A-Za-z_-])`);

/** The text without any later-memory marker: what the line was before one was added. */
export function stripRecallLaterMarkers(text: string): string {
  return text.replace(new RegExp(RECALL_LATER_MARKER_SOURCE, 'g'), '');
}

/**
 * Current full UUID pointers plus cached eight-character pointers from older
 * hooks. A later-memory marker right after the pointer belongs to the same
 * item, so an item split on pointers keeps its marker.
 */
export const AMBIENT_ITEM_POINTER_SOURCE =
  `\\u2014\\s*${FIRST_PERSON_POINTER_LEAD_SOURCE}memory_get\\s+(${MEMORY_UUID_SOURCE}|${LEGACY_MEMORY_ID_SOURCE})` +
  `(?![0-9A-Za-z_-])(?:${RECALL_LATER_MARKER_SOURCE})?`;

export function ambientItemPointerRegex(flags = 'g'): RegExp {
  return new RegExp(AMBIENT_ITEM_POINTER_SOURCE, flags);
}
