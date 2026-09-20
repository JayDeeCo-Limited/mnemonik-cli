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
const urlPattern = /https?:\/\/[^\s]+/gu;
const progressFrames = ['|', '/', '-', '\\'];
function supportsHyperlinks(stream) {
    if (stream.supportsHyperlinks !== undefined)
        return stream.supportsHyperlinks;
    return Boolean(stream.isTTY && process.env.TERM !== 'dumb');
}
function terminalUrl(url, stream) {
    return supportsHyperlinks(stream) ? `\u001b]8;;${url}\u0007${url}\u001b]8;;\u0007` : url;
}
function humanLines(value) {
    urlPattern.lastIndex = 0;
    if (!urlPattern.test(value))
        return [{ text: value }];
    urlPattern.lastIndex = 0;
    const lines = [];
    let offset = 0;
    for (const match of value.matchAll(urlPattern)) {
        const index = match.index;
        const before = value.slice(offset, index).trimEnd();
        if (before)
            lines.push({ text: before });
        const url = match[0];
        lines.push({ text: url, url });
        offset = index + match[0].length;
    }
    const after = value.slice(offset).trimStart();
    if (after)
        lines.push({ text: after });
    return lines.length ? lines : [{ text: value }];
}
export class Output {
    stdout;
    stderr;
    context;
    progress;
    constructor(stdout, stderr = stdout, context = {}) {
        this.stdout = stdout;
        this.stderr = stderr;
        this.context = context;
    }
    setContext(context) {
        this.context = { ...this.context, ...context };
    }
    line(value = '') {
        this.emitHuman(this.stdout, redact(value, this.context));
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
        this.emitHuman(this.stderr, redact(value, this.context));
    }
    json(value) {
        this.stdout.write(`${redactJson(value, this.context)}\n`);
    }
    progressLine(text, animated) {
        if (!animated) {
            this.line(text);
            return { complete: (result) => this.line(result), stop: () => undefined };
        }
        if (this.progress?.timer)
            clearInterval(this.progress.timer);
        const render = () => {
            const progress = this.progress;
            if (!progress)
                return;
            this.stdout.write(`\r\u001b[2K${progressFrames[progress.frame]} ${progress.text}`);
            progress.frame = (progress.frame + 1) % progressFrames.length;
        };
        const timer = setInterval(render, 80);
        timer.unref?.();
        this.progress = { frame: 0, text, timer };
        render();
        const stop = () => {
            if (!this.progress || this.progress.timer !== timer)
                return;
            clearInterval(timer);
            this.progress = undefined;
            this.stdout.write('\r\u001b[2K');
        };
        return {
            complete: (result) => {
                stop();
                this.line(result);
            },
            stop,
        };
    }
    emitHuman(stream, value) {
        const progress = this.progress;
        if (progress)
            this.stdout.write('\r\u001b[2K');
        for (const line of humanLines(value))
            stream.write(`${line.url ? terminalUrl(line.url, stream) : line.text}\n`);
        if (progress) {
            this.stdout.write(`\r\u001b[2K${progressFrames[progress.frame]} ${progress.text}`);
            progress.frame = (progress.frame + 1) % progressFrames.length;
        }
    }
}
//# sourceMappingURL=output.js.map