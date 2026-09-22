import { afterEach, expect, it, vi } from 'vitest';
import { macScannerLauncher } from '@mnemonik/shared';
import { RuntimeStore } from '../src/runtime/store.js';
import { scannerService } from '../src/scanner/service.js';
const { native, stat } = vi.hoisted(() => ({ native: vi.fn(), stat: vi.fn() }));
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  lstat: stat,
}));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFile: native,
}));
afterEach(() => {
  vi.restoreAllMocks();
  stat.mockReset();
  native.mockReset();
});
it.each(['status', 'stop'] as const)(
  'a fresh CLI %s after rollback uses the fixed launcher even without the selected runtime manifest',
  async (operation) => {
    const verify = vi
      .spyOn(RuntimeStore.prototype, 'verifyRuntime')
      .mockRejectedValue(Error('manifest_missing'));
    stat.mockResolvedValue({ isFile: () => true, uid: 0, mode: 0o100755 });
    native.mockImplementation((_file, _args, _options, callback) => {
      callback(
        null,
        JSON.stringify({
          status: 'ok',
          supervisor: { kind: 'launchd', installed: true, running: true, pid: 123 },
        })
      );
      return { stdin: { end: vi.fn() } };
    });
    const result = await scannerService({ stateDir: '/fixture', platform: 'darwin' })[operation]();
    if (operation === 'status') expect(result).toMatchObject({ running: true, pid: 123 });
    expect(native).toHaveBeenCalledWith(
      macScannerLauncher,
      ['service', operation, '--json'],
      expect.anything(),
      expect.any(Function)
    );
    expect(verify).not.toHaveBeenCalled();
  }
);
it.each([
  { uid: 501, mode: 0o100755, file: true },
  { uid: 0, mode: 0o100777, file: true },
  { uid: 0, mode: 0o120755, file: false },
])('refuses an untrusted fixed launcher: %j', async ({ uid, mode, file }) => {
  stat.mockResolvedValue({ isFile: () => file, uid, mode });
  await expect(
    scannerService({ stateDir: '/fixture', platform: 'darwin' }).status()
  ).rejects.toThrow('service_runtime_permission');
  expect(native).not.toHaveBeenCalled();
});
