import { vi } from 'vitest';
import type { HostDiscovery } from '../../src/hostDiscovery.js';

// Loaded before every CLI test file (vitest.config.ts setupFiles). The CLI's
// default host discovery reads the real home directory and PATH, so on a machine
// with Claude Code, Codex or Cursor installed a fixture that forgot to stub it
// found them, downloaded the real hook packages and ran a real install
// (joinedScanner, 18 September 2026). Here both lookups answer "absent" unless a
// test opts in with enableHostDiscovery().
const real = vi.hoisted(() => ({ discovery: undefined as HostDiscovery | undefined }));

vi.mock('../../src/hostDiscovery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/hostDiscovery.js')>();
  real.discovery = { ...actual.hostDiscovery };
  const blind: HostDiscovery = {
    pathExists: async () => false,
    binaryExists: async () => false,
  };
  return { ...actual, hostDiscovery: blind };
});

/** Restore the real file and PATH lookups for the calling test file only. Tests
 * that exercise discovery itself call this and point `home` and `PATH` at
 * fixtures they own; nothing else in the suite may see the host machine. */
export async function enableHostDiscovery(): Promise<void> {
  const { hostDiscovery } = await import('../../src/hostDiscovery.js');
  if (!real.discovery) throw new Error('host discovery mock not installed');
  Object.assign(hostDiscovery, real.discovery);
}
