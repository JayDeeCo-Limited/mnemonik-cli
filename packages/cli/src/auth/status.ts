import { apiOrigin } from '@mnemonik/shared';
import type { HostName } from '@mnemonik/shared';

export interface AccountGrant {
  deviceInstallationId?: string | null;
  id: string;
  clientId: string;
  clientName: string | null;
  softwareId: string | null;
  scopes: string[];
  resource: string;
  createdAt: string;
  activatedAt: string | null;
  /** Refresh-family activity; the server does not yet record each authenticated MCP request. */
  lastUsedAt: string | null;
}
export interface GrantStatus {
  deviceInstallationId?: string | null;
  account: string;
  grants: AccountGrant[];
}
// Display metadata is self-asserted. Account evidence comes only from the authenticated route.
const hosts: Record<string, HostName> = {
  'claude code': 'claude-code',
  'claude-code': 'claude-code',
  codex: 'codex',
  'codex cli': 'codex',
  cursor: 'cursor',
  grok: 'grok',
  'grok build': 'grok',
};
export const grantHost = (grant: AccountGrant) =>
  hosts[grant.softwareId?.toLowerCase() ?? ''] ??
  hosts[grant.clientName?.toLowerCase() ?? ''] ??
  ({ 'claude.ai': 'claude-code', 'chatgpt.com': 'codex' } as Record<string, HostName>)[
    URL.parse(grant.clientId)?.hostname ?? ''
  ];

export function grantTransport(getBearer: () => Promise<string>, fetcher: typeof fetch = fetch) {
  const resource = apiOrigin();
  async function request(path: string, method = 'GET') {
    const response = await fetcher(new URL(path, resource), {
      method,
      headers: { authorization: `Bearer ${await getBearer()}` },
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? 'grant_request_failed');
    }
    return response.json() as Promise<unknown>;
  }
  return {
    async list(): Promise<GrantStatus> {
      const body = (await request('/api/v1/auth/grants')) as GrantStatus;
      if (
        !body ||
        typeof body.account !== 'string' ||
        !body.account ||
        (body.deviceInstallationId != null && typeof body.deviceInstallationId !== 'string') ||
        !Array.isArray(body.grants) ||
        body.grants.some(
          (g) =>
            !g ||
            typeof g.id !== 'string' ||
            typeof g.clientId !== 'string' ||
            typeof g.resource !== 'string' ||
            (g.deviceInstallationId != null && typeof g.deviceInstallationId !== 'string') ||
            !Array.isArray(g.scopes) ||
            !g.scopes.every((s) => typeof s === 'string') ||
            !Number.isFinite(Date.parse(g.createdAt)) ||
            ![g.clientName, g.softwareId, g.activatedAt, g.lastUsedAt].every(
              (v) => v === null || typeof v === 'string'
            )
        )
      )
        throw new Error('invalid_grant_status');
      return body;
    },
    async revoke(id: string) {
      await request(`/api/v1/auth/grants/${encodeURIComponent(id)}/revoke`, 'POST');
    },
  };
}
export type GrantTransport = ReturnType<typeof grantTransport>;
