import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { scannerService } from '../src/scanner/service.js';
import { RuntimeStore } from '../src/runtime/store.js';

const fake = vi.hoisted(() => ({ duration: 31000 }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFile: vi.fn((_file, _args, options, callback) => {
    setTimeout(
      () => {
        if (fake.duration > options.timeout)
          callback(
            Object.assign(new Error('Command failed'), {
              killed: true,
              code: null,
              signal: 'SIGTERM',
            }),
            '',
            ''
          );
        else callback(null, JSON.stringify({ status: 'ok', supervisor: { installed: true } }));
      },
      Math.min(fake.duration, options.timeout)
    );
    return { stdin: { end: vi.fn() } };
  }),
}));
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(process, 'platform', { value: 'win32' });
  vi.spyOn(RuntimeStore.prototype, 'verifyRuntime').mockResolvedValue({
    entry: 'scanner.exe',
  } as never);
});
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const service = () =>
  scannerService({ stateDir: 'C:\\fixture', store: new RuntimeStore('C:\\fixture') });
it('allows a Windows service operation to return after thirty seconds', async () => {
  fake.duration = 31000;
  const result = expect(service().status()).resolves.toMatchObject({ installed: true });
  await Promise.all([result, vi.advanceTimersByTimeAsync(31000)]);
});
it('bounds the Windows child and preserves killed, code and signal in the refusal', async () => {
  fake.duration = 121000;
  const result = expect(service().status()).rejects.toThrow('killed=true code=null signal=SIGTERM');
  await Promise.all([result, vi.advanceTimersByTimeAsync(120000)]);
});
