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
export const SECRET_REDACTION_PLACEHOLDER = '[REDACTED]';
// Shared by the scanner daemon and server-side scrub paths.
export const SECRET_PATTERNS = [
    /(?:api[_-]?key|secret|token|password|credential|auth)\s*[:=]\s*\S+/gi,
    // Stripe-shape: (sk|pk)_(live|test)_<24+ alphanumerics>. Catches modern
    // Stripe keys whose body is split by an environment separator that
    // breaks the contiguous-alphanum pattern below. Required `live|test`
    // literal prevents false-positives on snake_case identifiers like
    // pkg_install_helper_function_xyz_abc_def.
    /(?:sk|pk)_(?:live|test)_[a-zA-Z0-9]{24,}/g,
    /(?:sk|pk)[-_][a-zA-Z0-9]{20,}/g,
    /ghp_[a-zA-Z0-9]{36}/g,
    /glpat-[a-zA-Z0-9-]{20,}/g,
    // PEM private keys. The BLOCK pattern runs first so header->footer (the
    // actual key material) is redacted as one unit; the header-only pattern
    // stays as the fallback for the case a chunk boundary lands between
    // header and footer, where the block never closes inside the chunk.
    // `[\s\S]*?` is lazy so two adjacent keys don't merge into one match.
    /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
    /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
    // AWS access key IDs. The 16-char body must be uppercase-alphanumeric and
    // \b-delimited, so prose ("AKIAMIA is a place name") cannot match.
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\bASIA[0-9A-Z]{16}\b/g,
    // AWS secret access key, labeled. The generic key=value pattern above does
    // NOT cover this: its `secret` alternative must be followed immediately by
    // `[:=]`, and here it is followed by `_access_key`.
    /\baws_secret_access_key\s*[:=]\s*[A-Za-z0-9/+=]{40}\b/gi,
    // JWT: three base64url segments. Length minimums keep dotted identifiers
    // (`payload.header.signature`) out.
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    /\bAIza[0-9A-Za-z_-]{35}\b/g,
    /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    /\b(?:npm_|npms_)[A-Za-z0-9]{36,}\b/g,
    // scheme://userinfo@: only the credential segment is consumed, so the
    // host and path survive for anyone reading the code. Userinfo may contain
    // empty fields or additional `:` / `@` characters; greediness selects its
    // final `@`, while `/`, `?`, and `#` keep paths and queries out of the match.
    /\b[a-z][a-z0-9+.-]*:\/\/[^/\s?#]*@/gi,
    // Authorization: Bearer <token>. The token class deliberately excludes
    // `<` and `$`, so documentation placeholders (`Bearer <your-api-key>`,
    // `Bearer $MNEMONIK_PROXY_TOKEN`) are left intact - redacting those would
    // destroy the instruction without hiding a secret.
    /Authorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
];
/**
 * Replace recognized secret shapes in `text` with the redaction
 * placeholder. Returns the input unchanged when no patterns match.
 *
 * Idempotent: scrubbing already-scrubbed text returns the same text
 * (the placeholder itself doesn't match any pattern).
 */
/**
 * A key=value match whose value side is a code REFERENCE to an env read
 * (`process.env.X`, `process.env['X']`, `import.meta.env.X`) contains no
 * literal secret - redacting it destroys information (it blinded the
 * doc-truth env_vars authority to every secret-named variable) without
 * protecting anything.
 */
const ENV_READ_VALUE_RE = /[:=]\s*(?:await\s+)?(?:process\.env[.[]|import\.meta\.env[.[])/;
/* ------------------------------------------------------------------ *
 * High-entropy token detector
 *
 * Catches credentials that carry no recognizable provider prefix - the
 * long random blob in `"webhook": "<40 random chars>"`. A naive entropy
 * threshold cannot do this safely: measured over this repository, a
 * camelCase identifier scores 4.49 bits/char against 4.66 for a real AWS
 * secret key, so entropy ALONE separates nothing. The structural guards
 * below carry the discrimination; entropy is only the final filter.
 *
 * Every candidate must clear ALL of:
 *   1. CONTEXT     - sits immediately after `=`/`:` or an opening quote.
 *                    Bare prose positions are never touched, which is what
 *                    keeps the detector out of documentation.
 *   2. LENGTH      - >= 36 characters. The floor started at 32 and was
 *                    raised by the claim-yield guard: 32-char opaque
 *                    RESOURCE IDS (Vercel `dpl_`/`prj_`, Stripe object ids)
 *                    are public identifiers, not credentials, and eating
 *                    them cost 39 real `symbol_reference` claims in
 *                    docs/deployment/LAUNCH_PLAN.md. Genuine credential
 *                    blobs sit at 36+ (GitHub 40, AWS 40, Google 39, a
 *                    base64 32-byte key 44); shorter non-hex randomness is
 *                    almost always an object id, and anything hex is
 *                    already exempt by rule 4.
 *   3. CHARSET MIX - contains lowercase AND uppercase AND a digit.
 *   4. NOT HEX-ISH - hex after stripping `-`/`_` is a digest or UUID
 *                    (commit SHAs, contentHash, snippet_hash, project ids).
 *   5. NOT STRUCTURED - if every `/`, `-`, `_` separated segment is <= 16
 *                    chars the token is a path, slug or SCREAMING_SNAKE
 *                    identifier ("tests/fixtures/docTruth/dogfood-2026-06-06").
 *   6. NOT WORDY   - a lowercase run longer than 5 means natural words
 *                    ("...FromCache..."), not random output.
 *   7. ENTROPY     - Shannon entropy >= 4.0 bits/char.
 *
 * Calibrated by sweeping every file this scanner would chunk across this
 * repository (1426 files): 8 tokens fire, every one of them a credential
 * shape - JWT headers, an AWS example secret key, a leaked Stripe
 * `whsec_`, and this suite's own fixtures. Zero prose, zero paths, zero
 * identifiers, zero resource ids.
 *
 * The bias is deliberately toward MISSING a secret rather than mangling
 * text: provider prefixes above are the primary net, this is the backstop.
 * ------------------------------------------------------------------ */
const ENTROPY_MIN_LENGTH = 36;
const ENTROPY_MIN_BITS_PER_CHAR = 4.0;
const ENTROPY_MAX_STRUCTURED_SEGMENT = 16;
const ENTROPY_MAX_LOWERCASE_RUN = 5;
/**
 * Maximal runs of base64url/base64 characters. `=` is admitted only as
 * trailing padding - allowing it inside the run let a candidate span an
 * assignment (`HARNESS_PROJECT_ID=<uuid>` matched as one token, defeating
 * the UUID exemption).
 */
// Keep the same 36-character floor without an unbounded counted repetition:
// V8 retains backtracking state for {36,} and overflows on a 10 MiB line.
const ENTROPY_CANDIDATE_RE = /[A-Za-z0-9+/_-]{35}[A-Za-z0-9+/_-]+={0,2}/g;
/** Opening quote, or `=`/`:` with optional whitespace and optional quote. */
const ENTROPY_CONTEXT_RE = /(?:["'`]|[:=]\s*["'`]?)$/;
/** `==`, `=>`, `!=`, `<=`, `>=`, `+=` ... are comparisons, not assignments. */
const ENTROPY_OPERATOR_TAIL_RE = /[=!<>+\-*/%&|^]$/;
const ENTROPY_HEXISH_RE = /^[0-9a-fA-F]+$/;
const ENTROPY_STRUCTURED_RE = /^[A-Za-z0-9]+(?:[/_-][A-Za-z0-9]+)+$/;
function shannonEntropy(token) {
    const counts = new Map();
    for (const ch of token)
        counts.set(ch, (counts.get(ch) ?? 0) + 1);
    let bits = 0;
    for (const count of counts.values()) {
        const p = count / token.length;
        bits -= p * Math.log2(p);
    }
    return bits;
}
function maxLowercaseRun(token) {
    let max = 0;
    let current = 0;
    for (const ch of token) {
        if (ch >= 'a' && ch <= 'z') {
            current += 1;
            if (current > max)
                max = current;
        }
        else {
            current = 0;
        }
    }
    return max;
}
/** True when `token` looks like random credential material, not text. */
function isHighEntropySecret(token) {
    if (token.length < ENTROPY_MIN_LENGTH)
        return false;
    const stripped = token.replace(/[-_]/g, '');
    if (stripped.length > 0 && ENTROPY_HEXISH_RE.test(stripped))
        return false; // digests, UUIDs
    if (!/[a-z]/.test(token) || !/[A-Z]/.test(token) || !/[0-9]/.test(token))
        return false;
    if (ENTROPY_STRUCTURED_RE.test(token) &&
        token.split(/[/_-]/).every((seg) => seg.length <= ENTROPY_MAX_STRUCTURED_SEGMENT)) {
        return false; // paths, slugs, snake/kebab identifiers
    }
    if (maxLowercaseRun(token) > ENTROPY_MAX_LOWERCASE_RUN)
        return false; // natural words
    return shannonEntropy(token) >= ENTROPY_MIN_BITS_PER_CHAR;
}
/**
 * Redact standalone high-entropy tokens that no provider pattern claimed.
 * Only the token is replaced - the surrounding key, quote and punctuation
 * survive, so `{"webhook": "<secret>"}` stays valid, readable JSON.
 *
 * Exported for direct testing of the guard behavior; production callers
 * should use `scrubSecrets`, which applies this after the pattern sweep.
 */
export function redactHighEntropyTokens(text) {
    if (!text)
        return text;
    return text.replace(ENTROPY_CANDIDATE_RE, (match, offset) => {
        const before = text.slice(Math.max(0, offset - 8), offset);
        if (!ENTROPY_CONTEXT_RE.test(before))
            return match;
        // Strip the trailing quote (if any) to inspect the operator underneath.
        const operatorContext = before
            .replace(/["'`]$/, '')
            .trimEnd()
            .slice(0, -1);
        if (ENTROPY_OPERATOR_TAIL_RE.test(operatorContext))
            return match;
        if (ENV_READ_VALUE_RE.test(before + match))
            return match;
        return isHighEntropySecret(match) ? SECRET_REDACTION_PLACEHOLDER : match;
    });
}
export function scrubSecrets(text) {
    if (!text)
        return text;
    let result = text;
    for (const pattern of SECRET_PATTERNS) {
        result = result.replace(pattern, (match) => ENV_READ_VALUE_RE.test(match) ? match : SECRET_REDACTION_PLACEHOLDER);
    }
    // Backstop for credentials with no recognizable prefix. Runs last so the
    // precise provider patterns get first claim on their own shapes.
    return redactHighEntropyTokens(result);
}
//# sourceMappingURL=secretPatterns.js.map