import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import packageJson from '../package.json' with { type: 'json' };
import { ensureLauncher } from '../src/launcher.js';
import { runCli } from '../src/router.js';
import { cliUpdateHint } from '../src/runtime/selfUpdate.js';
import { npmReleaseSource } from '../src/runtime/releaseSource.js';
import { RuntimeStore } from '../src/runtime/store.js';
import * as runtimes from '../src/runtime/store.js';
import * as hosts from '../src/install/hosts.js';
import * as scanner from '../src/scanner/update.js';

let fixture: string, state: string, store: RuntimeStore;
// `status` prints the version of the CLI that is running, which in this suite is
// the workspace package; the release bot bumps that on every release.
const running = packageJson.version;
const tarballs = new Map<string, Buffer>();
const dist = (version: string) => ({
  integrity: 'sha512-' + createHash('sha512').update(tarballs.get(version)!).digest('base64'),
  tarball: `https://registry.npmjs.org/cli-${version}.tgz`,
});
let latest: string, corrupt: boolean;
const registry = vi.fn<typeof fetch>(async (url) => {
  if (String(url).endsWith('.tgz'))
    return new Response(corrupt ? 'corrupt' : new Uint8Array(tarballs.get(latest)!));
  return Response.json({ name: '@mnemonik/cli', version: latest, dist: dist(latest) });
});
beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'self-update-'));
  for (const version of ['1.0.0', '1.1.0']) {
    const dir = join(fixture, version);
    await mkdir(join(dir, 'dist'), { recursive: true });
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        name: '@mnemonik/cli',
        version,
        type: 'module',
        mnemonik: { hosts: { codex: { package: '@mnemonik/codex-hooks', version, closure: [] } } },
      })
    );
    await writeFile(join(dir, 'dist/router.js'), `export const runCli = () => '${version}';`);
    const [pack] = JSON.parse(
      execFileSync('npm', ['pack', '--ignore-scripts', '--json'], { cwd: dir, encoding: 'utf8' })
    );
    tarballs.set(version, await readFile(join(dir, pack.filename)));
  }
});
afterAll(() => rm(fixture, { recursive: true, force: true }));
beforeEach(async () => {
  vi.stubEnv('MNEMONIK_DEV_RELEASE_DIR', '');
  state = await mkdtemp(join(fixture, 'state-'));
  store = new RuntimeStore(state);
  latest = '1.0.0';
  corrupt = false;
  vi.stubGlobal('fetch', registry);
  const source = await npmReleaseSource(registry, async () => ({
    version: latest,
    'dist.integrity': dist(latest).integrity,
    'dist.tarball': dist(latest).tarball,
  }));
  await store.installRuntime('cli', latest, source);
  latest = '1.1.0';
  registry.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
async function update(json = true) {
  let text = '';
  const stdout = {
    write: (value: string) => {
      text += value;
    },
  };
  const code = await runCli(['update', ...(json ? ['--json'] : [])], {
    installStateDir: state,
    home: state,
    stdout,
    stderr: { write: () => {} },
  });
  return { code, text, report: json ? JSON.parse(text) : undefined };
}
it('plain update --json installs latest, retaining the old CLI as previous', async () => {
  const { code, report } = await update();
  expect(report.cli).toMatchObject({ status: 'UPDATED', oldVersion: '1.0.0', newVersion: '1.1.0' });
  expect(code).toBe(0);
  expect(await readFile(join(state, '.local/bin/mnemonik'), 'utf8')).toContain(
    'runtimes/bootstrap/dist/bin.js'
  );
  expect(JSON.parse(await readFile(store.pointerPath('cli'), 'utf8'))).toMatchObject({
    current: { version: '1.1.0' },
    previous: { version: '1.0.0' },
  });
  expect(registry.mock.calls.map(([url]) => String(url))).toEqual([
    'https://registry.npmjs.org/%40mnemonik%2Fcli/latest',
    'https://registry.npmjs.org/%40mnemonik%2Fcli/1.1.0',
    dist(latest).tarball,
  ]);
});
it('keeps the owned launcher unchanged across a real CLI version update', async () => {
  const launcher = await ensureLauncher({ home: state, stateDir: state });
  const bytes = await readFile(launcher.path);
  await utimes(launcher.path, 1000, 1000);
  expect((await update()).code).toBe(0);
  expect((await store.verifyRuntime('cli')).reference.version).toBe('1.1.0');
  expect(await readFile(launcher.path)).toEqual(bytes);
  expect((await stat(launcher.path)).mtimeMs).toBe(1000000);
});
it('posts the newly installed CLI version without changing update output', async () => {
  let text = '';
  let posted: unknown;
  const code = await runCli(['update', '--json'], {
    installStateDir: state,
    home: state,
    cwd: state,
    stdout: { write: (value) => (text += value) },
    stderr: { write: () => {} },
    cliAuth: {
      signIn: async () => undefined,
      getCliBearer: async () => 'fixture-bearer',
      logout: async () => undefined,
    },
    grantFetch: async (_input, init) => {
      posted = JSON.parse(String(init?.body)).readiness;
      return Response.json({ status: 'recorded' });
    },
    configuredHosts: [],
    projectHookConditions: [],
    scannerStatus: async () => ({ roots: [], exclusions: [], repositories: [] }),
    installationConditions: [],
    preflight: {
      resolveIdentity: async () => ({ kind: 'git_unavailable', detail: 'fixture' }),
      pathExists: async () => false,
      fetch: async () => Response.json({}),
    },
  });
  expect(code).toBe(0);
  expect(JSON.parse(text).cli).toMatchObject({ status: 'UPDATED', newVersion: '1.1.0' });
  expect(posted).toMatchObject({ versions: { cli: '1.1.0' } });
});
it('bad tarball reports FAILED without changing the pointer or leaving a new directory', async () => {
  corrupt = true;
  const before = await readFile(store.pointerPath('cli'));
  const { code, report } = await update();
  expect(report.cli).toMatchObject({
    status: 'FAILED',
    reason: 'digest_mismatch',
    oldVersion: '1.0.0',
  });
  expect(code).toBe(1);
  expect(await readFile(store.pointerPath('cli'))).toEqual(before);
  expect(await readdir(join(state, 'runtimes/cli'))).toEqual(['1.0.0', 'current']);
});
it('same version performs no runtime writes or tarball download', async () => {
  latest = '1.0.0';
  const before = await stat(store.pointerPath('cli'));
  const install = vi.spyOn(RuntimeStore.prototype, 'installRuntime');
  expect((await update(false)).text).toContain('CLI up to date: 1.0.0.');
  expect(install).not.toHaveBeenCalled();
  expect((await stat(store.pointerPath('cli'))).mtimeMs).toBe(before.mtimeMs);
  expect(registry).toHaveBeenCalledTimes(1);
});
it('selects a released version even when it is the retained previous runtime', async () => {
  await update();
  latest = '1.0.0';
  await update();
  expect((await store.verifyRuntime('cli')).reference.version).toBe('1.0.0');
});

async function status() {
  let text = '';
  const code = await runCli(['status'], {
    installStateDir: state,
    home: state,
    cwd: state,
    stdout: {
      write: (value: string) => {
        text += value;
      },
    },
    configuredHosts: [],
    installationConditions: [],
    preflight: {
      resolveIdentity: async () => ({ kind: 'git_unavailable', detail: 'fixture' }),
      pathExists: async () => false,
      fetch: async () => Response.json({}),
    },
  });
  return { code, text };
}
it('status shows one newer-version hint and caches metadata for an hour', async () => {
  expect((await status()).text).toContain(`CLI ${running}.\n`);
  expect((await status()).text).toContain('CLI 1.1.0 is available; run mnemonik update.');
  expect(registry).toHaveBeenCalledTimes(1);
  await writeFile(
    join(state, 'cli-update-check.json'),
    JSON.stringify({ checkedAt: Date.now() - 3_600_001, devReleaseSource: '', version: latest })
  );
  await status();
  expect(registry).toHaveBeenCalledTimes(2);
});
it('status bounds a stalled registry to 2.5 seconds and caches the failure quietly', async () => {
  registry.mockImplementationOnce(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), {
          once: true,
        });
      })
  );
  const started = performance.now();
  const result = await status();
  expect(performance.now() - started).toBeLessThan(3000);
  expect(result.text).toContain(`CLI ${running}.`);
  expect(result.text).not.toContain('is available');
  expect((await status()).code).toBe(result.code);
  expect(registry).toHaveBeenCalledTimes(1);
});
it('uses the dev release index, records its source, and makes no registry calls', async () => {
  const directory = join(state, 'release');
  await mkdir(directory);
  await writeFile(join(directory, 'cli.tgz'), tarballs.get(latest)!);
  await writeFile(
    join(directory, 'index.json'),
    JSON.stringify({
      '@mnemonik/cli': { version: latest, integrity: dist(latest).integrity, tarball: 'cli.tgz' },
    })
  );
  vi.stubEnv('MNEMONIK_DEV_RELEASE_DIR', directory);
  expect((await update()).report.cli).toMatchObject({ status: 'UPDATED', devReleaseSource: true });
  expect(registry).not.toHaveBeenCalled();
});
it('refuses exact metadata that disagrees with the latest integrity pin', async () => {
  registry.mockImplementationOnce(async () =>
    Response.json({
      name: '@mnemonik/cli',
      version: latest,
      dist: { ...dist(latest), integrity: 'sha512-wrong' },
    })
  );
  expect((await update()).report.cli).toMatchObject({
    status: 'FAILED',
    reason: 'digest_mismatch',
  });
  expect((await store.verifyRuntime('cli')).reference.version).toBe('1.0.0');
  expect(registry).toHaveBeenCalledTimes(2);
});

