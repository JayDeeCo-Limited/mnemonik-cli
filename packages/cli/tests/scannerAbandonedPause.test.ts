import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { withLock } from '@mnemonik/local-setup';
import { runCli } from '../src/router.js';
import {
  ABANDONED_PAUSE_RESUMED,
  controlScanner,
  resumeAbandonedPause,
} from '../src/scanner/control.js';

// L-73: an install that dies after pausing the scanner must not leave it paused.
let home: string;
let state: string;
const pauseId = randomUUID();
/** A process id that is certainly gone: a child that already exited. */
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;
const command = async () => ({
  status: 'ok' as const,
  supervisor: { kind: 'fixture', installed: true, running: true, pid: 42 },
});

async function lifecycle(fields: Record<string, unknown>) {
  await writeFile(
    join(state, 'scanner/status.json'),
    JSON.stringify({
      recordedAt: Date.now(),
      snapshot: {
        version: 'fixture',
        lifecycle: { pid: 42, pauseIntervals: [], ...fields },
        heartbeat: { lastSuccess: null },
        roots: [],
        exclusions: [],
      },
    })
  );
}

/** The daemon's half: acknowledge whatever control request is on disk. */
const sleep = async () => {
  const request = JSON.parse(await readFile(join(state, 'scanner/control.json'), 'utf8')) as {
    id: string;
    action: string;
  };
  await lifecycle({
    state: request.action === 'pause' ? 'paused' : 'running',
    reason: `${request.action}_requested`,
    controlId: request.id,
  });
};
const service = () => ({ stateDir: state, command, sleep });

async function abandonedPause(owner: Record<string, unknown> | undefined) {
  await writeFile(
    join(state, 'scanner/control.json'),
    JSON.stringify({ id: pauseId, action: 'pause', ...(owner ? { owner } : {}) })
  );
  await lifecycle({ state: 'paused', reason: 'pause_requested', controlId: pauseId });
}
const action = async () =>
  (JSON.parse(await readFile(join(state, 'scanner/control.json'), 'utf8')) as { action: string })
    .action;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'abandoned-pause-'));
  state = join(home, 'state');
  await mkdir(join(state, 'scanner'), { recursive: true });
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

it('an install pause names the run that made it and when', async () => {
  const owner = { session: 'run-one', pid: process.pid, at: 1_700_000_000_000 };
  await lifecycle({ state: 'running', reason: 'start' });
  await controlScanner('pause', service(), owner);
  expect(JSON.parse(await readFile(join(state, 'scanner/control.json'), 'utf8'))).toMatchObject({
    action: 'pause',
    owner,
  });
});

it('status resumes a pause left by an install that is gone and says so in one line', async () => {
  await abandonedPause({ session: 'dead-run', pid: deadPid(), at: Date.now() - 11 * 3_600_000 });
  let text = '';
  await runCli(['status'], {
    home,
    installStateDir: state,
    scannerService: service(),
    preflight: {
      nodeVersion: '24.21.0',
      pathExists: async () => false,
      fetch: async () => Response.json({}),
      resolveIdentity: async () => ({ kind: 'git_unavailable' as const, detail: 'fixture' }),
    },
    stdout: { write: (chunk) => void (text += chunk) },
    stderr: { write: (chunk) => void (text += chunk) },
  });
  expect(await action()).toBe('resume');
  expect(text.split('\n').filter((line) => line === ABANDONED_PAUSE_RESUMED)).toHaveLength(1);
  expect(text).not.toContain('mnemonik scanner resume');
});

it('leaves a pause alone while the install that made it is still running', async () => {
  const session = 'live-run';
  await writeFile(
    join(state, 'install-owner.json'),
    JSON.stringify({ generation: 1, runId: session })
  );
  await withLock(join(state, 'install-owner.json'), 1000, async () => {
    await abandonedPause({ session, pid: process.pid, at: Date.now() });
    expect(await resumeAbandonedPause(service())).toBe(false);
  });
  expect(await action()).toBe('pause');
});

it('leaves a pause a person chose alone', async () => {
  await abandonedPause(undefined);
  expect(await resumeAbandonedPause(service())).toBe(false);
  expect(await action()).toBe('pause');
});

it('says nothing after a finished install whose scanner is already running', async () => {
  await abandonedPause({ session: 'done-run', pid: deadPid(), at: Date.now() });
  // The finished install restarted the scanner from its unpaused state.
  await lifecycle({ state: 'running', reason: 'start', controlId: pauseId });
  expect(await resumeAbandonedPause(service())).toBe(false);
  expect(await action()).toBe('pause');
});
