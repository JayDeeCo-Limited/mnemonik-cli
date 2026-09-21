import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import packageJson from '../package.json' with { type: 'json' };
import { ensureLauncher } from '../src/launcher.js';
import { runCli } from '../src/router.js';
import { cliUpdateHint, updateCli } from '../src/runtime/selfUpdate.js';
import { npmReleaseSource } from '../src/runtime/releaseSource.js';
import { RuntimeStore } from '../src/runtime/store.js';
import * as runtimes from '../src/runtime/store.js';
import * as hosts from '../src/install/hosts.js';
import * as scanner from '../src/scanner/update.js';

const releaseKeyFixture = vi.hoisted(() => ({
  identity: 'RWRR4IuRRiDm099vVMtdLMArwPsHl94YS/XD3d3CkS4zrxBTwbP/sZzM',
  privateKey: 'MC4CAQAwBQYDK2VwBCIEIB468qShwQ6z/PXYa953aeiP4/2PcY6V1SGan7D5CMFR',
  keyId: 'UeCLkUYg5tM=',
}));
vi.mock('@mnemonik/shared/hook-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mnemonik/shared/hook-runtime')>()),
  RELEASE_MINISIGN_PUBLIC_KEY: releaseKeyFixture.identity,
}));

let fixture: string, state: string, store: RuntimeStore;
// `status` prints the version of the CLI that is running, which in this suite is
// the workspace package; the release bot bumps that on every release.
const running = packageJson.version;
const tarballs = new Map<string, Buffer>();
const dist = (version: string) => ({
  integrity: 'sha512-' + createHash('sha512').update(tarballs.get(version)!).digest('base64'),
  tarball: `https://registry.npmjs.org/cli-${version}.tgz`,
});
const signingKey = () => {
  const pair = generateKeyPairSync('ed25519');
  const keyId = randomBytes(8);
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return {
    identity: Buffer.concat([Buffer.from('Ed'), keyId, publicKey]).toString('base64'),
    sign(message: Buffer) {
      const trustedComment = 'fixture release';
      const fileSignature = sign(null, message, pair.privateKey);
      return [
        'untrusted comment: fixture signature',
        Buffer.concat([Buffer.from('Ed'), keyId, fileSignature]).toString('base64'),
        `trusted comment: ${trustedComment}`,
        sign(
          null,
          Buffer.concat([fileSignature, Buffer.from(trustedComment)]),
          pair.privateKey
        ).toString('base64'),
        '',
      ].join('\n');
    },
  };
};
const pinnedSigningKey = {
  identity: releaseKeyFixture.identity,
  sign(message: Buffer) {
    const privateKey = createPrivateKey({
      key: Buffer.from(releaseKeyFixture.privateKey, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
    const keyId = Buffer.from(releaseKeyFixture.keyId, 'base64');
    const trustedComment = 'fixture release';
    const fileSignature = sign(null, message, privateKey);
    return [
      'untrusted comment: fixture signature',
      Buffer.concat([Buffer.from('Ed'), keyId, fileSignature]).toString('base64'),
      `trusted comment: ${trustedComment}`,
      sign(null, Buffer.concat([fileSignature, Buffer.from(trustedComment)]), privateKey).toString(
        'base64'
      ),
      '',
    ].join('\n');
  },
};
const releaseManifest = (version: string) => ({
  schemaVersion: 1,
  version,
  packages: Object.fromEntries(
    [
      '@mnemonik/cli',
      '@mnemonik/claude-code-hooks',
      '@mnemonik/codex-hooks',
      '@mnemonik/cursor-hooks',
    ].map((name) => [
      name,
      {
        version,
        integrity: name === '@mnemonik/cli' ? dist(version).integrity : 'sha512-Zml4dHVyZQ==',
      },
    ])
  ),
});
const manifestFetcher =
  (
    manifest: Buffer | undefined,
    signature: string | undefined,
    requests: string[] = []
  ): typeof fetch =>
  async (url, options) => {
    const address = String(url);
    requests.push(address);
    if (address.endsWith('/release-manifest.json'))
      return manifest ? new Response(manifest) : new Response(null, { status: 404 });
    if (address.endsWith('/release-manifest.json.minisig'))
      return signature ? new Response(signature) : new Response(null, { status: 404 });
    return registry(url, options);
  };
let latest: string, corrupt: boolean;
const registry = vi.fn<typeof fetch>(async (url) => {
  if (String(url).endsWith('/release-manifest.json'))
    return new Response(JSON.stringify(releaseManifest(latest)));
  if (String(url).endsWith('/release-manifest.json.minisig')) {
    const manifest = Buffer.from(JSON.stringify(releaseManifest(latest)));
    return new Response(pinnedSigningKey.sign(manifest));
  }
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
  let errors = '';
  const stdout = {
    write: (value: string) => {
      text += value;
    },
  };
  const code = await runCli(['update', ...(json ? ['--json'] : [])], {
    installStateDir: state,
    home: state,
    stdout,
    stderr: { write: (value) => (errors += value) },
  });
  return { code, text, errors, report: json ? JSON.parse(text) : undefined };
}

function selectCodexHooks() {
  vi.spyOn(hosts, 'selectOwned').mockResolvedValue({
    ambiguous: [],
    selected: [
      {
        id: 'codex-hooks',
        host: 'codex',
        component: 'hooks',
        scope: 'user',
        home: state,
        profilePath: join(state, 'codex/config.toml'),
        files: [],
        version: '0.8.177',
        artifactDigest: 'fixture',
        runtimePointer: 'fixture',
      },
    ],
  });
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
    'https://github.com/JayDeeCo-Limited/mnemonik-cli/releases/download/scanner-v1.1.0/release-manifest.json',
    'https://github.com/JayDeeCo-Limited/mnemonik-cli/releases/download/scanner-v1.1.0/release-manifest.json.minisig',
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
it('updates without reading sign-in state or uploading readiness', async () => {
  let text = '';
  let errors = '';
  const getCliBearer = vi.fn(async () => {
    throw new Error('update must not read sign-in state');
  });
  const grantFetch = vi.fn(async () => {
    throw new Error('update must not list grants or upload readiness');
  });
  const code = await runCli(['update', '--json'], {
    installStateDir: state,
    home: state,
    cwd: state,
    stdout: { write: (value) => (text += value) },
    stderr: { write: (value) => (errors += value) },
    cliAuth: {
      signIn: async () => undefined,
      getCliBearer,
      logout: async () => undefined,
    },
    grantFetch,
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
  expect({ code, errors }).toEqual({ code: 0, errors: '' });
  expect(JSON.parse(text).cli).toMatchObject({ status: 'UPDATED', newVersion: '1.1.0' });
  expect(getCliBearer).not.toHaveBeenCalled();
  expect(grantFetch).not.toHaveBeenCalled();
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
it('updates from a matching tarball only after verifying the signed release manifest', async () => {
  const key = signingKey();
  const manifest = Buffer.from(JSON.stringify(releaseManifest(latest)));
  const requests: string[] = [];
  const result = await updateCli(store, {
    fetcher: manifestFetcher(manifest, key.sign(manifest), requests),
    releaseKey: key.identity,
  });
  expect(result).toMatchObject({
    status: 'UPDATED',
    oldVersion: '1.0.0',
    newVersion: '1.1.0',
  });
  expect(JSON.parse(await readFile(store.pointerPath('cli'), 'utf8'))).toMatchObject({
    current: { version: '1.1.0' },
    previous: { version: '1.0.0' },
  });
  expect(requests.filter((url) => url.includes('release-manifest.json'))).toHaveLength(2);
});
it('refuses a release manifest signed by another key without moving the pointer', async () => {
  const trusted = signingKey();
  const other = signingKey();
  const manifest = Buffer.from(JSON.stringify(releaseManifest(latest)));
  const before = await readFile(store.pointerPath('cli'));
  expect(
    await updateCli(store, {
      fetcher: manifestFetcher(manifest, other.sign(manifest)),
      releaseKey: trusted.identity,
    })
  ).toMatchObject({ status: 'FAILED', reason: 'unsigned' });
  expect(await readFile(store.pointerPath('cli'))).toEqual(before);
});
it('refuses a one-byte SRI change after signing without moving the pointer', async () => {
  const key = signingKey();
  const manifest = Buffer.from(JSON.stringify(releaseManifest(latest)));
  const changed = Buffer.from(manifest);
  const sriByte = changed.indexOf(Buffer.from('sha512-')) + 'sha512-'.length;
  changed[sriByte] = changed[sriByte]! ^ 1;
  const before = await readFile(store.pointerPath('cli'));
  expect(
    await updateCli(store, {
      fetcher: manifestFetcher(changed, key.sign(manifest)),
      releaseKey: key.identity,
    })
  ).toMatchObject({ status: 'FAILED', reason: 'unsigned' });
  expect(await readFile(store.pointerPath('cli'))).toEqual(before);
});
it('refuses a missing manifest for any target release without moving the pointer', async () => {
  const before = await readFile(store.pointerPath('cli'));
  expect(await updateCli(store, { fetcher: manifestFetcher(undefined, undefined) })).toMatchObject({
    status: 'FAILED',
    reason: 'unsigned',
  });
  expect(await readFile(store.pointerPath('cli'))).toEqual(before);
});
it('same version performs no runtime writes or tarball download', async () => {
  latest = '1.0.0';
  const before = await stat(store.pointerPath('cli'));
  const install = vi.spyOn(RuntimeStore.prototype, 'installRuntime');
  expect((await update(false)).text).toBe('Mnemonik is up to date.\n');
  expect(install).not.toHaveBeenCalled();
  expect((await stat(store.pointerPath('cli'))).mtimeMs).toBe(before.mtimeMs);
  expect(registry).toHaveBeenCalledTimes(1);
});
it('manual and automatic updates use the customer output contract', async () => {
  const manual = await update(false);
  expect(manual).toMatchObject({ code: 0, text: 'Mnemonik updated.\n', errors: '' });

  latest = '1.0.0';
  const stdout = {
    text: '',
    write(value: string) {
      this.text += value;
    },
  };
  const stderr = {
    text: '',
    write(value: string) {
      this.text += value;
    },
  };
  expect(
    await runCli(['update', '--automatic'], {
      installStateDir: state,
      home: state,
      stdout,
      stderr,
    })
  ).toBe(0);
  expect({ stdout: stdout.text, stderr: stderr.text }).toEqual({ stdout: '', stderr: '' });
});

it.each([
  ['Grok', 'grok', '.grok'],
  ['Copilot', 'vscode-copilot', '.copilot'],
])('automatic update ignores ownership left by an earlier %s install', async (_name, host, dir) => {
  const id = `${host}:hooks:user`;
  await writeFile(
    join(state, 'host-ownership.json'),
    JSON.stringify({
      schemaVersion: 1,
      generation: 0,
      targets: [
        {
          id,
          host,
          component: 'hooks',
          scope: 'user',
          home: state,
          profilePath: join(state, dir, 'hooks', 'hooks.json'),
          version: '0.1.49',
          artifactDigest: 'legacy',
          runtimePointer: join(state, 'runtimes', host, 'current'),
          files: [],
        },
      ],
    })
  );
  const stdout = {
    text: '',
    write(value: string) {
      this.text += value;
    },
  };
  const stderr = {
    text: '',
    write(value: string) {
      this.text += value;
    },
  };

  expect(
    await runCli(['update', '--automatic'], {
      installStateDir: state,
      home: state,
      stdout,
      stderr,
    })
  ).toBe(0);
  expect({ stdout: stdout.text, stderr: stderr.text }).toEqual({ stdout: '', stderr: '' });
  expect(await readFile(join(state, 'host-ownership.json'), 'utf8')).toContain(id);
});

it.each([
  ['Grok', 'grok', '.grok'],
  ['Copilot', 'vscode-copilot', '.copilot'],
])('uninstall leaves earlier %s hooks alone without naming them', async (name, host, dir) => {
  const hook = join(state, dir, 'hooks', 'hooks.json');
  await mkdir(join(state, dir, 'hooks'), { recursive: true });
  await writeFile(hook, '{"mnemonik":"legacy"}\n');
  await writeFile(
    join(state, 'host-ownership.json'),
    JSON.stringify({
      schemaVersion: 1,
      generation: 0,
      targets: [
        {
          id: `${host}:hooks:user`,
          host,
          component: 'hooks',
          scope: 'user',
          home: state,
          profilePath: hook,
          version: '0.1.49',
          artifactDigest: 'legacy',
          runtimePointer: join(state, 'runtimes', host, 'current'),
          files: [{ path: hook, hash: 'legacy' }],
          credentialFamily: `legacy-${host}-hook-family`,
          grant: {
            installationId: '11111111-1111-4111-8111-111111111111',
            id: `legacy-${host}-grant`,
            account: 'owner',
            scopes: ['hooks:use'],
          },
        },
      ],
    })
  );
  let text = '';
  const grantFetch = vi.fn(async () => {
    throw new Error('legacy credentials must not be read');
  });

  expect(
    await runCli(['uninstall', '--non-interactive', '--confirm'], {
      installStateDir: state,
      home: state,
      stdout: { write: (value) => void (text += value) },
      grantFetch,
    })
  ).toBe(0);
  expect(await readFile(hook, 'utf8')).toBe('{"mnemonik":"legacy"}\n');
  expect(text.toLowerCase()).not.toContain(name.toLowerCase());
  expect(grantFetch).not.toHaveBeenCalled();
});

it('reports a completed host update before the pending Codex trust action', async () => {
  selectCodexHooks();
  vi.spyOn(hosts, 'runHosts').mockResolvedValue({
    results: [
      {
        target: 'codex-hooks',
        elapsedMs: 1,
        status: 'ACTION_REQUIRED',
        reason: 'codex_trust_pending',
      },
    ],
    reports: ['shared runtime updated codex to 0.8.177'],
    journal: { state: 'ACTION_REQUIRED' } as never,
  });

  expect(await update(false)).toEqual({
    code: 3,
    text:
      'Mnemonik updated.\n' +
      'Codex needs permission to use the Mnemonik hooks.\n' +
      'Open Codex, allow the Mnemonik hooks, then quit and reopen Codex.\n',
    errors: '',
    report: undefined,
  });
});

it('retries a failed host update once and reports the successful second attempt', async () => {
  selectCodexHooks();
  const runHosts = vi
    .spyOn(hosts, 'runHosts')
    .mockResolvedValueOnce({
      results: [
        {
          target: 'codex-hooks',
          elapsedMs: 1,
          status: 'ACTION_REQUIRED',
          reason: 'hooks_missing',
        },
      ],
      reports: [],
      journal: { state: 'ACTION_REQUIRED' } as never,
    })
    .mockResolvedValueOnce({
      results: [
        { target: 'codex-hooks', elapsedMs: 1, status: 'READY', reason: 'hooks installed' },
      ],
      reports: ['shared runtime updated codex to 0.8.177'],
      journal: { state: 'READY' } as never,
    });

  expect(await update(false)).toMatchObject({ code: 0, text: 'Mnemonik updated.\n', errors: '' });
  expect(runHosts).toHaveBeenCalledTimes(2);
});

it('reports one failure after both host update attempts fail', async () => {
  selectCodexHooks();
  const runHosts = vi.spyOn(hosts, 'runHosts').mockResolvedValue({
    results: [
      {
        target: 'codex-hooks',
        elapsedMs: 1,
        status: 'ACTION_REQUIRED',
        reason: 'hooks_missing',
      },
    ],
    reports: [],
    journal: { state: 'ACTION_REQUIRED' } as never,
  });

  expect(await update(false)).toMatchObject({
    code: 3,
    text: '',
    errors: 'Mnemonik could not update. It will try again automatically tomorrow.\n',
  });
  expect(runHosts).toHaveBeenCalledTimes(2);
});

it('manual update failure reports one automatic-follow-up line without internal detail', async () => {
  corrupt = true;
  const result = await update(false);
  expect(result).toMatchObject({
    code: 1,
    text: '',
    errors: 'Mnemonik could not update. It will try again automatically tomorrow.\n',
  });
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
  expect((await status()).text).not.toContain(`CLI ${running}.\n`);
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
  expect(result.text).not.toContain(`CLI ${running}.`);
  expect(result.text).not.toContain('is available');
  expect((await status()).code).toBe(result.code);
  expect(registry).toHaveBeenCalledTimes(1);
});
it('uses the dev release index, records its source, and makes no registry calls', async () => {
  const directory = join(state, 'release');
  await mkdir(directory);
  await writeFile(join(directory, 'cli.tgz'), tarballs.get(latest)!);
  const manifest = Buffer.from(JSON.stringify(releaseManifest(latest)));
  await writeFile(join(directory, 'release-manifest.json'), manifest);
  await writeFile(
    join(directory, 'release-manifest.json.minisig'),
    pinnedSigningKey.sign(manifest)
  );
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
it('retries after exact metadata disagrees with the latest integrity pin', async () => {
  registry.mockImplementationOnce(async () =>
    Response.json({
      name: '@mnemonik/cli',
      version: latest,
      dist: { ...dist(latest), integrity: 'sha512-wrong' },
    })
  );
  expect((await update()).report.cli).toMatchObject({ status: 'UPDATED', newVersion: '1.1.0' });
  expect((await store.verifyRuntime('cli')).reference.version).toBe('1.1.0');
  expect(registry).toHaveBeenCalledTimes(7);
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
