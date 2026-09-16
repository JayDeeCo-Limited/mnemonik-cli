export type ClaudeBaseUrlState = {
    kind: 'absent';
} | {
    kind: 'value';
    value: string;
};
export type ClaudeProxyStatus = 'on' | 'off' | 'custom' | 'not-paired' | 'invalid';
export interface ClaudeProxySettingsOptions {
    homeDir?: string;
    settingsPath?: string;
    configPath?: string;
}
export type ClaudeProxyPairingConfig = Record<string, unknown> & {
    server: string;
    proxyToken: string;
};
export interface ClaudeProxyMutationResult {
    changed: boolean;
    handoffCleanupUnconfirmed: boolean;
}
export interface ClaudeProxyOffResult extends ClaudeProxyMutationResult {
    outcome: 'disabled' | 'already-off';
}
export interface ClaudeProxyOnResult extends ClaudeProxyMutationResult {
    outcome: 'enabled' | 'already-on';
}
export declare class ClaudeProxyConflictError extends Error {
    constructor();
}
export declare class ClaudeProxySettingsError extends Error {
    constructor();
}
export declare class ClaudeProxyNotPairedError extends Error {
    constructor();
}
export declare function buildClaudeProxyUrl(server: string, proxyToken: string): string;
export declare function stageClaudeProxyPairingConfig(nextConfig: ClaudeProxyPairingConfig, options?: ClaudeProxySettingsOptions): Promise<void>;
export declare function assertClaudeProxyCanBeConfigured(options?: ClaudeProxySettingsOptions): Promise<void>;
export declare function configureClaudeProxy(server: string, proxyToken: string, options?: ClaudeProxySettingsOptions): Promise<ClaudeProxyMutationResult>;
export declare function turnClaudeProxyOff(options?: ClaudeProxySettingsOptions): Promise<ClaudeProxyOffResult>;
export declare function turnClaudeProxyOn(options?: ClaudeProxySettingsOptions): Promise<ClaudeProxyOnResult>;
export declare function getClaudeProxyStatus(options?: ClaudeProxySettingsOptions): Promise<ClaudeProxyStatus>;
export declare function formatClaudeProxyStatus(status: ClaudeProxyStatus): string;
export declare function formatClaudeProxyCleanupWarning(result: ClaudeProxyMutationResult): string | null;
//# sourceMappingURL=claudeProxySettings.d.ts.map