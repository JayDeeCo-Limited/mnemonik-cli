import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeReadiness } from '@mnemonik/shared';
import packageJson from '../package.json' with { type: 'json' };
import { ensureLauncher } from '../src/launcher.js';
import { runCli } from '../src/router.js';
import { installBootstrap } from '../src/runtime/bootstrap.js';
import { cliUpdateHint, updateCli } from '../src/runtime/selfUpdate.js';
import { npmReleaseSource } from '../src/runtime/releaseSource.js';
import { RuntimeStore, type RuntimeSource } from '../src/runtime/store.js';
import * as runtimes from '../src/runtime/store.js';
import * as hosts from '../src/install/hosts.js';
import * as scanner from '../src/scanner/update.js';
import * as scannerEnable from '../src/scanner/enable.js';
import { ScannerServiceLimited } from '../src/scanner/service.js';
import { SCANNER_FAILURE_MESSAGE, SCANNER_RETRY_MESSAGE } from '../src/screens/journey.js';

const releaseKeyFixture = vi.hoisted(() => ({
  identity: 'RWRR4IuRRiDm099vVMtdLMArwPsHl94YS/XD3d3CkS4zrxBTwbP/sZzM',
  privateKey: 'MC4CAQAwBQYDK2VwBCIEIB468qShwQ6z/PXYa953aeiP4/2PcY6V1SGan7D5CMFR',
  keyId: 'UeCLkUYg5tM=',
}));
// Fails only the publish of a staged bootstrap copy, after the installed copy moved aside.
const bootstrapFault = vi.hoisted(() => ({ publish: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    rename: async (from: string, to: string) => {
      if (bootstrapFault.publish && /[\\/]\.bootstrap-[^\\/]+$/.test(String(from)))
        throw new Error('busy');
      return fs.rename(from, to);
    },
  };
});
vi.mock('@mnemonik/shared/hook-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mnemonik/shared/hook-runtime')>()),
  RELEASE_MINISIGN_PUBLIC_KEY: releaseKeyFixture.identity,
}));

