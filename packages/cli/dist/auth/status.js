import { apiOrigin, hostForGrantClient } from '@mnemonik/shared';
// Display metadata is self-asserted. Account evidence comes only from the authenticated route.
export const grantHost = (grant) => hostForGrantClient(grant);
/** A sign-in that works: the server's status, or activated on a server too old to say. */
export const validGrant = (grant) => grant.status ? grant.status === 'connected' : grant.activatedAt !== null;
/**
 * Editors that can run on one machine while their hooks run on another (Cursor
 * over SSH, VS Code with Copilot over Remote SSH). Claude Code and Codex sign in
 * where their hooks run, so a sign-in elsewhere says nothing about this machine.
 */
const REMOTE_EDITOR_HOSTS = new Set(['cursor', 'vscode-copilot']);
const newest = (grants) => grants
    .map((grant) => grant.lastUsedAt)
    .filter((at) => !!at)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
const elsewhereGrants = (status, host) => {
    const here = status.deviceInstallationId;
    return REMOTE_EDITOR_HOSTS.has(host) && here
        ? status.grants.filter((grant) => grantHost(grant) === host &&
            validGrant(grant) &&
            !!grant.deviceInstallationId &&
            grant.deviceInstallationId !== here)
        : [];
};
/**
 * An editor that opens this machine remotely (Cursor on a Mac over SSH) signs in
 * where it runs, while its hooks run here. A valid sign-in for the host on
 * another of the account's installations is that editor's sign-in, for the
 * editors above only (L-182; the server's computeMachineHealth reads the same
 * rule). How long ago it was used says nothing about whether it is valid.
 */
export function signedInElsewhere(status, host) {
    return elsewhereGrants(status, host).length > 0;
}
/**
 * One coding tool's sign-in on this machine, from the server's listing of this
 * installation's sign-ins (`?installation=current`, revoked ones included).
 * Signed out only when it had sign-ins here and none of them is valid; never
 * because of idle time. `everywhere`, the account-wide listing, is read only
 * for editors that can sign in on another machine.
 */
export function codingToolSignIn(host, here, everywhere) {
    // A server too old to filter lists every machine's sign-ins: keep this one's.
    const mine = here.grants.filter((grant) => grantHost(grant) === host &&
        (!here.deviceInstallationId || grant.deviceInstallationId === here.deviceInstallationId));
    const valid = mine.filter(validGrant);
    if (valid.length)
        return { state: 'signed_in', lastUsedAt: newest(valid) };
    const remote = everywhere ? elsewhereGrants(everywhere, host) : [];
    if (remote.length)
        return { state: 'signed_in_elsewhere', lastUsedAt: newest(remote) };
    // A sign-in started and never used to reach Mnemonik is one not finished yet.
    return mine.some((grant) => grant.status !== 'incomplete' && grant.activatedAt !== null)
        ? { state: 'signed_out', lastUsedAt: null }
        : { state: 'not_set_up', lastUsedAt: null };
}
/** "just now", "5 minutes ago", "1 hour ago", "3 days ago", or "never". */
export function relativeTime(time, now) {
    if (time === null)
        return 'never';
    const minutes = Math.floor((now - time) / 60_000);
    if (minutes < 1)
        return 'just now';
    const [count, unit] = minutes < 60
        ? [minutes, 'minute']
        : minutes < 1_440
            ? [Math.floor(minutes / 60), 'hour']
            : [Math.floor(minutes / 1_440), 'day'];
    return `${count} ${unit}${count === 1 ? '' : 's'} ago`;
}
/**
 * One line per host for plain `auth status`: editors first, then the rest,
 * each by most recent use. Grant ids, dates and scopes are for --json.
 */
export function grantSummaryLines(grants, editors, now = Date.now()) {
    const rows = new Map();
    for (const grant of grants) {
        const row = rows.get(grant.host) ?? {
            name: editors[grant.host] ?? grant.host,
            editor: grant.host in editors,
            last: null,
            count: 0,
        };
        const used = grant.lastUsedAt ? Date.parse(grant.lastUsedAt) : null;
        if (used !== null && (row.last === null || used > row.last))
            row.last = used;
        row.count += 1;
        rows.set(grant.host, row);
    }
    const ordered = [...rows.values()].sort((a, b) => Number(b.editor) - Number(a.editor) || (b.last ?? 0) - (a.last ?? 0));
    const width = Math.max(...ordered.map((row) => row.name.length)) + 2;
    return ordered.map((row) => `${row.name.padEnd(width)}signed in, last used ${relativeTime(row.last, now)} (${row.count} sign-in${row.count === 1 ? '' : 's'})`);
}
export function grantTransport(getBearer, fetcher = fetch) {
    const resource = apiOrigin();
    async function request(path, method = 'GET') {
        const response = await fetcher(new URL(path, resource), {
            method,
            headers: { authorization: `Bearer ${await getBearer()}` },
        });
        if (!response.ok) {
            const body = (await response.json().catch(() => null));
            throw new Error(body?.error ?? 'grant_request_failed');
        }
        return response.json();
    }
    return {
        /** Every machine's unrevoked sign-ins, or with `here` every sign-in on this one. */
        async list(options = {}) {
            const body = (await request(options.here ? '/api/v1/auth/grants?installation=current' : '/api/v1/auth/grants'));
            if (!body ||
                typeof body.account !== 'string' ||
                !body.account ||
                (body.deviceInstallationId != null && typeof body.deviceInstallationId !== 'string') ||
                !Array.isArray(body.grants) ||
                body.grants.some((g) => !g ||
                    typeof g.id !== 'string' ||
                    typeof g.clientId !== 'string' ||
                    typeof g.resource !== 'string' ||
                    (g.deviceInstallationId != null && typeof g.deviceInstallationId !== 'string') ||
                    !Array.isArray(g.scopes) ||
                    !g.scopes.every((s) => typeof s === 'string') ||
                    !Number.isFinite(Date.parse(g.createdAt)) ||
                    ![g.clientName, g.softwareId, g.activatedAt, g.lastUsedAt].every((v) => v === null || typeof v === 'string') ||
                    (g.status !== undefined &&
                        !['connected', 'disconnected', 'expired', 'incomplete'].includes(g.status))))
                throw new Error('invalid_grant_status');
            return body;
        },
        async revoke(id) {
            await request(`/api/v1/auth/grants/${encodeURIComponent(id)}/revoke`, 'POST');
        },
    };
}
//# sourceMappingURL=status.js.map