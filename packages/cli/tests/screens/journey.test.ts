import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

it.each(['account', 'scanner', 'apply', 'done', 'skipped', 'windows'])(
  'joined %s screen matches its transcript',
  async (screen) => {
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
        total: 240,
        completed: 38,
        skipped: 'Background indexing was skipped.',
        remaining: 1,
        reason: 'Access is denied.',
        hosts: ['claude-code', 'codex', 'cursor'],
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
  }
);

it('states the controls on every choice screen', () => {
  let text = '';
  screens.renderSetup(
    [{ value: 'scanner', label: 'Automatic project indexing', checked: true }],
    new Output({ write: (chunk) => void (text += chunk) })
  );
  expect(text).toContain('Use the Up/Down arrow keys to move, Space to select, Enter to continue.');

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
  const changed = answers.choose(['First', 'Second']);
  input.write('\u001b[B\r');
  await expect(changed).resolves.toBe('Second');

  const accepted = answers.choose(['First', 'Second']);
  input.write('\r');
  await expect(accepted).resolves.toBe('First');
  expect(input.setRawMode).toHaveBeenCalledWith(true);
  answers.close();
});

it('discards keys pressed while no question is on screen', async () => {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: vi.fn(),
  });
  const answers = screens.journeyAnswers(input);
  const first = answers.choose(['First', 'Second']);
  input.write('\r');
  await expect(first).resolves.toBe('First');

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

it('renders fresh step 1 exactly for three editors and applies keyboard changes', async () => {
  let text = '';
  const output = new Output({ write: (chunk) => void (text += chunk) });
  screens.renderSetup(
    [
      { value: 'claude-code', label: 'Claude Code', checked: true },
      { value: 'codex', label: 'Codex', checked: true },
      { value: 'cursor', label: 'Cursor', checked: true },
      { value: 'scanner', label: 'Automatic project indexing', checked: true },
    ],
    output
  );
  expect(text).toBe(
    'Step 1 of 5: Choose what to set up\n' +
      '  These editors were found on this computer. Untick any you do not want.\n' +
      '  Use the Up/Down arrow keys to move, Space to select, Enter to continue.\n\n' +
      '  > [x] Claude Code\n' +
      '    [x] Codex\n' +
      '    [x] Cursor\n' +
      '    [x] Automatic project indexing\n\n' +
      '  Learn more about indexing:\n' +
      '  https://mnemonik.ai/indexing\n'
  );
  expect(text).toContain('[x] Claude Code');
  expect(text).not.toContain('Scope');

  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
  const answers = screens.journeyAnswers(input, output);
  const result = answers.checklist([
    { value: 'claude-code', label: 'Claude Code', checked: true },
    { value: 'codex', label: 'Codex', checked: true },
    { value: 'scanner', label: 'Automatic project indexing', checked: true },
  ]);
  input.write(' \u001b[B\r');
  await expect(result).resolves.toEqual({ selected: ['codex', 'scanner'] });
  answers.close();
});

it('never renders the removed setup-choice words', () => {
  let text = '';
  const output = new Output({ write: (chunk) => void (text += chunk) });
  screens.renderSetup(
    [
      { value: 'claude-code', label: 'Claude Code', checked: true },
      { value: 'scanner', label: 'Automatic project indexing', checked: true },
    ],
    output
  );
  for (const screen of ['account', 'scanner', 'apply', 'done', 'skipped', 'windows'])
    screens.renderJourney(screen, output);
  expect(text).not.toMatch(/Recommended|Customize/u);
});

