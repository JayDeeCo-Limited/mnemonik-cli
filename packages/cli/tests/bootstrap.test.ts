import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bootstrapProgress,
  installBootstrap,
  launchChild,
  REGISTRY_RETRY_DELAYS_MS,
  tarballBytes,
} from '../src/runtime/bootstrap.js';
import { RuntimeError, RuntimeStore, type RuntimeSource } from '../src/runtime/store.js';

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    readFile: vi.fn(fs.readFile),
    mkdtemp: vi.fn(fs.mkdtemp),
    writeFile: vi.fn(fs.writeFile),
    rename: vi.fn(fs.rename),
  };
});
vi.mock('node:child_process', async (original) => {
  const child = await original<typeof import('node:child_process')>();
  return { ...child, spawn: vi.fn(child.spawn), execFile: vi.fn(child.execFile) };
});

let state: string;
let store: RuntimeStore;
let source: RuntimeSource;
let bin: string;
let root: string;
beforeEach(async () => {
  state = await fs.mkdtemp(join(tmpdir(), 'bootstrap-refresh-'));
  store = new RuntimeStore(state);
  await fs.mkdir(join(state, 'runtimes/cli'), { recursive: true, mode: 0o700 });
  source = {
    files: Object.fromEntries([
      ...[
        'bin.js',
        'help.js',
        'humanReason.js',
        'runtime/bootstrap.js',
        'runtime/store.js',
        'runtime/signers.js',
      ].map((name) => [`node_modules/@mnemonik/cli/dist/${name}`, Buffer.from(name)]),
      ...['runtimeReader.js', 'runtimeSigners.js'].map((name) => [
        `node_modules/@mnemonik/shared/dist/${name}`,
        Buffer.from(name),
      ]),
    ]),
    manifest: {
      schemaVersion: 1,
      artifact: 'cli',
      version: '1.0.0',
      entry: '',
      totalSize: 0,
      files: {},
      source: { kind: 'npm', launchedFrom: 'fixture', packages: [] },
    },
  };
  root = join(state, 'runtimes/bootstrap');
  bin = await installBootstrap(store, source);
  vi.clearAllMocks();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(fs.writeFile).mockReset();
  vi.mocked(fs.rename).mockReset();
  await fs.rm(state, { recursive: true, force: true });
});

it('shows moving bootstrap progress on a terminal and one plain line otherwise', () => {
  vi.useFakeTimers();
  let terminalText = '';
  const terminal = bootstrapProgress(
    { write: (chunk: string) => void (terminalText += chunk) },
    true,
    false
  );
  vi.advanceTimersByTime(160);
  terminal.stop();
  expect(terminalText).toMatch(/\| Preparing the installer/u);
  expect(terminalText).toMatch(/[\\/-] Preparing the installer/u);
  expect(terminalText.endsWith('\r\u001b[2K')).toBe(true);

  let plainText = '';
  bootstrapProgress({ write: (chunk: string) => void (plainText += chunk) }, false, false).stop();
  expect(plainText).toBe('Preparing the installer\n');

  let inheritedText = '';
  bootstrapProgress(
    { write: (chunk: string) => void (inheritedText += chunk) },
    false,
    true
  ).stop();
  expect(inheritedText).toBe('');
  vi.useRealTimers();
});

it('returns the same path with zero staging, writes or spawns for equal digests', async () => {
  expect(await installBootstrap(store, source)).toBe(bin);
  expect(fs.mkdtemp).not.toHaveBeenCalled();
  expect(fs.writeFile).not.toHaveBeenCalled();
  expect(fs.rename).not.toHaveBeenCalled();
  expect(childProcess.spawn).not.toHaveBeenCalled();
  expect(childProcess.execFile).not.toHaveBeenCalled();
  expect(fs.readFile).toHaveBeenCalledWith(join(root, 'bootstrap-digests.json'), 'utf8');
});

it('leaves the installed bootstrap intact after a mid-stage write failure', async () => {
  source.files['node_modules/@mnemonik/cli/dist/runtime/store.js'] = Buffer.from('new');
  const before = await fs.readFile(join(root, 'bootstrap-digests.json'));
  const write = vi.mocked(fs.writeFile).getMockImplementation()!;
  vi.mocked(fs.writeFile).mockImplementation(async (path, ...args) => {
    if (String(path).endsWith('dist/runtime/store.js')) throw new Error('disk full');
    return write(path, ...args);
  });
  await expect(installBootstrap(store, source)).rejects.toThrow('disk full');
  expect(fs.mkdtemp).toHaveBeenCalledOnce();
  expect(await fs.readFile(join(root, 'bootstrap-digests.json'))).toEqual(before);
  expect(await fs.readFile(join(root, 'dist/runtime/store.js'), 'utf8')).toBe('runtime/store.js');
  expect(await fs.readdir(join(state, 'runtimes'))).toEqual(expect.arrayContaining(['bootstrap']));
  expect(
    (await fs.readdir(join(state, 'runtimes'))).some((name) => name.startsWith('.bootstrap-'))
  ).toBe(false);
});

