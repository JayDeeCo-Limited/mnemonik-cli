import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterAll } from 'vitest';

// Loaded before every CLI test file (vitest.config.ts setupFiles). The CLI
// falls back to the real home directory and the real state directory whenever a
// fixture omits `home` or `installStateDir`. On the developer's machine that
// meant runtime.test.ts read the owner's sign-in and posted this box's
// readiness to production after `update`, and scannerService.test.ts found the
// owner's own ~/.local/bin/mnemonik and refused the uninstall (18 September
// 2026). CI has neither file, so CI never saw it. Every test file now runs
// with an empty home and state directory of its own; a test that needs a
// particular path still passes it explicitly.
const home = mkdtempSync(join(tmpdir(), 'mnemonik-cli-test-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.MNEMONIK_STATE_DIR = join(home, 'state');
delete process.env.XDG_STATE_HOME;
delete process.env.MNEMONIK_DEV_RELEASE_DIR;

// PATH is the second way a test reaches the machine: the CLI walks it for
// claude, codex and cursor. The suite's PATH is now one directory holding only
// the tools the tests spawn (node, npm, npx, git, and sh for npm scripts),
// linked from wherever the real PATH found them, so an installed editor is
// invisible and a test that needs a fake editor puts one on a PATH it owns.
// Symlinks are not portable to Windows; there the real PATH stays.
if (process.platform !== 'win32') {
  const bin = join(home, 'bin');
  mkdirSync(bin);
  const realPath = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const locate = (name: string) =>
    name === 'node'
      ? process.execPath
      : realPath.map((dir) => join(dir, name)).find((candidate) => existsSync(candidate));
  for (const tool of ['node', 'npm', 'npx', 'git', 'sh']) {
    const target = locate(tool);
    if (target) symlinkSync(target, join(bin, tool));
  }
  // npm resolves node through its own directory first; keep that reachable.
  const nodeDir = dirname(process.execPath);
  process.env.PATH = [bin, nodeDir].join(delimiter);
}

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});
