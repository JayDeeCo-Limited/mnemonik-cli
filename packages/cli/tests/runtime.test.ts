import * as fs from 'node:fs/promises';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { guardNpmLaunch } from '../src/runtime/bootstrap.js';
import { hash, RuntimeStore, updateRuntime, type RuntimeSource } from '../src/runtime/store.js';
import { verifySigner, verifyWindowsPermission } from '../src/runtime/signers.js';
import { runCli } from '../src/router.js';

const writes = vi.hoisted(() => ({ open: vi.fn(), writeFile: vi.fn(), fsync: vi.fn() }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    mkdtemp: vi.fn(actual.mkdtemp),
    writeFile: vi.fn(async (...args: Parameters<typeof actual.writeFile>) => {
      writes.writeFile();
      return actual.writeFile(...args);
    }),
    open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (args[1] === 'wx') writes.open();
      return new Proxy(handle, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (property === 'writeFile' || property === 'sync')
            return (...methodArgs: unknown[]) => {
              writes[property === 'writeFile' ? 'writeFile' : 'fsync']();
              return Reflect.apply(
                value as (...callArgs: unknown[]) => unknown,
                target,
                methodArgs
              );
            };
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }),
  };
});

const { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } = fs;

let state: string;
let store: RuntimeStore;
function source(version: string): RuntimeSource {
  const bytes = Buffer.from(`export const version = '${version}';`);
  return {
    files: { 'entry.js': bytes },
    manifest: {
      schemaVersion: 1,
      artifact: 'cli',
      version,
      entry: 'entry.js',
      totalSize: bytes.length,
      files: { 'entry.js': { sha256: hash(bytes), size: bytes.length, executable: false } },
      source: {
        kind: 'npm',
        launchedFrom: '/fixture/node_modules/@mnemonik/cli/dist/bin.js',
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
  };
}
beforeEach(async () => {
  state = await mkdtemp(join(tmpdir(), 'runtime-'));
  store = new RuntimeStore(state);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(state, { recursive: true, force: true });
});

function signedScanner(algorithm: 'ED' | 'Ed' = 'ED') {
  const bytes = Buffer.from('scanner');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keyId = randomBytes(8);
  const identity = Buffer.concat([
    Buffer.from('Ed'),
    keyId,
    publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
  ]).toString('base64');
  const fileSignature = sign(
    null,
    algorithm === 'ED' ? createHash('blake2b512').update(bytes).digest() : bytes,
    privateKey
  );
  const packet = Buffer.concat([Buffer.from(algorithm), keyId, fileSignature]);
  const trustedComment = `timestamp:1\tfile:scanner${algorithm === 'ED' ? '\thashed' : ''}`;
  const globalSignature = sign(
    null,
    Buffer.concat([fileSignature, Buffer.from(trustedComment)]),
    privateKey
  );
  const signature = Buffer.from(
    `untrusted comment: signature\n${packet.toString('base64')}\ntrusted comment: ${trustedComment}\n${globalSignature.toString('base64')}\n`
  );
  const descriptor = (contents: Buffer, executable: boolean) => ({
    sha256: hash(contents),
    size: contents.length,
    executable,
  });
  const source: RuntimeSource = {
    files: { scanner: bytes, 'scanner.minisig': signature },
    manifest: {
      schemaVersion: 1,
      artifact: 'scanner',
      version: '1.0.0',
      entry: 'scanner',
      totalSize: bytes.length + signature.length,
      files: {
        scanner: descriptor(bytes, true),
        'scanner.minisig': descriptor(signature, false),
      },
      source: { kind: 'release', url: 'https://release.invalid/manifest.json' },
      signer: { platform: 'linux', identity, signature: 'scanner.minisig' },
    },
  };
  return { source, identity };
}

describe('verified runtime transactions', () => {
  it('verifies a retained runtime independently of the pointer and rejects later tampering', async () => {
    const retained = await store.installRuntime('cli', '1.0.0', source('1.0.0'));
    await store.installRuntime('cli', '2.0.0', source('2.0.0'));
    expect((await store.verifyRetainedRuntime('cli', retained.reference)).entry).toBe(
      retained.entry
    );
    expect((await store.verifyRuntime('cli')).reference.version).toBe('2.0.0');
    await writeFile(retained.entry, 'tampered after retention');
    await expect(store.verifyRetainedRuntime('cli', retained.reference)).rejects.toMatchObject({
      reason: 'digest_mismatch',
    });
  });

  it('reuses an identical verified runtime without staging or writes', async () => {
    const candidate = source('1.0.0');
    const first = await store.installRuntime('cli', '1.0.0', candidate);
    vi.clearAllMocks();

    const installed = await store.installRuntime('cli', '1.0.0', candidate);

    expect(installed.reference).toEqual(first.reference);
    expect({
      stages: vi.mocked(fs.mkdtemp).mock.calls.length,
      opens: writes.open.mock.calls.length,
      writes: writes.writeFile.mock.calls.length,
      fsyncs: writes.fsync.mock.calls.length,
    }).toEqual({ stages: 0, opens: 0, writes: 0, fsyncs: 0 });
    expect(
      (await readdir(join(state, 'runtimes/cli'))).some((name) => name.startsWith('.stage-'))
    ).toBe(false);
  });

  it('still rejects a different manifest for an installed version', async () => {
    await store.installRuntime('cli', '1.0.0', source('1.0.0'));
    const changed = source('1.0.0');
    const bytes = Buffer.from('different runtime');
    changed.files['entry.js'] = bytes;
    changed.manifest.totalSize = bytes.length;
    changed.manifest.files['entry.js'] = {
      sha256: hash(bytes),
      size: bytes.length,
      executable: false,
    };

    await expect(store.installRuntime('cli', '1.0.0', changed)).rejects.toMatchObject({
      reason: 'digest_mismatch',
    });
  });

  it('rejects a tampered installed runtime before staging the identical source', async () => {
    const candidate = source('1.0.0');
    const installed = await store.installRuntime('cli', '1.0.0', candidate);
    await writeFile(installed.entry, 'corrupt');
    vi.clearAllMocks();

    await expect(store.installRuntime('cli', '1.0.0', candidate)).rejects.toMatchObject({
      reason: 'digest_mismatch',
    });
    expect(fs.mkdtemp).not.toHaveBeenCalled();
  });

  it('installs, verifies, swaps and rolls back after re-verifying the previous version', async () => {
    const first = await store.installRuntime('cli', '1.0.0', source('1.0.0'));
    expect(first.directory).toBe(join(state, 'runtimes/cli/1.0.0'));
    expect(hash(await readFile(first.entry))).toBe(first.manifest.files['entry.js']!.sha256);
    await store.installRuntime('cli', '2.0.0', source('2.0.0'));
    expect((await store.verifyRuntime('cli')).manifest.version).toBe('2.0.0');
    expect((await store.rollbackRuntime('cli')).manifest.version).toBe('1.0.0');
  });
  it('refuses a one-byte corrupt candidate without touching current or restarting services', async () => {
    await store.installRuntime('cli', '1.0.0', source('1.0.0'));
    const before = await readFile(store.pointerPath('cli'));
    const next = source('2.0.0');
    next.files['entry.js']![0] = (next.files['entry.js']![0] ?? 0) ^ 1;
    const restartManagedServices = vi.fn();
    await expect(
      updateRuntime({ store, source: async () => next, restartManagedServices })
    ).rejects.toMatchObject({ reason: 'digest_mismatch' });
    expect(await readFile(store.pointerPath('cli'))).toEqual(before);
    expect((await store.verifyRuntime('cli')).manifest.version).toBe('1.0.0');
    expect(restartManagedServices).not.toHaveBeenCalled();
  });
  it('refuses corrupted installed current before returning a path and can recover to previous', async () => {
    await store.installRuntime('cli', '1.0.0', source('1.0.0'));
    const next = await store.installRuntime('cli', '2.0.0', source('2.0.0'));
    const before = await readFile(store.pointerPath('cli'));
    const bytes = await readFile(next.entry);
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    await writeFile(next.entry, bytes);
    await expect(store.verifyRuntime('cli')).rejects.toMatchObject({ reason: 'digest_mismatch' });
    expect(await readFile(store.pointerPath('cli'))).toEqual(before);
    expect((await store.rollbackRuntime('cli')).manifest.version).toBe('1.0.0');
  });
  it('will not roll back to a corrupt previous version', async () => {
    const first = await store.installRuntime('cli', '1.0.0', source('1.0.0'));
    await store.installRuntime('cli', '2.0.0', source('2.0.0'));
    const before = await readFile(store.pointerPath('cli'));
    await writeFile(first.entry, 'corrupt');
    await expect(store.rollbackRuntime('cli')).rejects.toMatchObject({ reason: 'digest_mismatch' });
    expect(await readFile(store.pointerPath('cli'))).toEqual(before);
  });
  it('binds manifest bytes to current, rejects extra files, names missing manifests', async () => {
    const first = await store.installRuntime('cli', '1.0.0', source('1.0.0'));
    await writeFile(join(first.directory, 'extra.js'), 'code', { mode: 0o600 });
    await expect(store.verifyRuntime('cli')).rejects.toMatchObject({ reason: 'digest_mismatch' });
    await rm(join(first.directory, 'extra.js'));
    await writeFile(
      join(first.directory, 'manifest.json'),
      JSON.stringify({ ...first.manifest, totalSize: 0 })
    );
    await expect(store.verifyRuntime('cli')).rejects.toMatchObject({ reason: 'digest_mismatch' });
    await rm(join(first.directory, 'manifest.json'));
    await expect(store.verifyRuntime('cli')).rejects.toMatchObject({ reason: 'manifest_missing' });
  });
  it('rejects symlinks and weak permissions', async () => {
    const first = await store.installRuntime('cli', '1.0.0', source('1.0.0'));
    await chmod(first.entry, 0o644);
    await expect(store.verifyRuntime('cli')).rejects.toMatchObject({ reason: 'permission' });
    await chmod(first.entry, 0o600);
    await rm(first.entry);
    await symlink(join(state, 'other'), first.entry);
    await expect(store.verifyRuntime('cli')).rejects.toMatchObject({ reason: 'permission' });
  });
  it('rolls back and restarts the previous runtime on a service restart failure', async () => {
    await store.installRuntime('cli', '1.0.0', source('1.0.0'));
    const restartManagedServices = vi
      .fn()
      .mockRejectedValueOnce(new Error('restart failed'))
      .mockResolvedValue(undefined);
    await expect(
      updateRuntime({ store, source: async () => source('2.0.0'), restartManagedServices })
    ).rejects.toThrow('restart failed');
    expect((await store.verifyRuntime('cli')).manifest.version).toBe('1.0.0');
    expect(restartManagedServices).toHaveBeenCalledTimes(2);
    expect(restartManagedServices).toHaveBeenLastCalledWith(store.pointerPath('cli'));
  });
  it('routes update through the typed source and restart seam', async () => {
    await store.installRuntime('cli', '1.0.0', source('1.0.0'));
    const write = vi.fn();
    expect(
      await runCli(['update', '--json'], {
        stdout: { write },
        runtimeUpdate: {
          store,
          source: async () => source('2.0.0'),
          restartManagedServices: async () => {},
        },
      })
    ).toBe(0);
    expect(JSON.parse(write.mock.calls[0]![0])).toMatchObject({
      status: 'updated',
      version: '2.0.0',
    });
  });
  it('reports the automatic follow-up after both runtime update attempts fail', async () => {
    const source = vi.fn(async () => {
      throw new Error('private runtime failure');
    });
    let stdout = '';
    let stderr = '';

    expect(
      await runCli(['update'], {
        stdout: { write: (value) => void (stdout += value) },
        stderr: { write: (value) => void (stderr += value) },
        runtimeUpdate: { store, source, restartManagedServices: async () => {} },
      })
    ).toBe(3);
    expect(source).toHaveBeenCalledTimes(2);
    expect(stdout).toBe('');
    expect(stderr).toBe('Mnemonik could not update. It will try again automatically tomorrow.\n');
  });
  it('reuses a verified version when a fresh npm prefix changes only its receipt path', async () => {
    await store.installRuntime('cli', '1.0.0', source('1.0.0'));
    const before = await readFile(store.pointerPath('cli'));
    const again = source('1.0.0');
    if (again.manifest.source.kind === 'npm')
      again.manifest.source.launchedFrom = '/another/npm/prefix';
    expect((await store.installRuntime('cli', '1.0.0', again)).manifest.version).toBe('1.0.0');
    expect(await readFile(store.pointerPath('cli'))).toEqual(before);
  });
  it('rejects a symlink ancestor before creating files and returns a named malformed-pointer error', async () => {
    const outside = join(state, 'outside');
    await mkdir(outside);
    await symlink(outside, join(state, 'runtimes'));
    await expect(store.installRuntime('cli', '1.0.0', source('1.0.0'))).rejects.toMatchObject({
      reason: 'permission',
    });
    await expect(readFile(join(outside, 'cli/current'))).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(join(state, 'runtimes'));
    await store.installRuntime('cli', '1.0.0', source('1.0.0'));
    await writeFile(store.pointerPath('cli'), '{');
    await expect(store.verifyRuntime('cli')).rejects.toMatchObject({ reason: 'digest_mismatch' });
  });
  it('rejects unsigned scanner files before any signer process can run', async () => {
    const run = vi.fn();
    store = new RuntimeStore(state, run);
    const next = source('1.0.0');
    next.manifest.artifact = 'scanner';
    next.manifest.source = { kind: 'release', url: 'https://release.invalid/manifest.json' };
    await expect(store.installRuntime('scanner', '1.0.0', next)).rejects.toMatchObject({
      reason: 'unsigned',
    });
    expect(run).not.toHaveBeenCalled();
  });
});

describe('npm launch guard', () => {
  async function fixture(root: string) {
    await mkdir(join(root, 'dist'), { recursive: true });
    await writeFile(join(root, 'dist/bin.js'), 'entry');
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: '@mnemonik/cli', version: '1.0.0' })
    );
    return join(root, 'dist/bin.js');
  }
  it('rejects a checkout path even with the official package name', async () => {
    const entry = await fixture(join(state, 'checkout/packages/cli'));
    await mkdir(join(state, 'node_modules'));
    await writeFile(
      join(state, 'node_modules/.package-lock.json'),
      JSON.stringify({
        packages: {
          'node_modules/@mnemonik/cli': {
            version: '1.0.0',
            integrity: 'sha512-fixture',
            resolved: 'file:///fixture.tgz',
          },
        },
      })
    );
    await expect(guardNpmLaunch(entry)).rejects.toMatchObject({ reason: 'permission' });
  });
  it('rejects a loose temp path', async () => {
    await expect(guardNpmLaunch(await fixture(join(state, 'temp/cli')))).rejects.toMatchObject({
      reason: 'permission',
    });
  });
  it('accepts an npm prefix with matching hidden lock metadata and rejects npm links', async () => {
    const root = join(state, 'prefix/node_modules/@mnemonik/cli');
    const entry = await fixture(root);
    const lock = join(state, 'prefix/node_modules/.package-lock.json');
    const packages = {
      'node_modules/@mnemonik/cli': {
        version: '1.0.0',
        integrity: 'sha512-fixture',
        resolved: 'file:///fixture.tgz',
      },
    };
    await writeFile(lock, JSON.stringify({ packages }));
    expect((await guardNpmLaunch(entry)).pkg.version).toBe('1.0.0');
    await rm(root, { recursive: true });
    const checkout = join(state, 'checkout');
    await fixture(checkout);
    await symlink(checkout, root);
    await expect(guardNpmLaunch(entry)).rejects.toMatchObject({ reason: 'permission' });
  });
});

