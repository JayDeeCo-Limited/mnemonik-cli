import { expect, it, vi } from 'vitest';
import { createFileHostAdapter, type Target } from '@mnemonik/shared';
import { waitForHost } from '../src/install/hosts.js';

it('verifies hook declarations without launching or listing MCP and preserves trust outcomes', async () => {
  const target: Target = {
    component: 'hooks',
    scope: 'user',
    runtimeEntry: '/runtime/hook.js',
    runtimeRoot: '/runtime',
    credentialFamily: 'family',
  };
  const execFile = vi.fn(async () => ({ stdout: '', stderr: '' }));
  const adapter = createFileHostAdapter(
    { target, execFile },
    {
      name: 'cursor',
      binary: 'agent',
      windowsBinary: { locations: [], extensions: ['.cmd'] },
      vendorMatch: /^2026\./,
      nativeConnect: true,
      instruction: 'Connect MCP',
      path: () => '/hooks.json',
      present: async () => true,
      changes: async () => [],
    }
  );
  let now = 0;
  const deps = {
    stateDir: '/state',
    account: 'owner',
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
  await expect(waitForHost(adapter, target, 'cursor', deps)).resolves.toMatchObject({
    declarationPresent: true,
    authenticatedTools: false,
  });
  expect(execFile).not.toHaveBeenCalled();
  const inspection = { declarationPresent: true, authenticatedTools: false };
  adapter.verify = async () => ({ ...inspection, trustPending: true });
  await expect(waitForHost(adapter, target, 'codex', deps)).resolves.toMatchObject({
    trustPending: true,
  });
  adapter.verify = async () => ({ ...inspection, trustDeclined: true });
  await expect(waitForHost(adapter, target, 'codex', deps)).rejects.toThrow('codex_trust_declined');
});
