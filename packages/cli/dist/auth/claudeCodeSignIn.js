import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
/** `security find-generic-password` exit code for an item that does not exist. */
const KEYCHAIN_ITEM_NOT_FOUND = 44;
export const CLAUDE_CODE_KEYCHAIN_SERVICE = 'Claude Code-credentials';
const object = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const present = (value) => typeof value === 'string' && value.length > 0;
const readKeychain = (service, account) => new Promise((resolve) => {
    execFile('/usr/bin/security', ['find-generic-password', '-a', account, '-w', '-s', service], { encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => resolve(error
        ? { code: typeof error.code === 'number' ? error.code : null, stdout: '' }
        : { code: 0, stdout }));
});
/** Claude Code's Keychain account: $USER, else the login name, if it is a plain name. */
function keychainAccount(env) {
    let name;
    try {
        name = env.USER || userInfo().username;
    }
    catch {
        name = undefined;
    }
    return name && /^[a-zA-Z0-9._-]+$/u.test(name) ? name : 'claude-code-user';
}
function parse(text) {
    try {
        const value = JSON.parse(text);
        return object(value) ? value : undefined;
    }
    catch {
        return undefined;
    }
}
/** The credential document, null when Claude Code holds none, undefined when unreadable. */
async function credentialDocument(options, config) {
    const { env, home, platform } = options;
    if (platform === 'darwin') {
        const item = await options
            .keychain(CLAUDE_CODE_KEYCHAIN_SERVICE, keychainAccount(env))
            .catch(() => undefined);
        if (!item)
            return undefined;
        if (item.code === 0)
            return parse(item.stdout.trim());
        // A locked or unavailable Keychain says nothing about what it holds.
        if (item.code !== KEYCHAIN_ITEM_NOT_FOUND)
            return undefined;
    }
    if (platform === 'win32' &&
        (env.CLAUDE_CODE_FORCE_WINDOWS_CREDMAN === '1' ||
            (object(config.cachedGrowthBookFeatures) &&
                config.cachedGrowthBookFeatures.tengu_windows_credman === true)))
        return undefined;
    let text;
    try {
        text = await readFile(join(home, '.claude', '.credentials.json'), 'utf8');
    }
    catch (error) {
        return error.code === 'ENOENT' ? null : undefined;
    }
    return parse(text);
}
/** Claude Code's key for a server's stored sign-in (its `zl(name, config)`). */
export function claudeCodeCredentialKey(name, declaration) {
    const type = declaration.type === 'streamable-http' ? 'http' : declaration.type;
    const digest = createHash('sha256')
        .update(JSON.stringify({ type, url: declaration.url, headers: declaration.headers || {} }))
        .digest('hex');
    return `${name}|${digest.slice(0, 16)}`;
}
/** One stored entry, judged as Claude Code judges it when it connects. */
export function storedSignInState(entry, now) {
    if (!object(entry) || (!present(entry.accessToken) && !present(entry.refreshToken)))
        return { state: 'missing', expiresAt: null };
    const expires = typeof entry.expiresAt === 'number' && Number.isFinite(entry.expiresAt)
        ? entry.expiresAt
        : undefined;
    const expiresAt = expires === undefined ? null : new Date(expires).toISOString();
    if (present(entry.accessToken) && (expires === undefined || expires > now))
        return { state: 'signed_in', expiresAt };
    // An expired access token with nothing to renew it is one Claude Code asks to replace.
    return { state: present(entry.refreshToken) ? 'refreshable' : 'missing', expiresAt };
}
/**
 * Claude Code's stored Mnemonik sign-in on this computer, or undefined when
 * Claude Code has no Mnemonik HTTP declaration that signs in with OAuth here.
 */
export async function claudeCodeStoredSignIn(options) {
    const env = options.env ?? process.env;
    const raw = await readFile(join(options.home, '.claude.json'), 'utf8').catch(() => undefined);
    const config = raw === undefined ? undefined : parse(raw);
    const declaration = object(config?.mcpServers) ? config.mcpServers.mnemonik : undefined;
    if (!config ||
        !object(declaration) ||
        typeof declaration.url !== 'string' ||
        typeof declaration.type !== 'string' ||
        !['http', 'streamable-http', 'sse'].includes(declaration.type))
        return undefined;
    // A declaration that carries its own credentials does not use Claude Code's sign-in.
    if (declaration.headersHelper !== undefined ||
        (object(declaration.headers) &&
            Object.keys(declaration.headers).some((name) => name.toLowerCase() === 'authorization')))
        return undefined;
    const unreadable = { state: 'unreadable', expiresAt: null };
    // Claude Code would keep its credentials somewhere other than the defaults.
    if (env.CLAUDE_CONFIG_DIR || env.CLAUDE_SECURESTORAGE_CONFIG_DIR !== undefined)
        return unreadable;
    const document = await credentialDocument({
        home: options.home,
        env,
        platform: options.platform ?? process.platform,
        keychain: options.keychain ?? readKeychain,
    }, config);
    if (document === undefined)
        return unreadable;
    const entries = object(document?.mcpOAuth) ? document.mcpOAuth : {};
    const key = claudeCodeCredentialKey('mnemonik', {
        type: declaration.type,
        url: declaration.url,
        headers: declaration.headers,
    });
    return storedSignInState(entries[key], (options.now ?? Date.now)());
}
//# sourceMappingURL=claudeCodeSignIn.js.map