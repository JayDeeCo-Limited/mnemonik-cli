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
 * it (RETRIEVAL_LAYER §2.0.3): how many, and a glimpse of the closest one,
 * the same kind every recall line gives of its own memory: how long after the
 * recalled memory it was learned, its opening, and its id. It follows the
 * line's own `memory_get <id>` pointer.
 *
 * The glimpse is what lets an agent decide whether the later memory is worth
 * recalling whole; a bare id gave it nothing to decide by (11 Nov 2026: 6 of
 * 1,771 were opened). `{which}` is "closest", or "next closest" when the
 * closest is already in the same reply. `{gap}` and `{glimpse}` are left out
 * when they are not known, which leaves the marker as it was before the
 * glimpse existed.
 *
 * The one place the wording lives: the renderer and the pattern that finds
 * (and sheds) the marker are both built from these. A hook runtime built
 * before a form existed cannot parse it, so the server writes the glimpse
 * only to a runtime that says it reads it (hookTimeouts.ts HOOK_READS_HEADER).
 * Agent-facing wording; it changes only with the owner's approval.
 */
export const RECALL_LATER_MARKER =
  ' \u00b7 you learned {count} related {memories} later; {which}{gap}: {glimpse}memory_get {laterId}';

/** `{which}`: the later memory named is the closest one. */
export const RECALL_LATER_CLOSEST = 'closest';

/** `{which}`: the closest one is in the same reply, so the next closest is named. */
export const RECALL_LATER_NEXT_CLOSEST = 'next closest';

/** `{gap}`: how long after the recalled memory the later one was learned. */
export const RECALL_LATER_GAP = ', {elapsed} later';

/** `{glimpse}`: the later memory's opening. */
export const RECALL_LATER_GLIMPSE = '\u201c{what}\u201d ';

