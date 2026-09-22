import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServiceDefinition, ServiceOperation, ServiceResult } from '@mnemonik/shared';
import { RuntimeStore, type RuntimeSource } from '../src/runtime/store.js';
import { updateScanner } from '../src/scanner/update.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function fixture(kind = 'systemd') {
  const stateDir = await mkdtemp(join(tmpdir(), 'scanner-update-'));
  directories.push(stateDir);
  await mkdir(join(stateDir, 'scanner'));
  const statePath = join(stateDir, 'scanner/state.json');
  const saved = JSON.stringify({ paused: false, consent: { disclosureVersion: 'v1' } });
  await writeFile(statePath, saved);
  let running = true;
  let now = 1000000;
  const command = vi.fn(async (operation: ServiceOperation): Promise<ServiceResult> => {
    if (operation === 'stop' || operation === 'uninstall') running = false;
    if (operation === 'start') running = true;
    return {
      status: 'ok',
      supervisor: {
        kind,
        installed: true,
        running,
        pid: running ? 1234 : null,
        binaryPath: '/verified/scanner',
      },
    };
  });
  const heartbeat = async () => {
    const control = JSON.parse(
      await readFile(join(stateDir, 'scanner/control.json'), 'utf8').catch(() => '{}')
    ) as { id?: string; action?: string };
    if (control.action === 'pause')
      await writeFile(statePath, JSON.stringify({ ...JSON.parse(saved), paused: true }));
    await writeFile(
      join(stateDir, 'scanner/status.json'),
      JSON.stringify({
        snapshot: {
          lifecycle: { pid: 1234, controlId: control.id },
          heartbeat: { lastSuccess: now },
        },
      })
    );
  };
  await heartbeat();
  const source: RuntimeSource = {
    manifest: {
      artifact: 'scanner',
      version: '1.0.0',
      disclosureVersion: 'v1',
    } as RuntimeSource['manifest'],
    files: {},
  };
  const verified = {
    entry: '/verified/scanner',
    reference: { version: '1.0.0' },
    manifest: source.manifest,
  } as Awaited<ReturnType<RuntimeStore['verifyRuntime']>>;
  const store = new RuntimeStore(stateDir);
  vi.spyOn(store, 'verifyRuntime').mockResolvedValue(verified);
  vi.spyOn(store, 'installRuntime').mockResolvedValue(verified);
  return {
    statePath,
    saved,
    command,
    source,
    store,
    options: {
      stateDir,
      store,
      command,
      describe: async () => ({
        binaryPath: '/verified/scanner',
        arguments: ['start'] as const,
        workingDirectory: '/verified',
        environment: { MNEMONIK_STATE_DIR: stateDir },
        runAtLogin: true as const,
        restart: { policy: 'on-failure' as const, delayMs: 3000 },
        logDestination: join(stateDir, 'scanner/log'),
      }),
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
        await heartbeat();
      },
    },
  };
}

it.each(['systemd', 'launchd'])(
  'an up-to-date %s scanner keeps running without stop, uninstall or install',
  async (kind) => {
    const f = await fixture(kind);
    await updateScanner(f.options, async () => f.source);
    expect(f.command.mock.calls.map(([operation]) => operation)).not.toEqual(
      expect.arrayContaining(['stop'])
    );
    expect(f.command.mock.calls.every(([operation]) => operation === 'status')).toBe(true);
  }
);

it('a release needing new consent leaves the approved scanner running and its state unchanged', async () => {
  const f = await fixture();
  await expect(
    updateScanner(f.options, async () => ({
      ...f.source,
      manifest: { ...f.source.manifest, version: '2.0.0', disclosureVersion: 'v2' },
    }))
  ).rejects.toThrow('release_consent_required');
  expect(await readFile(f.statePath, 'utf8')).toBe(f.saved);
  expect(f.store.installRuntime).not.toHaveBeenCalled();
});

