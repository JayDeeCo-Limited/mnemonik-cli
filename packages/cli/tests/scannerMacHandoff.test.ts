import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scannerService } from '../src/scanner/service.js';
import type { Verified } from '../src/runtime/store.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
it.each([
  'new',
  'paused',
  'old',
  'both-failed',
  'no-previous',
  'offline-ready',
  'not-locally-ready',
  'stale-readiness',
  'stale-receipt',
  'wrong-pid',
] as const)('Mac update reports the native handoff outcome truthfully: %s', async (outcome) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'scanner-mac-handoff-'));
  directories.push(stateDir);
  await mkdir(join(stateDir, 'scanner/service-replacement'), { recursive: true });
  let now = 1000000;
  const service = scannerService({
    stateDir,
    platform: 'darwin',
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    command: async (operation) => {
      if (operation === 'install') {
        await writeFile(
          join(stateDir, 'scanner/service-replacement/result.json'),
          JSON.stringify({
            pid: 42,
            startedAt: now,
            fallback: outcome === 'old',
            ...(outcome === 'both-failed' ? { fallbackError: 'digest_mismatch' } : {}),
            ...(outcome === 'no-previous'
              ? { candidateError: 'ENOSPC', fallbackError: 'scanner_fallback_missing' }
              : {}),
          })
        );
        await writeFile(
          join(stateDir, 'scanner/status.json'),
          JSON.stringify({
            recordedAt: now + (outcome === 'stale-receipt' ? -1 : 1),
            snapshot: {
              lifecycle: {
                pid: outcome === 'wrong-pid' ? 41 : 42,
                state:
                  outcome === 'paused'
                    ? 'paused'
                    : ['offline-ready', 'not-locally-ready', 'stale-readiness'].includes(outcome)
                      ? 'starting'
                      : 'running',
              },
              heartbeat: { lastSuccess: null },
              startupTimings: {
                localReadyAt:
                  outcome === 'not-locally-ready'
                    ? null
                    : now + (outcome === 'stale-readiness' ? -1 : 1),
              },
            },
          })
        );
      }
      return {
        status: 'ok',
        supervisor: { kind: 'launchd', installed: true, running: true, pid: 42 },
      };
    },
  });
  const result = service.replace(
    { entry: '/verified/scanner', directory: '/verified' } as Verified,
    {
      pointer: { after: '{}' },
      state: { before: null, after: JSON.stringify({ paused: outcome === 'paused' }) },
    }
  );
  if (outcome === 'new' || outcome === 'paused' || outcome === 'offline-ready') {
    await expect(result).resolves.toBeUndefined();
    expect(service.verified).toBe(true);
  } else {
    await expect(result).rejects.toMatchObject({
      reason:
        outcome === 'old'
          ? 'scanner_replacement_rolled_back'
          : outcome === 'both-failed'
            ? 'scanner_replacement_failed'
            : outcome === 'no-previous'
              ? 'scanner_replacement_candidate_failed'
              : 'scanner_replacement_interrupted',
      ...(outcome === 'no-previous'
        ? {
            action: 'Free disk space on this computer, then run mnemonik install.',
          }
        : {}),
    });
    expect(service.verified).toBe(false);
  }
});
