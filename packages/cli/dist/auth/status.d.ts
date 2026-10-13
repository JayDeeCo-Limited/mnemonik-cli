import type { HostName } from '@mnemonik/shared';
import type { StoredAuthorization } from './storedAuthorization.js';
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
/**
 * A coding tool's MCP authorization on this machine as the server records it.
 * `authorized_elsewhere`: valid on another of the account's computers, for the
 * tools that can run there while their hooks run here (Cursor over SSH).
 */
export type ServerAuthorizationState = 'authorized' | 'authorized_elsewhere' | 'revoked_or_expired' | 'never_authorized';
/**
 * One coding tool's MCP authorization on this machine, from the server's
 * listing of this installation's grants (`?installation=current`, revoked ones
 * included). Revoked or expired only when it had grants here and none of them
 * is valid; never because of idle time. `everywhere`, the account-wide
 * listing, is read only for tools that can run on another machine.
 */
export declare function serverAuthorization(host: HostName, here: GrantStatus, everywhere?: GrantStatus): {
    state: ServerAuthorizationState;
    lastUsedAt: string | null;
};
/** Why the server's record could not be asked: the CLI's own sign-in (absent, or locked in the macOS Keychain), or the network. */
export type ServerProblem = 'cli_not_signed_in' | 'cli_locked' | 'unreachable';
/**
 * A coding tool's MCP authorization on this computer, from both sides:
 *
 * - `authorized`: the server holds a valid grant and the tool's own store holds
 *   a usable token (or the tool keeps nothing Mnemonik reads).
 * - `authorized_elsewhere`: valid on the computer the tool runs on (Cursor over SSH).
 * - `not_authorized`: nothing usable here; `reason` says which side decided.
 * - `store_unchecked`: the server holds a valid grant; the tool's store on this
 *   computer could not be read (`stored.reason` says why).
 * - `server_unchecked`: the tool's store holds a usable token; the server could
 *   not be asked (`serverProblem` says why).
 * - `unchecked`: neither side could be read.
 */
export type McpState = 'authorized' | 'authorized_elsewhere' | 'not_authorized' | 'store_unchecked' | 'server_unchecked' | 'unchecked';
/**
 * Why a tool is not authorized: its grant here was revoked or expired; the
 * server holds a valid grant the tool no longer has (2026-10-12); or it was
 * never authorized on this computer.
 */
export type NotAuthorizedReason = 'revoked_or_expired' | 'not_held' | 'never_authorized';
export interface McpAuthorization {
    state: McpState;
    reason?: NotAuthorizedReason;
    /** The server's record; `unknown` when it could not be asked. */
    server: ServerAuthorizationState | 'unknown';
    serverProblem?: ServerProblem;
    /** What the tool itself stores here; absent when it keeps nothing Mnemonik reads. */
    stored?: StoredAuthorization;
    /** When the tool last renewed its grant; dates use, never decides it. */
    lastUsedAt: string | null;
}
/**
 * The server decides revoked or expired; only the tool's own store can say the
 * tool still holds what the server lists (2026-10-12 outage). A store that
 * cannot be read, or a server that cannot be asked, vouches for nothing, and
 * the state says which side was not checked.
 */
export declare function mcpAuthorization(server: {
    state: ServerAuthorizationState;
    lastUsedAt: string | null;
} | undefined, stored: StoredAuthorization | undefined, serverProblem?: ServerProblem): McpAuthorization;
/** "just now", "5 minutes ago", "1 hour ago", "3 days ago", or "never". */
export declare function relativeTime(time: number | null, now: number): string;
/** The CLI's own grants carry this client name; their rows are sign-ins, not authorizations. */
export declare const CLI_CLIENT_NAME = "Mnemonik CLI";
/**
 * One row per part for plain `auth status`, across all of the account's
 * computers: coding tools' MCP connections first ("Claude Code MCP"), then the
 * rest, each by most recent use; the CLI's own grants are sign-ins ("CLI").
 * Grant ids, dates and scopes are for --json. `onThisComputer` adds what the
 * tool itself stores on this computer to its row.
 */
export declare function grantSummaryLines(grants: readonly (AccountGrant & {
    host: string;
})[], tools: Readonly<Record<string, string>>, now?: number, onThisComputer?: Readonly<Record<string, (summary: string) => string>>): string[];
export declare function grantTransport(getBearer: () => Promise<string>, fetcher?: typeof fetch): {
    /** Every machine's unrevoked sign-ins, or with `here` every sign-in on this one. */
    list(options?: {
        here?: boolean;
    }): Promise<GrantStatus>;
    revoke(id: string): Promise<void>;
};
export type GrantTransport = ReturnType<typeof grantTransport>;
//# sourceMappingURL=status.d.ts.map