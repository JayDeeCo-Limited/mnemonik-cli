/**
 * Which coding tool an MCP sign-in (an OAuth grant) belongs to. The one mapping
 * read by the server's machine health, the console's device card and the CLI:
 * the registered software id first, then the client name, then the host of a
 * metadata-document client id. Display metadata is self-asserted, so this names
 * a tool for reporting only; it is never evidence of account ownership.
 */
const BY_NAME = {
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
const BY_CLIENT_HOST = {
    'claude.ai': 'claude-code',
    'chatgpt.com': 'codex',
};
export function hostForGrantClient(client) {
    return (BY_NAME[client.softwareId?.toLowerCase() ?? ''] ??
        BY_NAME[client.clientName?.toLowerCase() ?? ''] ??
        BY_CLIENT_HOST[URL.canParse(client.clientId) ? new URL(client.clientId).hostname : '']);
}
/** The coding tools' own names, as a person reads them. */
export const CODING_TOOL_NAMES = {
    'claude-code': 'Claude Code',
    codex: 'Codex',
    cursor: 'Cursor',
    grok: 'Grok',
    'vscode-copilot': 'VS Code Copilot',
};
export const CODING_TOOL_SIGN_IN = {
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
//# sourceMappingURL=grantHost.js.map