it('verifies staged bytes before moving the installed bootstrap', async () => {
  source.files['node_modules/@mnemonik/cli/dist/runtime/store.js'] = Buffer.from('new');
  const write = vi.mocked(fs.writeFile).getMockImplementation()!;
  vi.mocked(fs.writeFile).mockImplementation(async (path, bytes, options) =>
    write(path, String(path).endsWith('dist/runtime/store.js') ? 'corrupt' : bytes, options)
  );
  await expect(installBootstrap(store, source)).rejects.toThrow('digest_mismatch');
  expect(fs.mkdtemp).toHaveBeenCalledOnce();
  expect(fs.rename).not.toHaveBeenCalled();
  expect(await fs.readFile(join(root, 'dist/runtime/store.js'), 'utf8')).toBe('runtime/store.js');
});

it('refreshes shared reader bytes from the dependency-free public bundle', async () => {
  for (const name of ['runtimeReader.js', 'runtimeSigners.js']) {
    const key = `node_modules/@mnemonik/shared/dist/${name}`;
    source.files[`node_modules/@mnemonik/cli/dist/vendor/shared/${name}`] = source.files[key]!;
    delete source.files[key];
  }
  source.files['node_modules/@mnemonik/cli/dist/vendor/shared/runtimeReader.js'] =
    Buffer.from('new reader');
  expect(await installBootstrap(store, source)).toBe(bin);
  expect(
    await fs.readFile(join(root, 'node_modules/@mnemonik/shared/dist/runtimeReader.js'), 'utf8')
  ).toBe('new reader');
});

it('throws a non-ENOENT inspection failure without staging', async () => {
  const error = new RuntimeError('permission');
  vi.spyOn(store, 'inspect').mockRejectedValueOnce(error);
  await expect(installBootstrap(store, source)).rejects.toBe(error);
  expect(fs.mkdtemp).not.toHaveBeenCalled();
});

it('shares one removable signal handler set across twenty child launches', async () => {
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  const baseline = Object.fromEntries(
    signals.map((signal) => [signal, process.listenerCount(signal)])
  ) as Record<(typeof signals)[number], number>;
  const children: Array<EventEmitter & { kill: ReturnType<typeof vi.fn> }> = [];
  const previousHangups = new Set(process.listeners('SIGHUP'));
  vi.mocked(childProcess.spawn).mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    children.push(child);
    return child as unknown as ReturnType<typeof childProcess.spawn>;
  });

  const launches = Array.from({ length: 20 }, () => launchChild('node', []));
  expect(process.listenerCount('SIGINT')).toBe(baseline.SIGINT + 1);
  expect(process.listenerCount('SIGTERM')).toBe(baseline.SIGTERM + 1);
  expect(process.listenerCount('SIGHUP')).toBe(baseline.SIGHUP + 1);
  const forwardHangup = process
    .listeners('SIGHUP')
    .find((listener) => !previousHangups.has(listener));
  expect(forwardHangup).toBeTypeOf('function');
  forwardHangup?.('SIGHUP');
  for (const child of children) expect(child.kill).toHaveBeenCalledWith('SIGHUP');
  for (const child of children) child.emit('close', 0);
  await expect(Promise.all(launches)).resolves.toEqual(Array(20).fill(0));
  for (const signal of signals) expect(process.listenerCount(signal)).toBe(baseline[signal]);
});

it('restores the previous directory on the next run after an interrupted swap', async () => {
  await fs.rename(root, root + '.previous');
  vi.clearAllMocks();
  expect(await installBootstrap(store, source)).toBe(bin);
  expect(fs.mkdtemp).not.toHaveBeenCalled();
  expect(await fs.readFile(bin, 'utf8')).toBe('bin.js');
  await expect(fs.stat(root + '.previous')).rejects.toMatchObject({ code: 'ENOENT' });
});

