export const AMBIENT_ID_PREFIX_LENGTH = 8;
const MEMORY_UUID_SOURCE = '[0-9A-Fa-f]{8}-(?:[0-9A-Fa-f]{4}-){3}[0-9A-Fa-f]{12}';
const LEGACY_MEMORY_ID_SOURCE = `[0-9A-Za-z_-]{${AMBIENT_ID_PREFIX_LENGTH}}`;
/** Current full UUID pointers plus cached eight-character pointers from older hooks. */
export const AMBIENT_ITEM_POINTER_SOURCE = `\\u2014\\s*memory_get\\s+(${MEMORY_UUID_SOURCE}|${LEGACY_MEMORY_ID_SOURCE})` +
    '(?![0-9A-Za-z_-])';
export function ambientItemPointerRegex(flags = 'g') {
    return new RegExp(AMBIENT_ITEM_POINTER_SOURCE, flags);
}
//# sourceMappingURL=ambientPointer.js.map