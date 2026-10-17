import { type EnableOptions } from './scanner/enable.js';
import { type ScannerServiceOptions } from './scanner/service.js';
import { type HostDependencies, type HostResult } from './install/hosts.js';
import { type LauncherOptions } from './launcher.js';
import { type RuntimeUpdate } from './runtime/store.js';
import type { Readable } from 'node:stream';
import { type Writable } from './output.js';
import { type PreflightDependencies } from './preflight.js';
import { type InstallSessionTransport } from './installSession.js';
import { type ProjectExecutor, type ProjectReadTransport } from './project.js';
import { type ReadinessCondition, resolveProjectIdentity } from '@mnemonik/shared';
import { type ClaudeCodeStoreOptions } from './auth/claudeCodeSignIn.js';
import { type CodexStoreOptions } from './auth/codexAuthorization.js';
import { type CursorStoreOptions } from './auth/cursorAuthorization.js';
import { type EditorLoginOverrides } from './auth/pkce.js';
import { type ScannerPickerResult } from './scanner/picker.js';
import { type InstallDependencies } from './install/transaction.js';
import { type StatusDocumentInput } from './status.js';
import { type DiagnosticsDependencies } from './diagnostics.js';
export declare const connectFolderPrompt: (name: string) => string;
export declare const removeFolderPrompt: (name: string) => string;
export declare const connectedFolderLine: (name: string) => string;
export declare const alreadyConnectedFolderLine: (name: string) => string;
export declare const removedFolderLine: (name: string) => string;
export declare const projectDeletionWarning: (name: string) => string;
export declare const projectDeletedLine: (name: string) => string;
export declare const NOTHING_DELETED_LINE = "Nothing was deleted.";
export declare const NOTHING_REMOVED_LINE = "Nothing was removed.";
export declare const SCANNER_UNINSTALL_PROMPT: string;
export declare const SCANNER_REMOVED_LINE = "Background indexing removed from this machine.";
export declare const dataDeletePrompt: (projectId: string) => string;
export declare const stillWatchedLine: (root: string) => string;
export declare const identityFileKeptLine = "This folder's .mnemonik.json still points at the deleted project. Connecting the folder again creates a new project.";
export declare const CODEX_SIGNED_IN_MESSAGE = "Codex MCP: authorized.";
/** For the agent running `connect --json`: what to do with the link it was given. */
export declare const SIGN_IN_LINK_REASON = "Give this link to the person to authorize Codex MCP. This command finishes when they do.";
export declare const CONNECT_NOT_APPROVED_MESSAGE = "Codex MCP was not authorized in time. Run mnemonik connect codex to try again.";
export declare function maintenanceExitCode(results: readonly Pick<HostResult, 'status'>[]): number;
export declare const help: string;
export interface CliDependencies {
    launcher?: LauncherOptions;
    install?: InstallDependencies;
    hostManagement?: HostDependencies;
    installStateDir?: string;
    runtimeUpdate?: RuntimeUpdate;
    input?: Readable;
    stdout?: Writable;
    stderr?: Writable;
    cwd?: string;
    home?: string;
    width?: number;
    preflight?: PreflightDependencies;
    projectExecutor?: ProjectExecutor;
    projectResolver?: {
        resolveProjectIdentity: typeof resolveProjectIdentity;
    };
    projectStateDir?: string;
    getCliBearer?: () => Promise<string | undefined>;
    projectTransport?: ProjectReadTransport;
    interruptedProjectSetup?: boolean;
    installSession?: InstallSessionTransport;
    grantFetch?: typeof fetch;
    editorLogin?: EditorLoginOverrides;
    cliAuth?: {
        signIn(): Promise<unknown>;
        getCliBearer(): Promise<string | {
            status: string;
            reason: string;
        }>;
        accountEmail?(bearer: string): Promise<string>;
        logout(): Promise<void>;
    };
    identityStateDir?: string;
    scannerService?: ScannerServiceOptions;
    scannerEnable?: Partial<EnableOptions>;
    /** The disclosure version the scanner this CLI installs expects; the bundled release manifest by default. */
    scannerDisclosureVersion?: () => Promise<string | undefined>;
    scannerStatus?: () => Promise<ScannerPickerResult>;
    installationConditions?: readonly ReadinessCondition[];
    projectHookConditions?: readonly ReadinessCondition[];
    configuredHosts?: readonly string[];
    statusGeneratedAt?: string;
    statusDetails?: StatusDocumentInput['details'];
    codexTrustConditions?: () => Promise<readonly ReadinessCondition[]>;
    diagnostics?: DiagnosticsDependencies;
    /** Where Claude Code's own stored authorization is read: this platform, environment and Keychain by default. */
    claudeCodeStore?: Omit<ClaudeCodeStoreOptions, 'home'>;
    /** Where Codex's own stored authorization is read: this platform and environment by default. */
    codexStore?: Omit<CodexStoreOptions, 'home'>;
    /** Where Cursor's own stored authorization is read: this platform, environment and node:sqlite by default. */
    cursorStore?: Omit<CursorStoreOptions, 'home'>;
    /** `hooks log --follow` stops when this aborts (Ctrl-C by default); the clock and pid probe for tests. */
    hooksLog?: {
        signal?: AbortSignal;
        pollMs?: number;
        alive?: (pid: number) => boolean;
        now?: () => number;
    };
}
export declare function runCli(args: string[], deps?: CliDependencies): Promise<number>;
//# sourceMappingURL=router.d.ts.map