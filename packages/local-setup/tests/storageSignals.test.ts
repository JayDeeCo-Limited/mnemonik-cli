import { spawn } from 'node:child_process';
import { once } from 'node:events';
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

it('removes a held lock immediately when the process is stopped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'storage-signal-cleanup-'));
  dirs.push(root);
  const path = join(root, 'state');
  const storageModule = new URL('../src/storage.ts', import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "const {withLock}=await import(process.argv[2]); await withLock(process.argv[1], 20, async () => { console.log('locked'); await new Promise(() => { setInterval(() => {}, 1000); }); });",
      path,
      storageModule,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  );
  try {
    await once(child.stdout!, 'data');
    child.kill('SIGTERM');
    await once(child, 'exit');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }

  const { withLock } = await import('../src/storage.js');
  await expect(withLock(path, 20, async () => 'acquired')).resolves.toBe('acquired');
});
