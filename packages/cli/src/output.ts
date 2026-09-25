import { humanReason } from './humanReason.js';
export interface OutputContext {
  home?: string;
  projectRoot?: string;
}

const digestFields = new Set(['beforeHash', 'afterHash']);
const sha256Digest = /^sha256:[0-9a-f]{64}$/u;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Security boundary for every human and machine-readable CLI emission. */
export function redact(value: unknown, context: OutputContext = {}): string {
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

function restoreDigests(redacted: unknown, source: unknown): void {
  if (!redacted || !source || typeof redacted !== 'object' || typeof source !== 'object') return;
  for (const [key, value] of Object.entries(source)) {
    if (
      digestFields.has(key) &&
      typeof value === 'string' &&
      sha256Digest.test(value) &&
      Object.hasOwn(redacted, key)
    ) {
      (redacted as Record<string, unknown>)[key] = value;
    } else {
      restoreDigests((redacted as Record<string, unknown>)[key], value);
    }
  }
}

function redactJson(value: unknown, context: OutputContext): string {
  const serialized = JSON.stringify(value);
  const source = JSON.parse(serialized) as unknown;
  const redacted = JSON.parse(redact(serialized, context)) as unknown;
  restoreDigests(redacted, source);
  return JSON.stringify(redacted);
}

export interface Writable {
  isTTY?: boolean;
  supportsHyperlinks?: boolean;
  write(chunk: string): unknown;
}

const urlPattern = /https?:\/\/[^\s]+/gu;
const progressFrames = ['|', '/', '-', '\\'] as const;

function supportsHyperlinks(stream: Writable): boolean {
  if (stream.supportsHyperlinks !== undefined) return stream.supportsHyperlinks;
  return Boolean(stream.isTTY && process.env.TERM !== 'dumb');
}

function terminalUrl(url: string, stream: Writable, display = url): string {
  return supportsHyperlinks(stream) ? `\u001b]8;;${url}\u0007${display}\u001b]8;;\u0007` : display;
}

function humanLines(value: string): Array<{ text: string; url?: string }> {
  urlPattern.lastIndex = 0;
  if (!urlPattern.test(value)) return [{ text: value }];
  urlPattern.lastIndex = 0;
  const lines: Array<{ text: string; url?: string }> = [];
  let offset = 0;
  for (const match of value.matchAll(urlPattern)) {
    const index = match.index;
    const prefix = value.slice(offset, index);
    const before = prefix.trimEnd();
    if (before) lines.push({ text: before });
    const url = match[0];
    lines.push({ text: before ? url : `${prefix}${url}`, url });
    offset = index + match[0].length;
  }
  const after = value.slice(offset).trimStart();
  if (after) lines.push({ text: after });
  return lines.length ? lines : [{ text: value }];
}

export class Output {
  private context: OutputContext;
  private installationLayout = false;
  private lastHumanLineBlank = true;
  private headingNext = false;
  private progress?: {
    frame: number;
    text: string;
    timer: ReturnType<typeof setInterval>;
  };

  constructor(
    private readonly stdout: Writable,
    private readonly stderr: Writable = stdout,
    context: OutputContext = {}
  ) {
    this.context = context;
  }

  setContext(context: OutputContext): void {
    this.context = { ...this.context, ...context };
  }

  beginInstallation(): void {
    this.installationLayout = true;
    this.line('Mnemonik');
    this.line();
  }

  installSection(): void {
    if (!this.lastHumanLineBlank) this.line();
  }

  /** A heading that is not a numbered step: flush left, with a blank line above it. */
  heading(value: string): number {
    this.headingNext = true;
    try {
      return this.line(value);
    } finally {
      this.headingNext = false;
    }
  }

  inputPrefix(): void {
    if (this.installationLayout) this.write('  ');
  }

  line(value = ''): number {
    return this.emitHuman(this.stdout, redact(value, this.context));
  }

  write(value: string): void {
    this.stdout.write(redact(value, this.context));
  }

  /** Deliberate local-only identity display; never use for logs, JSON, or errors. */
  signedIn(email: string): void {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw new Error('account_identity_failed');
    this.stdout.write(`Signed in as ${email}\nRun mnemonik logout to switch account.\n`);
  }

  /** The account line of plain `auth status`: the same deliberate display, or nothing. */
  signedInAs(email: string | undefined): void {
    if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email))
      this.stdout.write(`Signed in as ${email}.\n`);
  }

  error(value: unknown, human = true): number {
    const message =
      human && typeof value === 'string' && /^[a-z][a-z0-9_]*$/u.test(value)
        ? humanReason(value)
        : value;
    return this.emitHuman(this.stderr, redact(message, this.context));
  }

  json(value: unknown): void {
    this.stdout.write(`${redactJson(value, this.context)}\n`);
  }

  progressLine(text: string, animated: boolean): { complete(result: string): void; stop(): void } {
    if (!animated) {
      this.line(text);
      return { complete: (result) => this.line(result), stop: () => undefined };
    }
    const indent = this.installationLayout ? '  ' : '';
    if (this.progress?.timer) clearInterval(this.progress.timer);
    const render = () => {
      const progress = this.progress;
      if (!progress) return;
      this.stdout.write(`\r\u001b[2K${indent}${progressFrames[progress.frame]} ${progress.text}`);
      progress.frame = (progress.frame + 1) % progressFrames.length;
    };
    const timer = setInterval(render, 80);
    timer.unref?.();
    this.progress = { frame: 0, text, timer };
    render();
    const stop = () => {
      if (!this.progress || this.progress.timer !== timer) return;
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

  private emitHuman(stream: Writable, value: string): number {
    const progress = this.progress;
    if (progress) this.stdout.write('\r\u001b[2K');
    let count = 0;
    for (const line of humanLines(value)) {
      const heading = this.headingNext || /^Step \d+ of \d+:/u.test(line.text);
      const approvalLink = line.url?.includes('/oauth/device?user_code=') ?? false;
      if (this.installationLayout && heading && !this.lastHumanLineBlank) {
        stream.write('\n');
        this.lastHumanLineBlank = true;
        count++;
      }
      if (approvalLink && !this.lastHumanLineBlank) {
        stream.write('\n');
        this.lastHumanLineBlank = true;
        count++;
      }
      const text = approvalLink
        ? (line.url ?? line.text)
        : this.installationLayout && line.text && line.text !== 'Mnemonik' && !heading
          ? line.text.startsWith('  ')
            ? line.text
            : `  ${line.text}`
          : line.text;
      stream.write(`${line.url ? terminalUrl(line.url, stream, text) : text}\n`);
      this.lastHumanLineBlank = !text;
      count++;
      if (approvalLink) {
        stream.write('\n');
        this.lastHumanLineBlank = true;
        count++;
      }
    }
    if (progress) {
      const indent = this.installationLayout ? '  ' : '';
      this.stdout.write(`\r\u001b[2K${indent}${progressFrames[progress.frame]} ${progress.text}`);
      progress.frame = (progress.frame + 1) % progressFrames.length;
    }
    return count;
  }
}
