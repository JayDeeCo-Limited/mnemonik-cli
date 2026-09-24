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
/** How recently a sign-in on another machine must have been used to count here. */
export declare const SIGNED_IN_ELSEWHERE_WITHIN_MS: number;
/**
 * An editor that opens this machine remotely (Cursor on a Mac over SSH) signs in
 * where it runs, while its hooks run here. A sign-in for the host on another of
 * the account's installations, activated and used within the last day, is that
 * editor's sign-in, for the editors above only (L-182; the server's
 * computeMachineHealth reads the same rule).
 * The listing already leaves out revoked grants.
 */
export declare function signedInElsewhere(status: GrantStatus, host: HostName, now?: number): boolean;
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