let fixture: string, state: string, store: RuntimeStore, installedSource: RuntimeSource;
const bootstrapBin = (version: string) => `// bootstrap bin ${version}\n`;
const bootstrapFiles = [
  'dist/help.js',
  'dist/humanReason.js',
  'dist/runtime/bootstrap.js',
  'dist/runtime/store.js',
  'dist/runtime/signers.js',
  'dist/vendor/shared/runtimeReader.js',
  'dist/vendor/shared/runtimeSigners.js',
];
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
    await writeFile(join(dir, 'dist/bin.js'), bootstrapBin(version));
    for (const name of bootstrapFiles) {
      await mkdir(join(dir, name, '..'), { recursive: true });
      await writeFile(join(dir, name), `// ${name}\n`);
    }
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
  installedSource = await npmReleaseSource(registry, async () => ({
    version: latest,
    'dist.integrity': dist(latest).integrity,
    'dist.tarball': dist(latest).tarball,
  }));
  await store.installRuntime('cli', latest, installedSource);
  latest = '1.1.0';
  registry.mockClear();
});
afterEach(() => {
  bootstrapFault.publish = false;
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
it('updates successfully when sign-in state cannot be read for its readiness report', async () => {
  let text = '';
  let errors = '';
  const getCliBearer = vi.fn(async () => {
    throw new Error('sign-in state unavailable');
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
  expect(getCliBearer).toHaveBeenCalledOnce();
  expect(grantFetch).not.toHaveBeenCalled();
});
it.each([
  [true, false],
  [false, false],
  [false, true],
])(
  'failed update reports scanner recovery only if it is not running: %s (scanner-only: %s)',
  async (running, scannerOnly) => {
    await mkdir(join(state, 'scanner'));
    await writeFile(join(state, 'scanner/state.json'), '{}');
    const failure = new ScannerServiceLimited('systemd_session_unavailable');
    vi.spyOn(scanner, 'updateScanner').mockRejectedValue(failure);
    let errors = '';
    const command = vi.fn(async () => ({
      status: 'ok' as const,
      supervisor: {
        kind: 'launchd' as const,
        installed: true,
        running,
        pid: running ? 1234 : null,
      },
    }));
    const code = await runCli(['update', ...(scannerOnly ? ['--component=scanner'] : [])], {
      installStateDir: state,
      home: state,
      stdout: { write: () => {} },
      stderr: { write: (value) => (errors += value) },
      scannerService: { stateDir: state, command },
    });
    expect(code).toBe(scannerOnly ? 3 : 1);
    if (running) expect(errors).not.toContain(failure.summary);
    else {
      expect(errors).toContain(failure.summary);
      expect(errors).toContain(failure.action);
      expect(errors).not.toContain('Run mnemonik install to try again.');
    }
    expect(command).toHaveBeenCalledWith('status', undefined);
  }
);
it.each([false, true])(
  'rolled-back Mac update says the scanner went back a version (scanner-only: %s)',
  async (scannerOnly) => {
    await mkdir(join(state, 'scanner'));
    await writeFile(join(state, 'scanner/state.json'), '{}');
    const failure = new ScannerServiceLimited('scanner_replacement_rolled_back');
    vi.spyOn(scanner, 'updateScanner').mockRejectedValue(failure);
    let errors = '';
    await runCli(['update', ...(scannerOnly ? ['--component=scanner'] : [])], {
      installStateDir: state,
      home: state,
      stdout: { write: () => {} },
      stderr: { write: (value) => (errors += value) },
      scannerService: {
        stateDir: state,
        command: async () => ({
          status: 'ok',
          supervisor: { kind: 'launchd', installed: true, running: true, pid: 1234 },
        }),
      },
    });
    expect(errors.split('\n').slice(-3, -1)).toEqual([
      'Background indexing went back to the previous version.',
      SCANNER_RETRY_MESSAGE,
    ]);
    expect(errors).not.toContain(SCANNER_FAILURE_MESSAGE);
    expect(errors).not.toContain('[COPY REVIEW REQUIRED]');
  }
);

it.each([false, true])(
  'update recovery reuses the approved installer sentences verbatim (scanner-only: %s)',
  async (scannerOnly) => {
    await mkdir(join(state, 'scanner'));
    await writeFile(join(state, 'scanner/state.json'), '{}');
    vi.spyOn(scanner, 'updateScanner').mockRejectedValue(new Error('fixture failure'));
    let errors = '';
    await runCli(['update', ...(scannerOnly ? ['--component=scanner'] : [])], {
      installStateDir: state,
      home: state,
      stdout: { write: () => {} },
      stderr: { write: (value) => (errors += value) },
      scannerService: {
        stateDir: state,
        command: async () => ({
          status: 'ok',
          supervisor: { kind: 'systemd', installed: true, running: false, pid: null },
        }),
      },
    });
    expect(errors.split('\n').slice(-3, -1)).toEqual([
      'Background indexing could not be started.',
      'Run mnemonik install to try again.',
    ]);
  }
);

it('standalone scanner enable retains the supervisor recovery action for an SSH session', async () => {
  const failure = new ScannerServiceLimited('systemd_session_unavailable');
  vi.spyOn(scannerEnable, 'enableScanner').mockRejectedValue(failure);
  let errors = '';
  expect(
    await runCli(['scanner', 'enable'], {
      installStateDir: state,
      home: state,
      stdout: { write: () => {} },
      stderr: { write: (value) => (errors += value) },
    })
  ).toBe(3);
  expect(errors).toContain(failure.action);
  expect(errors).not.toContain('mnemonik scanner enable');
});
async function bootstrapCopy() {
  const root = join(state, 'runtimes/bootstrap');
  const digests = JSON.parse(
    await readFile(join(root, 'bootstrap-digests.json'), 'utf8')
  ) as Record<string, string>;
  for (const [name, digest] of Object.entries(digests))
    expect(runtimes.hash(await readFile(join(root, name))), name).toBe(digest);
  return { bin: await readFile(join(root, 'dist/bin.js'), 'utf8'), digests };
}
it('update refreshes the bootstrap copy from the release it installed', async () => {
  await installBootstrap(store, installedSource);
  expect((await bootstrapCopy()).bin).toBe(bootstrapBin('1.0.0'));
  expect(await updateCli(store)).toMatchObject({
    status: 'UPDATED',
    oldVersion: '1.0.0',
    newVersion: '1.1.0',
  });
  const copy = await bootstrapCopy();
  expect(copy.bin).toBe(bootstrapBin('1.1.0'));
  expect(copy.digests['dist/bin.js']).toBe(runtimes.hash(Buffer.from(bootstrapBin('1.1.0'))));
});
it('a failed bootstrap refresh after the runtime install keeps the previous copy and reports FAILED', async () => {
  await installBootstrap(store, installedSource);
  const before = await bootstrapCopy();
  bootstrapFault.publish = true;
  expect(await updateCli(store)).toMatchObject({
    status: 'FAILED',
    reason: 'busy',
    oldVersion: '1.0.0',
    newVersion: '1.1.0',
  });
  expect((await store.verifyRuntime('cli')).reference.version).toBe('1.1.0');
  expect(await bootstrapCopy()).toEqual(before);
  expect(before.bin).toBe(bootstrapBin('1.0.0'));
  expect(await readdir(join(state, 'runtimes'))).not.toContain('bootstrap.previous');
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
      scannerService: {
        stateDir: state,
        supervisorRun: async (_file, args) =>
          args.includes('show')
            ? 'LoadState=not-found\nActiveState=inactive\nMainPID=0\nUnitFileState='
            : '',
      },
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
      'Codex has not trusted the Mnemonik hooks yet.\n' +
      'Open Codex settings, trust the Mnemonik hooks, then quit and reopen Codex.\n',
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
    text: 'The mnemonik command updated.\n',
    errors:
      'Your coding tools could not update.\nRun mnemonik repair, then start a new session in each coding tool.\n',
  });
  expect(runHosts).toHaveBeenCalledTimes(2);
});

it('manual update failure reports one automatic-follow-up line without internal detail', async () => {
  corrupt = true;
  const result = await update(false);
  expect(result).toMatchObject({
    code: 1,
    text: '',
    errors:
      'The mnemonik command could not update.\nRun npx -y @mnemonik/cli@latest install to update it.\n',
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

it.each([
  ['mac_authorization_failed', false],
  ['mac_authorization_failed', true],
  ['mac_authorization_required', false],
  ['mac_authorization_required', true],
] as const)(
  'manual update preserves %s wording while the old scanner runs (scanner-only: %s)',
  async (reason, scannerOnly) => {
    await mkdir(join(state, 'scanner'));
    await writeFile(join(state, 'scanner/state.json'), '{}');
    const failure = new ScannerServiceLimited(reason);
    vi.spyOn(scanner, 'updateScanner').mockRejectedValue(failure);
    let errors = '';
    await runCli(['update', ...(scannerOnly ? ['--component=scanner'] : [])], {
      installStateDir: state,
      home: state,
      stdout: { write: () => {} },
      stderr: { write: (value) => (errors += value) },
      scannerService: {
        stateDir: state,
        command: async () => ({
          status: 'ok',
          supervisor: { kind: 'launchd', installed: true, running: true, pid: 1234 },
        }),
      },
    });
    expect(errors.split('\n').slice(-3, -1)).toEqual([failure.summary, failure.action]);
  }
);

it('names what updated and what did not when only the scanner step fails', async () => {
  await mkdir(join(state, 'scanner'));
  await writeFile(join(state, 'scanner/state.json'), '{}');
  const failure = new ScannerServiceLimited('systemd_session_unavailable');
  vi.spyOn(scanner, 'updateScanner').mockRejectedValue(failure);
  let text = '';
  let errors = '';
  await runCli(['update'], {
    installStateDir: state,
    home: state,
    stdout: { write: (value) => (text += value) },
    stderr: { write: (value) => (errors += value) },
    scannerService: {
      stateDir: state,
      command: async () => ({
        status: 'ok',
        supervisor: { kind: 'systemd', installed: true, running: false, pid: null },
      }),
    },
  });
  expect(text).toBe('The mnemonik command updated.\n');
  expect(errors).toBe(`${failure.summary}\n${failure.action}\n`);
  expect(`${text}${errors}`).not.toContain('Mnemonik could not update.');
});

describe('a scanner release that names an updated notice', () => {
  const saved = (root: string) =>
    JSON.stringify({
      schemaVersion: 1,
      config: { roots: [root], exclusions: [], serverUrl: 'https://api.mnemonik.dev' },
      consent: { userId: 'owner', roots: [root], exclusions: [], disclosureVersion: '2026.09.1' },
      paused: false,
      pauseIntervals: [],
    });
  async function setup() {
    const root = join(state, 'Projects', 'app');
    await mkdir(root, { recursive: true });
    await mkdir(join(state, 'scanner'));
    await writeFile(join(state, 'scanner/state.json'), saved(root));
    const verify = RuntimeStore.prototype.verifyRuntime;
    vi.spyOn(RuntimeStore.prototype, 'verifyRuntime').mockImplementation(async function (
      this: RuntimeStore,
      artifact
    ) {
      if (artifact !== 'scanner') return verify.call(this, artifact);
      return {
        directory: '/verified/1',
        entry: '/verified/1/scanner',
        reference: { version: '1.0.0', manifestSha256: 'installed' },
        manifest: { artifact: 'scanner', version: '1.0.0', disclosureVersion: '2026.09.1' },
      } as Awaited<ReturnType<RuntimeStore['verifyRuntime']>>;
    });
    const operations: string[] = [];
    const command = vi.fn(async (operation: string) => {
      operations.push(operation);
      return {
        status: 'ok' as const,
        supervisor: { kind: 'systemd' as const, installed: true, running: true, pid: 1234 },
      };
    });
    const release: RuntimeSource = {
      manifest: {
        artifact: 'scanner',
        version: '2.0.0',
        disclosureVersion: '2026.09.2',
      } as RuntimeSource['manifest'],
      files: {},
    };
    const enable = vi
      .spyOn(scannerEnable, 'enableScanner')
      .mockResolvedValue(serializeReadiness({ installation: { conditions: [] } }));
    const install = vi.spyOn(RuntimeStore.prototype, 'installRuntime');
    const out = { text: '', write: (value: string) => void (out.text += value) };
    const err = { text: '', write: (value: string) => void (err.text += value) };
    const deps = {
      installStateDir: state,
      home: state,
      stdout: out,
      stderr: err,
      scannerService: { stateDir: state, command },
      scannerEnable: { source: async () => release },
    };
    return { root, operations, enable, install, out, err, deps };
  }

  it.each([false, true])(
    'a manual update asks once in the browser and leaves the running scanner running (scanner-only: %s)',
    async (scannerOnly) => {
      const f = await setup();
      const code = await runCli(
        ['update', ...(scannerOnly ? ['--component=scanner'] : [])],
        f.deps as Parameters<typeof runCli>[1]
      );
      expect(code).toBe(0);
      expect(f.enable).toHaveBeenCalledOnce();
      expect(f.enable).toHaveBeenCalledWith(
        expect.objectContaining({ roots: [f.root], exclusions: [], stateDir: state })
      );
      expect(f.enable.mock.calls[0]?.[0]).not.toHaveProperty('nonInteractive', true);
      expect(f.out.text).toContain('Mnemonik updated.\n');
      expect(f.out.text).not.toContain('updated notice');
      // The update itself neither paused, stopped nor replaced the running scanner:
      // the approval flow is where the new scanner is installed.
      expect(f.operations).not.toEqual(expect.arrayContaining(['stop']));
      expect(f.operations).not.toEqual(expect.arrayContaining(['uninstall']));
      expect(f.install).not.toHaveBeenCalledWith('scanner', expect.anything(), expect.anything());
      await expect(readFile(join(state, 'scanner/control.json'))).rejects.toThrow();
      expect(await readFile(join(state, 'scanner/state.json'), 'utf8')).toBe(saved(f.root));
    }
  );

  it('an automatic update asks nothing, keeps the scanner running and is not a failure', async () => {
    const f = await setup();
    expect(await runCli(['update', '--automatic'], f.deps as Parameters<typeof runCli>[1])).toBe(0);
    expect(f.enable).not.toHaveBeenCalled();
    expect(`${f.out.text}${f.err.text}`).toBe('');
    expect(f.operations).not.toEqual(expect.arrayContaining(['stop']));
    await expect(readFile(join(state, 'scanner/control.json'))).rejects.toThrow();
    expect(await readFile(join(state, 'scanner/state.json'), 'utf8')).toBe(saved(f.root));
    const check = JSON.parse(await readFile(join(state, 'update-check.json'), 'utf8'));
    expect(check.result).not.toBe('failed');
  });

  it('a manual update the person does not approve says what is waiting', async () => {
    const f = await setup();
    f.enable.mockRejectedValue(new Error('consent_declined'));
    expect(await runCli(['update'], f.deps as Parameters<typeof runCli>[1])).toBe(3);
    expect(f.enable).toHaveBeenCalledOnce();
    expect(f.out.text).toContain(
      'A scanner update is waiting until you approve an updated notice.\n' +
        'Run mnemonik scanner enable.\n'
    );
    expect(await readFile(join(state, 'scanner/state.json'), 'utf8')).toBe(saved(f.root));
  });
});
