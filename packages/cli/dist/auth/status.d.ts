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
export declare const grantHost: (grant: AccountGrant) => HostName;
export declare function grantTransport(getBearer: () => Promise<string>, fetcher?: typeof fetch): {
    list(): Promise<GrantStatus>;
    revoke(id: string): Promise<void>;
};
export type GrantTransport = ReturnType<typeof grantTransport>;
//# sourceMappingURL=status.d.ts.map