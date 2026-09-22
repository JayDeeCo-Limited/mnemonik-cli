import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { URLSearchParams } from 'node:url';
import type { CliTokenResponse } from '@mnemonik/credentials';

export class OAuthProtocolError extends Error {
  constructor(
    readonly code: string,
    message = code
  ) {
    super(message);
  }
}

export class BrowserUnavailableError extends Error {}

export interface PkceOptions {
  scannerRoots?: string;
  deviceInstallationId?: string;
  deviceInstallationIds?: string[];
  deviceName?: string;
  issuer: string;
  resource: string;
  scopes: readonly string[];
  clientId: string | ((redirectUri: string) => Promise<string>);
  print: (line: string) => void;
  fetch?: typeof fetch;
  openBrowser?: (url: string) => Promise<void>;
  platform?: NodeJS.Platform;
  preferredPort?: number;
  timeoutMs?: number;
  random?: (size: number) => Buffer;
  createServer?: (
    requestListener: (request: IncomingMessage, response: ServerResponse) => void
  ) => Server;
}

export interface PkceResult {
  clientId: string;
  tokens: CliTokenResponse;
  redirectUri: string;
  authorizeUrl: string;
}

export const browserFallbackLines = (url: string): [string, string] => [
  'If your browser did not open, open this link:',
  url,
];

export async function open(url: string, platform: NodeJS.Platform): Promise<void> {
  const file = platform === 'darwin' ? 'open' : platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  // cmd start interprets the authorization URL's ampersands as command separators.
  const args = platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

async function closeAll(servers: Server[]): Promise<void> {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) return resolve();
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
}

function parseTokens(response: Response, body: Record<string, unknown>): CliTokenResponse {
  if (
    !response.ok ||
    typeof body.access_token !== 'string' ||
    typeof body.refresh_token !== 'string' ||
    typeof body.expires_in !== 'number' ||
    typeof body.scope !== 'string'
  )
    throw new OAuthProtocolError(
      typeof body.error === 'string' ? body.error : 'token_exchange_failed'
    );
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    token_type: 'Bearer',
    expires_in: body.expires_in,
    scope: body.scope,
  };
}

export const EDITOR_SIGN_IN_INSTRUCTION = 'Open this link to sign in:';
export interface EditorLoginOptions {
  /** The editor's own headless login command. */
  command: readonly string[];
  apiOrigin: string;
  /** Only an authorize URL from this origin is shown and polled for. */
  issuer: string;
  bearer: () => Promise<string>;
  print: (line: string) => void;
  spawn?: typeof spawn;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  pollMs?: number;
}
export type EditorLoginOverrides = Omit<
  EditorLoginOptions,
  'command' | 'apiOrigin' | 'issuer' | 'bearer' | 'print'