it('updates a running Mac through the verified candidate without publishing or stopping in the caller', async () => {
  const f = await fixture('launchd');
  const pointer = f.store.pointerPath('scanner');
  const previous = JSON.stringify({ current: { version: '1.0.0' } });
  await mkdir(join(pointer, '..'), { recursive: true });
  await writeFile(pointer, previous);
  const runtime = {
    ...(await f.store.verifyRuntime('scanner')),
    directory: '/verified/2',
    entry: '/verified/2/scanner',
    reference: { version: '2.0.0', manifestSha256: 'candidate' },
  };
  const stage = vi.spyOn(f.store, 'stageRuntime').mockResolvedValue(runtime);
  const command = vi.fn(
    async (operation: ServiceOperation, definition?: ServiceDefinition): Promise<ServiceResult> => {
      if (operation === 'status')
        return {
          status: 'ok',
          supervisor: { kind: 'launchd', installed: true, running: true, pid: 2345 },
        };
      expect(operation).toBe('install');
      expect(await readFile(pointer, 'utf8')).toBe(previous);
      expect(definition?.binaryPath).toBe(runtime.entry);
      expect(JSON.parse(definition!.replacement!.pointer.after).current).toEqual(runtime.reference);
      await mkdir(join(f.options.stateDir, 'scanner/service-replacement'), { recursive: true });
      await writeFile(
        join(f.options.stateDir, 'scanner/service-replacement/result.json'),
        JSON.stringify({ pid: 2345, startedAt: f.options.now() })
      );
      await writeFile(
        join(f.options.stateDir, 'scanner/status.json'),
        JSON.stringify({
          recordedAt: f.options.now() + 1,
          snapshot: {
            lifecycle: { pid: 2345, state: 'starting' },
            heartbeat: { lastSuccess: null },
            startupTimings: { localReadyAt: f.options.now() + 1 },
          },
        })
      );
      return {
        status: 'ok',
        supervisor: { kind: 'launchd', installed: true, running: true, pid: 2345 },
      };
    }
  );
  await expect(
    updateScanner({ ...f.options, platform: 'darwin', command }, async () => ({
      ...f.source,
      manifest: { ...f.source.manifest, version: '2.0.0' },
    }))
  ).resolves.toBe(runtime);
  expect(stage).toHaveBeenCalledOnce();
  expect(f.store.installRuntime).not.toHaveBeenCalled();
  expect(command.mock.calls.filter(([operation]) => operation === 'install')).toHaveLength(1);
  expect(await readFile(f.statePath, 'utf8')).toBe(f.saved);
});

it('a killed Mac caller does not publish or roll back files after handing replacement to launchd', async () => {
  const f = await fixture('launchd');
  const pointer = f.store.pointerPath('scanner');
  const previous = JSON.stringify({ current: { version: '1.0.0' } });
  await mkdir(join(pointer, '..'), { recursive: true });
  await writeFile(pointer, previous);
  vi.spyOn(f.store, 'stageRuntime').mockResolvedValue({
    ...(await f.store.verifyRuntime('scanner')),
    reference: { version: '2.0.0', manifestSha256: 'candidate' },
  });
  const rollback = vi.spyOn(f.store, 'rollbackRuntime');
  const command = vi.fn(async (operation: ServiceOperation): Promise<ServiceResult> => {
    expect(operation).toBe('install');
    throw new Error('caller_disappeared');
  });
  await expect(
    updateScanner({ ...f.options, platform: 'darwin', command }, async () => ({
      ...f.source,
      manifest: { ...f.source.manifest, version: '2.0.0' },
    }))
  ).rejects.toThrow('caller_disappeared');
  expect(command).toHaveBeenCalledOnce();
  expect(rollback).not.toHaveBeenCalled();
  expect(await readFile(pointer, 'utf8')).toBe(previous);
  expect(await readFile(f.statePath, 'utf8')).toBe(f.saved);
});

it('a current healthy Mac scanner is verified without a replacement or restart', async () => {
  const f = await fixture('launchd');
  const stage = vi
    .spyOn(f.store, 'stageRuntime')
    .mockResolvedValue(await f.store.verifyRuntime('scanner'));
  await updateScanner({ ...f.options, platform: 'darwin' }, async () => f.source);
  expect(stage).toHaveBeenCalledOnce();
  expect(f.command.mock.calls.every(([op]) => op === 'status')).toBe(true);
});
