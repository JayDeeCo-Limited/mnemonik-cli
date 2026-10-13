import { describe, expect, it } from 'vitest';
import { mcpAuthorization, type ServerAuthorizationState } from '../src/auth/status.js';
import type { StoredAuthorization, UnreadableReason } from '../src/auth/storedAuthorization.js';
import { cliLine, hooksLine, mcpLine, scannerLine, storeNote } from '../src/authorizationWords.js';

// Each part of Mnemonik on a computer is authorized separately: each coding
// tool's MCP connection, its hooks, the scanner, and the CLI. On 2026-10-12
// "Claude Code: signed in" did not say which, and status dropped the Claude
// Code line when the Mac's Keychain was locked over SSH. Every line names its
// part, and says what was checked and what was not.

const AT = '2026-10-12T09:00:00.000Z';
const server = (state: ServerAuthorizationState) => ({
  state,
  lastUsedAt: state === 'authorized' || state === 'authorized_elsewhere' ? AT : null,
});
const stored = (state: StoredAuthorization['state'], reason?: UnreadableReason) =>
  ({
    state,
    expiresAt: null,
    ...(reason ? { reason } : {}),
  }) as StoredAuthorization;

describe("mcpAuthorization: the server record and the tool's own store together", () => {
  it('a valid grant and a usable or renewable stored token: authorized', () => {
    for (const held of [stored('authorized'), stored('renewable'), undefined])
      expect(mcpAuthorization(server('authorized'), held)).toMatchObject({
        state: 'authorized',
        server: 'authorized',
        lastUsedAt: AT,
      });
  });

  it('a valid grant and nothing stored: not authorized, not held (the 2026-10-12 outage)', () => {
    expect(mcpAuthorization(server('authorized'), stored('missing'))).toEqual({
      state: 'not_authorized',
      reason: 'not_held',
      server: 'authorized',
      stored: stored('missing'),
      lastUsedAt: null,
    });
  });

  it('a revoked or expired grant: not authorized, whatever is stored', () => {
    for (const held of [stored('authorized'), stored('unreadable', 'keychain_locked'), undefined])
      expect(mcpAuthorization(server('revoked_or_expired'), held)).toMatchObject({
        state: 'not_authorized',
        reason: 'revoked_or_expired',
      });
  });

  it('never authorized here: not authorized, whatever is stored', () => {
    for (const held of [stored('authorized'), stored('missing'), undefined])
      expect(mcpAuthorization(server('never_authorized'), held)).toMatchObject({
        state: 'not_authorized',
        reason: 'never_authorized',
      });
  });

  it('a valid grant and a store that cannot be read: the store is unchecked, said as such', () => {
    expect(
      mcpAuthorization(server('authorized'), stored('unreadable', 'keychain_locked'))
    ).toMatchObject({ state: 'store_unchecked', server: 'authorized', lastUsedAt: AT });
  });

  it('valid on another computer: authorized there, or here too when the tool here holds it', () => {
    expect(mcpAuthorization(server('authorized_elsewhere'), undefined)).toMatchObject({
      state: 'authorized_elsewhere',
    });
    expect(
      mcpAuthorization(server('authorized_elsewhere'), stored('unreadable', 'remote'))
    ).toMatchObject({ state: 'authorized_elsewhere' });
    expect(mcpAuthorization(server('authorized_elsewhere'), stored('authorized'))).toMatchObject({
      state: 'authorized',
    });
    expect(mcpAuthorization(server('authorized_elsewhere'), stored('missing'))).toMatchObject({
      state: 'not_authorized',
      reason: 'never_authorized',
    });
  });

  it('no server record: the store alone, and which side was not checked', () => {
    expect(mcpAuthorization(undefined, stored('renewable'))).toEqual({
      state: 'server_unchecked',
      server: 'unknown',
      serverProblem: 'unreachable',
      stored: stored('renewable'),
      lastUsedAt: null,
    });
    expect(mcpAuthorization(undefined, stored('missing'), 'cli_not_signed_in')).toMatchObject({
      state: 'not_authorized',
      reason: 'never_authorized',
    });
    expect(
      mcpAuthorization(undefined, stored('unreadable', 'macos_keychain'), 'cli_locked')
    ).toMatchObject({ state: 'unchecked', serverProblem: 'cli_locked' });
    expect(mcpAuthorization(undefined, undefined)).toMatchObject({
      state: 'unchecked',
      serverProblem: 'unreachable',
    });
  });
});

