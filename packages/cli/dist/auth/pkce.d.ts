import { spawn } from 'node:child_process';
import { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { CliTokenResponse } from '@mnemonik/credentials';
export declare class OAuthProtocolError extends Error {
    readonly code: string;
    constructor(code: string, message?: string);
}
export declare class BrowserUnavailableError extends Error {
}
export interface PkceOptions {
    scannerRoots?: string;
    deviceInstallationId?: string;
    deviceInstallationIds?: string[];
    deviceName?: string;
    issuer: string;
    resource: string;
    scopes: readonly string[];
    clientId: string | ((redirectUri: string) => Promise<string>);
    print: (line: string) => void;
    fetch?: typeof fetch;
    openBrowser?: (url: string) => Promise<void>;
    platform?: NodeJS.Platform;
    preferredPort?: number;
    timeoutMs?: number;
    random?: (size: number) => Buffer;
    createServer?: (requestListener: (request: IncomingMessage, response: ServerResponse) => void) => Server;
}
export interface PkceResult {
    clientId: string;
    tokens: CliTokenResponse;
    redirectUri: string;
    authorizeUrl: string;
}
export declare const browserFallbackLines: (url: string) => [string, string];
export declare function open(url: string, platform: NodeJS.Platform): Promise<void>;
export declare const EDITOR_SIGN_IN_INSTRUCTION = "Open this link to sign in:";
export interface EditorLoginOptions {
    /** The editor's own headless login command. */
    command: readonly string[];
    apiOrigin: string;
    /** Only an authorize URL from this origin is shown and polled for. */
    issuer: string;
    bearer: () => Promise<string>;
    print: (line: string) => void;
    spawn?: typeof spawn;
    fetch?: typeof fetch;
    sleep?: (milliseconds: number) => Promise<void>;
    now?: () => number;
    timeoutMs?: number;
    pollMs?: number;
}
export type EditorLoginOverrides = Omit<EditorLoginOptions, 'command' | 'apiOrigin' | 'issuer' | 'bearer' | 'print'>;
/**
 * Sign an editor on this machine in when the browser is on another machine.
 * The editor keeps its PKCE verifier and its loopback port; only its redirect
 * travels, collected once from the server and replayed to that port here.
 */
export declare function runEditorLogin(options: EditorLoginOptions): Promise<'signed_in' | 'not_approved' | 'failed'>;
export declare function runPkce(options: PkceOptions): Promise<PkceResult>;
//# sourceMappingURL=pkce.d.ts.map