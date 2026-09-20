import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bytesAt, withInstall } from '../../src/install/journal.js';
import { runHosts } from '../../src/install/hosts.js';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { runCli } from '../../src/router.js';
import { waitForInstallation } from '../../src/install/journey.js';
import { serializeReadiness } from '@mnemonik/shared';
import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import * as screens from '../../src/screens.js';
import { Output } from '../../src/output.js';

it.each([
  'recommended',
  'account',
  'cli_approval',
  'scanner',
  'apply',
  'done',
  'skipped',
  'windows',
])('joined %s screen matches its transcript', async (screen) => {
  const render = (
    screens as unknown as {
      renderJourney?: (screen: string, output: Output, values: unknown) => void;
    }
  ).renderJourney;
  expect(render, 'the production journey renders this screen').toBeTypeOf('function');
  let text = '';
  render?.(
    screen,
    new Output({
      write: (chunk) => {
        text += chunk;
      },
    }),
    {
      hosts: ['Claude Code', 'Cursor', 'Codex'],
      project: '~/code/acme-api',
      node: '24.21.0',
      os: 'macOS 15.3',
      files: [
        'Claude Code    ~/.claude/settings.json',
        'Cursor         ~/.cursor/mcp.json',
        'Codex          ~/.codex/config.toml',
        'Scanner        background service, starts at login',
        'This project   "acme-api" set up, saves .mnemonik.json',
      ],
      total: 240,
      completed: 38,
      skipped: 'Background indexing was skipped.',
      remaining: 1,
      reason: 'Access is denied.',
    }
  );
  const golden = await readFile(new URL(`./${screen}.golden.txt`, import.meta.url), 'utf8');
  expect(text).toBe(
    ['account', 'scanner'].includes(screen)
      ? golden
      : golden.endsWith('\n\n')
        ? golden
        : `${golden}\n`
  );
});

it('states the controls on every choice screen', () => {
  let text = '';
  screens.renderJourney('recommended', new Output({ write: (chunk) => void (text += chunk) }), {
    hosts: ['Claude Code', 'Codex'],
    project: '~/Projects',
    node: '24.21.0',
    os: 'macOS',
  });
  expect(text).toContain('Use the Up/Down arrow keys and Enter.');

  text = '';
  screens.renderScreen(
    {
      id: 'cancel',
      title: 'Cancel installation?',
      lines: [],
      choices: ['Keep going', 'Cancel'],
      default: 0,
    },
    new Output({ write: (chunk) => void (text += chunk) })
  );
  expect(text).toContain('Use the Up/Down arrow keys and Enter.');
});

it('uses arrow keys and Enter, with Enter accepting the highlighted default', async () => {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: vi.fn(),
  });
  let text = '';
  const answers = screens.journeyAnswers(
    input,
    new Output({ write: (chunk) => void (text += chunk) })
  );
  const changed = answers.choose(['Recommended', 'Customize']);
  input.write('\u001b[B\r');
  await expect(changed).resolves.toBe('Customize');

  const accepted = answers.choose(['Recommended', 'Customize']);
  input.write('\r');
  await expect(accepted).resolves.toBe('Recommended');
  expect(input.setRawMode).toHaveBeenCalledWith(true);
  answers.close();
});

it('discards keys pressed while no question is on screen', async () => {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: vi.fn(),
  });
  const answers = screens.journeyAnswers(input);
  const first = answers.choose(['Recommended', 'Customize']);
  input.write('\r');
  await expect(first).resolves.toBe('Recommended');

  input.write('\r');
  const second = answers.choose(['Install', 'Cancel']);
  let settled = false;
  void second.then(() => (settled = true));
  await new Promise((resolve) => globalThis.setImmediate(resolve));
  expect(settled).toBe(false);

  input.write('\u001b[B\r');
  await expect(second).resolves.toBe('Cancel');
  answers.close();
});

it('reports Ctrl-C and terminal hang-up immediately even when no question is waiting', () => {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: vi.fn(),
  });
  const signals = new EventEmitter();
  const stopped = vi.fn();
  const answers = (
    screens.journeyAnswers as unknown as (
      input: Readable,
      output: undefined,
      options: { interrupt: () => void; signals: EventEmitter }
    ) => ReturnType<typeof screens.journeyAnswers>
  )(input, undefined, { interrupt: stopped, signals });

  input.write('\u0003');
  signals.emit('SIGHUP');
  expect(stopped).toHaveBeenCalledTimes(2);
  answers.close();
  expect(signals.listenerCount('SIGHUP')).toBe(0);
});

