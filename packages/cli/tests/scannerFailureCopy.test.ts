import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runCli } from '../src/router.js';
import { ScannerServiceLimited } from '../src/scanner/service.js';

it.each([
  [
    'scanner_stop_failed',
    'Background indexing could not be stopped.',
    'Restart this computer, then run mnemonik uninstall again.',
  ],
  [
    'systemd_linger_required',
    'Background indexing needs permission to keep running after you log out.',
    'Run sudo loginctl enable-linger $USER, then run mnemonik install.',
  ],
  [
    'systemd_session_unavailable',
    'This server cannot keep background indexing running.',
    'Ask the server administrator to enable systemd user services, then run mnemonik install.',
  ],
  [
    'mac_authorization_failed',
    'Background indexing was not set up because the password was not accepted.',
    'Run mnemonik install to try again.',
  ],
])(
  'scanner command prints the owner-approved pair for %s and retains diagnostic detail',
  async (reason, summary, action) => {
    const stateDir = await mkdtemp(join(tmpdir(), 'scanner-copy-'));
    try {
      const failure = new ScannerServiceLimited(reason, 'supervisor_diagnostic');
      expect(failure.summary).toBe(summary);
      expect(failure.action).toBe(action);
      let text = '';
      const deps = {
        installStateDir: stateDir,
        home: stateDir,
        stdout: {
          write: (value: string) => {
            text += value;
          },
        },
        scannerService: {
          stateDir,
          command: async () => ({
            status: 'LIMITED' as const,
            reason,
            detail: 'supervisor_diagnostic',
            action: 'unused',
          }),
        },
      };
      expect(await runCli(['scanner', 'stop'], deps)).toBe(3);
      expect(text.trim().split('\n')).toEqual([summary, action]);
      text = '';
      expect(await runCli(['scanner', 'stop', '--json'], deps)).toBe(3);
      expect(JSON.parse(text)).toMatchObject({ reason, detail: 'supervisor_diagnostic', action });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  }
);

it.each([
  ['scanner_service_unavailable', 'Background indexing could not be started.'],
  ['service_runtime_permission', 'Background indexing could not be started.'],
  ['service_timeout', 'Background indexing could not be started.'],
  ['supervisor_operation_failed', 'Background indexing could not be started.'],
  ['heartbeat_timeout', 'Background indexing started but has not reported yet.'],
])('reason %s reaches a person as a sentence, never as a code', async (reason, summary) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'scanner-copy-'));
  try {
    let text = '';
    const deps = {
      installStateDir: stateDir,
      home: stateDir,
      stdout: {
        write: (value: string) => {
          text += value;
        },
      },
      scannerService: {
        stateDir,
        command: async () => ({
          status: 'LIMITED' as const,
          reason,
          detail: 'supervisor_diagnostic',
          action: 'unused',
        }),
      },
    };
    expect(await runCli(['scanner', 'stop'], deps)).toBe(3);
    const lines = text.trim().split('\n');
    expect(lines[0]).toBe(summary);
    expect(lines.every((line) => !/^LIMITED:|^[a-z][a-z0-9_]*$/u.test(line))).toBe(true);
    text = '';
    expect(await runCli(['scanner', 'stop', '--json'], deps)).toBe(3);
    expect(JSON.parse(text)).toMatchObject({ reason, detail: 'supervisor_diagnostic' });
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

it('a second account on the same Mac is told the truth and given nothing to do', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'scanner-copy-'));
  try {
    let text = '';
    const deps = {
      installStateDir: stateDir,
      home: stateDir,
      stdout: {
        write: (value: string) => {
          text += value;
        },
      },
      scannerService: {
        stateDir,
        command: async () => ({
          status: 'LIMITED' as const,
          reason: 'scanner_other_account',
          detail: 'scanner_other_account',
          action: 'unused',
        }),
      },
    };
    expect(await runCli(['scanner', 'stop'], deps)).toBe(3);
    expect(text.trim().split('\n')).toEqual([
      'Background indexing is already set up for another account on this Mac.',
    ]);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

it('stopping background indexing on a Mac says it comes back at the next restart', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'scanner-copy-'));
  try {
    let text = '';
    expect(
      await runCli(['scanner', 'stop'], {
        installStateDir: stateDir,
        home: stateDir,
        stdout: {
          write: (value: string) => {
            text += value;
          },
        },
        scannerService: {
          stateDir,
          platform: 'darwin' as const,
          command: async () => ({
            status: 'ok' as const,
            supervisor: { kind: 'launchd' as const, installed: true, running: false, pid: null },
          }),
        },
      })
    ).toBe(0);
    expect(text.trim().split('\n')).toContain(
      'Background indexing will start again when this Mac restarts.'
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
