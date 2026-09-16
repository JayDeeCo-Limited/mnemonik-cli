import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { guardNpmLaunch, installBootstrap, npmSource, unpack } from '../src/runtime/bootstrap.js';
import { RuntimeStore, hash } from '../src/runtime/store.js';

const exec = promisify(execFile);
const repo = resolve(import.meta.dirname, '../../..');
const names = [
  'cli',
  'shared',
  'local-setup',
  'credentials',
  'claude-code-hooks',
  'codex-hooks',
  'cursor-hooks',
  'grok-hooks',
  'copilot-hooks',
  'scanner',
];
let fixture: string;
const packs = new Map<string, string>();
beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'runtime-pack-'));
  for (const name of names) {
    const { stdout } = await exec(
      'npm',
      ['pack', '--ignore-scripts', '--json', '--pack-destination', fixture],
      { cwd: join(repo, 'packages', name), maxBuffer: 8 * 1024 * 1024 }
    );
    packs.set(name, join(fixture, JSON.parse(stdout)[0].filename));
  }
}, 120_000);
afterAll(async () => {
  await rm(fixture, { recursive: true, force: true });
});

async function installFixture(name: string) {
  const prefix = join(fixture, `${name}-prefix`);
  const state = join(fixture, `${name}-home/.local/state/mnemonik`);
  const cache = join(fixture, `${name}-cache`);
  await mkdir(prefix);
  const dependencies = Object.fromEntries(
    ['cli', 'shared', 'local-setup', 'credentials'].map((packageName) => [
      '@mnemonik/' + packageName,
      pathToFileURL(packs.get(packageName)!).href,
    ])
  );
  await writeFile(
    join(prefix, 'package.json'),
    JSON.stringify({ private: true, dependencies, overrides: dependencies })
  );
  await exec('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: prefix,
    env: { ...process.env, npm_config_cache: cache },
    timeout: 90_000,
  });
  return { prefix, state, cache, env: { ...process.env, MNEMONIK_STATE_DIR: state } };
}

it('every packed publishable package has no install lifecycle scripts', async () => {
  for (const name of names) {
    const files = unpack(await readFile(packs.get(name)!));
    const pkg = JSON.parse(files['package.json']!.toString());
    for (const script of ['preinstall', 'install', 'postinstall'])
      expect(pkg.scripts?.[script], `${name}:${script}`).toBeUndefined();
  }
});

it('refuses a changed installed dependency before the first runtime import', async () => {
  const { prefix, env } = await installFixture('tampered');
  const dependency = join(prefix, 'node_modules/@mnemonik/local-setup/dist/index.js');
  const bytes = await readFile(dependency);
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  await writeFile(dependency, bytes);
  await expect(
    exec(process.execPath, [join(prefix, 'node_modules/@mnemonik/cli/dist/bin.js'), '--version'], {
      env,
      timeout: 90_000,
    })
  ).rejects.toMatchObject({ code: 1, stderr: 'digest_mismatch\n', stdout: '' });
}, 120_000);