>;
/** The editor's exit code, or -1 once the sign-in deadline has passed. */
async function exitedBy(exited: Promise<number>, milliseconds: number): Promise<number> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      exited,
      new Promise<number>((resolve) => {
        timer = setTimeout(() => resolve(-1), Math.max(0, milliseconds));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
const isLoopbackCallback = (url: URL | null): url is URL =>
  !!url && url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Sign an editor on this machine in when the browser is on another machine.
 * The editor keeps its PKCE verifier and its loopback port; only its redirect
 * travels, collected once from the server and replayed to that port here.
 */
export async function runEditorLogin(
  options: EditorLoginOptions
): Promise<'signed_in' | 'not_approved' | 'failed'> {
  const [file, ...args] = options.command;
  if (!file) return 'failed';
  const fetchImpl = options.fetch ?? fetch;
  const sleep =
    options.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? 600_000);
  const child = (options.spawn ?? spawn)(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<number>((resolve) => {
    child.once('error', () => resolve(1));
    child.once('close', (code) => resolve(code ?? 1));
  });
  let settle!: (value: string) => void;
  const printed = new Promise<string>((resolve) => (settle = resolve));
  let seen = '';
  for (const stream of [child.stdout, child.stderr])
    stream?.on('data', (chunk: Buffer) => {
      seen += chunk.toString();
      const match = /https?:\/\/[^\s'"]*\/oauth\/authorize\?[^\s'"]+/.exec(seen);
      if (match) settle(match[0].replace(/[.,;)\]]+$/u, ''));
    });
  const authorizeUrl = await Promise.race([printed, exited.then(() => '')]);
  // Only this server's own authorize URL is worth showing or polling for.
  const authorize = authorizeUrl ? URL.parse(authorizeUrl) : null;
  const state =
    authorize && authorize.origin === URL.parse(options.issuer)?.origin
      ? authorize.searchParams.get('state')
      : null;
  if (!state) {
    child.kill();
    return 'failed';
  }
  options.print(EDITOR_SIGN_IN_INSTRUCTION);
  options.print(authorizeUrl);
  const poll = new URL(
    `/api/v1/auth/editor-callback/${encodeURIComponent(state)}`,
    options.apiOrigin
  );
  while (now() < deadline) {
    // A blip on the way to the server is worth another poll, not a failure.
    const response = await fetchImpl(poll, {
      headers: { authorization: `Bearer ${await options.bearer()}` },
    }).catch(() => undefined);
    const body = response?.ok
      ? ((await response.json().catch(() => ({}))) as { url?: unknown })
      : {};
    if (typeof body.url === 'string') {
      // The editor is listening on this machine's loopback port, not the browser's.
      const callback = URL.parse(body.url);
      if (!isLoopbackCallback(callback)) return 'failed';
      const delivered = await fetchImpl(callback, { redirect: 'manual' }).then(
        () => true,
        () => false
      );
      // An editor that has its callback but will not exit has had its chance.
      const code = delivered ? await exitedBy(exited, deadline - now()) : -1;
      if (code !== 0) child.kill();
      return code === 0 ? 'signed_in' : 'failed';
    }
    await sleep(options.pollMs ?? 2000);
  }
  child.kill();
  return 'not_approved';
}

export async function runPkce(options: PkceOptions): Promise<PkceResult> {
  const issuer = options.issuer.replace(/\/$/u, '');
  const random = options.random ?? randomBytes;
  const state = random(32).toString('base64url');
  const stateBytes = Buffer.from(state);
  const verifier = random(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const servers: Server[] = [];
  const authorities = new Set<string>();
  let settle!: (value: URL) => void;
  const callback = new Promise<URL>((resolve) => (settle = resolve));

  const handler = (request: IncomingMessage, response: ServerResponse) => {
    const authority = request.headers.host ?? '';
    if (
      request.method !== 'GET' ||
      (request.url ?? '').split('?', 1)[0] !== '/callback' ||
      !authorities.has(authority)
    ) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    const url = new URL(request.url ?? '/', `http://${authority}`);
    const receivedState = Buffer.from(url.searchParams.get('state') ?? '');
    if (
      receivedState.length !== stateBytes.length ||
      !timingSafeEqual(receivedState, stateBytes) ||
      url.searchParams.get('iss') !== issuer
    ) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    response.writeHead(204);
    response.end(() => settle(url));
  };

  const serverFactory = options.createServer ?? createServer;
  const ipv4 = serverFactory(handler);
  servers.push(ipv4);
  let ipv4Port: number;
  try {
    ipv4Port = await listen(ipv4, '127.0.0.1', options.preferredPort ?? 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || !options.preferredPort)
      throw error;
    servers.pop();
    const replacement = serverFactory(handler);
    servers.push(replacement);
    ipv4Port = await listen(replacement, '127.0.0.1', 0);
  }
  authorities.add(`127.0.0.1:${ipv4Port}`);
  const ipv6 = serverFactory(handler);
  try {
    const ipv6Port = await listen(ipv6, '::1', 0);
    servers.push(ipv6);
    authorities.add(`[::1]:${ipv6Port}`);
  } catch {
    ipv6.close();
  }

  const redirectUri = `http://127.0.0.1:${ipv4Port}/callback`;
  let timer: NodeJS.Timeout | undefined;
  try {
    const clientId =
      typeof options.clientId === 'string' ? options.clientId : await options.clientId(redirectUri);
    const authorize = new URL(`${issuer}/oauth/authorize`);
    authorize.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: options.scopes.join(' '),
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: options.resource,
      ...(options.scannerRoots ? { scanner_roots: options.scannerRoots } : {}),
      ...(options.deviceName ? { device_name: options.deviceName } : {}),
      ...(options.deviceInstallationIds?.length
        ? { device_installation_ids: JSON.stringify(options.deviceInstallationIds) }
        : {}),
      ...(options.deviceInstallationId
        ? { device_installation_id: options.deviceInstallationId }
        : {}),
    }).toString();
    const authorizeUrl = authorize.toString();
    for (const line of browserFallbackLines(authorizeUrl)) options.print(line);
    const opener = (
      options.openBrowser ?? ((url) => open(url, options.platform ?? process.platform))
    )(authorizeUrl).then(
      () => new Promise<never>(() => {}),
      (error) => Promise.reject(new BrowserUnavailableError(String(error)))
    );
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new OAuthProtocolError('expired', 'expired')),
        options.timeoutMs ?? 600_000
      );
    });
    const responseUrl = await Promise.race([callback, opener, expired]);
    await closeAll(servers);
    const responseError = responseUrl.searchParams.get('error');
    if (responseError) {
      const code = responseError;
      throw new OAuthProtocolError(code, code === 'access_denied' ? 'denied in the browser' : code);
    }
    const code = responseUrl.searchParams.get('code');
    if (!code) throw new OAuthProtocolError('invalid_response');
    const tokenResponse = await (options.fetch ?? fetch)(`${issuer}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource: options.resource,
      }),
    });
    const body = (await tokenResponse.json().catch(() => ({}))) as Record<string, unknown>;
    return { clientId, tokens: parseTokens(tokenResponse, body), redirectUri, authorizeUrl };
  } finally {
    if (timer) clearTimeout(timer);
    await closeAll(servers);
  }
}
