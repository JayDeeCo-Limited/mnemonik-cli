import { afterEach, expect, it, vi } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { scannerService } from '../src/scanner/service.js';
import { controlScanner } from '../src/scanner/control.js';
import { RuntimeStore } from '../src/runtime/store.js';
import { WindowsTaskAdapter } from '../../scanner/src/supervisor/windows.js';

vi.mock('@mnemonik/shared', async (original) => ({
  ...(await original<typeof import('@mnemonik/shared')>()),
  WINDOWS_SERVICE_BUDGET_MS: 800,
}));
vi.mock('@mnemonik/local-setup', async (original) => ({
  ...(await original<typeof import('@mnemonik/local-setup')>()),
  atomicWrite: vi.fn(),
  withLock: (_path: string, _ms: number, work: () => Promise<unknown>) => work(),
}));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFile: vi.fn((_file, _args, _options, callback) => {
    callback(null, JSON.stringify({ status: 'ok', supervisor: {}, installed: true }), '');
    return { stdin: { end: vi.fn() } };
  }),
  execFileSync: vi.fn(() => '{}'),
}));
const platform = process.platform;
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
it('moves CLI launch, Windows supervisor and control acknowledgement with one budget', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  vi.stubEnv('SystemRoot', 'C:\\Windows');
  const store = new RuntimeStore('/fixture');
  vi.spyOn(store, 'verifyRuntime').mockResolvedValue({ entry: 'scanner.exe' } as never);
  await scannerService({ stateDir: '/fixture', store }).status();
  await new WindowsTaskAdapter().status();
  new WindowsTaskAdapter().isSupervised();
  expect(
    vi.mocked(execFile).mock.calls.map((call) => (call[2] as { timeout: number }).timeout)
  ).toEqual([800, 200]);
  expect(execFileSync).toHaveBeenCalledWith(
    'powershell.exe',
    expect.any(Array),
    expect.objectContaining({ timeout: 200 })
  );
  let elapsed = 0;
  await expect(
    controlScanner('pause', {
      stateDir: '/fixture',
      now: () => elapsed,
      sleep: async (ms) => {
        elapsed += ms;
      },
      command: async () => ({
        status: 'ok',
        supervisor: { kind: 'test', installed: true, running: true, pid: 42 },
      }),
    })
  ).rejects.toThrow('scanner_control_timeout');
  expect(elapsed).toBe(200);
});
