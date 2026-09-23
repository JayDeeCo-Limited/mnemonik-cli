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
export declare const grantHost: (grant: AccountGrant) => HostName;
/** "just now", "5 minutes ago", "1 hour ago", "3 days ago", or "never". */
export declare function relativeTime(time: number | null, now: number): string;
/**
 * One line per host for plain `auth status`: editors first, then the rest,
 * each by most recent use. Grant ids, dates and scopes are for --json.
 */
export declare function grantSummaryLines(grants: readonly (AccountGrant & {
    host: string;
})[], editors: Readonly<Record<string, string>>, now?: number): string[];
export declare function grantTransport(getBearer: () => Promise<string>, fetcher?: typeof fetch): {
    list(): Promise<GrantStatus>;
    revoke(id: string): Promise<void>;
};
export type GrantTransport = ReturnType<typeof grantTransport>;
//# sourceMappingURL=status.d.ts.map