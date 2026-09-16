import type { Grant, HostName, Inspection } from '@mnemonik/shared';
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
export declare const grantHost: (grant: AccountGrant) => HostName;
export declare function grantTransport(getBearer: () => Promise<string>, fetcher?: typeof fetch): {
    list(): Promise<GrantStatus>;
    approveHost(id: string): Promise<string>;
    revoke(id: string): Promise<void>;
};
export type GrantTransport = ReturnType<typeof grantTransport>;
/** Native clients can renew into another grant while the installed host stays connected. */
export declare function bindInstalledHostGrants(listing: GrantStatus, installedHosts: readonly HostName[], transport: GrantTransport): Promise<void>;
export declare function matchHostGrant(status: Inspection, host: HostName, account: string, transport: GrantTransport, attemptStartedAt: number, recorded?: Grant, approve?: () => Promise<boolean>, approvalMode?: 'all' | 'recovered'): Promise<Inspection>;
//# sourceMappingURL=status.d.ts.map