it('recovers an interrupted upgrade from a verified older previous release', async () => {
  await fs.rename(root, root + '.previous');
  source.files['node_modules/@mnemonik/cli/dist/runtime/store.js'] = Buffer.from('upgraded');
  expect(await installBootstrap(store, source)).toBe(bin);
  expect(await fs.readFile(join(root, 'dist/runtime/store.js'), 'utf8')).toBe('upgraded');
});

it('restores the old bootstrap if the second rename fails', async () => {
  source.files['node_modules/@mnemonik/cli/dist/runtime/store.js'] = Buffer.from('new');
  const rename = vi.mocked(fs.rename).getMockImplementation()!;
  vi.mocked(fs.rename).mockImplementationOnce(rename).mockRejectedValueOnce(new Error('busy'));
  await expect(installBootstrap(store, source)).rejects.toThrow('busy');
  expect(fs.rename).toHaveBeenCalledTimes(3);
  expect(await fs.readFile(join(root, 'dist/runtime/store.js'), 'utf8')).toBe('runtime/store.js');
});

it.each([
  'dist/bin.js',
  'dist/help.js',
  'dist/humanReason.js',
  'dist/runtime/bootstrap.js',
  'dist/runtime/store.js',
  'dist/runtime/signers.js',
  'node_modules/@mnemonik/shared/dist/runtimeReader.js',
  'node_modules/@mnemonik/shared/dist/runtimeSigners.js',
  'node_modules/@mnemonik/shared/package.json',
  'package.json',
])('rejects a pre-created bootstrap with a copied digest document and altered %s', async (name) => {
  await fs.writeFile(join(root, name), 'untrusted bytes');
  await expect(installBootstrap(store, source)).rejects.toThrow('digest_mismatch');
  expect(fs.rename).not.toHaveBeenCalled();
});

it.each(['unrelated', 'extra-file', 'corrupt-file'])(
  'preserves an unverified previous tree (%s)',
  async (mode) => {
    const previous = root + '.previous';
    if (mode === 'unrelated') await fs.mkdir(previous, { mode: 0o700 });
    else await fs.cp(root, previous, { recursive: true });
    const name = mode === 'corrupt-file' ? 'dist/bin.js' : 'keep.txt';
    await fs.writeFile(join(previous, name), 'keep these bytes', { mode: 0o600 });
    source.files['node_modules/@mnemonik/cli/dist/runtime/store.js'] = Buffer.from('new');
    await expect(installBootstrap(store, source)).rejects.toThrow();
    expect(await fs.readFile(join(previous, name), 'utf8')).toBe('keep these bytes');
    expect(await fs.readFile(bin, 'utf8')).toBe('bin.js');
  }
);

it('replaces a verified previous release on a subsequent update', async () => {
  for (const version of ['second', 'third']) {
    source.files['node_modules/@mnemonik/cli/dist/runtime/store.js'] = Buffer.from(version);
    expect(await installBootstrap(store, source)).toBe(bin);
    expect(await fs.readFile(join(root, 'dist/runtime/store.js'), 'utf8')).toBe(version);
  }
});

describe('a tarball npm has not served yet', () => {
  const tarball = Buffer.from('published tarball');
  const entry = {
    version: '1.0.0',
    resolved: 'https://registry.npmjs.org/@mnemonik/cli/-/cli-1.0.0.tgz',
    integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
  };
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is fetched again after a short pause, and the published bytes are used', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(new Uint8Array(tarball)));
    vi.stubGlobal('fetch', fetch);
    expect(await tarballBytes(entry, state, [0, 0])).toEqual(tarball);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['still answers 404', async () => new Response(null, { status: 404 })],
    ['is busy', async () => new Response(null, { status: 503 })],
  ])('is named temporary, not missing, when the registry %s', async (_, answer) => {
    const fetch = vi.fn<typeof globalThis.fetch>(answer);
    vi.stubGlobal('fetch', fetch);
    await expect(tarballBytes(entry, state, [0, 0])).rejects.toMatchObject({
      name: 'RuntimeError',
      reason: 'registry_unavailable',
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('is named unreachable, not unavailable, when the registry cannot be reached', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', fetch);
    await expect(tarballBytes(entry, state, [0, 0])).rejects.toMatchObject({
      name: 'RuntimeError',
      reason: 'registry_unreachable',
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('is not retried when the registry refuses it outright', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 403 }));
    vi.stubGlobal('fetch', fetch);
    await expect(tarballBytes(entry, state, [0, 0])).rejects.toMatchObject({
      reason: 'manifest_missing',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('waits at most about fifteen seconds in total', () => {
    expect(REGISTRY_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0)).toBeLessThanOrEqual(
      15_000
    );
  });
});