/** Every MCP state for one tool, with the line status prints for it. */
const line = (
  tool: string,
  host: string,
  found: Parameters<typeof mcpAuthorization>[0] | undefined,
  held: StoredAuthorization | undefined,
  problem?: Parameters<typeof mcpAuthorization>[2]
) => mcpLine(tool, host, mcpAuthorization(found, held, problem));

describe('the MCP line, for every state of every coding tool', () => {
  const tools = [
    {
      tool: 'Claude Code',
      host: 'claude-code',
      step: 'In Claude Code, type /mcp, choose mnemonik, then Authenticate.',
    },
    { tool: 'Codex', host: 'codex', step: 'Run mnemonik connect codex.' },
    {
      tool: 'Cursor',
      host: 'cursor',
      step: 'In Cursor, open Cursor Settings, Customize, MCPs, then Authenticate.',
    },
  ];
  for (const { tool, host, step } of tools)
    it(`${tool}: authorized, ended, never, and each side not checked`, () => {
      expect(line(tool, host, server('authorized'), stored('authorized'))).toBe(
        `${tool} MCP: authorized.`
      );
      expect(line(tool, host, server('authorized'), stored('renewable'))).toBe(
        `${tool} MCP: authorized.`
      );
      expect(line(tool, host, server('revoked_or_expired'), stored('authorized'))).toBe(
        `${tool} MCP: not authorized. Its authorization on this computer was revoked or has expired.`
      );
      expect(line(tool, host, server('authorized'), stored('missing'))).toBe(
        `${tool} MCP: not authorized. ${tool} no longer holds the authorization Mnemonik lists for this computer.`
      );
      expect(line(tool, host, server('never_authorized'), stored('missing'))).toBe(
        `${tool} MCP: not authorized. ${step}`
      );
      expect(line(tool, host, undefined, stored('missing'))).toBe(
        `${tool} MCP: not authorized. ${step}`
      );
      expect(line(tool, host, server('authorized'), stored('unreadable', 'file_unreadable'))).toBe(
        `${tool} MCP: Mnemonik lists it as authorized. ${tool}'s copy on this computer could not be checked because ${tool}'s credentials file could not be read.`
      );
      expect(line(tool, host, undefined, stored('authorized'))).toBe(
        `${tool} MCP: ${tool} holds an authorization on this computer, but Mnemonik could not be reached to confirm it.`
      );
      expect(line(tool, host, undefined, stored('authorized'), 'cli_not_signed_in')).toBe(
        `${tool} MCP: ${tool} holds an authorization on this computer, but it could not be confirmed because the CLI is not signed in.`
      );
      expect(line(tool, host, undefined, undefined)).toBe(
        `${tool} MCP: could not be checked because Mnemonik could not be reached.`
      );
      expect(line(tool, host, undefined, stored('unreadable', 'file_unreadable'))).toBe(
        `${tool} MCP: could not be checked because Mnemonik could not be reached. ${tool}'s copy on this computer could not be checked because ${tool}'s credentials file could not be read.`
      );
    });

  it('Claude Code on a Mac over SSH: Mnemonik says authorized, the locked Keychain is named', () => {
    expect(
      line(
        'Claude Code',
        'claude-code',
        server('authorized'),
        stored('unreadable', 'keychain_locked')
      )
    ).toBe(
      "Claude Code MCP: Mnemonik lists it as authorized. Claude Code's copy on this computer could not be checked because the macOS Keychain is locked in this session, as it is over SSH. Run mnemonik status in Terminal on the Mac to check it."
    );
    // The CLI's own sign-in is in the same locked Keychain: one reason, one step.
    expect(
      line(
        'Claude Code',
        'claude-code',
        undefined,
        stored('unreadable', 'keychain_locked'),
        'cli_locked'
      )
    ).toBe(
      'Claude Code MCP: could not be checked because the macOS Keychain is locked in this session, as it is over SSH. Run mnemonik status in Terminal on the Mac to check it.'
    );
  });

  it('Claude Code: Windows Credential Manager, CLAUDE_CONFIG_DIR, and a Keychain that will not answer', () => {
    expect(
      line(
        'Claude Code',
        'claude-code',
        server('authorized'),
        stored('unreadable', 'credential_manager')
      )
    ).toBe(
      "Claude Code MCP: Mnemonik lists it as authorized. Claude Code's copy on this computer could not be checked because Claude Code keeps it in Windows Credential Manager, which Mnemonik does not read."
    );
    expect(
      line(
        'Claude Code',
        'claude-code',
        server('authorized'),
        stored('unreadable', 'custom_folder')
      )
    ).toBe(
      "Claude Code MCP: Mnemonik lists it as authorized. Claude Code's copy on this computer could not be checked because CLAUDE_CONFIG_DIR keeps Claude Code's files in a folder Mnemonik does not read."
    );
    expect(
      line(
        'Claude Code',
        'claude-code',
        server('authorized'),
        stored('unreadable', 'keychain_unreadable')
      )
    ).toBe(
      "Claude Code MCP: Mnemonik lists it as authorized. Claude Code's copy on this computer could not be checked because the macOS Keychain could not be read."
    );
  });

  it('Codex: kept in the operating system keyring, named for each system', () => {
    expect(
      line('Codex', 'codex', server('authorized'), stored('unreadable', 'macos_keychain'))
    ).toBe(
      "Codex MCP: Mnemonik lists it as authorized. Codex's copy on this computer could not be checked because Codex keeps it in the macOS Keychain, which Mnemonik does not read."
    );
    expect(
      line('Codex', 'codex', server('authorized'), stored('unreadable', 'credential_manager'))
    ).toBe(
      "Codex MCP: Mnemonik lists it as authorized. Codex's copy on this computer could not be checked because Codex keeps it in Windows Credential Manager, which Mnemonik does not read."
    );
    expect(
      line('Codex', 'codex', server('authorized'), stored('unreadable', 'system_keyring'))
    ).toBe(
      "Codex MCP: Mnemonik lists it as authorized. Codex's copy on this computer could not be checked because Codex keeps it in the system keyring, which Mnemonik does not read."
    );
  });

  it('Cursor: authorized on another computer, opened over SSH, and a database that cannot be read', () => {
    expect(
      line('Cursor', 'cursor', server('authorized_elsewhere'), stored('unreadable', 'remote'))
    ).toBe('Cursor MCP: authorized in Cursor on another of your computers.');
    expect(line('Cursor', 'cursor', server('authorized'), stored('unreadable', 'remote'))).toBe(
      'Cursor MCP: Mnemonik lists it as authorized. Cursor keeps its authorization on the computer it runs on, not on this one, so it was not checked here.'
    );
    expect(
      line('Cursor', 'cursor', server('authorized'), stored('unreadable', 'not_on_this_computer'))
    ).toBe(
      'Cursor MCP: Mnemonik lists it as authorized. Cursor keeps its authorization on the computer it runs on, not on this one, so it was not checked here.'
    );
    expect(
      line('Cursor', 'cursor', server('authorized'), stored('unreadable', 'database_unreadable'))
    ).toBe(
      "Cursor MCP: Mnemonik lists it as authorized. Cursor's copy on this computer could not be checked because Cursor's settings database could not be read."
    );
    expect(line('Cursor', 'cursor', undefined, stored('unreadable', 'remote'))).toBe(
      'Cursor MCP: could not be checked because Mnemonik could not be reached. Cursor keeps its authorization on the computer it runs on, not on this one, so it was not checked here.'
    );
  });

  it('connect leaves the step to the rows it prints below', () => {
    expect(
      mcpLine(
        'Claude Code',
        'claude-code',
        mcpAuthorization(server('never_authorized'), undefined),
        false
      )
    ).toBe('Claude Code MCP: not authorized.');
  });
});

