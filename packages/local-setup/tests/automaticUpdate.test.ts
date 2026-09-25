import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SystemdAdapter } from '../../scanner/src/supervisor/systemd.js';
import {
  maybeStartAutomaticUpdate,
  startAutomaticUpdateForSession,
  type AutomaticUpdateOptions,
  type SessionUpdateOptions,
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
  const spawn = vi.fn<NonNullable<AutomaticUpdateOptions['spawn']>>(() => ({
    once: vi.fn(),
    unref: vi.fn(),
  }));
  return { stateDir, spawn, env: { INVOCATION_ID: 'fixture-service' } };
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
    'systemd-run',
    [
      '--user',
      '--collect',
      '--quiet',
      `--setenv=MNEMONIK_STATE_DIR=${f.stateDir}`,
      '--',
      join(f.stateDir, '.local', 'bin', 'mnemonik'),
      'update',
      '--automatic',
    ],
    expect.objectContaining({ detached: true, stdio: 'ignore' })
  );
});

it('a scanner-triggered Linux update runs outside the scanner service cgroup', async () => {
  const f = await fixture();
  let updaterAlive = false;
  let updaterCgroup = '';
  f.spawn.mockImplementation((file: string) => {
    updaterAlive = true;
    updaterCgroup = file === 'systemd-run' ? 'run-update.service' : 'mnemonik-scanner.service';
    return { once: vi.fn(), unref: vi.fn() };
  });
  await maybeStartAutomaticUpdate({ ...f, home: f.stateDir, platform: 'linux' });
  await new SystemdAdapter({
    run: async (_file, args) => {
      // systemd stop kills the scanner's whole cgroup, including detached children.
      if (args.includes('stop') && updaterCgroup === 'mnemonik-scanner.service')
        updaterAlive = false;
      return '';
    },
  }).stop();
  expect(updaterAlive).toBe(true);
});

it('an ordinary Linux host updates without requiring a systemd user manager', async () => {
  const f = await fixture();
  expect(
    await maybeStartAutomaticUpdate({ ...f, home: f.stateDir, platform: 'linux', env: {} })
  ).toBe(true);
  expect(f.spawn).toHaveBeenCalledWith(
    join(f.stateDir, '.local', 'bin', 'mnemonik'),
    ['update', '--automatic'],
    expect.objectContaining({ detached: true, stdio: 'ignore' })
  );
});

it('failure to launch a separate Linux update service never falls back to a scanner child', async () => {
  const f = await fixture();
  f.spawn.mockImplementation(() => {
    throw new Error('systemd-run unavailable');
  });
  expect(await maybeStartAutomaticUpdate({ ...f, home: f.stateDir, platform: 'linux' })).toBe(
    false
  );
  expect(f.spawn).toHaveBeenCalledOnce();
  expect(f.spawn.mock.calls[0]?.[0]).toBe('systemd-run');
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

describe('session start', () => {
  const helper = () =>
    vi.fn<NonNullable<SessionUpdateOptions['spawnHelper']>>(() => ({
      once: vi.fn(),
      unref: vi.fn(),
    }));

  it('does one stat and starts nothing when the day is already claimed', async () => {
    const f = await fixture();
    const spawnHelper = helper();
    const stat = vi.fn(async () => ({ isFile: () => true, mtimeMs: 1 }));
    await startAutomaticUpdateForSession({
      stateDir: f.stateDir,
      home: f.stateDir,
      now: () => 86_400_000,
      stat,
      spawnHelper,
    });
    expect(stat).toHaveBeenCalledOnce();
    expect(spawnHelper).not.toHaveBeenCalled();
  });

  it('hands a due claim to a detached helper and does none of it itself', async () => {
    const f = await fixture();
    const spawnHelper = helper();
    const launcher = join(f.stateDir, '.local', 'bin', 'mnemonik');
    await mkdir(dirname(launcher), { recursive: true });
    await writeFile(launcher, '#!/bin/sh\n', { mode: 0o755 });
    await startAutomaticUpdateForSession({
      stateDir: f.stateDir,
      home: f.stateDir,
      platform: 'linux',
      spawnHelper,
    });
    expect(spawnHelper).toHaveBeenCalledWith(
      process.execPath,
      [
        fileURLToPath(new URL('../src/automaticUpdate.ts', import.meta.url)),
        '--mnemonik-automatic-update',
        f.stateDir,
      ],
      expect.objectContaining({ detached: true, stdio: 'ignore' })
    );
    // The claim is the helper's: session start wrote nothing.
    await expect(stat(join(f.stateDir, 'automatic-update.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('starts no helper on a machine without the mnemonik launcher', async () => {
    const f = await fixture();
    const spawnHelper = helper();
    await startAutomaticUpdateForSession({
      stateDir: f.stateDir,
      home: f.stateDir,
      platform: 'linux',
      spawnHelper,
    });
    expect(spawnHelper).not.toHaveBeenCalled();
  });

  it('is silent and fail-open when the helper cannot start', async () => {
    const f = await fixture();
    const stdout = vi.spyOn(process.stdout, 'write');
    const stderr = vi.spyOn(process.stderr, 'write');
    try {
      await expect(
        startAutomaticUpdateForSession({
          stateDir: f.stateDir,
          home: f.stateDir,
          stat: async () => {
            throw Object.assign(new Error('gone'), { code: 'ENOENT' });
          },
          spawnHelper: () => {
            throw new Error('spawn refused');
          },
        })
      ).resolves.toBeUndefined();
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});