it('animates a long step in a TTY, replaces it with the result, and uses plain lines otherwise', () => {
  vi.useFakeTimers();
  const progress = (
    screens as unknown as {
      stepProgress?: (
        output: Output,
        interactive: boolean,
        text: string
      ) => { complete(result: string): void };
    }
  ).stepProgress;
  expect(progress, 'the production journey exposes long-step output').toBeTypeOf('function');

  let ttyText = '';
  const tty = progress?.(
    new Output({ isTTY: true, write: (chunk) => void (ttyText += chunk) }),
    true,
    'Signing in'
  );
  vi.advanceTimersByTime(160);
  tty?.complete('  ✓ Signed in');
  expect(ttyText).toMatch(/\| Signing in/u);
  expect(ttyText).toMatch(/[\\/-] Signing in/u);
  expect(ttyText.endsWith('\r\u001b[2K  ✓ Signed in\n')).toBe(true);

  let plainText = '';
  const plain = progress?.(
    new Output({ write: (chunk) => void (plainText += chunk) }),
    false,
    'Signing in'
  );
  plain?.complete('  ✓ Signed in');
  expect(plainText).toBe('  Signing in\n  ✓ Signed in\n');
  vi.useRealTimers();
});

it('renders Customize as one checklist and applies its keyboard changes', async () => {
  let text = '';
  const output = new Output({ write: (chunk) => void (text += chunk) });
  screens.renderCustomize(
    [
      { value: 'claude-code', label: 'Claude Code', checked: true },
      { value: 'codex', label: 'Codex', checked: true },
      { value: 'scanner', label: 'Indexing of your projects', checked: true },
    ],
    output
  );
  expect(text).toContain(
    'Use the Up/Down arrow keys to move, Space to select, Enter to continue, Esc to go back.'
  );
  expect(text).toContain('[x] Claude Code');
  expect(text).not.toContain('Scope');

  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
  const answers = screens.journeyAnswers(input, output);
  const result = answers.customize([
    { value: 'claude-code', label: 'Claude Code', checked: true },
    { value: 'codex', label: 'Codex', checked: true },
    { value: 'scanner', label: 'Indexing of your projects', checked: true },
  ]);
  input.write(' \u001b[B\r');
  await expect(result).resolves.toEqual({ selected: ['codex', 'scanner'] });
  answers.close();
});

it('reports closed input as a cancellation', async () => {
  let text = '';
  const answers = screens.journeyAnswers(
    Readable.from([]),
    new Output({ write: (chunk) => void (text += chunk) })
  );
  await expect(answers.choose(['Recommended', 'Customize'])).resolves.toBe('Cancel');
  expect(text).toContain('Installation cancelled.');
});

it('stops reading terminal input when the journey closes', () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
  const pause = vi.spyOn(input, 'pause');

  const answers = screens.journeyAnswers(input);
  answers.close();

  expect(pause).toHaveBeenCalledOnce();
});

it.each([
  [0, 'Done.'],
  [1, 'Done, with one thing left.'],
  [7, 'Done, with 7 things left.'],
])('counts %s remaining reasons independently of shared actions', (remaining, heading) => {
  let text = '';
  screens.renderJourney(
    'skipped',
    new Output({
      write: (chunk) => {
        text += chunk;
      },
    }),
    {
      remaining: Number(remaining),
      skipped: 'host digest_mismatch; scanner unavailable; no automatic fix; mnemonik repair',
    }
  );
  expect(text).toContain(`  ${heading}\n`);
  expect(text).toContain(
    '1. host digest_mismatch; scanner unavailable; no automatic fix; mnemonik repair'
  );
});

it('the real flagless router starts with Recommended before authorization', async () => {
  let text = '';
  let authorizations = 0;
  const code = await runCli(['install'], {
    cwd: '/code/acme-api',
    home: '/home/tester',
    input: Readable.from('Cancel\n'),
    stdout: {
      write: (chunk) => {
        text += chunk;
      },
    },
    preflight: {
      nodeVersion: '24.21.0',
      platform: 'linux',
      fetch: async () => Response.json({}),
      resolveIdentity: async () => ({
        kind: 'absent',
        root: '/code/acme-api',
        repository: { kind: 'plain', root: '/code/acme-api' },
        nested: [],
      }),
    },
    cliAuth: {
      getCliBearer: async () => {
        authorizations++;
        return 'cli';
      },
      signIn: async () => {},
      logout: async () => {},
    },
  });
  expect(code).toBe(130);
  expect(authorizations).toBe(0);
  expect(text).toContain('  > Recommended\n    Customize\n');
});