describe('the hooks, scanner and CLI lines', () => {
  it('hooks: each state, with the repair step only when no attention line gives it', () => {
    expect(hooksLine('Claude Code', 'authorized', false)).toBe('Claude Code hooks: authorized.');
    expect(hooksLine('Codex', 'trust_pending', true)).toBe(
      'Codex hooks: waiting for you to trust them in Codex.'
    );
    expect(hooksLine('Cursor', 'not_authorized', true)).toBe(
      'Cursor hooks: not authorized. Their authorization is missing from this computer or has expired.'
    );
    expect(hooksLine('Cursor', 'not_authorized', false)).toBe(
      'Cursor hooks: not authorized. Their authorization is missing from this computer or has expired. Run mnemonik repair.'
    );
    expect(hooksLine('Codex', 'not_installed', false)).toBe(
      'Codex hooks: not installed. Run mnemonik repair.'
    );
    expect(hooksLine('Claude Code', 'unchecked', true)).toBe(
      'Claude Code hooks: could not be checked because they do not say which authorization they use.'
    );
  });

  it('scanner: each state', () => {
    expect(scannerLine('authorized', false)).toBe('Scanner: authorized.');
    expect(scannerLine('refused', true)).toBe(
      'Scanner: not authorized. Mnemonik no longer accepts its authorization.'
    );
    expect(scannerLine('not_authorized', false)).toBe(
      'Scanner: not authorized. Its authorization is missing from this computer or has expired. Run mnemonik repair.'
    );
    expect(scannerLine('unchecked', false)).toBe(
      'Scanner: could not be checked because its settings do not say which authorization it uses.'
    );
    expect(scannerLine('not_set_up', false)).toBe('Scanner: not set up on this computer.');
  });

  it('CLI: each state', () => {
    expect(cliLine({ state: 'signed_in', email: 'sam@acme.test' })).toBe(
      'CLI: signed in as sam@acme.test.'
    );
    expect(cliLine({ state: 'signed_in', email: null })).toBe('CLI: signed in.');
    expect(cliLine({ state: 'unconfirmed' })).toBe(
      'CLI: signed in on this computer, but Mnemonik could not be reached to confirm it.'
    );
    expect(cliLine({ state: 'not_signed_in' })).toBe(
      'CLI: not signed in. Run mnemonik auth login.'
    );
    expect(cliLine({ state: 'signed_out' })).toBe(
      'CLI: signed out. Mnemonik no longer accepts its sign-in. Run mnemonik auth renew.'
    );
    expect(cliLine({ state: 'locked' })).toBe(
      'CLI: could not be checked because its sign-in is in the macOS Keychain, which is locked in this session, as it is over SSH. Run mnemonik status in Terminal on the Mac to check it.'
    );
  });

  it('what a tool holds on this computer, beside the account rows of auth status', () => {
    expect(storeNote('Claude Code', stored('authorized'))).toBe('');
    expect(storeNote('Claude Code', undefined)).toBe('');
    expect(storeNote('Claude Code', stored('missing'))).toBe(
      'Claude Code holds none on this computer.'
    );
  });

  it('no line uses a contraction, an ellipsis or the word editor', () => {
    const lines = [
      ...['authorized', 'trust_pending', 'not_authorized', 'not_installed', 'unchecked'].map(
        (state) => hooksLine('Codex', state as never, false)
      ),
      ...['authorized', 'refused', 'not_authorized', 'unchecked', 'not_set_up'].map((state) =>
        scannerLine(state as never, false)
      ),
      line('Cursor', 'cursor', undefined, stored('unreadable', 'database_unreadable')),
    ];
    for (const text of lines) {
      expect(text).not.toMatch(/n't|'re\b|'s been|\u2026|\beditor/iu);
      expect(text).toMatch(/\.$/u);
    }
  });
});
