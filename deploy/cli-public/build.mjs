import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  globSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { sbom } from './sbom.mjs';

for (const name of ['shared', 'local-setup', 'credentials', 'cli'])
  execFileSync('npm', ['run', 'build', '-w', `@mnemonik/${name}`], { stdio: 'inherit' });
rmSync('dist-package', { recursive: true, force: true });
mkdirSync('dist-package/dist', { recursive: true });
cpSync('packages/cli/dist', 'dist-package/dist', { recursive: true });
// npm links an existing workspace bin before rebuilds, but not before its first build.
chmodSync('dist-package/dist/bin.js', 0o755);
cpSync('packages/cli/LICENSE', 'dist-package/LICENSE');
const options = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
};
// Keep the original stdlib bootstrap and verifier separate from the application bundle.
// Preserve CLI module locations: auth and router resolve package.json relative to import.meta.url.
await build({
  ...options,
  entryPoints: globSync('packages/cli/src/**/*.ts').filter(
    (path) => !/\/(bin|runtime\/bootstrap)\.ts$/.test(path)
  ),
  outbase: 'packages/cli/src',
  outdir: 'dist-package/dist',
  plugins: [
    {
      name: 'preserve-cli-module-paths',
      setup(builder) {
        builder.onResolve({ filter: /^@mnemonik\/local-setup$/ }, (args) =>
          args.importer === resolve('packages/cli/src/runtime/store.ts')
            ? { path: args.path, external: true }
            : undefined
        );
        builder.onResolve({ filter: /^\./ }, (args) =>
          args.importer.startsWith(resolve('packages/cli/src'))
            ? { path: args.path, external: true }
            : undefined
        );
      },
    },
  ],
});
await build({
  ...options,
  entryPoints: ['packages/local-setup/src/index.ts'],
  outfile: 'dist-package/dist/vendor/local-setup.js',
});
const store = 'dist-package/dist/runtime/store.js';
writeFileSync(
  store,
  readFileSync(store, 'utf8').replace(
    /import\(['"]@mnemonik\/local-setup['"]\)/g,
    "import('../vendor/local-setup.js')"
  )
);
mkdirSync('dist-package/dist/vendor/shared', { recursive: true });
for (const name of ['runtimeReader.js', 'runtimeSigners.js'])
  cpSync(`packages/shared/dist/${name}`, `dist-package/dist/vendor/shared/${name}`);
const pkg = JSON.parse(readFileSync('packages/cli/package.json'));
// Preserve source manifests in packages/. Only the distribution manifest is transformed.
pkg.repository = {
  type: 'git',
  url: 'git+https://github.com/JayDeeCo-Limited/mnemonik-cli.git',
};
pkg.version = JSON.parse(readFileSync('scanner-release.json')).version;
for (const pin of Object.values(pkg.mnemonik.hosts)) pin.releaseVersion = pkg.version;
pkg.dependencies = {};
pkg.scripts = {};
pkg.files = ['dist'];
writeFileSync('dist-package/package.json', JSON.stringify(pkg, null, 2) + '\n');
cpSync('scanner-release.json', 'dist-package/dist/scanner-release.json');
writeFileSync('dist-package/dist/sbom.json', sbom('cli'));
const digests = Object.fromEntries(
  readdirSync('dist-package/dist', { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = entry.parentPath + '/' + entry.name;
      return [
        path.slice('dist-package/'.length),
        createHash('sha256').update(readFileSync(path)).digest('hex'),
      ];
    })
);
writeFileSync('dist-package/dist/digests.json', JSON.stringify(digests, null, 2) + '\n');
