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
  write(chunk: string): unknown;
}

export class Output {
  private context: OutputContext;

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

  line(value = ''): void {
    this.stdout.write(`${redact(value, this.context)}\n`);
  }

  /** Deliberate local-only identity display; never use for logs, JSON, or errors. */
  signedIn(email: string): void {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw new Error('account_identity_failed');
    this.stdout.write(`Signed in as ${email}\nRun mnemonik logout to switch account.\n`);
  }

  error(value: unknown): void {
    this.stderr.write(`${redact(value, this.context)}\n`);
  }

  json(value: unknown): void {
    this.stdout.write(`${redactJson(value, this.context)}\n`);
  }
}
