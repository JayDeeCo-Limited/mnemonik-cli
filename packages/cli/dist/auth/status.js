import { apiOrigin } from '@mnemonik/shared';
// Display metadata is self-asserted. Account evidence comes only from the authenticated route.
const hosts = {
    'claude code': 'claude-code',
    'claude-code': 'claude-code',
    codex: 'codex',
    'codex cli': 'codex',
    cursor: 'cursor',
    grok: 'grok',
    'grok build': 'grok',
};
export const grantHost = (grant) => hosts[grant.softwareId?.toLowerCase() ?? ''] ??
    hosts[grant.clientName?.toLowerCase() ?? ''] ??
    { 'claude.ai': 'claude-code', 'chatgpt.com': 'codex' }[URL.parse(grant.clientId)?.hostname ?? ''];
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
        async list() {
            const body = (await request('/api/v1/auth/grants'));
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
                    ![g.clientName, g.softwareId, g.activatedAt, g.lastUsedAt].every((v) => v === null || typeof v === 'string')))
                throw new Error('invalid_grant_status');
            return body;
        },
        async approveHost(id) {
            const body = (await request(`/api/v1/auth/grants/${encodeURIComponent(id)}/approve-host`, 'POST'));
            if (body?.id !== id ||
                typeof body.deviceInstallationId !== 'string' ||
                !body.deviceInstallationId)
                throw new Error('invalid_grant_approval');
            return body.deviceInstallationId;
        },
        async revoke(id) {
            await request(`/api/v1/auth/grants/${encodeURIComponent(id)}/revoke`, 'POST');
        },
    };
}
function installationWindow(result) {
    return Math.min(...result.grants
        .filter((g) => result.deviceInstallationId &&
        g.deviceInstallationId === result.deviceInstallationId &&
        g.resource === `${apiOrigin()}/` &&
        g.scopes.includes('install:manage') &&
        g.scopes.includes('components:manage'))
        .map((g) => Date.parse(g.createdAt)));
}
/** Native clients can renew into another grant while the installed host stays connected. */
export async function bindInstalledHostGrants(listing, installedHosts, transport) {
    const startedAt = installationWindow(listing);
    for (const grant of listing.grants) {
        if (!listing.deviceInstallationId ||
            grant.deviceInstallationId ||
            !grant.activatedAt ||
            !installedHosts.some((host) => host === grantHost(grant)) ||
            grant.resource !== `${apiOrigin()}/mcp` ||
            !grant.scopes.includes('mcp:use') ||
            !(Date.parse(grant.createdAt) >= startedAt))
            continue;
        const installationId = await transport.approveHost(grant.id);
        if (installationId !== listing.deviceInstallationId)
            throw new Error('grant_bound_elsewhere');
        grant.deviceInstallationId = installationId;
    }
}
// Provisional until real-host qualification: a listing corroborates the account-scoped grant.
export async function matchHostGrant(status, host, account, transport, attemptStartedAt, recorded, approve, approvalMode = 'all') {
    const { grant: _untrusted, ...inspection } = status;
    if (!inspection.authenticatedTools)
        return inspection;
    const result = await transport.list();
    if (!account || result.account !== account)
        throw new Error('host_account_mismatch');
    const candidates = result.grants.filter((g) => grantHost(g) === host &&
        g.resource === `${apiOrigin()}/mcp` &&
        // Codex's native OAuth listing does not handshake; its first session activates the grant.
        (g.activatedAt || host === 'codex') &&
        g.scopes.includes('mcp:use'));
    const recordedInstallation = (g) => recorded?.installationId && recorded.account === account && recorded.id === g.id
        ? recorded.installationId
        : undefined;
    const boundHere = (g) => Boolean(recordedInstallation(g) ||
        (g.deviceInstallationId && g.deviceInstallationId === result.deviceInstallationId));
    const unbound = candidates.filter((g) => !g.deviceInstallationId);
    const activatedUnbound = unbound.filter((g) => g.activatedAt && Date.parse(g.activatedAt) >= attemptStartedAt);
    const installationStartedAt = installationWindow(result);
    const codexUnbound = unbound.filter((g) => Date.parse(g.createdAt) >= installationStartedAt);
    const newest = candidates
        .filter((g) => {
        if (host === 'codex')
            return (boundHere(g) ||
                (g.deviceInstallationId
                    ? Date.parse(g.createdAt) >= attemptStartedAt
                    : codexUnbound.includes(g) && (codexUnbound.length === 1 || g.activatedAt)));
        return (Date.parse(g.createdAt) >= attemptStartedAt ||
            boundHere(g) ||
            (!g.deviceInstallationId &&
                (unbound.length === 1 ||
                    (activatedUnbound.length === 1 && activatedUnbound[0]?.id === g.id))));
    })
        .sort((a, b) => Number(boundHere(b)) - Number(boundHere(a)) ||
        Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    if (!newest)
        throw new Error('host_connection_pending');
    let installationId = newest.deviceInstallationId ?? recordedInstallation(newest);
    if (installationId &&
        result.deviceInstallationId &&
        installationId !== result.deviceInstallationId)
        throw new Error('grant_bound_elsewhere');
    if (!installationId &&
        approve &&
        (approvalMode === 'all' || Date.parse(newest.createdAt) < attemptStartedAt)) {
        if (!(await approve()))
            throw new Error('host_grant_unbound');
        installationId = await transport.approveHost(newest.id);
    }
    const grant = {
        id: newest.id,
        account: result.account,
        scopes: newest.scopes,
        ...(installationId ? { installationId } : {}),
    };
    return { ...inspection, grant };
}
//# sourceMappingURL=status.js.map