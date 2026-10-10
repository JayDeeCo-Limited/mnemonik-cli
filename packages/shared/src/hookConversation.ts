import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm, utimes } from 'node:fs/promises';
import { dirname } from 'node:path';
import { withFileLock } from './settingsIo.js';
import { ensureWindowsPrivateDirectorySync } from './runtimeSigners.js';

type HookFetchInit = NonNullable<Parameters<typeof fetch>[1]>;

const RETENTION_MS = 24 * 60 * 60 * 1000;
export const CONVERSATION_STATE_FILE = 'conversation.json';

export interface HookConversationInput {
  stateFile: string;
  server: string;
  account: string;
  host: string;
  nativeSessionId: string;
  agentId?: string;
  acquire?: boolean;
}

/** Organizer only. Signature/developer authority is checked by the server. */
function boundedHandle(value: unknown): value is string {
  return typeof value === 'string' && /^cv1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(value);
}

export class HookConversation {
  private conversationId?: string;
  private readonly scope: string;
  constructor(private readonly input: HookConversationInput) {
    this.scope = createHash('sha256')
      .update(
        JSON.stringify([
          input.server.replace(/\/$/, ''),
          input.account,
          input.host,
          input.nativeSessionId,
          input.agentId ?? '',
        ])
      )
      .digest('hex');
  }
  get id(): string | undefined {
    return this.conversationId;
  }

  async load(): Promise<string | undefined> {
    this.conversationId = undefined;
    try {
      const directory = await lstat(dirname(this.input.stateFile));
      if (
        !directory.isDirectory() ||
        directory.isSymbolicLink() ||
        (process.platform !== 'win32' &&
          ((process.getuid && directory.uid !== process.getuid()) || directory.mode & 0o077))
      )
        return;
      const file = await open(this.input.stateFile, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (
          !stat.isFile() ||
          stat.size > 4096 ||
          (process.platform !== 'win32' &&
            ((process.getuid && stat.uid !== process.getuid()) || stat.mode & 0o077))
        )
          return;
        const cache = JSON.parse(await file.readFile('utf8')) as {
          scope?: string;
          conversationId?: unknown;
          usedAt?: number;
        };
        if (
          cache.scope !== this.scope ||
          !boundedHandle(cache.conversationId) ||
          typeof cache.usedAt !== 'number' ||
          Date.now() - stat.mtimeMs >= RETENTION_MS
        )
          return;
        this.conversationId = cache.conversationId;
      } finally {
        await file.close();
      }
      await utimes(this.input.stateFile, new Date(), new Date());
      return this.conversationId;
    } catch {
      return undefined;
    }
  }

  private async locked<T>(run: () => Promise<T>): Promise<T> {
    const directory = dirname(this.input.stateFile);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (process.platform !== 'win32' &&
        ((process.getuid && stat.uid !== process.getuid()) || stat.mode & 0o077))
    )
      throw new Error('conversation cache unavailable');
    ensureWindowsPrivateDirectorySync(directory);
    return withFileLock(`${this.input.stateFile}.lock`, run, {
      staleMs: 10_000,
      retries: 150,
      retryMs: 20,
    });
  }

  private async save(id: string): Promise<void> {
    const temporary = `${this.input.stateFile}.${randomBytes(8).toString('hex')}`;
    const file = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600
    );
    try {
      await file.writeFile(
        JSON.stringify({ v: 1, scope: this.scope, conversationId: id, usedAt: Date.now() })
      );
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, this.input.stateFile);
      this.conversationId = id;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  /** Existing authenticated response is the acquisition; no additional endpoint. */
  async request(
    url: string,
    init: HookFetchInit,
    post: (init: HookFetchInit) => Promise<Response>
  ): Promise<Response> {
    if (
      typeof init.body !== 'string' ||
      !url.startsWith(`${this.input.server.replace(/\/$/, '')}/api/v1/`)
    )
      return post(init);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      return post(init);
    }
    const acquisition =
      this.input.acquire !== false &&
      (url.endsWith('/hooks/mcp-precheck') ||
        (url.endsWith('/hooks/injections') &&
          ['SessionStart', 'SubagentStart', 'UserPromptSubmit'].includes(String(body.event))));
    const send = async () => {
      await this.load();
      const response = await post({
        ...init,
        body: JSON.stringify({
          ...body,
          ...(this.conversationId ? { conversationId: this.conversationId } : {}),
        }),
      });
      if (acquisition && response.ok) {
        const result = (await response
          .clone()
          .json()
          .catch(() => null)) as { conversationId?: unknown } | null;
        if (boundedHandle(result?.conversationId)) {
          if (this.conversationId && this.conversationId !== result.conversationId)
            throw new Error('conversation response mismatch');
          await this.save(result.conversationId);
        }
      } else if (this.conversationId) await this.save(this.conversationId);
      return response;
    };
    return acquisition ? this.locked(send) : send();
  }

  /** Grok adopts only an authenticated explicit-bootstrap tool result. */
  async adopt(result: unknown): Promise<void> {
    const walk = (value: unknown, depth: number): string | undefined => {
      if (depth > 5 || !value) return;
      if (typeof value === 'string' && value.length < 65536) {
        // Explicit bootstrap can be projected by a host as native plain text.
        // Only the server's reserved marker is a carrier; arbitrary IDs in
        // prose are never adopted.
        const marker = value.match(
          /(?:^|[\s>])mnemonik-conversation:\s*(cv1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43})(?=$|[\s<])/
        );
        if (marker && boundedHandle(marker[1])) return marker[1];
        try {
          return walk(JSON.parse(value), depth + 1);
        } catch {
          return;
        }
      }
      if (typeof value !== 'object') return;
      const object = value as Record<string, unknown>;
      if (boundedHandle(object.conversationId)) return object.conversationId;
      if (typeof object.text === 'string' && object.text.length < 65536) {
        const id = walk(object.text, depth + 1);
        if (id) return id;
      }
      for (const key of ['structuredContent', 'result', 'content']) {
        const nested = object[key];
        for (const child of Array.isArray(nested) ? nested : [nested]) {
          const id = walk(child, depth + 1);
          if (id) return id;
        }
      }
      return;
    };
    const id = walk(result, 0);
    if (id)
      await this.locked(async () => {
        await this.load();
        if (this.conversationId && this.conversationId !== id)
          throw new Error('conversation response mismatch');
        await this.save(id);
      });
  }
}

let active: HookConversation | undefined;
export async function configureHookConversation(input: HookConversationInput): Promise<void> {
  active = new HookConversation(input);
  await active.load();
}
export function currentConversationId(): string | undefined {
  return active?.id;
}
export function conversationMarker(): string | undefined {
  return active?.id
    ? `<system-reminder>mnemonik-conversation: ${active.id}</system-reminder>`
    : undefined;
}
export async function adoptHookConversation(result: unknown): Promise<void> {
  await active?.adopt(result);
}
export function withHookConversation(
  url: string,
  init: HookFetchInit,
  post: (init: HookFetchInit) => Promise<Response>
): Promise<Response> {
  return active ? active.request(url, init, post) : post(init);
}
