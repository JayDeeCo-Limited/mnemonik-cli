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
        async revoke(id) {
            await request(`/api/v1/auth/grants/${encodeURIComponent(id)}/revoke`, 'POST');
        },
    };
}
//# sourceMappingURL=status.js.map