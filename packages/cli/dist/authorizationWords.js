import { CODING_TOOL_SIGN_IN } from '@mnemonik/shared';
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
export function authorizeStep(host) {
    const signIn = CODING_TOOL_SIGN_IN[host];
    return signIn && 'step' in signIn ? signIn.step : `Run mnemonik connect ${host}.`;
}
/** The step to run status where the Keychain can be read. */
const TERMINAL_ON_MAC = 'Run mnemonik status in Terminal on the Mac to check it.';
const KEYCHAIN_LOCKED = 'the macOS Keychain is locked in this session, as it is over SSH';
/** Why a tool's own store could not be read, said after "because". */
export function unreadableBecause(tool, reason) {
    switch (reason) {
        case 'keychain_locked':
            return KEYCHAIN_LOCKED;
        case 'keychain_unreadable':
            return 'the macOS Keychain could not be read';
        case 'credential_manager':
            return `${tool} keeps it in Windows Credential Manager, which Mnemonik does not read`;
        case 'custom_folder':
            return `CLAUDE_CONFIG_DIR keeps ${tool}'s files in a folder Mnemonik does not read`;
        case 'macos_keychain':
            return `${tool} keeps it in the macOS Keychain, which Mnemonik does not read`;
        case 'system_keyring':
            return `${tool} keeps it in the system keyring, which Mnemonik does not read`;
        case 'database_unreadable':
            return `${tool}'s settings database could not be read`;
        case 'remote':
        case 'not_on_this_computer':
            return `${tool}'s own settings are not on this computer`;
        default:
            return `${tool}'s credentials file could not be read`;
    }
}
/** Why the server's record could not be asked, said after "because". */
function serverBecause(problem) {
    return problem === 'cli_not_signed_in'
        ? 'the CLI is not signed in'
        : problem === 'cli_locked'
            ? 'the CLI sign-in is in the macOS Keychain, which is locked in this session'
            : 'Mnemonik could not be reached';
}
/**
 * What a tool's own store on this computer adds to the server's record, as
 * whole sentences: nothing when it holds a usable authorization, or keeps
 * nothing Mnemonik reads.
 */
export function storeNote(tool, stored) {
    if (stored?.state === 'missing')
        return `${tool} holds none on this computer.`;
    if (stored?.state !== 'unreadable')
        return '';
    if (stored.reason === 'remote' || stored.reason === 'not_on_this_computer')
        return `${tool} keeps its authorization on the computer it runs on, not on this one, so it was not checked here.`;
    return `${tool}'s copy on this computer could not be checked because ${unreadableBecause(tool, stored.reason)}.${stored.reason === 'keychain_locked' ? ` ${TERMINAL_ON_MAC}` : ''}`;
}
/**
 * One coding tool's MCP authorization, as the line `status` and `connect`
 * print. A tool never authorized here carries its step unless `step` is false
 * (connect prints the steps below it); one whose authorization ended has its
 * step in the installation's attention lines.
 */
export function mcpLine(tool, host, mcp, step = true) {
    const label = `${tool} MCP:`;
    const locked = mcp.stored?.reason === 'keychain_locked';
    switch (mcp.state) {
        case 'authorized':
            return `${label} authorized.`;
        case 'authorized_elsewhere':
            return `${label} authorized in ${tool} on another of your computers.`;
        case 'not_authorized':
            return mcp.reason === 'revoked_or_expired'
                ? `${label} not authorized. Its authorization on this computer was revoked or has expired.`
                : mcp.reason === 'not_held'
                    ? `${label} not authorized. ${tool} no longer holds the authorization Mnemonik lists for this computer.`
                    : `${label} not authorized.${step ? ` ${authorizeStep(host)}` : ''}`;
        case 'store_unchecked':
            return `${label} Mnemonik lists it as authorized. ${storeNote(tool, mcp.stored)}`;
        case 'server_unchecked':
            return `${label} ${tool} holds an authorization on this computer, but ${mcp.serverProblem === 'cli_not_signed_in' || mcp.serverProblem === 'cli_locked'
                ? `it could not be confirmed because ${serverBecause(mcp.serverProblem)}.`
                : 'Mnemonik could not be reached to confirm it.'}${mcp.serverProblem === 'cli_locked' ? ` ${TERMINAL_ON_MAC}` : ''}`;
        default: {
            if (mcp.serverProblem === 'cli_locked' && locked)
                return `${label} could not be checked because ${KEYCHAIN_LOCKED}. ${TERMINAL_ON_MAC}`;
            const note = storeNote(tool, mcp.stored);
            const hint = mcp.serverProblem === 'cli_locked' && !note.includes(TERMINAL_ON_MAC)
                ? ` ${TERMINAL_ON_MAC}`
                : '';
            return `${label} could not be checked because ${serverBecause(mcp.serverProblem)}.${note ? ` ${note}` : ''}${hint}`;
        }
    }
}
/** The reason of the installation's attention line for a tool whose MCP authorization ended. */
export const mcpNotAuthorizedReason = (tool) => `${tool} MCP is not authorized on this computer.`;
/** The reason of the installation's attention line for hooks whose own authorization is gone. */
export const hooksNotAuthorizedReason = (tool) => `${tool} hooks are not authorized on this computer.`;
/**
 * One coding tool's hooks, as the line `status` prints. `stepped`: the
 * installation's attention lines already give the step, so the line says only
 * what is wrong.
 */
export function hooksLine(tool, state, stepped) {
    const step = stepped ? '' : ' Run mnemonik repair.';
    switch (state) {
        case 'authorized':
            return `${tool} hooks: authorized.`;
        case 'trust_pending':
            return `${tool} hooks: waiting for you to trust them in ${tool}.`;
        case 'not_authorized':
            return `${tool} hooks: not authorized. Their authorization is missing from this computer or has expired.${step}`;
        case 'not_installed':
            return `${tool} hooks: not installed.${step}`;
        default:
            return `${tool} hooks: could not be checked because they do not say which authorization they use.`;
    }
}
export function scannerLine(state, stepped) {
    const step = stepped ? '' : ' Run mnemonik repair.';
    switch (state) {
        case 'authorized':
            return 'Scanner: authorized.';
        case 'refused':
            return `Scanner: not authorized. Mnemonik no longer accepts its authorization.${step}`;
        case 'not_authorized':
            return `Scanner: not authorized. Its authorization is missing from this computer or has expired.${step}`;
        case 'unchecked':
            return 'Scanner: could not be checked because its settings do not say which authorization it uses.';
        default:
            return 'Scanner: not set up on this computer.';
    }
}
export function cliLine(cli) {
    switch (cli.state) {
        case 'signed_in':
            return cli.email ? `CLI: signed in as ${cli.email}.` : 'CLI: signed in.';
        case 'unconfirmed':
            return 'CLI: signed in on this computer, but Mnemonik could not be reached to confirm it.';
        case 'not_signed_in':
            return 'CLI: not signed in. Run mnemonik auth login.';
        case 'signed_out':
            return 'CLI: signed out. Mnemonik no longer accepts its sign-in. Run mnemonik auth renew.';
        default:
            return `CLI: could not be checked because its sign-in is in the macOS Keychain, which is locked in this session, as it is over SSH. ${TERMINAL_ON_MAC}`;
    }
}
//# sourceMappingURL=authorizationWords.js.map