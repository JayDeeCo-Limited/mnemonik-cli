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
export declare function runPkce(options: PkceOptions): Promise<PkceResult>;
//# sourceMappingURL=pkce.d.ts.map