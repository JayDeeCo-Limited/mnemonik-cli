import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { RuntimeStore } from '../src/runtime/store.js';
import { scannerService } from '../src/scanner/service.js';
import { runCli } from '../src/router.js';
import type { ServiceOperation, ServiceResult } from '@mnemonik/shared';

let stateDir: string;
let time: number;
beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'scanner-cli-'));
  time = 1000000;
  await mkdir(join(stateDir, 'scanner'), { mode: 0o700 });
  await writeFile(
    join(stateDir, 'scanner/state.json'),
    JSON.stringify({ config: { credentialFamilyId: 'family-reference' } }),
    { mode: 0o600 }
  );
  vi.spyOn(RuntimeStore.prototype, 'verifyRuntime').mockResolvedValue({
    entry: '/verified/scanner',
    directory: '/verified',
    manifest: {} as never,
    reference: {} as never,
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(stateDir, { recursive: true, force: true });
});
const receipt = async (heartbeat: number, pid = 1234) =>
  writeFile(
    join(stateDir, 'scanner/status.json'),
    JSON.stringify({ snapshot: { lifecycle: { pid }, heartbeat: { lastSuccess: heartbeat } } })
  );
function fixture(initiallyRunning = false) {
  let running = initiallyRunning;
  let installed = initiallyRunning;
  const command = vi.fn(async (operation: ServiceOperation): Promise<ServiceResult> => {
    if (operation === 'install') installed = true;
    if (operation === 'start') running = true;
    if (operation === 'stop') running = false;
    if (operation === 'uninstall') {
      running = false;
      installed = false;
    }
    return {
      status: 'ok',
      supervisor: { kind: 'systemd', installed, running, pid: running ? 1234 : null },
    };
  });
  const options = {
    stateDir,
    describe: async () => ({
      binaryPath: '/verified/scanner',
      arguments: ['start'] as const,
      workingDirectory: '/verified',
      environment: { MNEMONIK_STATE_DIR: stateDir },
      runAtLogin: true as const,
      restart: { policy: 'on-failure' as const, delayMs: 3000 },
      logDestination: join(stateDir, 'scanner/log'),
    }),
    command,
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
  };
  return { command, options };
}
it('verifies the first heartbeat and keeps services.start ensure-running on replay', async () => {
  const f = fixture();
  const service = scannerService({
    ...f.options,
    sleep: async (ms) => {
      time += ms;
      await receipt(time);
    },
  });
  expect(await service.start()).toEqual({ started: true, alreadyRunning: false });
  expect(await service.start()).toEqual({ started: false, alreadyRunning: true });
  expect(service.verified).toBe(true);
  expect(f.command.mock.calls.filter(([operation]) => operation === 'start')).toHaveLength(1);
  expect(f.command.mock.calls.filter(([operation]) => operation === 'install')).toHaveLength(1);
});
it('reports LIMITED after one minute without heartbeat and offers retry or skip', async () => {
  const f = fixture();
  await receipt(time - 1);
  const timeout = vi.fn(async () => 'skip' as const);
  const service = scannerService({ ...f.options, timeout });
  await expect(service.start()).rejects.toMatchObject({
    status: 'LIMITED',
    reason: 'heartbeat_timeout',
    action: 'mnemonik scanner enable',
  });
  expect(time).toBe(1060000);
  expect(timeout).toHaveBeenCalledWith('heartbeat');
  expect(service.verified).toBe(false);
});
it('retries a heartbeat timeout and bounds a nonrunning service at two minutes', async () => {
  const f = fixture();
  const timeout = vi.fn(async () => {
    await receipt(time + 1);
    return 'retry' as const;
  });
  await scannerService({ ...f.options, timeout }).start();
  expect(timeout).toHaveBeenCalledTimes(1);
  const dead = fixture();
  dead.command.mockImplementation(async () => ({
    status: 'ok',
    supervisor: { kind: 'systemd', installed: true, running: false, pid: null },
  }));
  const start = time;
  await expect(scannerService(dead.options).start()).rejects.toMatchObject({
    reason: 'service_timeout',
  });
  expect(time - start).toBe(120000);
});
it('registration failure stays LIMITED and does not try to start', async () => {
  const f = fixture();
  f.command.mockImplementation(async (op) =>
    op === 'install'
      ? {
          status: 'LIMITED',
          reason: 'task_registration_failed',
          detail: 'Access is denied',
          action: 'mnemonik scanner enable',
        }
      : {
          status: 'ok',
          supervisor: { kind: 'task-scheduler', installed: false, running: false, pid: null },
        }
  );
  await expect(scannerService(f.options).start()).rejects.toMatchObject({
    reason: 'task_registration_failed',
    message: 'Access is denied',
  });
  expect(f.command.mock.calls.map(([op]) => op)).toEqual(['status', 'install']);
});
it('uninstall removes only the scanner runtime pointer after supervisor removal succeeds', async () => {
  const f = fixture(true);
  const pointer = new RuntimeStore(stateDir).pointerPath('scanner');
  await mkdir(join(stateDir, 'runtimes/scanner'), { recursive: true });
  await writeFile(pointer, 'pointer');
  const kept = ['credentials.json', 'scanner/state.json', 'scanner/other.json'];
  for (const name of kept) await writeFile(join(stateDir, name), 'retain exact bytes\r\n');
  await scannerService(f.options).uninstall();
  await expect(readFile(pointer)).rejects.toThrow();
  for (const name of kept)
    expect(await readFile(join(stateDir, name), 'utf8')).toBe('retain exact bytes\r\n');
});
it('scanner start observes the Linux adapter pid and refuses a second instance', async () => {
  const calls = join(stateDir, 'calls.jsonl');
  const systemctl = join(stateDir, 'systemctl');
  const scanner = join(stateDir, 'scanner-fixture');
  await writeFile(
    systemctl,
    `#!/usr/bin/env node\nconst fs=require('fs');fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n');console.log('LoadState=loaded\\nActiveState=active\\nSubState=running\\nMainPID=1234');`,
    { mode: 0o700 }
  );
  const modulePath = new URL('../../scanner/dist/supervisor/systemd.js', import.meta.url).href;
  await writeFile(
    scanner,
    `#!/usr/bin/env node\n(async()=>{const {SystemdAdapter}=await import(${JSON.stringify(modulePath)});const a=new SystemdAdapter();require('fs').appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n');console.log(JSON.stringify({status:'ok',supervisor:await a.status()}));})().catch(()=>process.exit(1));`,
    { mode: 0o700 }
  );
  vi.stubEnv('PATH', `${stateDir}:${process.env.PATH}`);
  vi.mocked(RuntimeStore.prototype.verifyRuntime).mockResolvedValue({
    entry: scanner,
    directory: stateDir,
    manifest: {} as never,
    reference: {} as never,
  });
  await receipt(time - 100);
  let text = '';
  const stdout = new Writable({
    write(chunk, _encoding, done) {
      text += chunk.toString();
      done();
    },
  });
  const code = await runCli(['scanner', 'start', '--non-interactive', '--json'], {
    stdout,
    scannerService: { stateDir, now: () => time },
  });
  expect(code).toBe(3);
  expect(JSON.parse(text)).toMatchObject({
    status: 'ACTION_REQUIRED',
    reason: 'instance_running',
    pid: 1234,
  });
  const recorded = (await readFile(calls, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(recorded).toContainEqual(['service', 'status', '--json']);
  expect(recorded.some((args: string[]) => args[0] === '--user' && args[1] === 'show')).toBe(true);
});

it('Retry of a stopped service issues another start attempt', async () => {
  let starts = 0;
  const f = fixture();
  f.command.mockImplementation(async (op) => {
    if (op === 'start') starts++;
    if (starts === 2) await receipt(time + 1);
    return {
      status: 'ok',
      supervisor: { kind: 'systemd', installed: true, running: starts === 2, pid: 1234 },
    };
  });
  await scannerService({ ...f.options, timeout: async () => 'retry' }).start();
  expect(starts).toBe(2);
  expect(time).toBe(1120000);
});

it('scanner start prints LIMITED and retry/skip after the heartbeat window', async () => {
  const f = fixture();
  let text = '';
  const stdout = new Writable({
    write(chunk, _encoding, done) {
      text += chunk.toString();
      done();
    },
  });
  const code = await runCli(['scanner', 'start', '--non-interactive', '--json'], {
    stdout,
    scannerService: f.options,
  });
  expect(code).toBe(3);
  expect(JSON.parse(text)).toMatchObject({
    status: 'LIMITED',
    reason: 'heartbeat_timeout',
    choices: ['retry', 'skip'],
  });
  expect(time).toBe(1060000);
});

it('plain uninstall removes an installed scanner when no host targets are recorded', async () => {
  const f = fixture(true);
  const pointer = new RuntimeStore(stateDir).pointerPath('scanner');
  await mkdir(join(stateDir, 'runtimes/scanner'), { recursive: true });
  await writeFile(pointer, 'pointer');
  let text = '';
  const code = await runCli(['uninstall', '--non-interactive', '--confirm', '--json'], {
    installStateDir: stateDir,
    scannerService: f.options,
    stdout: {
      write: (chunk) => {
        text += chunk;
      },
    },
    stderr: {
      write: (chunk) => {
        text += chunk;
      },
    },
  });
  expect(code).toBe(0);
  expect(f.command.mock.calls.map(([operation]) => operation)).toEqual(['stop', 'uninstall']);
  expect(JSON.parse(text)).toMatchObject({
    status: 'uninstalled',
    targets: [],
    scanner: { status: 'uninstalled' },
    launcher: { status: 'not_installed' },
  });
  await expect(readFile(pointer)).rejects.toThrow();
  expect(JSON.parse(await readFile(join(stateDir, 'scanner/state.json'), 'utf8'))).toEqual({
    config: { credentialFamilyId: 'family-reference' },
  });
});

it.each([
  ['uninstall', '--non-interactive', '--json'],
  ['uninstall', '--host', 'codex', '--non-interactive', '--confirm', '--json'],
  ['uninstall', '--scope', 'user', '--non-interactive', '--confirm', '--json'],
])('does not remove the scanner for unconfirmed or filtered uninstall: %s', async (...args) => {
  const f = fixture(true);
  const pointer = new RuntimeStore(stateDir).pointerPath('scanner');
  await mkdir(join(stateDir, 'runtimes/scanner'), { recursive: true });
  await writeFile(pointer, 'pointer');
  expect(
    await runCli(args, {
      installStateDir: stateDir,
      scannerService: f.options,
      stdout: { write() {} },
      stderr: { write() {} },
    })
  ).toBe(3);
  expect(f.command).not.toHaveBeenCalled();
  expect(await readFile(pointer, 'utf8')).toBe('pointer');
});

it('restores the saved definition and running state through the verified runtime', async () => {
  const f = fixture(true);
  const service = scannerService({ ...f.options, captureDefinition: true });
  const [before] = await service.inspect();
  expect(JSON.parse(before!.before).definition.binaryPath).toBe('/verified/scanner');
  f.command.mockClear();
  await service.restore('scanner', before!.before);
  expect(f.command.mock.calls.map(([op]) => op)).toEqual(['install', 'start']);
  expect(f.command.mock.calls[0]).toEqual(['install', await f.options.describe()]);
});
