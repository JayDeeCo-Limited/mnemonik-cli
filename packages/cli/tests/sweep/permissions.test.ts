import { afterEach, describe, expect, it } from 'vitest';
import { chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeSweepFixture, type SweepFixture } from '../fixtures/sweep.js';

// A completed install exits 3 (LIMITED) until scanner and hook checks prove the
// components work; 0 is READY.
const INSTALLED = 3;
const fixtures: SweepFixture[] = [];
afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup())));

async function fixture() {
  const result = await makeSweepFixture();
  fixtures.push(result);
  for (const adapter of result.adapters) adapter.declaration.staging = 'inactive';
  return result;
}

async function expectOriginalHosts(f: SweepFixture) {
  for (const path of Object.values(f.hostPaths)) expect(await readFile(path)).toEqual(f.original);
}

describe.runIf(process.platform !== 'win32')('permission failures', () => {
  it('names a read-only state directory, writes no journal, and succeeds after repair', async () => {
    const f = await fixture();
    await chmod(f.stateDir, 0o500);
    expect(await f.run()).toBe(1);
    expect(f.stderr.text).toContain('Install failed: permission_denied');
    await expectOriginalHosts(f);
    await expect(f.journal()).rejects.toThrow();

    await chmod(f.stateDir, 0o700);
    f.stderr.clear();
    expect(await f.run()).toBe(INSTALLED);
    expect(f.counts.remoteCreates).toBe(1);
  });

  it('refuses a read-only host config before staging and completes after chmod', async () => {
    const f = await fixture();
    await chmod(f.hostPaths.codex, 0o400);
    expect(await f.run()).toBe(1);
    expect(f.stdout.text).toContain('target_read_only');
    await expectOriginalHosts(f);
    expect((await f.journal()).targets.filter((target) => target.kind === 'host')).toHaveLength(1);

    await chmod(f.hostPaths.codex, 0o600);
    f.stdout.clear();
    expect(await f.run()).toBe(INSTALLED);
    expect(f.counts.recoveries).toBe(1);
  });

  it('refuses a read-only project root before remote create or Apply, then resumes', async () => {
    const f = await fixture();
    await chmod(f.root, 0o500);
    expect(await f.run()).toBe(1);
    expect(f.stdout.text).toContain('permission_denied');
    expect(f.counts.remoteCreates).toBe(0);
    await expectOriginalHosts(f);
    expect(await readFile(join(f.root, '.mnemonik.json')).catch(() => null)).toBeNull();

    await chmod(f.root, 0o700);
    f.stdout.clear();
    expect(await f.run()).toBe(INSTALLED);
    expect(f.counts.remoteCreates).toBe(1);
    expect(f.counts.recoveries).toBe(1);
  });
});
