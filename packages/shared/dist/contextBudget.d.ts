export { AMBIENT_ITEM_POINTER_SOURCE } from './ambientPointer.js';
export type ContextBudgetUnits = 'characters' | 'utf8-bytes';
export declare const REFLEX_NOTE_BUDGET_BYTES: {
    readonly claude_code: 6000;
    readonly codex: 6000;
    readonly cursor: 6000;
    readonly grok: 6000;
    readonly vscode: 6000;
};
export interface ContextBudgetItem {
    /** Exact text emitted when the item fits in full. */
    text: string;
    /** Stable envelope name used for diagnostics only. Never emitted as a retrieval stub. */
    name: string;
    /** Memory identity when this item is one pointer-terminated memory precis. */
    memoryId?: string;
    /** Memory identities when one rendered envelope represents several memories. */
    memoryIds?: readonly string[];
    /** Exact server-side call that can retrieve this emission after it is shed. */
    retrievalRoute?: string;
}
export type ContextBudgetPiece = string | ContextBudgetItem;
export interface BudgetedContextFit {
    value: string;
    fullyDeliveredItems: number;
    /** Index of the one memory item whose head was delivered, when present. */
    partialItemIndex: number | null;
    /** Units delivered from the partial memory item, excluding its marker. */
    partialUnitsDelivered: number;
}
/** Measure rendered context in the host's native budget unit. */
export declare function measureContext(text: string, units?: ContextBudgetUnits): number;
/**
 * Compose ordered items within a fixed budget. Full items are emitted exactly;
 * the first item that does not fit and every later item are shed. The first
 * shed memory keeps a bounded head plus its retrieval marker; later shed items
 * share one trailing marker containing only their explicit retrieval routes.
 * Items without a route leave no agent-visible stub.
 */
export declare function fitContextItems(items: readonly ContextBudgetItem[], opts: {
    budget: number;
    units?: ContextBudgetUnits;
    reservedSuffix?: readonly ContextBudgetItem[];
}): BudgetedContextFit;
/**
 * Turn one rendered envelope into budget items. Pointer-terminated memories
 * retain their IDs; an unrecognised shape remains one named envelope. Callers
 * may provide response metadata IDs for envelopes (such as JIT) whose visible
 * wire format does not carry trailing memory pointers.
 */
export declare function contextItemsFromText(text: string, envelopeName: string, memoryIds?: readonly string[]): ContextBudgetItem[];
/** Fit one rendered envelope while preserving its exact under-budget bytes. */
export declare function fitContextText(text: string, envelopeName: string, opts: {
    budget: number;
    units?: ContextBudgetUnits;
    memoryIds?: readonly string[];
}): string;
/** Split an ambient body into whole pointer-terminated items. */
export declare function splitAmbientItems(body: string): string[];
//# sourceMappingURL=contextBudget.d.ts.map