it('plain update uses the new CLI pins for hooks in the same invocation; explicit scanner update stays scanner-only', async () => {
  const steps: string[] = [];
  await mkdir(join(state, 'scanner'));
  await writeFile(join(state, 'scanner/state.json'), '{}');
  vi.spyOn(hosts, 'selectOwned').mockResolvedValue({
    ambiguous: [],
    selected: [
      {
        id: 'fixture',
        host: 'codex',
        component: 'hooks',
        scope: 'user',
        home: state,
        profilePath: join(state, 'hooks.json'),
        files: [],
        version: '1.0.0',
        artifactDigest: '',
        runtimePointer: '',
      },
    ],
  });
  const source = vi
    .spyOn(runtimes, 'hostNpmSource')
    .mockResolvedValue({} as Awaited<ReturnType<typeof runtimes.hostNpmSource>>);
  const runHosts = hosts.runHosts;
  const hooks = vi.spyOn(hosts, 'runHosts').mockImplementation(async (command, _targets, deps) => {
    steps.push('hooks');
    expect((await store.verifyRuntime('cli')).reference.version).toBe('1.1.0');
    await deps.source?.('codex');
    expect(source).toHaveBeenCalledWith('codex', {
      package: '@mnemonik/codex-hooks',
      version: '1.1.0',
      closure: [],
    });
    return runHosts(command, [], deps);
  });
  const service = vi.spyOn(scanner, 'updateScanner').mockImplementation(async () => {
    steps.push('scanner');
    expect((await store.verifyRuntime('cli')).reference.version).toBe('1.1.0');
    return store.verifyRuntime('cli');
  });
  registry.mockImplementationOnce(async () => {
    steps.push('cli');
    return Response.json({ name: '@mnemonik/cli', version: latest, dist: dist(latest) });
  });
  const deps = {
    installStateDir: state,
    home: state,
    hostManagement: { stateDir: state, account: 'fixture' },
    stdout: { write: () => {} },
  };
  expect(await runCli(['update', '--json'], deps)).toBe(0);
  expect(steps).toEqual(['cli', 'hooks', 'scanner']);
  hooks.mockClear();
  registry.mockClear();
  service.mockImplementation(async () => store.verifyRuntime('cli'));
  expect(await runCli(['update', '--component=scanner', '--json'], deps)).toBe(0);
  expect(hooks).not.toHaveBeenCalled();
  expect(registry).not.toHaveBeenCalled();
});

it.each([
  ['7.95.3-win.43', '7.95.3-win.44', false],
  ['7.95.3-win.44', '7.95.3-win.43', true],
  ['7.95.3-win.9', '7.95.3-win.10', false],
])('orders cached development hint %s against %s', async (cached, current, newer) => {
  vi.stubEnv('MNEMONIK_DEV_RELEASE_DIR', '/fixture/dev');
  await writeFile(
    join(state, 'cli-update-check.json'),
    JSON.stringify({ checkedAt: Date.now(), devReleaseSource: '/fixture/dev', version: cached }),
    { mode: 0o600 }
  );
  expect(Boolean(await cliUpdateHint(store, current))).toBe(newer);
  expect(registry).not.toHaveBeenCalled();
});