describe('platform signer contracts', () => {
  it('uses codesign alone with an inline Team ID requirement', async () => {
    const run = vi.fn();
    await verifySigner('/runtime/scanner', { platform: 'darwin', identity: 'ABCDE12345' }, run);
    expect(run.mock.calls).toEqual([
      [
        '/usr/bin/codesign',
        [
          '--verify',
          '--strict',
          '-R',
          '=anchor apple generic and certificate leaf[subject.OU] = "ABCDE12345"',
          '/runtime/scanner',
        ],
      ],
    ]);
  });
  it('uses Authenticode Valid status and exact thumbprint with an escaped literal path', async () => {
    const run = vi.fn();
    await verifySigner(
      "C:\\a'b\\scanner.exe",
      { platform: 'win32', identity: 'A'.repeat(40) },
      run
    );
    expect(run.mock.calls[0]).toEqual([
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$ErrorActionPreference = 'Stop'; $s = Get-AuthenticodeSignature -LiteralPath 'C:\\a''b\\scanner.exe'; if ($s.Status -ne 'Valid' -or $s.SignerCertificate.Thumbprint -ne '${'A'.repeat(40)}') { exit 1 }`,
      ],
    ]);
  });
  it.each(['ED', 'Ed'] as const)(
    'verifies a Linux %s signature without a process',
    async (form) => {
      vi.stubEnv('PATH', '');
      const { source } = signedScanner(form);

      const verified = await new RuntimeStore(state).installRuntime('scanner', '1.0.0', source);

      expect(await readFile(verified.entry)).toEqual(source.files.scanner);
    }
  );
  it('does not call the injected process runner for a Linux signature', async () => {
    const run = vi.fn();
    const { source } = signedScanner();

    await new RuntimeStore(state, run).installRuntime('scanner', '1.0.0', source);

    expect(run).not.toHaveBeenCalled();
  });
  it('rejects modified files, another key and malformed signatures as unsigned', async () => {
    const cases = ['modified', 'other-key', 'trusted-comment', 'truncated'] as const;
    for (const [index, kind] of cases.entries()) {
      const { source } = signedScanner();
      if (kind === 'modified') {
        source.files.scanner![0] = source.files.scanner![0]! ^ 1;
        source.manifest.files.scanner!.sha256 = hash(source.files.scanner!);
      } else if (kind === 'other-key') {
        source.manifest.signer = {
          ...source.manifest.signer!,
          identity: signedScanner().identity,
        };
      } else if (kind === 'trusted-comment') {
        source.files['scanner.minisig'] = Buffer.from(
          source.files['scanner.minisig']!.toString().replace('file:scanner', 'file:changed')
        );
      } else {
        source.files['scanner.minisig'] = Buffer.from('untrusted comment: signature\n');
      }
      if (kind === 'trusted-comment' || kind === 'truncated') {
        source.manifest.files['scanner.minisig'] = {
          sha256: hash(source.files['scanner.minisig']!),
          size: source.files['scanner.minisig']!.length,
          executable: false,
        };
        source.manifest.totalSize =
          source.files.scanner!.length + source.files['scanner.minisig']!.length;
      }
      await expect(
        new RuntimeStore(join(state, String(index))).installRuntime('scanner', '1.0.0', source)
      ).rejects.toMatchObject({ reason: 'unsigned' });
    }
  });
  it('fails on signer failure and unavailable Windows ACL evidence', async () => {
    const run = vi.fn().mockRejectedValue(new Error('bad signature'));
    await expect(
      verifySigner('/runtime/scanner', { platform: 'darwin', identity: 'ABCDE12345' }, run)
    ).rejects.toThrow('bad signature');
    expect(run).toHaveBeenCalledTimes(1);
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    const acl = vi.fn(async (file: string) => ({
      stdout: file.endsWith('whoami.exe') ? '"MACHINE\\agent","S-1-5-21-1-2-3-1001"' : '',
    }));
    await expect(verifyWindowsPermission(state, acl)).rejects.toThrow('acl_unavailable');
    expect(acl.mock.calls.every(([file]) => !file.includes('powershell'))).toBe(true);
    vi.unstubAllEnvs();
  });
  it.todo('real notarized macOS, Authenticode Windows and release-key Linux artifacts');
});

it('staging a scanner release verifies its files without publishing the active pointer', async () => {
  const first = signedScanner().source;
  await store.installRuntime('scanner', '1.0.0', first);
  const before = await readFile(store.pointerPath('scanner'), 'utf8');
  const next = { ...first, manifest: { ...first.manifest, version: '2.0.0' } };
  const staged = await store.stageRuntime('scanner', '2.0.0', next);
  expect(staged.reference.version).toBe('2.0.0');
  expect(await readFile(store.pointerPath('scanner'), 'utf8')).toBe(before);
  expect((await store.verifyRuntime('scanner')).reference.version).toBe('1.0.0');
  expect((await store.verifyRetainedRuntime('scanner', staged.reference)).entry).toBe(staged.entry);
});
