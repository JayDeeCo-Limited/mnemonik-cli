import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink, lstat } from 'node:fs/promises';
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
  vi.stubEnv('XDG_CONFIG_HOME', join(stateDir, '.config'));
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
  let enabled = initiallyRunning;
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
  const supervisorRun = vi.fn(async (file: string, args: string[]) => {
    if (file === 'ps') return running ? '1234' : '';
    if (file !== 'systemctl') throw new Error('unexpected native command');
    const action = args[1];
    if (action === 'stop' || action === 'disable') running = false;
    if (action === 'disable') enabled = false;
    if (action === 'daemon-reload') installed = false;
    if (action === 'show')
      return `LoadState=${installed ? 'loaded' : 'not-found'}\nActiveState=${running ? 'active' : 'inactive'}\nMainPID=${running ? 1234 : 0}\nUnitFileState=${installed ? (enabled ? 'enabled' : 'disabled') : ''}`;
    return '';
  });
  const options = {
    stateDir,
    home: stateDir,
    platform: 'linux' as const,
    supervisorRun,
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
  return { command, options, supervisorRun };
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
    action: 'Wait a minute, then run mnemonik status.',
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
  // Temporary fixtures now live below this ESM repository's isolated HOME.
  await writeFile(join(stateDir, 'package.json'), JSON.stringify({ type: 'commonjs' }));
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
  expect(JSON.parse(text), text).toMatchObject({
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
  expect(f.command).not.toHaveBeenCalled();
  expect(f.supervisorRun).toHaveBeenCalledWith('systemctl', [
    '--user',
    'stop',
    'mnemonik-scanner.service',
  ]);
  expect(f.supervisorRun).toHaveBeenCalledWith('systemctl', [
    '--user',
    'disable',
    '--now',
    'mnemonik-scanner.service',
  ]);
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
  await receipt(time + 1);
  await service.restore('scanner', before!.before);
  expect(f.command.mock.calls.map(([op]) => op)).toEqual(['install', 'status', 'status', 'status']);
  expect(f.command.mock.calls[0]).toEqual(['install', await f.options.describe()]);
});

it('replacement refusal leaves the running scanner registered and running', async () => {
  const f = fixture(true);
  const original = f.command.getMockImplementation()!;
  f.command.mockImplementation(async (operation) => {
    if (operation === 'install')
      return {
        status: 'LIMITED',
        reason: 'supervisor_operation_failed',
        detail: 'domain unavailable',
        action: 'mnemonik scanner enable',
      };
    return original(operation);
  });
  await expect(scannerService(f.options).restart()).rejects.toThrow('domain unavailable');
  expect(f.command.mock.calls.map(([op]) => op)).not.toContain('stop');
  expect(f.command.mock.calls.map(([op]) => op)).not.toContain('uninstall');
  expect((await scannerService(f.options).status()).running).toBe(true);
});

it('replacement verifies its definition before changing the working scanner', async () => {
  const f = fixture(true);
  await expect(
    scannerService({
      ...f.options,
      describe: async () => {
        throw new Error('bad runtime');
      },
    }).restart()
  ).rejects.toThrow('bad runtime');
  expect(f.command).not.toHaveBeenCalled();
});

it('replacement leaves restarting to the supervisor without issuing a separate stop', async () => {
  const f = fixture(true);
  await scannerService({
    ...f.options,
    sleep: async (ms) => {
      time += ms;
      await receipt(time);
    },
  }).restart();
  const operations = f.command.mock.calls.map(([op]) => op);
  expect(operations).toContain('install');
  expect(operations).not.toContain('stop');
  expect(operations).not.toContain('uninstall');
});

it('updater disappearance after every supervisor command never leaves a stopped scanner', async () => {
  for (let cut = 1; cut <= 8; cut++) {
    const f = fixture(true);
    const execute = f.command.getMockImplementation()!;
    let commands = 0;
    f.command.mockImplementation(async (operation) => {
      const result = await execute(operation);
      if (++commands === cut) throw new Error('updater disappeared');
      return result;
    });
    await receipt(time + 1);
    await scannerService(f.options)
      .restart()
      .catch(() => undefined);
    expect((await execute('status')).status).toBe('ok');
    const result = await execute('status');
    expect(result.status === 'ok' && result.supervisor.running, `after command ${cut}`).toBe(true);
  }
});

it('restoration rejects a pre-restore heartbeat from a reused PID', async () => {
  const f = fixture(true);
  await receipt(time - 1, 1234);
  const service = scannerService(f.options);
  await expect(
    service.restore(
      'scanner',
      JSON.stringify({
        installed: true,
        running: true,
        pid: 1234,
        definition: await f.options.describe(),
      })
    )
  ).rejects.toMatchObject({ reason: 'heartbeat_timeout' });
  expect(service.verified).toBe(false);
});

it('restoration verifies that the previous running scanner has a fresh heartbeat', async () => {
  const f = fixture(false);
  const service = scannerService(f.options);
  await expect(
    service.restore(
      'scanner',
      JSON.stringify({
        installed: true,
        running: true,
        pid: 999,
        definition: await f.options.describe(),
      })
    )
  ).rejects.toMatchObject({ reason: 'heartbeat_timeout' });
  expect(service.verified).toBe(false);
});

function macRemovalFixture() {
  const registrations = new Map([
    ['user/501/ai.mnemonik.scanner', 201],
    ['gui/501/ai.mnemonik.scanner', 202],
    ['user/501/ai.mnemonik.scanner.replacement', 203],
  ]);
  const alive = new Set(registrations.values());
  const run = vi.fn(async (file: string, args: string[]) => {
    if (file === 'ps')
      return args[1]!
        .split(',')
        .filter((pid) => alive.has(Number(pid)))
        .join('\n');
    if (args[0] === 'print') {
      const pid = registrations.get(args[1]!);
      if (!pid) throw new Error('Could not find service');
      return `state = running\npid = ${pid}`;
    }
    if (args[0] === 'bootout') {
      alive.delete(registrations.get(args[1]!)!);
      registrations.delete(args[1]!);
      return '';
    }
    throw new Error('unexpected command');
  });
  return {
    registrations,
    alive,
    run,
    options: {
      stateDir,
      platform: 'darwin' as const,
      home: stateDir,
      uid: 501,
      supervisorRun: run,
      // An old supervisor can falsely report absence because it knows only gui/501.
      command: async (): Promise<ServiceResult> => ({
        status: 'ok',
        supervisor: { kind: 'launchd', installed: false, running: false, pid: null },
      }),
      now: () => time,
      sleep: async (ms: number) => {
        time += ms;
      },
    },
  };
}
async function macRemovalFiles() {
  const files = [
    'Library/LaunchAgents/ai.mnemonik.scanner.plist',
    'Library/LaunchAgents/ai.mnemonik.scanner.replacement.plist',
    'runtimes/scanner/7.99.12/scanner-darwin-arm64',
    'scanner/service-replacement/transaction.json',
    'scanner/service-supervisor.json',
  ];
  for (const path of files) {
    await mkdir(join(stateDir, path, '..'), { recursive: true });
    await writeFile(join(stateDir, path), 'retained until stopped');
  }
  return files;
}
it('Mac uninstall without a runtime pointer stops both domains and helper before deleting software', async () => {
  const f = macRemovalFixture();
  const files = await macRemovalFiles();
  const saved = await readFile(join(stateDir, 'scanner/state.json'));
  await scannerService(f.options).uninstall();
  expect(f.registrations.size).toBe(0);
  expect(f.alive.size).toBe(0);
  for (const path of files) await expect(readFile(join(stateDir, path))).rejects.toThrow();
  expect(await readFile(join(stateDir, 'scanner/state.json'))).toEqual(saved);
  expect(RuntimeStore.prototype.verifyRuntime).not.toHaveBeenCalled();
});
it.each(['registration', 'process', 'inspection'] as const)(
  'Mac uninstall preserves every executable and definition when %s removal is unverified',
  async (failure) => {
    const f = macRemovalFixture();
    const files = await macRemovalFiles();
    const real = f.run.getMockImplementation()!;
    f.run.mockImplementation(async (file, args) => {
      if (args[0] === 'print' && failure === 'inspection') throw new Error('Permission denied');
      if (args[0] === 'bootout') {
        if (failure === 'registration') return '';
        if (failure === 'process' && !args[1]!.endsWith('.replacement')) {
          f.registrations.delete(args[1]!);
          return '';
        }
      }
      return real(file, args);
    });
    await expect(scannerService(f.options).uninstall()).rejects.toThrow();
    for (const path of files)
      expect(await readFile(join(stateDir, path), 'utf8')).toBe('retained until stopped');
  }
);
it('full Mac uninstall checks launchd even when the runtime pointer is missing', async () => {
  const f = macRemovalFixture();
  await macRemovalFiles();
  let text = '';
  const output = {
    write: (chunk: string) => {
      text += chunk;
    },
  };
  const code = await runCli(['uninstall', '--non-interactive', '--confirm', '--json'], {
    home: stateDir,
    installStateDir: stateDir,
    scannerService: f.options,
    stdout: output,
    stderr: output,
  });
  expect(code).toBe(0);
  expect(f.registrations.size).toBe(0);
  expect(f.alive.size).toBe(0);
  expect(JSON.parse(text).scanner.status).toBe('uninstalled');
});
it('full Mac uninstall does not claim collection stopped when launchd cannot be inspected', async () => {
  const f = macRemovalFixture();
  await macRemovalFiles();
  f.run.mockRejectedValue(new Error('Permission denied'));
  let text = '';
  const output = {
    write: (chunk: string) => {
      text += chunk;
    },
  };
  const code = await runCli(['uninstall', '--non-interactive', '--confirm'], {
    home: stateDir,
    installStateDir: stateDir,
    scannerService: f.options,
    stdout: output,
    stderr: output,
  });
  expect(code).toBe(1);
  expect(text).not.toContain('Stopped collection');
  expect(f.alive.size).toBe(3);
});

it('Mac uninstall preserves software when the orphan-process receipt cannot be read', async () => {
  const f = macRemovalFixture();
  const files = await macRemovalFiles();
  await writeFile(join(stateDir, 'scanner/status.json'), 'invalid JSON');
  await expect(scannerService(f.options).uninstall()).rejects.toThrow();
  expect(f.registrations.has('user/501/ai.mnemonik.scanner')).toBe(true);
  for (const path of files)
    expect(await readFile(join(stateDir, path), 'utf8')).toBe('retained until stopped');
});

async function linuxRemovalFiles(pointer = true, unit = false) {
  const unitPath = join(stateDir, '.config/systemd/user/mnemonik-scanner.service');
  const enabledPath = join(
    stateDir,
    '.config/systemd/user/default.target.wants/mnemonik-scanner.service'
  );
  const runtimePath = join(stateDir, 'runtimes/scanner/7.99.12/scanner-linux-x64');
  await mkdir(join(enabledPath, '..'), { recursive: true });
  await mkdir(join(runtimePath, '..'), { recursive: true });
  await symlink(unitPath, enabledPath);
  if (unit) await writeFile(unitPath, 'working scanner unit');
  await writeFile(runtimePath, 'retained executable');
  if (pointer) await writeFile(new RuntimeStore(stateDir).pointerPath('scanner'), 'legacy pointer');
  return { unitPath, enabledPath, runtimePath };
}

it('Linux uninstall stops a loaded unit with a missing backing file without trusting the old scanner', async () => {
  const f = fixture(true);
  const files = await linuxRemovalFiles();
  const native = f.supervisorRun.getMockImplementation()!;
  f.supervisorRun.mockImplementation(async (file, args) => {
    if (args[1] === 'disable')
      throw new Error('Failed to disable unit: Unit file mnemonik-scanner.service does not exist.');
    return native(file, args);
  });
  await scannerService(f.options).uninstall();
  expect(f.command).not.toHaveBeenCalled();
  expect(RuntimeStore.prototype.verifyRuntime).not.toHaveBeenCalled();
  expect(f.supervisorRun).toHaveBeenCalledWith('systemctl', [
    '--user',
    'stop',
    'mnemonik-scanner.service',
  ]);
  await expect(lstat(files.enabledPath)).rejects.toThrow('ENOENT');
  await expect(readFile(files.runtimePath)).rejects.toThrow('ENOENT');
});

it('full Linux uninstall checks the native unit even when its runtime pointer is missing', async () => {
  const f = fixture(true);
  const files = await linuxRemovalFiles(false);
  const native = f.supervisorRun.getMockImplementation()!;
  f.supervisorRun.mockImplementation(async (file, args) => {
    if (args[1] === 'disable')
      throw new Error('Failed to disable unit: Unit file mnemonik-scanner.service does not exist.');
    return native(file, args);
  });
  let text = '';
  const output = {
    write: (chunk: string) => {
      text += chunk;
    },
  };
  const code = await runCli(['uninstall', '--non-interactive', '--confirm', '--json'], {
    home: stateDir,
    installStateDir: stateDir,
    scannerService: f.options,
    stdout: output,
    stderr: output,
  });
  expect(code).toBe(0);
  expect(JSON.parse(text).scanner.status).toBe('uninstalled');
  expect(f.supervisorRun).toHaveBeenCalledWith('systemctl', [
    '--user',
    'stop',
    'mnemonik-scanner.service',
  ]);
  await expect(lstat(files.enabledPath)).rejects.toThrow('ENOENT');
  await expect(readFile(files.runtimePath)).rejects.toThrow('ENOENT');
});

it.each(['process', 'inspection'] as const)(
  'Linux uninstall preserves the executable when native %s verification fails',
  async (fault) => {
    const f = fixture(true);
    const files = await linuxRemovalFiles(true, true);
    const native = f.supervisorRun.getMockImplementation()!;
    f.supervisorRun.mockImplementation(async (file, args) => {
      if (fault === 'process' && file === 'ps') return '1234';
      if (fault === 'inspection' && args[1] === 'show') throw new Error('Permission denied');
      return native(file, args);
    });
    await expect(scannerService(f.options).uninstall()).rejects.toThrow('scanner_stop_failed');
    expect(await readFile(files.runtimePath, 'utf8')).toBe('retained executable');
    expect(await readFile(files.unitPath, 'utf8')).toBe('working scanner unit');
    expect(f.command).not.toHaveBeenCalled();
  }
);

it('Linux uninstall retains software when the recorded scanner PID is still alive', async () => {
  const f = fixture(true);
  const files = await linuxRemovalFiles(true, true);
  await receipt(time, 9000);
  const native = f.supervisorRun.getMockImplementation()!;
  f.supervisorRun.mockImplementation(async (file, args) => {
    if (file === 'ps' && args[1]!.split(',').includes('9000')) return '9000';
    return native(file, args);
  });
  await expect(scannerService(f.options).uninstall()).rejects.toThrow('scanner_stop_failed');
  expect(await readFile(files.runtimePath, 'utf8')).toBe('retained executable');
  expect(await readFile(files.unitPath, 'utf8')).toBe('working scanner unit');
});
