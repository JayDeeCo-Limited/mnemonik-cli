import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { URLSearchParams } from 'node:url';
export class OAuthProtocolError extends Error {
    code;
    constructor(code, message = code) {
        super(message);
        this.code = code;
    }
}
export class BrowserUnavailableError extends Error {
}
export const browserFallbackLines = (url) => [
    'If your browser did not open, open this link:',
    url,
];
export async function open(url, platform) {
    const file = platform === 'darwin' ? 'open' : platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
    // cmd start interprets the authorization URL's ampersands as command separators.
    const args = platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
    await new Promise((resolve, reject) => {
        const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true });
        child.once('error', reject);
        child.once('spawn', () => {
            child.unref();
            resolve();
        });
    });
}
function listen(server, host, port) {
    return new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        server.once('error', onError);
        server.listen(port, host, () => {
            server.off('error', onError);
            resolve(server.address().port);
        });
    });
}
async function closeAll(servers) {
    await Promise.all(servers.map((server) => new Promise((resolve) => {
        if (!server.listening)
            return resolve();
        server.closeAllConnections();
        server.close(() => resolve());
    })));
}
function parseTokens(response, body) {
    if (!response.ok ||
        typeof body.access_token !== 'string' ||
        typeof body.refresh_token !== 'string' ||
        typeof body.expires_in !== 'number' ||
        typeof body.scope !== 'string')
        throw new OAuthProtocolError(typeof body.error === 'string' ? body.error : 'token_exchange_failed');
    return {
        access_token: body.access_token,
        refresh_token: body.refresh_token,
        token_type: 'Bearer',
        expires_in: body.expires_in,
        scope: body.scope,
    };
}
export async function runPkce(options) {
    const issuer = options.issuer.replace(/\/$/u, '');
    const random = options.random ?? randomBytes;
    const state = random(32).toString('base64url');
    const stateBytes = Buffer.from(state);
    const verifier = random(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const servers = [];
    const authorities = new Set();
    let settle;
    const callback = new Promise((resolve) => (settle = resolve));
    const handler = (request, response) => {
        const authority = request.headers.host ?? '';
        if (request.method !== 'GET' ||
            (request.url ?? '').split('?', 1)[0] !== '/callback' ||
            !authorities.has(authority)) {
            response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            response.end('Not found');
            return;
        }
        const url = new URL(request.url ?? '/', `http://${authority}`);
        const receivedState = Buffer.from(url.searchParams.get('state') ?? '');
        if (receivedState.length !== stateBytes.length ||
            !timingSafeEqual(receivedState, stateBytes) ||
            url.searchParams.get('iss') !== issuer) {
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
    let ipv4Port;
    try {
        ipv4Port = await listen(ipv4, '127.0.0.1', options.preferredPort ?? 0);
    }
    catch (error) {
        if (error.code !== 'EADDRINUSE' || !options.preferredPort)
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
    }
    catch {
        ipv6.close();
    }
    const redirectUri = `http://127.0.0.1:${ipv4Port}/callback`;
    let timer;
    try {
        const clientId = typeof options.clientId === 'string' ? options.clientId : await options.clientId(redirectUri);
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
        for (const line of browserFallbackLines(authorizeUrl))
            options.print(line);
        const opener = (options.openBrowser ?? ((url) => open(url, options.platform ?? process.platform)))(authorizeUrl).then(() => new Promise(() => { }), (error) => Promise.reject(new BrowserUnavailableError(String(error))));
        const expired = new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new OAuthProtocolError('expired', 'expired')), options.timeoutMs ?? 600_000);
        });
        const responseUrl = await Promise.race([callback, opener, expired]);
        await closeAll(servers);
        const responseError = responseUrl.searchParams.get('error');
        if (responseError) {
            const code = responseError;
            throw new OAuthProtocolError(code, code === 'access_denied' ? 'denied in the browser' : code);
        }
        const code = responseUrl.searchParams.get('code');
        if (!code)
            throw new OAuthProtocolError('invalid_response');
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
        const body = (await tokenResponse.json().catch(() => ({})));
        return { clientId, tokens: parseTokens(tokenResponse, body), redirectUri, authorizeUrl };
    }
    finally {
        if (timer)
            clearTimeout(timer);
        await closeAll(servers);
    }
}
//# sourceMappingURL=pkce.js.map