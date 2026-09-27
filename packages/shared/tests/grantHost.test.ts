import assert from 'node:assert/strict';
import test from 'node:test';
import { CODING_TOOL_SIGN_IN, hostForGrantClient } from '../src/grantHost.js';

test('names the coding tool from software id, then client name, then client id host', () => {
  assert.equal(
    hostForGrantClient({ clientId: 'https://claude.ai/oauth/claude-code' }),
    'claude-code'
  );
  assert.equal(hostForGrantClient({ clientId: 'https://chatgpt.com/codex' }), 'codex');
  assert.equal(hostForGrantClient({ clientId: 'x', clientName: 'Cursor' }), 'cursor');
  assert.equal(hostForGrantClient({ clientId: 'x', clientName: 'Codex CLI' }), 'codex');
  assert.equal(
    hostForGrantClient({
      clientId: 'https://claude.ai/x',
      softwareId: 'cursor',
      clientName: 'Codex',
    }),
    'cursor'
  );
  assert.equal(hostForGrantClient({ clientId: 'mnemonik-cli' }), undefined);
  assert.equal(
    hostForGrantClient({ clientId: 'https://example.com/x', clientName: 'Other' }),
    undefined
  );
});

test('Codex signs in through mnemonik connect; Claude Code and Cursor only inside the tool', () => {
  assert.deepEqual(CODING_TOOL_SIGN_IN.codex, { kind: 'connect' });
  assert.equal(CODING_TOOL_SIGN_IN['claude-code'].kind, 'in_tool');
  assert.equal(CODING_TOOL_SIGN_IN.cursor.kind, 'in_tool');
});
