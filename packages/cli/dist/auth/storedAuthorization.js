export const object = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
/** A non-empty string after trimming, the test each tool applies to a token field. */
export const present = (value) => typeof value === 'string' && value.trim().length > 0;
/** JSON text as an object, or undefined; the parse error is dropped because it can quote the input. */
export function parseObject(text) {
    try {
        const value = JSON.parse(text);
        return object(value) ? value : undefined;
    }
    catch {
        return undefined;
    }
}
export const unreadable = (reason) => ({
    state: 'unreadable',
    expiresAt: null,
    reason,
});
//# sourceMappingURL=storedAuthorization.js.map