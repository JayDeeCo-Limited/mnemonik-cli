export declare const AMBIENT_ID_PREFIX_LENGTH = 8;
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
export declare const RECALL_LATER_MARKER = " \u00B7 you learned {count} related {memories} later; {which}{gap}: {glimpse}memory_get {laterId}";
/** `{which}`: the later memory named is the closest one. */
export declare const RECALL_LATER_CLOSEST = "closest";
/** `{which}`: the closest one is in the same reply, so the next closest is named. */
export declare const RECALL_LATER_NEXT_CLOSEST = "next closest";
/** `{gap}`: how long after the recalled memory the later one was learned. */
export declare const RECALL_LATER_GAP = ", {elapsed} later";
/** `{glimpse}`: the later memory's opening. */
export declare const RECALL_LATER_GLIMPSE = "\u201C{what}\u201D ";
/**
 * How long after, in words: a plain duration, so no zone and no calendar
 * words. Null when the later memory was not memorized after the recalled one.
 */
export declare function renderLaterElapsed(learnedAfterMs: number | null | undefined): string | null;
/** What a marker says of the later memory beyond its id. */
export interface RecallLaterGlimpse {
    /** The later memory's opening, on one line. */
    what?: string | null;
    /** How long after the recalled memory it was memorized, in milliseconds. */
    learnedAfterMs?: number | null;
    /** The closest later memory is in the same reply; this is the next closest. */
    passedOver?: boolean;
}
/**
 * The marker for one recalled memory: `laterCount` later related memories,
 * `laterId` the one named, with what is known of it.
 */
export declare function renderRecallLaterMarker(laterCount: number, laterId: string, glimpse?: RecallLaterGlimpse): string;
/**
 * Pattern source of one marker, derived from {@link RECALL_LATER_MARKER} and
 * its parts; no capture groups. It finds every form the renderer writes,
 * the one without a gap or a glimpse included.
 */
export declare const RECALL_LATER_MARKER_SOURCE: string;
/** The text without any later-memory marker: what the line was before one was added. */
export declare function stripRecallLaterMarkers(text: string): string;
/**
 * Current full UUID pointers plus cached eight-character pointers from older
 * hooks. A later-memory marker right after the pointer belongs to the same
 * item, so an item split on pointers keeps its marker.
 */
export declare const AMBIENT_ITEM_POINTER_SOURCE: string;
export declare function ambientItemPointerRegex(flags?: string): RegExp;
/**
 * The same texts without any later-memory marker that names a memory one of
 * them carries. A hook assembles one block from several server replies
 * (ambient recall beside the other recall lines), and only the hook sees the
 * whole block: a marker pointing at a memory a few lines away tells the agent
 * nothing, so it goes. A memory is carried by the line whose own pointer names
 * it, by a JIT line headed with its id, or by being named in `alsoCarried`.
 * A text with no such marker is returned as the same string.
 */
export declare function withoutMarkersNamingCarried(texts: readonly string[], alsoCarried?: readonly string[]): string[];
//# sourceMappingURL=ambientPointer.d.ts.map