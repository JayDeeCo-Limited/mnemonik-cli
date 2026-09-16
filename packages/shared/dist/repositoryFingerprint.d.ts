/** Only this hash/version pair may be sent to or stored by the server. */
export interface RepositoryFingerprint {
    algorithmVersion: 1;
    hash: string;
}
export type RemoteRejectionReason = 'invalid_remote' | 'unsupported_transport' | 'local_remote' | 'scp_unreviewed_remote' | 'https_userinfo' | 'ssh_password' | 'ssh_user_required' | 'invalid_ssh_user' | 'invalid_host' | 'invalid_port' | 'invalid_encoding' | 'escaped_separator' | 'control_character' | 'backslash' | 'empty_segment' | 'dot_segment';
export type RemoteResult = (RepositoryFingerprint & {
    canonical: string;
}) | {
    status: 'rejected';
    reason: RemoteRejectionReason;
};
export interface RepositoryProviderRule {
    readonly name: string;
    readonly host: string;
    readonly sshUser: string;
    readonly removeTerminalDotGit: boolean;
}
/** Registry changes require review and golden cases; changed v1 outputs require v2. */
export declare const REPOSITORY_PROVIDER_RULES: readonly RepositoryProviderRule[];
/** Parse the raw path ourselves: WHATWG URL would silently resolve dot segments. */
export declare function canonicalizeRemote(url: string, { providerRules, }?: {
    providerRules?: readonly RepositoryProviderRule[];
}): RemoteResult;
export interface RepositoryRemote {
    name: string;
    fetchUrls: readonly string[];
    pushUrls?: readonly string[];
}
export type RemoteSelection = {
    status: 'fingerprint';
    remote: string;
    fingerprint: RepositoryFingerprint & {
        canonical: string;
    };
} | {
    status: 'none';
    reason: 'no_remote' | 'no_fetch_url';
} | {
    status: 'rejected';
    remote: string;
    reason: RemoteRejectionReason;
} | {
    status: 'choice_required';
    reason: 'multiple_remotes' | 'different_urls';
    remotes: string[];
};
/** Choice results carry names, never credential-bearing URLs. No URL is guessed. */
export declare function selectRemote(remotes: readonly RepositoryRemote[]): RemoteSelection;
//# sourceMappingURL=repositoryFingerprint.d.ts.map