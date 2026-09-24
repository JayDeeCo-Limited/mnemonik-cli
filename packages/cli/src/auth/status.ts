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
  /** The account's email, sent with the grants; the CLI reads it for sign-in too. */
  email?: string;
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
  'github copilot': 'vscode-copilot',
  'vs code copilot': 'vscode-copilot',
  'vscode-copilot': 'vscode-copilot',
};
export const grantHost = (grant: AccountGrant) =>
  hosts[grant.softwareId?.toLowerCase() ?? ''] ??
  hosts[grant.clientName?.toLowerCase() ?? ''] ??
  ({ 'claude.ai': 'claude-code', 'chatgpt.com': 'codex' } as Record<string, HostName>)[
    URL.parse(grant.clientId)?.hostname ?? ''
  ];

/**
 * Editors that can run on one machine while their hooks run on another (Cursor
 * over SSH, VS Code with Copilot over Remote SSH). Claude Code and Codex sign in
 * where their hooks run, so a sign-in elsewhere says nothing about this machine.
 */
const REMOTE_EDITOR_HOSTS: ReadonlySet<HostName> = new Set(['cursor', 'vscode-copilot']);

/** How recently a sign-in on another machine must have been used to count here. */
export const SIGNED_IN_ELSEWHERE_WITHIN_MS = 24 * 60 * 60 * 1000;

/**
 * An editor that opens this machine remotely (Cursor on a Mac over SSH) signs in
 * where it runs, while its hooks run here. A sign-in for the host on another of
 * the account's installations, activated and used within the last day, is that
 * editor's sign-in, for the editors above only (L-182; the server's
 * computeMachineHealth reads the same rule).
 * The listing already leaves out revoked grants.
 */
export function signedInElsewhere(status: GrantStatus, host: HostName, now = Date.now()) {
  const here = status.deviceInstallationId;
  return (
    REMOTE_EDITOR_HOSTS.has(host) &&
    !!here &&
    status.grants.some(
      (grant) =>
        grantHost(grant) === host &&
        grant.activatedAt !== null &&
        !!grant.deviceInstallationId &&
        grant.deviceInstallationId !== here &&
        grant.lastUsedAt !== null &&
        now - Date.parse(grant.lastUsedAt) <= SIGNED_IN_ELSEWHERE_WITHIN_MS
    )
  );
}

/** "just now", "5 minutes ago", "1 hour ago", "3 days ago", or "never". */
export function relativeTime(time: number | null, now: number): string {
  if (time === null) return 'never';
  const minutes = Math.floor((now - time) / 60_000);
  if (minutes < 1) return 'just now';
  const [count, unit] =
    minutes < 60
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
export function grantSummaryLines(
  grants: readonly (AccountGrant & { host: string })[],
  editors: Readonly<Record<string, string>>,
  now = Date.now()
): string[] {
  const rows = new Map<
    string,
    { name: string; editor: boolean; last: number | null; count: number }
  >();
  for (const grant of grants) {
    const row = rows.get(grant.host) ?? {
      name: editors[grant.host] ?? grant.host,
      editor: grant.host in editors,
      last: null,
      count: 0,
    };
    const used = grant.lastUsedAt ? Date.parse(grant.lastUsedAt) : null;
    if (used !== null && (row.last === null || used > row.last)) row.last = used;
    row.count += 1;
    rows.set(grant.host, row);
  }
  const ordered = [...rows.values()].sort(
    (a, b) => Number(b.editor) - Number(a.editor) || (b.last ?? 0) - (a.last ?? 0)
  );
  const width = Math.max(...ordered.map((row) => row.name.length)) + 2;
  return ordered.map(
    (row) =>
      `${row.name.padEnd(width)}signed in, last used ${relativeTime(row.last, now)} (${row.count} sign-in${row.count === 1 ? '' : 's'})`
  );
}

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