it('keeps the existing zero-editor and skipped-indexing wording when everything is unticked', async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
  let text = '';
  const output = new Output({ write: (chunk) => void (text += chunk) });
  const answers = screens.journeyAnswers(input, output);
  const selected = answers.checklist([
    { value: 'codex', label: 'Codex', checked: true },
    { value: 'scanner', label: 'Automatic project indexing', checked: true },
  ]);
  input.write(' \u001b[B \r');
  await expect(selected).resolves.toEqual({ selected: [] });
  output.line('  ✓ 0 editors configured');
  screens.renderJourney('indexing_skipped', output);
  expect(text).toContain('  ✓ 0 editors configured\n');
  expect(text).toContain('Indexing was skipped. Run mnemonik install to set it up later.\n');
  answers.close();
});

it('reports closed input as a cancellation', async () => {
  let text = '';
  const answers = screens.journeyAnswers(
    Readable.from([]),
    new Output({ write: (chunk) => void (text += chunk) })
  );
  await expect(answers.choose(['First', 'Second'])).resolves.toBe('Cancel');
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

it('the real flagless router shows the approved checklist before authorization', async () => {
  let text = '';
  let authorizations = 0;
  const code = await runCli(['install'], {
    cwd: '/code/acme-api',
    home: '/home/tester',
    input: Object.assign(Readable.from('Cancel\n'), { isTTY: true }),
    stdout: {
      write: (chunk) => {
        text += chunk;
      },
    },
    preflight: {
      nodeVersion: '24.21.0',
      platform: 'linux',
      pathExists: async (path) => /\.(?:claude|codex|cursor)(?:\/|$)/u.test(path),
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
  expect(text).toContain('Step 1 of 5: Choose what to set up\n');
  expect(text).toContain('  > [x] Claude Code\n    [x] Codex\n    [x] Cursor\n');
  expect(text).toContain('    [x] Automatic project indexing\n');
  expect(text).not.toMatch(/Recommended|Customize/u);
});

it('a piped install stops at the first missing flag without printing key instructions', async () => {
  let text = '';
  let authorizations = 0;
  const code = await runCli(['install'], {
    input: Readable.from('\n'),
    stdout: { write: (chunk) => void (text += chunk) },
    stderr: { write: (chunk) => void (text += chunk) },
    cliAuth: {
      getCliBearer: async () => {
        authorizations++;
        return 'cli';
      },
      signIn: async () => {},
      logout: async () => {},
    },
  });

  expect(code).toBe(3);
  expect(text).toBe('Missing required consent flag: --accept-indexing\n');
  expect(text).not.toMatch(/arrow keys|Recommended|Customize/iu);
  expect(authorizations).toBe(0);
});

it('a second run after skipping indexing offers only indexing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'joined-indexing-only-'));
  try {
    await writeFile(join(home, 'indexing-skipped'), 'indexing was skipped\n');
    await writeFile(
      join(home, 'host-ownership.json'),
      JSON.stringify({
        schemaVersion: 1,
        generation: 0,
        targets: [
          {
            id: 'codex:hooks:user',
            host: 'codex',
            component: 'hooks',
            scope: 'user',
            home,
            profilePath: join(home, '.codex', 'hooks.json'),
            version: '1.0.0',
            artifactDigest: 'fixture',
            runtimePointer: join(home, 'runtimes', 'codex', 'current'),
            files: [],
          },
        ],
      })
    );
    let text = '';
    const code = await runCli(['install'], {
      cwd: home,
      home,
      installStateDir: home,
      input: Object.assign(Readable.from('Cancel\n'), { isTTY: true }),
      stdout: { write: (chunk) => void (text += chunk) },
      preflight: {
        nodeVersion: '24.21.0',
        fetch: async () => Response.json({}),
        resolveIdentity: async () => ({
          kind: 'absent',
          root: home,
          repository: { kind: 'plain', root: home },
          nested: [],
        }),
      },
    });

    expect(code).toBe(130);
    expect(text).toContain('Indexing was skipped.\n');
    expect(text).toContain('  > Set up indexing\n    Cancel\n');
    expect(text).not.toMatch(/Recommended|Customize|Configure editors/iu);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it('names skipped indexing and the command that sets it up later', () => {
  let text = '';
  screens.renderJourney('indexing_skipped', new Output({ write: (chunk) => void (text += chunk) }));
  expect(text).toContain('Indexing was skipped. Run mnemonik install to set it up later.\n');
  expect(text).not.toContain('one thing left');
});

it('prints the failed discovery URL and network detail before stopping setup', async () => {
  let text = '';
  const output = {
    write: (chunk: string) => {
      text += chunk;
    },
  };
  const code = await runCli(['install', '--components=scanner', '--accept-indexing', '--apply'], {
    cwd: '/code/acme-api',
    home: '/home/tester',
    input: Object.assign(Readable.from('\n'), { isTTY: true }),
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
  expect(text).toContain('claude-code, codex, cursor');
  expect(text).not.toContain('grok');
  expect(text).not.toContain('vscode-copilot');
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
    { total: 6, completed: 3, hosts: ['claude-code'] }
  );
  expect(text).not.toContain('Indexing');
  expect(text).toContain('  One step is left in each editor');
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

it('shows the exact authorization block for all three editors', () => {
  let text = '';
  screens.renderJourney('done', new Output({ write: (chunk) => void (text += chunk) }), {
    hosts: ['claude-code', 'codex', 'cursor'],
  });
  expect(text).toBe(`  One step is left in each editor: Authorize the Mnemonik MCP connection.
  You may need to restart your editor after authorizing.

  Claude Code      type /mcp, choose mnemonik, then Authenticate
  Codex CLI        run codex mcp login mnemonik
  Codex Desktop    open Settings, Plugins, MCPs, then Authenticate
  Cursor Desktop   open Cursor Settings, Customize, MCPs, then Authenticate

`);
});

it('shows only the Claude Code authorization row when only Claude Code was set up', () => {
  let text = '';
  screens.renderJourney('done', new Output({ write: (chunk) => void (text += chunk) }), {
    hosts: ['claude-code'],
  });
  expect(text).toBe(`  One step is left in each editor: Authorize the Mnemonik MCP connection.
  You may need to restart your editor after authorizing.

  Claude Code      type /mcp, choose mnemonik, then Authenticate

`);
});

it('omits editor authorization when no editors were selected', () => {
  let text = '';
  screens.renderJourney('done', new Output({ write: (chunk) => void (text += chunk) }), {
    hosts: [],
  });
  expect(text).toBe('');
});

it('puts scanner failure before the editor authorization block', () => {
  let text = '';
  screens.renderJourney('scanner_failed', new Output({ write: (chunk) => void (text += chunk) }), {
    hosts: ['claude-code'],
  });
  expect(text).toBe(`  Background indexing could not be started.
  Run mnemonik install to try again.

  One step is left in each editor: Authorize the Mnemonik MCP connection.
  You may need to restart your editor after authorizing.

  Claude Code      type /mcp, choose mnemonik, then Authenticate

`);
});

it('removes an interrupted install in a non-interactive run and says so in one line', async () => {
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
    await runCli(
      ['install', '--non-interactive', '--accept-scanner', '--apply', '--scan-roots=/repo'],
      { installStateDir: stateDir, stdout: output, stderr: output }
    );
    expect(text).toContain('An earlier installation did not finish and was removed.');
    expect(text).not.toContain('Run mnemonik install interactively');
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
    let text = '';
    const code = await runCli(['install'], {
      cwd: stateDir,
      home: stateDir,
      installStateDir: stateDir,
      input: Object.assign(Readable.from('Rollback\n'), { isTTY: true }),
      stdout: { write: (chunk) => void (text += chunk) },
      stderr: { write: (chunk) => void (text += chunk) },
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
    expect(text).toContain('Resume keeps your choices and continues the installation.\n');
    expect(text).toContain('Rollback removes changes from the unfinished installation.\n');
    expect(text).toContain('The unfinished installation was removed.\n');
    expect(text).not.toContain('rolled_back');
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
