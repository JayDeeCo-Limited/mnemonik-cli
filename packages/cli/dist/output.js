const digestFields = new Set(['beforeHash', 'afterHash']);
const sha256Digest = /^sha256:[0-9a-f]{64}$/u;
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Security boundary for every human and machine-readable CLI emission. */
export function redact(value, context = {}) {
    let text = typeof value === 'string' ? value : JSON.stringify(value);
    text = text
        .replace(/\bBearer\s+[^\s"',}]+/gi, 'Bearer [REDACTED]')
        .replace(/\bmn[ck]_[A-Za-z0-9._~-]+/gi, '[REDACTED]')
        .replace(/\b[a-f0-9]{64}\b/gi, '[REDACTED]')
        .replace(/((?:"?authorization"?\s*[:=]\s*)"?)[^"\r\n,}]*/gi, '$1[REDACTED]')
        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]');
    if (context.home) {
        const home = context.home.replace(/[\\/]+$/, '');
        text = text.replace(new RegExp(`${escapeRegExp(home)}(?=[\\/]|$)`, 'g'), '~');
    }
    return text;
}
function restoreDigests(redacted, source) {
    if (!redacted || !source || typeof redacted !== 'object' || typeof source !== 'object')
        return;
    for (const [key, value] of Object.entries(source)) {
        if (digestFields.has(key) &&
            typeof value === 'string' &&
            sha256Digest.test(value) &&
            Object.hasOwn(redacted, key)) {
            redacted[key] = value;
        }
        else {
            restoreDigests(redacted[key], value);
        }
    }
}
function redactJson(value, context) {
    const serialized = JSON.stringify(value);
    const source = JSON.parse(serialized);
    const redacted = JSON.parse(redact(serialized, context));
    restoreDigests(redacted, source);
    return JSON.stringify(redacted);
}
export class Output {
    stdout;
    stderr;
    context;
    constructor(stdout, stderr = stdout, context = {}) {
        this.stdout = stdout;
        this.stderr = stderr;
        this.context = context;
    }
    setContext(context) {
        this.context = { ...this.context, ...context };
    }
    line(value = '') {
        this.stdout.write(`${redact(value, this.context)}\n`);
    }
    write(value) {
        this.stdout.write(redact(value, this.context));
    }
    /** Deliberate local-only identity display; never use for logs, JSON, or errors. */
    signedIn(email) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email))
            throw new Error('account_identity_failed');
        this.stdout.write(`Signed in as ${email}\nRun mnemonik logout to switch account.\n`);
    }
    error(value) {
        this.stderr.write(`${redact(value, this.context)}\n`);
    }
    json(value) {
        this.stdout.write(`${redactJson(value, this.context)}\n`);
    }
}
//# sourceMappingURL=output.js.map