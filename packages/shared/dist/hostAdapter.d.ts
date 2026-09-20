import { type WindowsBinary } from './hostBinary.js';
export type HostName = 'claude-code' | 'codex' | 'cursor' | 'grok' | 'vscode-copilot';
export interface Target {
    component: 'hooks' | 'mcp';
    scope: 'user' | 'project';
    projectRoot?: string;
    /** Absolute dispatcher path, already verified by the CLI runtime store. */
    runtimeEntry: string;
    /** CLI artifact directory containing current and versioned manifests. */
    runtimeRoot: string;
    /** Non-secret hook component family recorded by the CLI installer. */
    credentialFamily: string;
    /** Machine identity written only to user-scope MCP declarations. */
    installationId?: string;
    /** Config paths known to have been absent before Mnemonik first wrote them. */
    createdFiles?: string[];
    /** Verified first-install config backups supplied by the ownership journal. */
    originalFiles?: Record<string, Buffer | null>;
}
export interface FileChange {
    path: string;
    content: Buffer;
    mode?: number;
    remove?: true;
}
export interface AdapterWriter {
    stage(change: FileChange): Promise<void>;
}
export interface Grant {
    installationId?: string;
    id: string;
    account: string;
    scopes: string[];
}
export interface Inspection {
    resolvedPath?: string;
    declarationPath?: string;
    authenticatedTools: boolean;
    grant?: Grant;
    declarationPresent: boolean;
    enableRequired?: boolean;
    trustPending?: boolean;
    trustDeclined?: boolean;
    otherScopes?: {
        scope: Target['scope'];
        path: string;
    }[];
}
export interface HostPlan {
    changes: FileChange[];
    staging: 'inactive' | 'additive';
    requestedScope: string;
    effectiveScope: string;
    version: string;
    artifactDigest: string;
}
export interface HostAdapter {
    name: HostName;
    detect(): Promise<{
        supported: boolean;
        version: string;
        reason?: string;
        resolvedPath?: string;
        searchedLocations?: string[];
    }>;
    capabilities(): {
        scopes: string[];
        revoke: boolean;
        components: Target['component'][];
        nativeConnect: boolean;
        nativeListing?: boolean;
    };
    inspect(target?: Target): Promise<Inspection>;
    plan(target?: Target): Promise<HostPlan>;
    install(writer: AdapterWriter, target: Target): Promise<void>;
    update(writer: AdapterWriter, target: Target): Promise<void>;
    repair(writer: AdapterWriter, target: Target): Promise<void>;
    /** Always return the recovery instruction, including after a native action. */
    launch(input?: {
        signedIn: boolean;
    }): Promise<string>;
    /** Run the host's native MCP enable action once and return its recovery instruction. */
    enable?(): Promise<string>;
    verify(target?: Target): Promise<Inspection>;
    uninstall(writer: AdapterWriter, target: Target): Promise<void>;
    revoke?(grant: Grant): Promise<boolean>;
    revokeAction: string;
}
export interface AdapterDependencies {
    platform?: NodeJS.Platform;
    binaryExists?: (file: string) => Promise<boolean>;
    target?: Target;
    env?: NodeJS.ProcessEnv;
    /** Verified package provenance supplied by the CLI, never inferred from config. */
    version?: string;
    artifactDigest?: string;
    execFile?: (file: string, args: string[], options: {
        env: NodeJS.ProcessEnv;
        cwd?: string;
        timeout: number;
        maxBuffer: number;
        windowsHide: boolean;
        windowsVerbatimArguments?: boolean;
    }) => Promise<{
        stdout: string;
        stderr: string;
    }>;
}
/** Common read/propose/stage lifecycle; the host's installer still owns its bytes. */
export declare function createFileHostAdapter(deps: AdapterDependencies, host: {
    name: HostName;
    binary: string;
    windowsBinary: WindowsBinary;
    vendorMatch: RegExp;
    instruction: string;
    signedInInstruction?: string;
    mcp?: {
        path(target: Target): string;
        format: 'json' | 'toml';
        type?: 'http';
        headerKey?: 'headers' | 'http_headers';
    };
    nativeConnect?: boolean;
    nativeListing?: boolean;
    desktopPaths?: string[];
    nativeEnable?: string[];
    nativeLogout?: boolean;
    revokeAction?: string;
    path(target: Target): string;
    present(target: Target): Promise<boolean>;
    changes(target: Target, install: boolean): Promise<FileChange[]>;
    classifyVersion?: (output: string) => {
        supported: boolean;
        version: string;
        reason?: string;
    };
}): HostAdapter;
//# sourceMappingURL=hostAdapter.d.ts.map