import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});
