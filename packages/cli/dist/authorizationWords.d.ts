import type { McpAuthorization } from './auth/status.js';
import type { StoredAuthorization, UnreadableReason } from './auth/storedAuthorization.js';
/**
 * The words for each separately authorized part of Mnemonik on a computer, so
 * `status`, `connect` and `auth status` name the same part the same way:
 *
 * - "<Tool> MCP": the MCP connection inside the coding tool, authorized in the
 *   tool itself (Claude Code: /mcp; Codex: codex mcp login; Cursor: Settings, MCPs).
 * - "<Tool> hooks": the hooks the installer set up, with an authorization of their own.
 * - "Scanner": background indexing, with an authorization of its own.
 * - "CLI": the mnemonik command's own sign-in.
 *
 * Each line says the state, and when something was not checked, what was not
 * and why, in words a person can act on.
 */
/** How the person authorizes a tool's MCP connection: the step inside the tool, or the command. */
export declare function authorizeStep(host: string): string;
/** Why a tool's own store could not be read, said after "because". */
export declare function unreadableBecause(tool: string, reason: UnreadableReason | undefined): string;
/**
 * What a tool's own store on this computer adds to the server's record, as
 * whole sentences: nothing when it holds a usable authorization, or keeps
 * nothing Mnemonik reads.
 */
export declare function storeNote(tool: string, stored: StoredAuthorization | undefined): string;
/**
 * One coding tool's MCP authorization, as the line `status` and `connect`
 * print. A tool never authorized here carries its step unless `step` is false
 * (connect prints the steps below it); one whose authorization ended has its
 * step in the installation's attention lines.
 */
export declare function mcpLine(tool: string, host: string, mcp: McpAuthorization, step?: boolean): string;
/** The reason of the installation's attention line for a tool whose MCP authorization ended. */
export declare const mcpNotAuthorizedReason: (tool: string) => string;
/**
 * The hooks' authorization on this computer: their own credential stored here
 * (not expired), their declaration in the tool's settings, and for Codex its
 * trust in them. The server's record of it is not asked.
 */
export type HooksState = 'authorized' | 'trust_pending' | 'not_authorized' | 'not_installed' | 'unchecked';
/** The reason of the installation's attention line for hooks whose own authorization is gone. */
export declare const hooksNotAuthorizedReason: (tool: string) => string;
/**
 * One coding tool's hooks, as the line `status` prints. `stepped`: the
 * installation's attention lines already give the step, so the line says only
 * what is wrong.
 */
export declare function hooksLine(tool: string, state: HooksState, stepped: boolean): string;
/**
 * Background indexing's own authorization: its credential stored here (not
 * expired) and no refusal reported by the running scanner.
 */
export type ScannerAuthorizationState = 'authorized' | 'refused' | 'not_authorized' | 'unchecked' | 'not_set_up';
export declare function scannerLine(state: ScannerAuthorizationState, stepped: boolean): string;
/** The CLI's own sign-in on this computer. */
export type CliSignIn = {
    state: 'signed_in';
    email: string | null;
} | {
    state: 'unconfirmed';
} | {
    state: 'not_signed_in';
} | {
    state: 'signed_out';
} | {
    state: 'locked';
};
export declare function cliLine(cli: CliSignIn): string;
//# sourceMappingURL=authorizationWords.d.ts.map