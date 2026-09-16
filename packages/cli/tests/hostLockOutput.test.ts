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
      hostManagement: { stateDir: '/unused', account: 'owner' },
    }
  );
  expect(exit).toBe(1);
  expect(stdout).toBe(json ? '{"status":"FAILED","reason":"lock_held"}\n' : '');
  expect(stderr).toBe(
    json ? '' : 'Another mnemonik command holds the state lock; retry in a moment.\n'
  );
});
