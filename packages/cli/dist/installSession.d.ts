import { type ReadinessDocument, type ReadinessDocumentInput } from '@mnemonik/shared';
import type { Output } from './output.js';
export type InstallSummary = ReadinessDocumentInput & {
    steps: Array<{
        name: string;
        status: 'READY' | 'LIMITED' | 'ACTION_REQUIRED' | 'FAILED' | 'not_implemented';
        action?: string;
        owner?: string;
    }>;
};
export interface InstallSessionTransport {
    getCurrent(): Promise<{
        id: string;
    }>;
    complete(id: string, readiness: ReadinessDocument): Promise<void>;
}
export type InstallSessionReport = {
    status: 'not_signed_in';
} | {
    status: 'not_ready';
    id: string;
} | {
    status: 'completed';
    id: string;
} | {
    status: 'report_failed';
    reason: string;
};
export declare const serializeInstallReadiness: (input: Omit<InstallSummary, 'steps'>) => ReadinessDocument;
export declare function createHttpInstallSessionTransport(accessToken: string, fetcher?: typeof globalThis.fetch, apiUrl?: string): InstallSessionTransport;
export declare function postCurrentReadiness(accessToken: string, readiness: ReadinessDocument, fetcher?: typeof globalThis.fetch, apiUrl?: string): Promise<void>;
export declare function reportInstall(input: InstallSummary, output: Output, transport?: InstallSessionTransport, json?: boolean): Promise<InstallSessionReport>;
//# sourceMappingURL=installSession.d.ts.map