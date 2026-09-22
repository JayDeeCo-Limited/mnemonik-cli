import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { stateDirectory } from '@mnemonik/local-setup';
import { helpScreen } from '../src/help.js';

const paths: string[][] = [
  [],
  ['install'],
  ['status'],
  ['add'],
  ['remove'],
  ['connect'],
  ['project'],
  ...['status', 'init', 'link', 'delete', 'ensure'].map((command) => ['project', command]),
  ['update'],
  ['repair'],
  ['doctor'],
  ['uninstall'],
  ['auth'],
  ...['login', 'status', 'logout'].map((command) => ['auth', command]),
  ['logout'],
  ['scanner'],
  ...['enable', 'status', 'start', 'stop', 'pause', 'resume', 'uninstall', 'export-preview'].map(
    (command) => ['scanner', command]
  ),
  ['roots'],
  ['data', 'delete'],
  ['diagnostics'],
  ['identity', 'migrate'],
];

const root = resolve(import.meta.dirname, '../../..');
const bin = join(root, 'packages/cli/dist/bin.js');

beforeAll(() => {
  execFileSync('npm', ['run', 'build', '-w', '@mnemonik/cli'], { cwd: root, stdio: 'pipe' });
});

function runHelp(path: string[]) {
  const home = mkdtempSync(join(tmpdir(), 'mnemonik-help-'));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('MNEMONIK_'))
  );
  env.HOME = home;
  env.XDG_STATE_HOME = join(home, '.local', 'state');
  const state = stateDirectory(process.platform, env, home);
  const result = spawnSync(process.execPath, [bin, ...path, '--help'], {
    cwd: home,
    encoding: 'utf8',
    env,
  });
  return { home, result, state };
}

describe('help has no side effects', () => {
  it.each(paths.map((path) => ({ path })))('prints $path before bootstrap', ({ path }) => {
    const { home, result, state } = runHelp(path);
    try {
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(helpScreen(path));
      expect(result.stderr).toBe('');
      expect(existsSync(state)).toBe(false);
      expect(existsSync(join(state, 'runtimes'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('does not prepare the installer for install --help', () => {
    const { home, result, state } = runHelp(['install']);
    try {
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain('Preparing the installer');
      expect(result.stderr).toBe('');
      expect(existsSync(state)).toBe(false);
      expect(existsSync(join(state, 'runtimes'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
