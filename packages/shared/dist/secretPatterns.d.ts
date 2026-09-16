/**
 * Single source of truth for secret-redaction patterns.
 *
 * Used by:
 * - packages/shared CodeScanner - scrubs chunk content before computing
 *   contentHash, so daemon ships scrubbed content (correct hash for
 *   server-side cache dedup).
 * - server /api/v1/scan/push handler - re-applies scrub as defense in
 *   depth (idempotent - already-scrubbed content stays the same), so
 *   older daemons or compromised daemons can't leak secrets through us.
 * - server GitMiner - scrubs commit messages before storing as memories.
 *
 * Patterns target high-confidence credential shapes:
 *   1. key=value style: api_key, secret, token, password, credential, auth
 *   2. Stripe-style sk_live_/pk_test_ keys
 *   3. GitHub personal access tokens (ghp_ prefix, exact 36 chars)
 *   4. GitLab personal access tokens (glpat- prefix, 20+ chars)
 *   5. PEM private keys - whole block, header through footer
 *   6. Provider prefixes: AWS (AKIA/ASIA + labeled secret key), JWT,
 *      Slack (xox*), Google (AIza), Anthropic (sk-ant-), npm (npm_/npms_)
 *   7. Credentials inside scheme://user:pass@host connection strings
 *   8. Authorization: Bearer headers
 *   9. Standalone high-entropy tokens matching no known prefix
 *      (`redactHighEntropyTokens` - heavily guarded, see below)
 *
 * False-positive cost: a few legitimate strings get replaced with the
 * placeholder. False-negative cost: a credential ships to the server and
 * gets stored in a memory. The patterns are deliberately tight (require
 * specific prefixes, length minimums) to keep the false-positive rate low
 * while catching the common credential leak vectors.
 *
 * FIDELITY IS A PEER CONCERN, NOT A ROUNDING ERROR. Over-scrubbing is the
 * same class of failure as under-scrubbing: a pattern that eats prose,
 * identifiers, hashes or paths silently blinds doc-truth's authority
 * extractors - exactly what happened when a `process.env.X` read was
 * redacted as if it were a literal (see ENV_READ_VALUE_RE below). Every
 * pattern here carries positive AND negative tests in
 * tests/SecretPatterns.test.ts, and the entropy detector is also
 * guarded against hashes, UUIDs, paths, slugs and identifiers.
 */
export declare const SECRET_REDACTION_PLACEHOLDER = "[REDACTED]";
export declare const SECRET_PATTERNS: ReadonlyArray<RegExp>;
/**
 * Redact standalone high-entropy tokens that no provider pattern claimed.
 * Only the token is replaced - the surrounding key, quote and punctuation
 * survive, so `{"webhook": "<secret>"}` stays valid, readable JSON.
 *
 * Exported for direct testing of the guard behavior; production callers
 * should use `scrubSecrets`, which applies this after the pattern sweep.
 */
export declare function redactHighEntropyTokens(text: string): string;
export declare function scrubSecrets(text: string): string;
//# sourceMappingURL=secretPatterns.d.ts.map