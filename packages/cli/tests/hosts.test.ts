import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { grantHost, type AccountGrant } from '../src/auth/status.js';
import { codexTrustAction } from '../src/install/hosts.js';

const grant: AccountGrant = {
  id: 'host',
  clientId: 'https://claude.ai/oauth/claude-code-client-metadata',
  clientName: null,
  softwareId: null,
  scopes: ['mcp:use'],
  resource: 'https://api.mnemonik.dev/mcp',
  createdAt: new Date().toISOString(),
  activatedAt: new Date().toISOString(),
  lastUsedAt: null,
  deviceInstallationId: null,
};
it('renders trust instructions for the detected Codex surface', () => {
  expect(codexTrustAction('/usr/local/bin/codex')).toBe(
    'Run the codex command in a terminal and use its hook trust prompt to allow the Mnemonik hooks; then quit and reopen Codex.'
  );
  expect(codexTrustAction('/Applications/ChatGPT.app/Contents/Resources/codex')).toBe(
    "Open the ChatGPT app and use the 'Hooks need review' notice at startup to review and allow the Mnemonik hooks. If the notice does not appear, restart the app once."
  );
  expect(
    codexTrustAction('C:\\Users\\Jo\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe')
  ).toContain("'Hooks need review'");
});
it('recognises the captured Claude Code and Codex CIMD documents without DCR names', () => {
  for (const host of ['claude-code', 'codex'] as const) {
    const document = JSON.parse(
      readFileSync(`../../tests/fixtures/oauth-clients/${host}.json`, 'utf8')
    );
    expect(grantHost({ ...grant, clientId: document.client_id })).toBe(host);
  }
  expect(grantHost({ ...grant, clientId: 'https://claude.ai.evil.test/client' })).toBeUndefined();
});
