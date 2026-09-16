import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
const commands = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock('node:child_process', () => commands);
import { open } from '../src/auth/pkce.js';

it('releases the opener after spawn while the browser is still running', async () => {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  commands.spawn.mockImplementation(() => {
    globalThis.queueMicrotask(() => child.emit('spawn'));
    return child;
  });
  expect(
    await Promise.race([
      open('https://auth.example/authorize', 'linux').then(() => 'opened'),
      new Promise((resolve) => setTimeout(() => resolve('blocked'), 100)),
    ])
  ).toBe('opened');
  expect(commands.spawn).toHaveBeenCalledWith('xdg-open', ['https://auth.example/authorize'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  expect(child.unref).toHaveBeenCalledOnce();
});
