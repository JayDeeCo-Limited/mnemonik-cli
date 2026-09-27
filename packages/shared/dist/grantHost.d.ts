import type { HostName } from './hostAdapter.js';
export interface GrantClient {
    clientId: string;
    clientName?: string | null;
    softwareId?: string | null;
}
export declare function hostForGrantClient(client: GrantClient): HostName | undefined;
/** The coding tools' own names, as a person reads them. */
export declare const CODING_TOOL_NAMES: Readonly<Record<HostName, string>>;
/**
 * How each launch coding tool signs in to Mnemonik's MCP. `connect`:
 * `mnemonik connect <tool>` drives the tool's own headless login (Codex:
 * `codex mcp login mnemonik`), prints the approval link and waits, so an agent
 * with a terminal runs it and hands the person the link. `in_tool`: only the
 * person can, inside the coding tool (Claude Code refuses OAuth login on piped
 * stdin; Cursor has no login command); `step` is that step in plain words.
 */
export type CodingToolSignIn = {
    kind: 'connect';
} | {
    kind: 'in_tool';
    step: string;
};
export declare const CODING_TOOL_SIGN_IN: Readonly<Record<'claude-code' | 'codex' | 'cursor', CodingToolSignIn>>;
//# sourceMappingURL=grantHost.d.ts.map