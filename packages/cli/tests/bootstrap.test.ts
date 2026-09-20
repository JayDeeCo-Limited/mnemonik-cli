import * as fs from 'node:fs/promises';
import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bootstrapProgress, installBootstrap, launchChild } from '../src/runtime/bootstrap.js';
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
      ...['bin.js', 'runtime/bootstrap.js', 'runtime/store.js', 'runtime/signers.js'].map(
        (name) => [`node_modules/@mnemonik/cli/dist/${name}`, Buffer.from(name)]
      ),
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
  expect(fs.readFile).toHaveBeenCalledExactlyOnceWith(join(root, 'bootstrap-digests.json'), 'utf8');
});

it('leaves the installed bootstrap intact after a mid-stage write failure', async () => {
  source.files['node_modules/@mnemonik/cli/dist/runtime/store.js'] = Buffer.from('new');
  const before = await fs.readFile(join(root, 'bootstrap-digests.json'));
  const write = vi.mocked(fs.writeFile).getMockImplementation()!;
  vi.mocked(fs.writeFile).mockImplementation(async (path, ...args) => {
    if (String(path).endsWith('dist/runtime/store.js')) throw new Error('disk full');
    return write(path, ...args);
  });
  expect(await installBootstrap(store, source)).toBe(bin);
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
  expect(await installBootstrap(store, source)).toBe(bin);
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

it('restores the old bootstrap if the second rename fails', async () => {
  source.files['node_modules/@mnemonik/cli/dist/runtime/store.js'] = Buffer.from('new');
  const rename = vi.mocked(fs.rename).getMockImplementation()!;
  vi.mocked(fs.rename).mockImplementationOnce(rename).mockRejectedValueOnce(new Error('busy'));
  expect(await installBootstrap(store, source)).toBe(bin);
  expect(fs.rename).toHaveBeenCalledTimes(3);
  expect(await fs.readFile(join(root, 'dist/runtime/store.js'), 'utf8')).toBe('runtime/store.js');
});