it('prints the failed discovery URL and network detail before stopping setup', async () => {
  let text = '';
  const output = {
    write: (chunk: string) => {
      text += chunk;
    },
  };
  const code = await runCli(['install'], {
    cwd: '/code/acme-api',
    home: '/home/tester',
    input: Readable.from('Recommended\n'),
    stdout: output,
    stderr: output,
    preflight: {
      nodeVersion: '24.21.0',
      discoveryUrl: 'https://staging.example/.well-known/oauth-protected-resource',
      fetch: async () => new Response('', { status: 503 }),
      resolveIdentity: async () => ({
        kind: 'absent',
        root: '/code/acme-api',
        repository: { kind: 'plain', root: '/code/acme-api' },
        nested: [],
      }),
    },
  });
  expect(code).toBe(3);
  expect(text).toContain('https://staging.example/.well-known/oauth-protected-resource');
  expect(text).toContain('HTTP 503');
});
it('rejects the unsupported install host before preflight', async () => {
  const host = 'vscode-copilot';
  let text = '';
  const resolveIdentity = vi.fn(async () => {
    throw new Error('preflight must not run');
  });
  const code = await runCli(
    [
      'install',
      `--hosts=${host}`,
      '--components=hooks,mcp',
      '--without-scanner',
      '--accept-limited',
      '--apply',
    ],
    {
      stdout: { write: (chunk) => (text += chunk) },
      stderr: { write: (chunk) => (text += chunk) },
      preflight: { resolveIdentity },
    }
  );
  expect(code).toBe(2);
  expect(resolveIdentity).not.toHaveBeenCalled();
  expect(text).toContain('claude-code, codex, cursor, grok');
  expect(text).toContain('vscode-copilot');
});
it('names the found and minimum Node versions before stopping setup', async () => {
  let text = '';
  const output = { write: (chunk: string) => (text += chunk) };
  const code = await runCli(
    [
      'install',
      '--hosts=codex',
      '--components=hooks,mcp',
      '--without-scanner',
      '--accept-limited',
      '--apply',
    ],
    {
      cwd: '/code/acme-api',
      home: '/home/tester',
      stdout: output,
      stderr: output,
      preflight: {
        nodeVersion: '23.1.0',
        fetch: async () => Response.json({}),
        resolveIdentity: async () => ({
          kind: 'absent',
          root: '/code/acme-api',
          repository: { kind: 'plain', root: '/code/acme-api' },
          nested: [],
        }),
      },
    }
  );
  expect(code).toBe(3);
  expect(text).toContain('Node 23.1.0 is installed. Mnemonik needs Node 24 or newer.');
  expect(text).toContain('Install Node 24:\nhttps://nodejs.org/en/download/package-manager\n');
  expect(text.trim()).not.toBe('preflight_failed');
});
it('doctor does not wait for indexing and bounds each Retry attempt', async () => {
  const ready = serializeReadiness({
    installation: { conditions: [] },
    projects: [{ summary: { conditions: [] }, indexing: { total: 240, completed: 38 } }],
  });
  const retry = async () => 'Skip' as const;
  expect(await waitForInstallation(async () => ready, retry)).toEqual({
    document: ready,
    skipped: false,
  });
  let time = 0;
  let attempts = 0;
  const pending = serializeReadiness({
    installation: { conditions: [{ kind: 'login_pending', reason: 'pending' }] },
  });
  const result = await waitForInstallation(
    async () => pending,
    async () => (++attempts === 1 ? 'Retry' : 'Skip'),
    {
      now: () => time,
      sleep: async (ms) => {
        time += ms;
      },
    }
  );
  expect(time).toBe(240000);
  expect(result.skipped).toBe(true);
});
it('accepts a READY document returned exactly at the deadline', async () => {
  let time = 0;
  const ready = serializeReadiness({ installation: { conditions: [] } });
  const timeout = vi.fn(async () => 'Skip' as const);
  const result = await waitForInstallation(
    async () => {
      time = 120000;
      return ready;
    },
    timeout,
    { now: () => time, sleep: async (ms) => void (time += ms) }
  );
  expect(result).toEqual({ document: ready, skipped: false });
  expect(timeout).not.toHaveBeenCalled();
});
it('keeps indexing detail out of the finished install transcript', () => {
  let text = '';
  screens.renderJourney(
    'done',
    new Output({
      write: (chunk) => {
        text += chunk;
      },
    }),
    { total: 6, completed: 3 }
  );
  expect(text).not.toContain('Indexing');
  expect(text).toContain(
    '  ✓ Installed.\n  Your editors will ask you to sign in to Mnemonik the first time you use it.\n'
  );
});
it('keeps unknown indexing detail out of the completion wording', () => {
  let text = '';
  screens.renderJourney(
    'done',
    new Output({
      write: (chunk) => {
        text += chunk;
      },
    }),
    { total: null, completed: null }
  );
  expect(text).not.toContain('Indexing');
  expect(text).not.toContain('Indexing 0');
});

