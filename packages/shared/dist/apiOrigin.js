/** The existing resource override selects the API origin for local staging rehearsals. */
export function apiOrigin(env = process.env) {
    return new URL(env.MNEMONIK_API_RESOURCE || 'https://api.mnemonik.dev').origin;
}
//# sourceMappingURL=apiOrigin.js.map