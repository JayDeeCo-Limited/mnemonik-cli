import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { open } from '../src/auth/pkce.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
it('opens the complete Windows URL without cmd parsing', async () => {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
  const url = 'https://auth.example.test/oauth/authorize?first=one&second=two&encoded=%26';
  const result = open(url, 'win32');
  child.emit('spawn');
  await result;
  expect(spawn).toHaveBeenCalledWith('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
});
