import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { object, parseObject, unreadable, } from './storedAuthorization.js';
const IDENTIFIER = 'user-mnemonik';
const TOKENS = '] mcp_tokens';
/** Cursor's own user-data folder for this platform (Electron's appData plus "Cursor"). */
export function cursorUserData(home, platform, env) {
    if (platform === 'darwin')
        return join(home, 'Library', 'Application Support', 'Cursor');
    if (platform === 'win32')
        return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Cursor');
    return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'Cursor');
}
const base64url = (text) => Buffer.from(text, 'base64url').toString('utf8');
/** A URL the way Cursor compares server URLs, near enough: no trailing slash, any case host. */
function sameServer(left, right) {
    const normal = (value) => {
        try {
            const url = new URL(value);
            return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/u, '')}${url.search}`;
        }
        catch {
            return value.replace(/\/+$/u, '');
        }
    };
    return normal(left) === normal(right);
}
/** Whether one storage key name holds Mnemonik's tokens for this declaration. */
export function isMnemonikTokens(name, url) {
    // An optional profile prefix, then `[<id>] mcp_tokens`.
    const bare = name.replace(/^\[profile:[^\]]+\] /u, '');
    if (!bare.startsWith('[') || !bare.endsWith(TOKENS))
        return false;
    let id = bare.slice(1, -TOKENS.length);
    if (id.startsWith('identifier:v1:'))
        id = base64url(id.slice('identifier:v1:'.length));
    else if (id.startsWith('raw-identifier:v1:'))
        id = base64url(id.slice('raw-identifier:v1:'.length));
    if (id.startsWith('url:'))
        return sameServer(base64url(id.slice('url:'.length)), url);
    return id === IDENTIFIER || id.startsWith(`${IDENTIFIER}::`);
}
/** The key name a database row stands for, or undefined for rows that are not MCP secrets. */
function keyName(row) {
    if (row.startsWith('mcpOAuth.secret.'))
        return base64url(row.slice('mcpOAuth.secret.'.length));
    if (row.startsWith('secret://')) {
        const parsed = parseObject(row.slice('secret://'.length));
        return typeof parsed?.key === 'string' ? parsed.key : undefined;
    }
    return undefined;
}
const SQLITE = 'node:sqlite';
/** Imports node:sqlite without the ExperimentalWarning some Node 24 releases print for it. */
async function sqlite() {
    const emit = process.emitWarning;
    process.emitWarning = ((warning, ...rest) => {
        const text = typeof warning === 'string' ? warning : warning.message;
        if (/sqlite/iu.test(text))
            return;
        emit.call(process, warning, ...rest);
    });
    try {
        return (await import(SQLITE));
    }
    finally {
        process.emitWarning = emit;
    }
}
const exists = (path) => stat(path).then(() => true, () => false);
/**
 * The database's MCP secret key names, opened read only. While Cursor runs, its
 * changes sit in the write-ahead log, which only a plain read-only connection
 * reads. When there is no log (Cursor is closed), the database is opened
 * immutable, because a plain connection would create the log and its index
 * beside Cursor's database.
 */
async function databaseKeys(database) {
    const { DatabaseSync } = await sqlite();
    const url = pathToFileURL(database);
    url.searchParams.set('mode', 'ro');
    if (!(await exists(`${database}-wal`)))
        url.searchParams.set('immutable', '1');
    const db = new DatabaseSync(url, { readOnly: true });
    try {
        return db
            .prepare("SELECT key FROM ItemTable WHERE key LIKE 'mcpOAuth.secret.%' OR key LIKE 'secret://%'")
            .all()
            .map((row) => String(row.key));
    }
    finally {
        db.close();
    }
}
/**
 * Cursor's stored Mnemonik authorization on this computer, or undefined when
 * Cursor has no Mnemonik HTTP declaration that authorizes with OAuth here.
 */
export async function cursorStoredAuthorization(options) {
    const env = options.env ?? process.env;
    const platform = options.platform ?? process.platform;
    const raw = await readFile(join(options.home, '.cursor', 'mcp.json'), 'utf8').catch(() => undefined);
    const config = raw === undefined ? undefined : parseObject(raw);
    const declaration = object(config?.mcpServers) ? config.mcpServers.mnemonik : undefined;
    if (!object(declaration) || typeof declaration.url !== 'string')
        return undefined;
    // A declaration that carries its own credentials does not use Cursor's OAuth store.
    if (object(declaration.headers) &&
        Object.keys(declaration.headers).some((name) => name.toLowerCase() === 'authorization'))
        return undefined;
    const userData = cursorUserData(options.home, platform, env);
    const database = join(userData, 'User', 'globalStorage', 'state.vscdb');
    if (!(await exists(database))) {
        if (await exists(userData))
            return { state: 'missing', expiresAt: null };
        // Cursor opens this computer from another one, or is not installed here.
        return unreadable((await exists(join(options.home, '.cursor-server'))) ? 'remote' : 'not_on_this_computer');
    }
    let rows;
    try {
        rows = await (options.listKeys ?? databaseKeys)(database);
    }
    catch {
        return unreadable('database_unreadable');
    }
    const url = declaration.url;
    return rows.some((row) => {
        const name = keyName(row);
        return name !== undefined && isMnemonikTokens(name, url);
    })
        ? { state: 'authorized', expiresAt: null }
        : { state: 'missing', expiresAt: null };
}
//# sourceMappingURL=cursorAuthorization.js.map