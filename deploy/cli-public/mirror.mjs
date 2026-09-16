import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [destination, artifacts, source = 'HEAD'] = process.argv.slice(2);
if (!destination || !artifacts) throw Error('mirror.mjs DESTINATION ARTIFACTS [COMMIT]');
const out = resolve(destination),
  scratch = mkdtempSync(join(tmpdir(), 'mnemonik-mirror-'));
const names = ['shared', 'local-setup', 'credentials', 'cli'];
const commit = execFileSync('git', ['rev-parse', `${source}^{commit}`], {
  encoding: 'utf8',
}).trim();
mkdirSync(out, { recursive: true });
try {
  const archive = join(scratch, 'source.tar');
  execFileSync('git', [
    'archive',
    '--format=tar',
    `--output=${archive}`,
    commit,
    ...names.map((n) => `packages/${n}`),
    'deploy/cli-public',
  ]);
  execFileSync('tar', ['-xf', archive, '-C', out]);
  mkdirSync(join(out, '.github/workflows'), { recursive: true });
  cpSync(join(out, 'deploy/cli-public/publish.yml'), join(out, '.github/workflows/publish.yml'));
  const root = JSON.parse(execFileSync('git', ['show', `${commit}:package.json`]));
  const pkg = {
    name: 'mnemonik-cli-source',
    private: true,
    type: 'module',
    workspaces: names.map((n) => `packages/${n}`),
    devDependencies: {
      esbuild: '0.28.1',
      typescript: root.devDependencies.typescript,
      '@typescript/native': root.devDependencies['@typescript/native'],
      '@types/node': root.devDependencies['@types/node'],
    },
  };
  writeFileSync(join(out, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  // Seed exact third-party resolutions, then prune server-only packages from the generated lock.
  const lock = JSON.parse(execFileSync('git', ['show', `${commit}:package-lock.json`]));
  lock.packages[''] = pkg;
  for (const key of Object.keys(lock.packages)) {
    if (
      (key.startsWith('packages/') && !pkg.workspaces.includes(key)) ||
      (lock.packages[key].link && !pkg.workspaces.includes(lock.packages[key].resolved))
    )
      delete lock.packages[key];
  }
  writeFileSync(join(out, 'package-lock.json'), JSON.stringify(lock));
  execFileSync(
    'npm',
    ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: out, stdio: 'inherit' }
  );
  cpSync(join(artifacts, 'scanner-release.json'), join(out, 'scanner-release.json'));
  writeFileSync(join(out, 'SOURCE_COMMIT'), commit + '\n');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
