import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bytesAt, withInstall } from '../../src/install/journal.js';
import { runHosts } from '../../src/install/hosts.js';
import { Readable } from 'node:stream';
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
  'host_approvals',
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
      skipped: 'Cursor was skipped. Connect it later: mnemonik connect cursor',
      remaining: 1,
      reason: 'Access is denied.',
    }
  );
  expect(text).toBe(await readFile(new URL(`./${screen}.golden.txt`, import.meta.url), 'utf8'));
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
    'host digest_mismatch; scanner unavailable; no automatic fix; mnemonik repair'
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
      pathExists: async () => false,
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
      pathExists: async () => false,
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
it.each(['grok', 'vscode-copilot'])(
  'rejects the non-launch host %s before preflight',
  async (host) => {
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
        '--integration-scope=user',
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
    expect(text).toContain('grok, vscode-copilot');
  }
);
it('names the found and minimum Node versions before stopping setup', async () => {
  let text = '';
  const output = { write: (chunk: string) => (text += chunk) };
  const code = await runCli(
    [
      'install',
      '--hosts=codex',
      '--components=hooks,mcp',
      '--without-scanner',
      '--integration-scope=user',
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
        pathExists: async () => false,
        binaryExists: async () => false,
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
  expect(text).toContain('Node 23.1.0 found; Node 24 or newer is required.');
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
it('renders the indexing counts from a receipt that carries them', () => {
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
  expect(text).toContain('Indexing 6 files, 3 done.');
});
it('unknown indexing counts are kept unknown in the completion wording', () => {
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
  expect(text).toContain('Indexing in progress.');
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
        pathExists: async () => false,
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
