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
import { type ReadinessCondition, type resolveProjectIdentity } from '@mnemonik/shared';
import { type ScannerPickerResult } from './scanner/picker.js';
import { type InstallDependencies } from './install/transaction.js';
import { type StatusDocumentInput } from './status.js';
import { type DiagnosticsDependencies } from './diagnostics.js';
export declare const connectFolderPrompt: (name: string) => string;
export declare const removeFolderPrompt: (name: string) => string;
export declare const connectedFolderLine: (name: string) => string;
export declare const removedFolderLine: (name: string) => string;
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
    scannerStatus?: () => Promise<ScannerPickerResult>;
    installationConditions?: readonly ReadinessCondition[];
    projectHookConditions?: readonly ReadinessCondition[];
    configuredHosts?: readonly string[];
    statusGeneratedAt?: string;
    statusDetails?: StatusDocumentInput['details'];
    codexTrustConditions?: () => Promise<readonly ReadinessCondition[]>;
    diagnostics?: DiagnosticsDependencies;
}
export declare function runCli(args: string[], deps?: CliDependencies): Promise<number>;
//# sourceMappingURL=router.d.ts.map