it('prints an interrupted non-interactive install as plain text without --json', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'joined-human-interrupted-'));
  try {
    await withInstall(
      stateDir,
      {
        account: 'owner',
        components: ['scanner'],
        roots: ['/repo'],
        hosts: [],
        scopes: {},
        credentials: [],
        joined: true,
        hostRequest: { command: 'install', selections: [], allowMigration: false },
      },
      undefined,
      async () => undefined
    );
    let text = '';
    const output = { write: (chunk: string) => void (text += chunk) };
    expect(
      await runCli(
        ['install', '--non-interactive', '--accept-scanner', '--apply', '--scan-roots=/repo'],
        { installStateDir: stateDir, stdout: output, stderr: output }
      )
    ).toBe(3);
    expect(text).toBe(
      'Previous installation was interrupted. Run mnemonik install interactively to resume or roll back.\n'
    );
    expect(text).not.toContain('{');
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

it('resumes the remaining joined steps in the interrupted journal', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'joined-recovery-'));
  try {
    let runId = '';
    let resumed = false;
    await withInstall(
      stateDir,
      {
        account: 'owner',
        components: ['scanner'],
        roots: ['/repo'],
        hosts: [],
        scopes: {},
        credentials: [],
        joined: true,
        hostRequest: { command: 'install', selections: [], allowMigration: false },
      },
      undefined,
      async (journal) => {
        runId = journal.data.runId;
        journal.data.phase = 'applying';
        await journal.save();
      }
    );
    const result = await runHosts('install', [], {
      stateDir,
      account: 'owner',
      recovery: async () => 'resume',
      rollbackInstall: async () => {
        throw new Error('unexpected rollback');
      },
      afterHosts: async (journal) => {
        resumed = true;
        expect(journal.data.runId).toBe(runId);
        journal.data.state = 'READY';
      },
    });
    expect(resumed).toBe(true);
    expect(result.journal.phase).toBe('complete');
    expect(result.journal.runId).toBe(runId);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

it('interrupted joined files can be rolled back without account authorization', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'joined-offline-'));
  const identity = join(stateDir, '.mnemonik.json');
  try {
    await withInstall(
      stateDir,
      {
        account: 'owner',
        hosts: [],
        components: ['scanner'],
        roots: [stateDir],
        scopes: {},
        credentials: [],
        joined: true,
        hostRequest: { command: 'install', selections: [], allowMigration: false },
      },
      undefined,
      async (journal) => {
        await journal.commit(
          await journal.plan(identity, Buffer.from('{"projectId":"created"}'), { kind: 'project' })
        );
        journal.data.projects.push({ root: stateDir });
        journal.data.phase = 'applying';
        await journal.save();
      }
    );
    let authorized = false;
    const code = await runCli(['install'], {
      cwd: stateDir,
      home: stateDir,
      installStateDir: stateDir,
      input: Readable.from('Rollback\n'),
      stdout: { write() {} },
      stderr: { write() {} },
      preflight: {
        nodeVersion: '24.21.0',
        fetch: async () => Response.json({}),
        resolveIdentity: async () => ({
          kind: 'absent',
          root: stateDir,
          repository: { kind: 'plain', root: stateDir },
          nested: [],
        }),
      },
      cliAuth: {
        signIn: async () => {
          throw new Error('offline');
        },
        getCliBearer: async () => {
          authorized = true;
          throw new Error('offline');
        },
        logout: async () => {},
      },
    });
    expect(code).toBe(130);
    expect(authorized).toBe(false);
    expect(await bytesAt(identity)).toBeNull();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
