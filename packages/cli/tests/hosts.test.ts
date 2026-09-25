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
it('gives one Codex trust step on every surface, with nothing to restart', () => {
  for (const path of [
    '/usr/local/bin/codex',
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    'C:\\Users\\Jo\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe',
    undefined,
  ])
    expect(codexTrustAction(path)).toBe('Run codex, then approve the Mnemonik hooks when it asks.');
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
