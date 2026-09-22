import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { RuntimeStore } from '../src/runtime/store.js';
import {
  scannerService,
  SCANNER_RESTART_MESSAGE,
  SCANNER_RESTART_ACTION,
} from '../src/scanner/service.js';
import { updateScanner } from '../src/scanner/update.js';
import { collectStatusDocument, renderStatusSummaries } from '../src/status.js';

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const stateDir = await mkdtemp(join(tmpdir(), 'scanner-recovery-'));
  homes.push(stateDir);
  await mkdir(join(stateDir, 'scanner'));
  const state = { paused: false, config: { roots: [], exclusions: [] } };
  const receipt = {
    recordedAt: 100,
    snapshot: {
      version: '1',
      lifecycle: { state: 'running', reason: 'started', pid: 987654 },
      heartbeat: { lastSuccess: 100 },
    },
  };
  const binary = join(stateDir, 'mnemonik-scanner');
  const supervisor = {
    kind: 'launchd' as const,
    installed: true,
    running: true,
    pid: 987654,
    binaryPath: binary,
  };
  const options = {
    stateDir,
    platform: 'darwin' as NodeJS.Platform,
    now: () => 1000000,
    store: {
      verifyRuntime: vi.fn(async () => ({ entry: binary, reference: { version: '1' } })),
      pointerPath: vi.fn(() => join(stateDir, 'pointer.json')),
      bytes: vi.fn(async () => Buffer.from('{}')),
    } as unknown as RuntimeStore,
    command: vi.fn(async () => ({ status: 'ok' as const, supervisor })),
    pidIdentity: vi.fn(() => true),
    signal: vi.fn(() => true as const),
    onScannerRestartRequested: vi.fn(),
  };
  const save = async () => {
    await writeFile(join(stateDir, 'scanner/state.json'), JSON.stringify(state));
    await writeFile(join(stateDir, 'scanner/status.json'), JSON.stringify(receipt));
  };
  await save();
  return { stateDir, options, state, receipt, supervisor, binary, save };
}

it('requests launchd restart only for the stale exact owner scanner and leaves its registration loaded', async () => {
  const f = await fixture();
  expect(await scannerService(f.options).recover()).toBe(true);
  expect(f.options.pidIdentity).toHaveBeenCalledWith(987654, 'darwin', undefined, {
    binaryPath: f.binary,
    uid: process.getuid?.(),
  });
  expect(f.options.signal).toHaveBeenCalledExactlyOnceWith(987654, 'SIGKILL');
  expect(f.options.command.mock.calls).toEqual([['status', undefined]]);
  expect(f.options.onScannerRestartRequested).toHaveBeenCalledOnce();
});

it.each([
  'linux',
  'fresh heartbeat',
  'fresh local receipt',
  'paused receipt',
  'paused state',
  'different PID',
  'different binary',
  'unconfirmed identity',
])('does not signal %s', async (condition) => {
  const f = await fixture();
  if (condition === 'linux') f.options.platform = 'linux';
  if (condition === 'fresh heartbeat') f.receipt.snapshot.heartbeat.lastSuccess = 999999;
  if (condition === 'fresh local receipt') f.receipt.recordedAt = 999999;
  if (condition === 'paused receipt') f.receipt.snapshot.lifecycle.state = 'paused';
  if (condition === 'paused state') f.state.paused = true;
  if (condition === 'different PID') f.supervisor.pid++;
  if (condition === 'different binary') f.supervisor.binaryPath += '-other';
  if (condition === 'unconfirmed identity') f.options.pidIdentity.mockReturnValue(false);
  await f.save();
  expect(await scannerService(f.options).recover()).toBe(false);
  expect(f.options.signal).not.toHaveBeenCalled();
  expect(f.options.onScannerRestartRequested).not.toHaveBeenCalled();
});

it('real status reports its restart request instead of claiming the stale scanner is ready', async () => {
  const f = await fixture();
  await mkdir(join(f.stateDir, 'scanner/service-replacement'));
  await writeFile(
    join(f.stateDir, 'scanner/service-replacement/result.json'),
    JSON.stringify({ pid: 987654, startedAt: 100 })
  );
  const document = await collectStatusDocument({
    stateDir: f.stateDir,
    cwd: f.stateDir,
    input: Readable.from(''),
    scannerRecovery: f.options,
    projectHookConditions: [],
    preflight: {
      status: 'ready',
      node: { supported: true, version: '24' },
      os: 'macOS',
      hosts: [],
      project: { resolution: 'absent' },
      network: { reachable: true, discoveryUrl: '' },
    },
  });
  expect(f.options.signal).toHaveBeenCalledExactlyOnceWith(987654, 'SIGKILL');
  expect(document.installation.reasons).toEqual(['scanner_restart_requested']);
  expect(document.installation.state).toBe('LIMITED');
  const lines: string[] = [];
  renderStatusSummaries(document, {
    line: (value = '') => {
      lines.push(value);
      return 1;
    },
  });
  expect(lines).toContain(SCANNER_RESTART_MESSAGE);
  expect(lines).toContain(SCANNER_RESTART_ACTION);
});

it('update recovers a stalled owner scanner before a release download can fail', async () => {
  const f = await fixture();
  const source = async () => {
    throw new Error('release_offline');
  };
  await expect(updateScanner(f.options, source)).rejects.toThrow('release_offline');
  expect(f.options.signal).toHaveBeenCalledExactlyOnceWith(987654, 'SIGKILL');
  expect(f.options.onScannerRestartRequested).toHaveBeenCalledOnce();
});

it.each([
  'missing receipt',
  'previous PID receipt',
  'fresh attempt',
  'paused state',
  'foreign PID',
])('legacy fallback without its first heartbeat handles %s safely', async (condition) => {
  const f = await fixture();
  await mkdir(join(f.stateDir, 'scanner/service-replacement'));
  const attempt = { pid: 987654, startedAt: 100 };
  if (condition === 'fresh attempt') attempt.startedAt = 999999;
  if (condition === 'paused state') f.state.paused = true;
  if (condition === 'foreign PID') f.supervisor.pid++;
  if (condition === 'previous PID receipt') f.receipt.snapshot.lifecycle.pid--;
  await f.save();
  if (!['previous PID receipt', 'fresh attempt'].includes(condition))
    await rm(join(f.stateDir, 'scanner/status.json'));
  await writeFile(
    join(f.stateDir, 'scanner/service-replacement/result.json'),
    JSON.stringify(attempt)
  );
  const recover = ['missing receipt', 'previous PID receipt'].includes(condition);
  expect(await scannerService(f.options).recover()).toBe(recover);
  expect(f.options.signal).toHaveBeenCalledTimes(recover ? 1 : 0);
});

it('verifies the retained fallback runtime before recovering its stalled process', async () => {
  const f = await fixture();
  const retained = vi.fn(async () => ({ entry: f.binary, reference: { version: '1' } }));
  Object.assign(f.options.store, {
    verifyRuntime: async () => ({ entry: `${f.binary}-new`, reference: { version: '2' } }),
    bytes: async () => Buffer.from(JSON.stringify({ previous: { version: '1' } })),
    verifyRetainedRuntime: retained,
  });
  expect(await scannerService(f.options).recover()).toBe(true);
  expect(retained).toHaveBeenCalledWith('scanner', { version: '1' });
  expect(f.options.signal).toHaveBeenCalledExactlyOnceWith(987654, 'SIGKILL');
});
