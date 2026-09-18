import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { runCli } from '../src/router.js';

vi.mock('../src/install/hosts.js', async (original) => ({
  ...(await original<typeof import('../src/install/hosts.js')>()),
  selectOwned: async () => ({ selected: [{}], ambiguous: [] }),
  runHosts: async () => {
    const { RuntimeError } = await import('@mnemonik/shared/hook-runtime');
    throw new RuntimeError('lock_held');
  },
}));

it.each([false, true])('reports a contending maintenance lock (json=%s)', async (json) => {
  let stdout = '',
    stderr = '';
  // repair ensures the launcher before it reaches the mocked runHosts. The
  // launcher lives under the home and its record under the state directory, so
  // each case owns both: '/unused' passed only on a machine whose real
  // launcher already existed, and a shared home made the second case find the
  // first case's launcher without its record.
  const base = await mkdtemp(join(tmpdir(), 'lock-'));
  const exit = await runCli(
    ['repair', '--non-interactive', '--apply', ...(json ? ['--json'] : [])],
    {
      stdout: {
        write: (s) => {
          stdout += s;
        },
      },
      stderr: {
        write: (s) => {
          stderr += s;
        },
      },
      home: base,
      hostManagement: { stateDir: join(base, 'state'), account: 'owner' },
    }
  );
  expect(exit).toBe(1);
  expect(stdout).toBe(json ? '{"status":"FAILED","reason":"lock_held"}\n' : '');
  expect(stderr).toBe(
    json ? '' : 'Another mnemonik command holds the state lock; retry in a moment.\n'
  );
});
