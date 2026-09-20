import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  maybeStartAutomaticUpdate,
  startAutomaticUpdateForSession,
} from '../src/automaticUpdate.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function fixture() {
  const stateDir = await mkdtemp(join(tmpdir(), 'automatic-update-'));
  directories.push(stateDir);
  const spawn = vi.fn(() => ({
    once: vi.fn(),
    unref: vi.fn(),
  }));
  return { stateDir, spawn };
}

it('claims exactly at the 24-hour boundary', async () => {
  const f = await fixture();
  const options = { ...f, home: f.stateDir, platform: 'linux' as const };

  expect(await maybeStartAutomaticUpdate({ ...options, now: () => 0 })).toBe(true);
  f.spawn.mockClear();
  expect(await maybeStartAutomaticUpdate({ ...options, now: () => 86_399_999 })).toBe(false);
  expect(f.spawn).not.toHaveBeenCalled();
  expect(await maybeStartAutomaticUpdate({ ...options, now: () => 86_400_000 })).toBe(true);
  expect(f.spawn).toHaveBeenCalledOnce();
  expect(f.spawn).toHaveBeenCalledWith(
    join(f.stateDir, '.local', 'bin', 'mnemonik'),
    ['update', '--automatic'],
    expect.objectContaining({ detached: true, stdio: 'ignore' })
  );
});

it('allows one of 20 concurrent starts to spawn', async () => {
  const f = await fixture();
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      maybeStartAutomaticUpdate({
        ...f,
        home: f.stateDir,
        platform: 'linux',
        now: () => 86_400_000,
      })
    )
  );
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(f.spawn).toHaveBeenCalledOnce();
});

it('returns after one stat when the last attempt is younger than 24 hours', async () => {
  const f = await fixture();
  const stat = vi.fn(async () => ({ isFile: () => true, mtimeMs: 1 }));

  expect(
    await maybeStartAutomaticUpdate({
      ...f,
      home: f.stateDir,
      platform: 'linux',
      now: () => 86_400_000,
      stat,
    })
  ).toBe(false);
  expect(stat).toHaveBeenCalledOnce();
  expect(f.spawn).not.toHaveBeenCalled();
});

it('bounds a never-settling session update at 50 ms without output', async () => {
  vi.useFakeTimers();
  const stdout = vi.spyOn(process.stdout, 'write');
  const stderr = vi.spyOn(process.stderr, 'write');
  try {
    let settled = false;
    const result = startAutomaticUpdateForSession(() => new Promise(() => {})).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(49);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(settled).toBe(true);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    await expect(
      startAutomaticUpdateForSession(async () => {
        throw new Error('slow state directory');
      })
    ).resolves.toBeUndefined();
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
    vi.useRealTimers();
  }
});
