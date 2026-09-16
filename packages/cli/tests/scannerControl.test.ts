import { expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/router.js';

it('exits after an early pause acknowledgement while the daemon drain continues', async () => {
  const home = await mkdtemp(join(tmpdir(), 'scanner-control-'));
  const state = join(home, 'state');
  await mkdir(join(state, 'scanner'), { recursive: true });
  try {
    let elapsed = 0;
    let draining = true;
    let output = '';
    const sleep = async (ms: number) => {
      elapsed += ms;
      if (elapsed === 1_000) {
        const { id } = JSON.parse(await readFile(join(state, 'scanner/control.json'), 'utf8')) as {
          id: string;
        };
        await writeFile(
          join(state, 'scanner/status.json'),
          JSON.stringify({
            recordedAt: elapsed,
            snapshot: {
              version: 'fixture',
              lifecycle: {
                state: 'paused',
                reason: 'pause_requested',
                pid: 42,
                controlId: id,
                pauseIntervals: [],
              },
              heartbeat: { lastSuccess: null },
              roots: [],
              exclusions: [],
            },
          })
        );
      }
      if (elapsed >= 20_000) draining = false;
    };
    const command = async () => ({
      status: 'ok' as const,
      supervisor: { kind: 'fixture', installed: true, running: true, pid: 42 },
    });

    expect(
      await runCli(['scanner', 'pause'], {
        installStateDir: state,
        scannerService: { stateDir: state, now: () => elapsed, sleep, command },
        stdout: { write: (text) => (output += text) },
      })
    ).toBe(0);
    expect(elapsed).toBe(1_000);
    expect(draining).toBe(true);
    expect(output).toContain('"state":"paused"');
    expect(output).not.toContain('scanner_control_timeout');

    await sleep(19_000);
    expect(draining).toBe(false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
