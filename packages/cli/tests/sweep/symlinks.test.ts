import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordPath } from '@mnemonik/local-setup';
import { makeSweepFixture, type SweepFixture } from '../fixtures/sweep.js';

// A completed install exits 3 (LIMITED) until scanner and hook checks prove the
// components work; 0 is READY.
const INSTALLED = 3;
const fixtures: SweepFixture[] = [];
const extraDirs: string[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
  await Promise.all(extraDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const result = await makeSweepFixture();
  fixtures.push(result);
  for (const adapter of result.adapters) adapter.declaration.staging = 'inactive';
  return result;
}

describe.runIf(process.platform !== 'win32')('symlink refusal and canonicalisation', () => {
  it('refuses a .mnemonik.json symlink and does not alter its target', async () => {
    const f = await fixture();
    const target = join(f.home, 'identity-target.json');
    await writeFile(target, 'outside identity\n');
    await symlink(target, join(f.root, '.mnemonik.json'));

    expect(await f.run()).toBe(1);
    expect(f.stdout.text).toContain('This machine needs attention before Mnemonik can work fully.');
    expect(f.stdout.text).not.toContain('target_symlink');
    expect(await readFile(target, 'utf8')).toBe('outside identity\n');
    for (const path of Object.values(f.hostPaths)) expect(await readFile(path)).toEqual(f.original);

    await unlink(join(f.root, '.mnemonik.json'));
    expect(await f.run()).toBe(INSTALLED);
    expect(await readFile(target, 'utf8')).toBe('outside identity\n');
  });

  it('refuses a host config symlink outside home without writing through it', async () => {
    const f = await fixture();
    const outside = await mkdtemp(join(tmpdir(), 'mnemonik-outside-host-'));
    extraDirs.push(outside);
    const target = join(outside, 'config.json');
    await writeFile(target, 'outside host\n');
    await unlink(f.hostPaths['claude-code']);
    await symlink(target, f.hostPaths['claude-code']);

    expect(await f.run()).toBe(1);
    expect(f.stdout.text).toContain('This machine needs attention before Mnemonik can work fully.');
    expect(f.stdout.text).not.toContain('target_symlink');
    expect(await readFile(target, 'utf8')).toBe('outside host\n');

    await unlink(f.hostPaths['claude-code']);
    await writeFile(f.hostPaths['claude-code'], f.original, { mode: 0o600 });
    expect(await f.run()).toBe(INSTALLED);
    expect(await readFile(target, 'utf8')).toBe('outside host\n');
  });

  it('refuses a state-directory symlink before creating anything beneath it', async () => {
    const f = await fixture();
    const outside = await mkdtemp(join(tmpdir(), 'mnemonik-outside-state-'));
    extraDirs.push(outside);
    await rm(f.stateDir, { recursive: true });
    await symlink(outside, f.stateDir, 'dir');

    expect(await f.run()).toBe(1);
    expect(f.stderr.text).toContain('This machine needs attention before Mnemonik can work fully.');
    expect(f.stderr.text).not.toContain('state_directory_symlink');
    expect(await readdir(outside)).toEqual([]);

    await unlink(f.stateDir);
    await mkdir(f.stateDir, { mode: 0o700 });
    expect(await f.run()).toBe(INSTALLED);
  });

  it('canonicalises a repository reached through a symlinked parent', async () => {
    const f = await fixture();
    const aliasParent = join(f.home, 'alias');
    await symlink(f.home, aliasParent, 'dir');
    const aliasRoot = join(aliasParent, 'repo');
    f.install.ui.roots = async () => ({
      account: 'owner',
      disclosureVersion: 'v1',
      picked: {
        roots: [aliasRoot],
        exclusions: [],
        repositories: [
          { path: aliasRoot, state: 'not_set_up', selected: true, nonGitSelected: true },
        ],
      },
    });

    expect(await f.run()).toBe(INSTALLED);
    expect(await readFile(join(f.root, '.mnemonik.json'), 'utf8')).toContain(
      '12345678-1234-4234-8234-123456789012'
    );
    expect(await readFile(recordPath(f.root, f.stateDir), 'utf8')).toContain(f.root);
    await expect(readFile(recordPath(aliasRoot, f.stateDir))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
