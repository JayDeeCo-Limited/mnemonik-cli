import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it('shares one signal-exit listener set across separate storage module identities', async () => {
  const signals = ['SIGABRT', 'SIGALRM', 'SIGHUP'] as const;
  const counts = () => signals.map((signal) => process.listenerCount(signal));
  const baseline = counts();
  const first = await import('../src/storage.js');
  const firstRoot = await mkdtemp(join(tmpdir(), 'storage-signals-first-'));
  dirs.push(firstRoot);
  await first.withLock(join(firstRoot, 'state'), 20, async () => {});
  const afterFirst = counts();

  vi.resetModules();
  const second = await import('../src/storage.js');
  const secondRoot = await mkdtemp(join(tmpdir(), 'storage-signals-second-'));
  dirs.push(secondRoot);
  await second.withLock(join(secondRoot, 'state'), 20, async () => {});

  expect(counts()).toEqual(afterFirst);
  expect(afterFirst.every((count, index) => count - baseline[index]! <= 1)).toBe(true);
});
