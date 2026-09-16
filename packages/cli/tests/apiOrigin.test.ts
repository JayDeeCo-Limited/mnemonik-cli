import { afterEach, expect, it, vi } from 'vitest';
import { apiOrigin } from '@mnemonik/shared';
import { grantTransport, matchHostGrant } from '../src/auth/status.js';

afterEach(() => vi.unstubAllEnvs());
it('keeps production URLs and resolves staging to its origin', async () => {
  vi.stubEnv('MNEMONIK_API_RESOURCE', '');
  expect(apiOrigin()).toBe('https://api.mnemonik.dev');
  vi.stubEnv('MNEMONIK_API_RESOURCE', 'https://mnemonik-api.devops.jaydeeco.com/');
  expect(apiOrigin()).toBe('https://mnemonik-api.devops.jaydeeco.com');
  const grant = {
    id: 'test-grant',
    // 550077bda requires current-installation binding or a CLI sign-in window.
    deviceInstallationId: 'test-installation',
    clientId: 'client',
    clientName: 'Codex',
    softwareId: 'codex',
    scopes: ['mcp:use'],
    resource: apiOrigin() + '/mcp',
    createdAt: new Date().toISOString(),
    activatedAt: new Date().toISOString(),
    lastUsedAt: null,
  };
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({
          account: 'user',
          deviceInstallationId: 'test-installation',
          grants: [grant],
        })
      )
  );
  const transport = grantTransport(async () => 'bearer', fetcher);
  expect(
    (
      await matchHostGrant(
        { authenticatedTools: true, declarationPresent: true },
        'codex',
        'user',
        transport,
        0
      )
    ).grant?.id
  ).toBe('test-grant');
  expect(String(fetcher.mock.calls[0]?.[0])).toBe(apiOrigin() + '/api/v1/auth/grants');
});

it.each(['json', 'toml'] as const)(
  'writes and recognizes the selected API origin in %s',
  async (format) => {
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createFileHostAdapter } = await import('@mnemonik/shared');
    const root = await mkdtemp(join(tmpdir(), 'api-origin-'));
    try {
      for (const origin of [
        'https://api.mnemonik.dev',
        'https://mnemonik-api.devops.jaydeeco.com',
      ]) {
        const path = () => join(root, 'mcp.json');
        const adapter = createFileHostAdapter(
          {
            env: { MNEMONIK_API_RESOURCE: origin + '/' },
            execFile: async () => ({ stdout: '', stderr: '' }),
          },
          {
            name: 'cursor',
            binary: 'agent',
            windowsBinary: { locations: [], extensions: ['.cmd'] },
            vendorMatch: /^2026\./,
            path,
            instruction: '',
            mcp: { path, format },
            present: async () => false,
            changes: async () => [],
          }
        );
        const target = {
          component: 'mcp' as const,
          scope: 'user' as const,
          runtimeEntry: join(root, 'hook.js'),
          runtimeRoot: root,
          credentialFamily: '',
        };
        const plan = await adapter.plan(target);
        if (format === 'json')
          expect(JSON.parse(plan.changes[0]!.content.toString())).toEqual({
            mcpServers: { mnemonik: { url: origin + '/mcp' } },
          });
        else expect(plan.changes[0]!.content.toString()).toContain(origin + '/mcp');
        await writeFile(path(), plan.changes[0]!.content);
        expect((await adapter.inspect(target)).declarationPresent).toBe(true);
        await rm(path());
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);
