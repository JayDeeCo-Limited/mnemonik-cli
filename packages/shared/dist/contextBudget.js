import { AMBIENT_ITEM_POINTER_SOURCE } from './ambientPointer.js';
export { AMBIENT_ITEM_POINTER_SOURCE } from './ambientPointer.js';
export const REFLEX_NOTE_BUDGET_BYTES = {
    claude_code: 6_000,
    codex: 6_000,
    cursor: 6_000,
    grok: 6_000,
    vscode: 6_000,
};
const JOINER = '\n\n';
const NOT_REACHED_PREFIX = '... not reached: ';
function truncatedMemoryMarker(memoryId) {
    return `... [truncated; memory_get ${memoryId} for the rest]`;
}
function itemMemoryIds(item) {
    if (item.memoryIds && item.memoryIds.length > 0)
        return item.memoryIds;
    return item.memoryId ? [item.memoryId] : [];
}
function retrievalRoutes(item) {
    const memoryIds = itemMemoryIds(item);
    if (memoryIds.length > 0)
        return memoryIds.map((id) => `memory_get ${id}`);
    const route = item.retrievalRoute?.replace(/\s+/g, ' ').trim();
    return route ? [route] : [];
}
function notReachedPointer(items) {
    const routes = [...new Set(items.flatMap(retrievalRoutes))];
    if (routes.length === 0)
        return null;
    return `${NOT_REACHED_PREFIX}${routes.join(', ')}`;
}
function joinSections(sections) {
    return sections
        .filter((section) => section !== null && section.length > 0)
        .join(JOINER);
}
function contextHead(text, budget, units) {
    if (budget <= 0)
        return '';
    const characters = [];
    let used = 0;
    for (const character of text) {
        const size = measureContext(character, units);
        if (used + size > budget)
            break;
        characters.push(character);
        used += size;
    }
    return characters.join('');
}
/** Measure rendered context in the host's native budget unit. */
export function measureContext(text, units = 'characters') {
    return units === 'utf8-bytes' ? Buffer.byteLength(text, 'utf8') : text.length;
}
/**
 * Compose ordered items within a fixed budget. Full items are emitted exactly;
 * the first item that does not fit and every later item are shed. The first
 * shed memory keeps a bounded head plus its retrieval marker; later shed items
 * share one trailing marker containing only their explicit retrieval routes.
 * Items without a route leave no agent-visible stub.
 */
export function fitContextItems(items, opts) {
    const units = opts.units ?? 'characters';
    const suffix = opts.reservedSuffix ?? [];
    const fullValue = [...items, ...suffix].map((item) => item.text).join(JOINER);
    if (measureContext(fullValue, units) <= opts.budget) {
        return {
            value: fullValue,
            fullyDeliveredItems: items.length,
            partialItemIndex: null,
            partialUnitsDelivered: 0,
        };
    }
    const accepted = [];
    for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (item === undefined)
            continue;
        const later = items.slice(index + 1);
        const withFullItem = joinSections([
            ...accepted,
            item.text,
            ...suffix.map((entry) => entry.text),
            notReachedPointer(later),
        ]);
        if (measureContext(withFullItem, units) <= opts.budget) {
            accepted.push(item.text);
            continue;
        }
        if (item.memoryId) {
            const marker = truncatedMemoryMarker(item.memoryId);
            const laterPointer = notReachedPointer(later);
            const markerOnly = joinSections([
                ...accepted,
                marker,
                ...suffix.map((entry) => entry.text),
                laterPointer,
            ]);
            if (measureContext(markerOnly, units) <= opts.budget) {
                const headBudget = opts.budget - measureContext(markerOnly, units) - measureContext('\n', units);
                const head = contextHead(item.text, headBudget, units);
                return {
                    value: head.length > 0
                        ? joinSections([
                            ...accepted,
                            `${head}\n${marker}`,
                            ...suffix.map((entry) => entry.text),
                            laterPointer,
                        ])
                        : markerOnly,
                    fullyDeliveredItems: index,
                    partialItemIndex: index,
                    partialUnitsDelivered: measureContext(head, units),
                };
            }
            const fullItemWithoutPointer = joinSections([
                ...accepted,
                item.text,
                ...suffix.map((entry) => entry.text),
            ]);
            if (measureContext(fullItemWithoutPointer, units) <= opts.budget) {
                return {
                    value: fullItemWithoutPointer,
                    fullyDeliveredItems: index + 1,
                    partialItemIndex: null,
                    partialUnitsDelivered: 0,
                };
            }
        }
        const withoutPointer = joinSections([...accepted, ...suffix.map((entry) => entry.text)]);
        const withPointer = joinSections([
            ...accepted,
            ...suffix.map((entry) => entry.text),
            notReachedPointer(items.slice(index)),
        ]);
        return {
            value: measureContext(withPointer, units) <= opts.budget ? withPointer : withoutPointer,
            fullyDeliveredItems: index,
            partialItemIndex: null,
            partialUnitsDelivered: 0,
        };
    }
    return {
        value: joinSections([...accepted, ...suffix.map((entry) => entry.text)]),
        fullyDeliveredItems: items.length,
        partialItemIndex: null,
        partialUnitsDelivered: 0,
    };
}
function parsePointerItems(body, envelopeName) {
    const regex = new RegExp(AMBIENT_ITEM_POINTER_SOURCE, 'g');
    const memories = [];
    let cursor = 0;
    let match;
    while ((match = regex.exec(body)) !== null) {
        const end = match.index + match[0].length;
        const text = body.slice(cursor, end).trim();
        const memoryId = match[1];
        if (text.length > 0 && memoryId !== undefined) {
            memories.push({ text, name: envelopeName, memoryId });
        }
        cursor = end;
    }
    const trailerText = body.slice(cursor).trim();
    return {
        memories,
        trailer: trailerText ? { text: trailerText, name: `${envelopeName} trailer` } : null,
    };
}
/**
 * Turn one rendered envelope into budget items. Pointer-terminated memories
 * retain their IDs; an unrecognised shape remains one named envelope. Callers
 * may provide response metadata IDs for envelopes (such as JIT) whose visible
 * wire format does not carry trailing memory pointers.
 */
export function contextItemsFromText(text, envelopeName, memoryIds = []) {
    const parsed = parsePointerItems(text, envelopeName);
    if (parsed.memories.length === 0) {
        return [{ text, name: envelopeName, ...(memoryIds.length > 0 ? { memoryIds } : {}) }];
    }
    return [...parsed.memories, ...(parsed.trailer ? [parsed.trailer] : [])];
}
/** Fit one rendered envelope while preserving its exact under-budget bytes. */
export function fitContextText(text, envelopeName, opts) {
    const units = opts.units ?? 'characters';
    if (measureContext(text, units) <= opts.budget)
        return text;
    return fitContextItems(contextItemsFromText(text, envelopeName, opts.memoryIds), opts).value;
}
/** Split an ambient body into whole pointer-terminated items. */
export function splitAmbientItems(body) {
    return parsePointerItems(body, 'ambient recall').memories.map((item) => item.text);
}
//# sourceMappingURL=contextBudget.js.map