const GLIMPSE_CLOSE = '\u201d';

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function elapsedUnits(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

/**
 * How long after, in words: a plain duration, so no zone and no calendar
 * words. Null when the later memory was not memorized after the recalled one.
 */
export function renderLaterElapsed(learnedAfterMs: number | null | undefined): string | null {
  if (typeof learnedAfterMs !== 'number' || !Number.isFinite(learnedAfterMs)) return null;
  if (learnedAfterMs <= 0) return null;
  if (learnedAfterMs < 90 * SECOND_MS) return 'moments';
  if (learnedAfterMs < HOUR_MS)
    return elapsedUnits(Math.round(learnedAfterMs / MINUTE_MS), 'minute');
  if (learnedAfterMs < 2 * DAY_MS)
    return elapsedUnits(Math.round(learnedAfterMs / HOUR_MS), 'hour');
  if (learnedAfterMs < 14 * DAY_MS) return elapsedUnits(Math.round(learnedAfterMs / DAY_MS), 'day');
  if (learnedAfterMs < 56 * DAY_MS) {
    return elapsedUnits(Math.round(learnedAfterMs / (7 * DAY_MS)), 'week');
  }
  if (learnedAfterMs < 730 * DAY_MS) {
    return elapsedUnits(Math.round(learnedAfterMs / (30.44 * DAY_MS)), 'month');
  }
  return elapsedUnits(Math.round(learnedAfterMs / (365.25 * DAY_MS)), 'year');
}

/** What a marker says of the later memory beyond its id. */
export interface RecallLaterGlimpse {
  /** The later memory's opening, on one line. */
  what?: string | null;
  /** How long after the recalled memory it was memorized, in milliseconds. */
  learnedAfterMs?: number | null;
  /** The closest later memory is in the same reply; this is the next closest. */
  passedOver?: boolean;
}

/** The opening as the marker can carry it: one line, and never its own closing quote. */
function glimpseText(what: string | null | undefined): string {
  if (typeof what !== 'string') return '';
  return what.replace(/\s+/gu, ' ').replaceAll(GLIMPSE_CLOSE, '"').trim();
}

/**
 * The marker for one recalled memory: `laterCount` later related memories,
 * `laterId` the one named, with what is known of it.
 */
export function renderRecallLaterMarker(
  laterCount: number,
  laterId: string,
  glimpse: RecallLaterGlimpse = {}
): string {
  const elapsed = renderLaterElapsed(glimpse.learnedAfterMs);
  const what = glimpseText(glimpse.what);
  return (
    RECALL_LATER_MARKER.replace('{count}', String(laterCount))
      .replace('{memories}', laterCount === 1 ? 'memory' : 'memories')
      .replace('{which}', glimpse.passedOver ? RECALL_LATER_NEXT_CLOSEST : RECALL_LATER_CLOSEST)
      .replace('{laterId}', laterId)
      .replace('{gap}', () => (elapsed ? RECALL_LATER_GAP.replace('{elapsed}', elapsed) : ''))
      // Last, so nothing in the opening is read as a placeholder.
      .replace('{glimpse}', () => (what ? RECALL_LATER_GLIMPSE.replace('{what}', () => what) : ''))
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Pattern source of one marker, derived from {@link RECALL_LATER_MARKER} and
 * its parts; no capture groups. It finds every form the renderer writes,
 * the one without a gap or a glimpse included.
 */
export const RECALL_LATER_MARKER_SOURCE = escapeRegExp(RECALL_LATER_MARKER)
  .replace(escapeRegExp('{count}'), '\\d+')
  .replace(escapeRegExp('{memories}'), 'memor(?:y|ies)')
  .replace(
    escapeRegExp('{which}'),
    `(?:${escapeRegExp(RECALL_LATER_NEXT_CLOSEST)}|${escapeRegExp(RECALL_LATER_CLOSEST)})`
  )
  .replace(
    escapeRegExp('{gap}'),
    `(?:${escapeRegExp(RECALL_LATER_GAP).replace(escapeRegExp('{elapsed}'), '[a-z0-9 ]{1,24}')})?`
  )
  .replace(
    escapeRegExp('{glimpse}'),
    `(?:${escapeRegExp(RECALL_LATER_GLIMPSE).replace(escapeRegExp('{what}'), `[^${GLIMPSE_CLOSE}\\n]*`)})?`
  )
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

const LATER_ID_AT_END = new RegExp(`(${MEMORY_UUID_SOURCE})$`);
/** A JIT line without a pointer names its memory by the first eight characters of its id. */
const ID_HEAD_LINE = new RegExp(`^\\[([0-9A-Fa-f]{${AMBIENT_ID_PREFIX_LENGTH}})\\] `, 'gm');

/**
 * The same texts without any later-memory marker that names a memory one of
 * them carries. A hook assembles one block from several server replies
 * (ambient recall beside the other recall lines), and only the hook sees the
 * whole block: a marker pointing at a memory a few lines away tells the agent
 * nothing, so it goes. A memory is carried by the line whose own pointer names
 * it, by a JIT line headed with its id, or by being named in `alsoCarried`.
 * A text with no such marker is returned as the same string.
 */
export function withoutMarkersNamingCarried(
  texts: readonly string[],
  alsoCarried: readonly string[] = []
): string[] {
  const marker = new RegExp(RECALL_LATER_MARKER_SOURCE, 'g');
  if (!texts.some((text) => new RegExp(RECALL_LATER_MARKER_SOURCE).test(text))) return [...texts];
  const carried = new Set<string>();
  const heads = new Set<string>();
  const note = (id: string): void => {
    const lower = id.toLowerCase();
    if (lower.length <= AMBIENT_ID_PREFIX_LENGTH) heads.add(lower);
    else carried.add(lower);
  };
  alsoCarried.forEach(note);
  for (const text of texts) {
    // Without its markers, so a later memory's own id is not taken for a line's pointer.
    const plain = stripRecallLaterMarkers(text);
    for (const match of plain.matchAll(ambientItemPointerRegex('g'))) {
      if (match[1]) note(match[1]);
    }
    for (const match of plain.matchAll(ID_HEAD_LINE)) {
      if (match[1]) heads.add(match[1].toLowerCase());
    }
  }
  return texts.map((text) =>
    text.replace(marker, (found: string) => {
      const later = LATER_ID_AT_END.exec(found)?.[1]?.toLowerCase();
      if (!later) return found;
      return carried.has(later) || heads.has(later.slice(0, AMBIENT_ID_PREFIX_LENGTH)) ? '' : found;
    })
  );
}
