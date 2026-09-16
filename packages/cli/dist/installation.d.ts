type Account = {
    account: string;
    email?: string;
};
/** Account identities survive credentials and component uninstall. */
export declare function saveInstallation(stateDir: string, deviceInstallationId: string, account?: Account): Promise<void>;
export declare function readInstallation(stateDir: string, account?: string): Promise<string | undefined>;
/** Ordered hints only; the server selects ownership using the browser account. */
export declare function readInstallations(stateDir: string): Promise<string[]>;
export {};
//# sourceMappingURL=installation.d.ts.map