import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { object, parseObject, present, unreadable, } from './storedAuthorization.js';
/** Codex refreshes an access token this long before it expires (REFRESH_SKEW_MILLIS). */
const REFRESH_SKEW_MS = 30_000;
/** Codex's key for a server's stored authorization (compute_store_key). */
export function codexCredentialKey(name, url) {
    const digest = createHash('sha256')
        .update(JSON.stringify({ type: 'http', url, headers: {} }))
        .digest('hex');
    return `${name}|${digest.slice(0, 16)}`;
}
/** One file entry, judged as Codex judges it when it connects. */
export function codexEntryState(entry, now) {
    const expires = typeof entry.expires_at === 'number' && Number.isFinite(entry.expires_at)
        ? entry.expires_at
        : undefined;
    const expiresAt = expires === undefined ? null : new Date(expires).toISOString();
    if (!present(entry.client_id))
        return { state: 'missing', expiresAt };
    if (expires !== undefined && now + REFRESH_SKEW_MS >= expires)
        return {
            state: present(entry.issuer) && present(entry.refresh_token) ? 'renewable' : 'missing',
            expiresAt,
        };
    return { state: present(entry.access_token) ? 'authorized' : 'missing', expiresAt };
}
/** Whether this Linux user has a Secret Service keyring Codex could have written to. */
async function secretServiceKeyring(home, env) {
    const data = env.XDG_DATA_HOME || join(home, '.local', 'share');
    const found = await Promise.all(['keyrings', 'kwalletd'].map((dir) => stat(join(data, dir)).then((entry) => entry.isDirectory(), () => false)));
    return found.some(Boolean);
}
/**
 * Codex's stored Mnemonik authorization on this computer, or undefined when
 * Codex has no Mnemonik HTTP declaration that authorizes with OAuth here.
 */
export async function codexStoredAuthorization(options) {
    const env = options.env ?? process.env;
    const platform = options.platform ?? process.platform;
    const codexHome = env.CODEX_HOME || join(options.home, '.codex');
    const raw = await readFile(join(codexHome, 'config.toml'), 'utf8').catch(() => undefined);
    let config;
    try {
        config = raw === undefined ? {} : parseToml(raw);
    }
    catch {
        return undefined;
    }
    const declaration = object(config.mcp_servers) ? config.mcp_servers.mnemonik : undefined;
    if (!object(declaration) || typeof declaration.url !== 'string')
        return undefined;
    // A declaration that sends its own bearer token does not use Codex's OAuth store.
    if (declaration.bearer_token_env_var !== undefined ||
        declaration.bearer_token !== undefined ||
        (object(declaration.http_headers) &&
            Object.keys(declaration.http_headers).some((name) => name.toLowerCase() === 'authorization')))
        return undefined;
    const url = declaration.url;
    const mode = config.mcp_oauth_credentials_store ?? 'auto';
    // Codex's keyring on each system, said by name.
    const keyring = unreadable(platform === 'darwin'
        ? 'macos_keychain'
        : platform === 'win32'
            ? 'credential_manager'
            : 'system_keyring');
    if (mode === 'keyring')
        return keyring;
    let text;
    try {
        text = await readFile(join(codexHome, '.credentials.json'), 'utf8');
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            return unreadable('file_unreadable');
    }
    const file = text === undefined ? {} : parseObject(text);
    if (!file)
        return unreadable('file_unreadable');
    const entry = Object.keys(file)
        .sort()
        .map((key) => file[key])
        .find((candidate) => object(candidate) &&
        candidate.executor_owned !== true &&
        candidate.server_url === url &&
        candidate.server_name === 'mnemonik');
    const now = (options.now ?? Date.now)();
    if (entry)
        return codexEntryState(entry, now);
    if (mode === 'file')
        return { state: 'missing', expiresAt: null };
    // `auto` with nothing in the file: the keyring may hold it.
    if (platform === 'linux' && !(await secretServiceKeyring(options.home, env)))
        return { state: 'missing', expiresAt: null };
    return keyring;
}
//# sourceMappingURL=codexAuthorization.js.map