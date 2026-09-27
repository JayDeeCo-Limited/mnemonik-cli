import type { HostName } from './hostAdapter.js';

/**
 * Which coding tool an MCP sign-in (an OAuth grant) belongs to. The one mapping
 * read by the server's machine health, the console's device card and the CLI:
 * the registered software id first, then the client name, then the host of a
 * metadata-document client id. Display metadata is self-asserted, so this names
 * a tool for reporting only; it is never evidence of account ownership.
 */
const BY_NAME: Readonly<Record<string, HostName>> = {
  'claude code': 'claude-code',
  'claude-code': 'claude-code',
  codex: 'codex',
  'codex cli': 'codex',
  cursor: 'cursor',
  grok: 'grok',
  'grok build': 'grok',
  'github copilot': 'vscode-copilot',
  'vs code copilot': 'vscode-copilot',
  'vscode-copilot': 'vscode-copilot',
};
const BY_CLIENT_HOST: Readonly<Record<string, HostName>> = {
  'claude.ai': 'claude-code',
  'chatgpt.com': 'codex',
};

export interface GrantClient {
  clientId: string;
  clientName?: string | null;
  softwareId?: string | null;
}

export function hostForGrantClient(client: GrantClient): HostName | undefined {
  return (
    BY_NAME[client.softwareId?.toLowerCase() ?? ''] ??
    BY_NAME[client.clientName?.toLowerCase() ?? ''] ??
    BY_CLIENT_HOST[URL.canParse(client.clientId) ? new URL(client.clientId).hostname : '']
  );
}

/** The coding tools' own names, as a person reads them. */
export const CODING_TOOL_NAMES: Readonly<Record<HostName, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  grok: 'Grok',
  'vscode-copilot': 'VS Code Copilot',
};

/**
 * How each launch coding tool signs in to Mnemonik's MCP. `connect`:
 * `mnemonik connect <tool>` drives the tool's own headless login (Codex:
 * `codex mcp login mnemonik`), prints the approval link and waits, so an agent
 * with a terminal runs it and hands the person the link. `in_tool`: only the
 * person can, inside the coding tool (Claude Code refuses OAuth login on piped
 * stdin; Cursor has no login command); `step` is that step in plain words.
 */
export type CodingToolSignIn = { kind: 'connect' } | { kind: 'in_tool'; step: string };
export const CODING_TOOL_SIGN_IN: Readonly<
  Record<'claude-code' | 'codex' | 'cursor', CodingToolSignIn>
> = {
  'claude-code': {
    kind: 'in_tool',
    step: 'In Claude Code, type /mcp, choose mnemonik, then Authenticate.',
  },
  codex: { kind: 'connect' },
  cursor: {
    kind: 'in_tool',
    step: 'In Cursor, open Cursor Settings, Customize, MCPs, then Authenticate.',
  },
};
