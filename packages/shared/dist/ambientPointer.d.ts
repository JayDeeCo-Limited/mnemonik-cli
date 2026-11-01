export declare const AMBIENT_ID_PREFIX_LENGTH = 8;
/**
 * What a recalled memory's line carries when memories learned later relate to
 * it (RETRIEVAL_LAYER §2.0.3): how many, and the closest one's id. It follows
 * the line's own `memory_get <id>` pointer and carries no text from the
 * later memory. The one place the wording lives: the renderer and the pattern
 * that finds (and sheds) it are both built from it. Agent-facing wording; it
 * changes only with the owner's approval.
 */
export declare const RECALL_LATER_MARKER = " \u00B7 you learned {count} related {memories} later; closest: memory_get {laterId}";
/** The marker for one recalled memory: `laterCount` later related memories, `laterId` the closest. */
export declare function renderRecallLaterMarker(laterCount: number, laterId: string): string;
/** Pattern source of one marker, derived from {@link RECALL_LATER_MARKER}; no capture groups. */
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
//# sourceMappingURL=ambientPointer.d.ts.map