import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runCli } from '../src/router.js';

let directory: string;

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it('prints and reports the live service state over the daemon snapshot', async () => {
  directory = await mkdtemp(join(tmpdir(), 'scanner-status-'));
  await mkdir(join(directory, 'scanner'));
  await writeFile(
    join(directory, 'scanner/status.json'),
    JSON.stringify({
      snapshot: {
        supervisor: { kind: 'none', installed: false, running: false, pid: null },
      },
    })
  );
  const stdout = {
    text: '',
    write(chunk: string) {
      this.text += chunk;
    },
  };
  const live = { kind: 'launchd' as const, installed: true, running: true, pid: 42 };
  const command = vi.fn(async () => ({ status: 'ok' as const, supervisor: live }));

  expect(
    await runCli(['scanner', 'status'], {
      installStateDir: directory,
      scannerService: { stateDir: directory, command },
      stdout,
      stderr: stdout,
    })
  ).toBe(0);

  const lines = stdout.text.trim().split('\n');
  expect(lines[0]).toBe('Scanner status: ok (service: launchd, running)');
  expect(lines).toHaveLength(1);
  stdout.text = '';
  expect(
    await runCli(['scanner', 'status', '--json'], {
      installStateDir: directory,
      scannerService: { stateDir: directory, command },
      stdout,
      stderr: stdout,
    })
  ).toBe(0);
  expect(JSON.parse(stdout.text).receipt.snapshot.supervisor).toEqual(live);
});
