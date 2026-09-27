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
    /**
     * When the coding tool last renewed this sign-in (about once an hour while it
     * is in use); the server does not record each MCP request. Dates use only.
     */
    lastUsedAt: string | null;
    /** When the sign-in's refresh token expires; absent from older servers. */
    expiresAt?: string | null;
    /** The coding tool, by the shared mapping; absent from older servers. */
    host?: string | null;
    /**
     * The console's validity rule, decided by the server: `connected` is a
     * valid sign-in. Absent from older servers, which listed only unrevoked ones.
     */
    status?: 'connected' | 'disconnected' | 'expired' | 'incomplete';
}
export interface GrantStatus {
    deviceInstallationId?: string | null;
    account: string;
    /** The account's email, sent with the grants; the CLI reads it for sign-in too. */
    email?: string;
    grants: AccountGrant[];
}
export declare const grantHost: (grant: AccountGrant) => HostName | undefined;
/** A sign-in that works: the server's status, or activated on a server too old to say. */
export declare const validGrant: (grant: AccountGrant) => boolean;
/**
 * An editor that opens this machine remotely (Cursor on a Mac over SSH) signs in
 * where it runs, while its hooks run here. A valid sign-in for the host on
 * another of the account's installations is that editor's sign-in, for the
 * editors above only (L-182; the server's computeMachineHealth reads the same
 * rule). How long ago it was used says nothing about whether it is valid.
 */
export declare function signedInElsewhere(status: GrantStatus, host: HostName): boolean;
export type CodingToolSignInState = 'signed_in' | 'signed_in_elsewhere' | 'signed_out' | 'not_set_up';
/**
 * One coding tool's sign-in on this machine, from the server's listing of this
 * installation's sign-ins (`?installation=current`, revoked ones included).
 * Signed out only when it had sign-ins here and none of them is valid; never
 * because of idle time. `everywhere`, the account-wide listing, is read only
 * for editors that can sign in on another machine.
 */
export declare function codingToolSignIn(host: HostName, here: GrantStatus, everywhere?: GrantStatus): {
    state: CodingToolSignInState;
    lastUsedAt: string | null;
};
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
    /** Every machine's unrevoked sign-ins, or with `here` every sign-in on this one. */
    list(options?: {
        here?: boolean;
    }): Promise<GrantStatus>;
    revoke(id: string): Promise<void>;
};
export type GrantTransport = ReturnType<typeof grantTransport>;
//# sourceMappingURL=status.d.ts.map