it('executes the packed CLI from an npm prefix, hands off, and runs after the prefix is deleted', async () => {
  const { prefix, state, cache, env } = await installFixture('npm');
  const { stdout } = await exec(
    process.execPath,
    [join(prefix, 'node_modules/@mnemonik/cli/dist/bin.js'), '--version'],
    { env, timeout: 90_000 }
  );
  expect(stdout.trim()).toBe('0.1.0');
  const store = new RuntimeStore(state);
  const runtime = await store.verifyRuntime('cli');
  const bin = join(runtime.directory, 'node_modules/@mnemonik/cli/dist/bin.js');
  expect((await exec(process.execPath, [bin, '--version'], { env })).stdout.trim()).toBe('0.1.0');
  const bootstrapRoot = join(state, 'runtimes/bootstrap');
  const digests = JSON.parse(await readFile(join(bootstrapRoot, 'bootstrap-digests.json'), 'utf8'));
  const allFiles = await readdir(bootstrapRoot, { recursive: true, withFileTypes: true });
  expect(Object.keys(digests).sort()).toEqual(
    allFiles
      .filter((item) => item.isFile() && item.name !== 'bootstrap-digests.json')
      .map((item) => join(item.parentPath, item.name).slice(bootstrapRoot.length + 1))
      .sort()
  );
  for (const [name, digest] of Object.entries(digests))
    expect(hash(await readFile(join(bootstrapRoot, name)))).toBe(digest);
  const source = await npmSource(
    await guardNpmLaunch(join(prefix, 'node_modules/@mnemonik/cli/dist/bin.js'))
  );
  const storeKey = 'node_modules/@mnemonik/cli/dist/runtime/store.js';
  const oldStore = source.files[storeKey]!;
  source.files[storeKey] = Buffer.concat([oldStore, Buffer.from('\n// refreshed bundle\n')]);
  const launcherPath = await installBootstrap(store, source);
  expect(launcherPath).toBe(join(bootstrapRoot, 'dist/bin.js'));
  expect(await readFile(join(bootstrapRoot, 'dist/runtime/store.js'))).toEqual(
    source.files[storeKey]
  );
  const refreshedDigests = JSON.parse(
    await readFile(join(bootstrapRoot, 'bootstrap-digests.json'), 'utf8')
  );
  expect(refreshedDigests['dist/runtime/store.js']).toBe(hash(source.files[storeKey]));
  expect(await readFile(join(state, 'runtimes/bootstrap.previous/dist/runtime/store.js'))).toEqual(
    oldStore
  );
  expect(await installBootstrap(store, source)).toBe(launcherPath);
  expect(await readFile(join(state, 'runtimes/bootstrap.previous/dist/runtime/store.js'))).toEqual(
    oldStore
  );
  const copied = join(state, 'runtimes/cli/9.9.9');
  await cp(runtime.directory, copied, { recursive: true });
  await expect(
    exec(process.execPath, [join(copied, 'node_modules/@mnemonik/cli/dist/bin.js'), '--version'], {
      env,
    })
  ).rejects.toMatchObject({ code: 1, stderr: 'permission\n', stdout: '' });
  await rm(copied, { recursive: true });
  const pointer = await readFile(store.pointerPath('cli'));
  const files = { 'dist/router.js': Buffer.from(''), 'dist/bin.js': Buffer.from('') };
  await store.installRuntime('cli', '2.0.0', {
    files,
    manifest: {
      ...runtime.manifest,
      version: '2.0.0',
      entry: 'dist/router.js',
      totalSize: 0,
      files: Object.fromEntries(
        Object.entries(files).map(([name, value]) => [
          name,
          { sha256: hash(value), size: 0, executable: false },
        ])
      ),
      source: {
        kind: 'npm',
        launchedFrom: 'fixture',
        packages: [
          {
            name: '@mnemonik/cli',
            version: '2.0.0',
            integrity: 'fixture',
            tarball: 'fixture',
            tarballSha256: 'fixture',
          },
        ],
      },
    },
  });
  await expect(exec(process.execPath, [bin, '--version'], { env })).rejects.toMatchObject({
    code: 1,
    stderr: 'permission\n',
    stdout: '',
  });
  await writeFile(store.pointerPath('cli'), pointer);
  expect(runtime.directory.startsWith(state + '/runtimes/cli/')).toBe(true);
  expect(runtime.directory.startsWith(prefix)).toBe(false);
  expect(runtime.directory.startsWith(cache)).toBe(false);
  expect(store.pointerPath('scanner')).toBe(join(state, 'runtimes/scanner/current'));
  expect(runtime.manifest.source.kind).toBe('npm');
  if (runtime.manifest.source.kind === 'npm') {
    expect(runtime.manifest.source.packages.map((p) => p.name)).toEqual(
      expect.arrayContaining([
        '@mnemonik/cli',
        '@mnemonik/credentials',
        '@mnemonik/local-setup',
        '@mnemonik/shared',
        'proper-lockfile',
        'ignore',
        'web-tree-sitter',
      ])
    );
    expect(
      runtime.manifest.source.packages.every(
        (p) => p.integrity.startsWith('sha512-') && /^[a-f0-9]{64}$/.test(p.tarballSha256)
      )
    ).toBe(true);
  }
  await rm(prefix, { recursive: true });
  await rm(cache, { recursive: true, force: true });
  const launcher = join(state, 'runtimes/bootstrap/dist/bin.js');
  expect((await exec(process.execPath, [launcher, '--version'], { env })).stdout.trim()).toBe(
    '0.1.0'
  );
  const dependency = Object.keys(runtime.manifest.files).find((name) =>
    name.endsWith('node_modules/proper-lockfile/index.js')
  )!;
  const path = join(runtime.directory, dependency);
  const bytes = await readFile(path);
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  await writeFile(path, bytes);
  await expect(exec(process.execPath, [launcher, '--version'], { env })).rejects.toMatchObject({
    code: 1,
    stderr: 'digest_mismatch\n',
    stdout: '',
  });
}, 120_000);

it('an old npm entry preserves multiple self-updates; newer npm and explicit install still select their version', async () => {
  const { prefix, state, env } = await installFixture('self-updated');
  const entry = join(prefix, 'node_modules/@mnemonik/cli/dist/bin.js');
  const source = await npmSource(await guardNpmLaunch(entry));
  const store = new RuntimeStore(state);
  await store.installRuntime('cli', source.manifest.version, source);
  const installVersion = async (version: string) => {
    const name = 'node_modules/@mnemonik/cli/dist/router.js';
    const bytes = Buffer.from(`export function runCli() { console.log('${version}'); return 0; }`);
    const files = { ...source.files, [name]: bytes };
    await store.installRuntime('cli', version, {
      files,
      manifest: {
        ...source.manifest,
        version,
        totalSize: Object.values(files).reduce((n, b) => n + b.length, 0),
        files: {
          ...source.manifest.files,
          [name]: { sha256: hash(bytes), size: bytes.length, executable: false },
        },
        source: {
          kind: 'npm',
          launchedFrom: 'fixture',
          packages: [
            {
              name: '@mnemonik/cli',
              version,
              integrity: 'sha512-fixture',
              tarball: 'file:///fixture.tgz',
              tarballSha256: hash(bytes),
            },
          ],
        },
      },
    });
  };
  await installVersion('1.0.0');
  await installVersion('2.0.0');
  const run = (...args: string[]) =>
    exec(process.execPath, [entry, ...args], { env, timeout: 90_000 });
  expect((await run('--version')).stdout.trim()).toBe('2.0.0');
  expect((await store.verifyRuntime('cli')).reference.version).toBe('2.0.0');
  await run('install', '--help');
  expect((await store.verifyRuntime('cli')).reference.version).toBe('0.1.0');
  await installVersion('0.0.1');
  expect((await run('--version')).stdout.trim()).toBe('0.1.0');
  expect((await store.verifyRuntime('cli')).reference.version).toBe('0.1.0');
}, 120_000);
