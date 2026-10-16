import { afterEach, describe, expect, it } from 'vitest';
import { getEventListeners } from 'node:events';
import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/router.js';
import { hookActivityLines, hooksLog } from '../src/hooksLog.js';

const NOW = Date.parse('2026-10-17T01:00:00.000Z');
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function stateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cli-hooks-log-'));
  dirs.push(dir);
  await mkdir(join(dir, 'hook-trace'), { recursive: true, mode: 0o700 });
  return dir;
}

const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

function opened(host: string, id: string, minutesAgo: number) {
  return { v: 1, phase: 'start', ts: at(minutesAgo), host, pid: 4242, id, processMs: 40 };
}

/** The `start` line and the `input` line a run writes once its event arrives. */
function start(host: string, id: string, event: string, minutesAgo: number, extra = {}) {
  return [
    opened(host, id, minutesAgo),
    {
      v: 1,
      phase: 'input',
      ts: at(minutesAgo),
      host,
      pid: 4242,
      id,
      event,
      sessionId: 'session-abc',
      cwd: '/work/app',
      inputBytes: 300,
      fields: { prompt: 120 },
      readMs: 3,
      ...extra,
    },
  ];
}

function end(host: string, id: string, event: string, minutesAgo: number, extra = {}) {
  return {
    v: 1,
    phase: 'end',
    ts: at(minutesAgo),
    host,
    pid: 4242,
    id,
    event,
    output: null,
    calls: [],
    durationMs: 140,
    processMs: 260,
    exitCode: 0,
    ...extra,
  };
}

async function write(state: string, host: string, ...records: Array<object | object[]>) {
  await appendFile(
    join(state, 'hook-trace', `${host}.jsonl`),
    records
      .flat()
      .map((record) => `${JSON.stringify(record)}\n`)
      .join('')
  );
}

async function fixture(): Promise<string> {
  const state = await stateDir();
  await write(
    state,
    'cursor',
    start('cursor', 'c1', 'beforeSubmitPrompt', 3),
    end('cursor', 'c1', 'beforeSubmitPrompt', 3, {
      output: { bytes: 1300, sizes: { additional_context: 1250 }, continue: true },
      calls: [
        { path: '/api/v1/hooks/jit', status: 200, ms: 35 },
        { path: '/api/v1/hooks/ambient-recall', error: 'timeout', ms: 2001 },
      ],
    }),
    start('cursor', 'c2', 'beforeSubmitPrompt', 2)
  );
  await write(
    state,
    'claude-code',
    start('claude-code', 'k1', 'PreToolUse', 5, { tool: 'Bash' }),
    end('claude-code', 'k1', 'PreToolUse', 5, {
      output: {
        bytes: 500,
        sizes: { 'hookSpecificOutput.permissionDecision': 4 },
        permission: 'deny',
      },
    })
  );
  await write(
    state,
    'codex',
    start('codex', 'x1', 'Stop', 10),
    end('codex', 'x1', 'Stop', 10, { errorKind: 'TypeError', error: 'dispatcher error [REDACTED]' })
  );
  return state;
}

function capture() {
  let stdout = '';
  let stderr = '';
  return {
    stdout: { write: (chunk: string) => void (stdout += chunk) },
    stderr: { write: (chunk: string) => void (stderr += chunk) },
    get out() {
      return stdout;
    },
    get err() {
      return stderr;
    },
  };
}

describe('mnemonik hooks log', () => {
  it('prints one plain line per run, oldest first, with unfinished runs marked', async () => {
    const state = await fixture();
    const io = capture();
    const code = await runCli(['hooks', 'log'], {
      installStateDir: state,
      stdout: io.stdout,
      stderr: io.stderr,
      hooksLog: { alive: () => false },
    });
    expect(code).toBe(0);
    const lines = io.out.trim().split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(
      /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d {2}Codex {2}Stop {2}failed open \(TypeError: dispatcher error \[REDACTED\]\) {2}140 ms {2}no server calls$/
    );
    expect(lines[1]).toMatch(
      / {2}Claude Code {2}PreToolUse \(Bash\) {2}deny {2}140 ms {2}no server calls$/
    );
    expect(lines[2]).toMatch(
      / {2}Cursor {2}beforeSubmitPrompt {2}allow, context 1\.2 KB {2}140 ms {2}server: jit 200 35 ms, ambient-recall timeout 2001 ms$/
    );
    expect(lines[3]).toMatch(
      / {2}Cursor {2}beforeSubmitPrompt {2}UNFINISHED: started but never finished \(the coding tool may have stopped it\)$/
    );
  });

  it('shows a run under a minute old whose process is alive as running', async () => {
    const state = await fixture();
    await write(state, 'cursor', start('cursor', 'c4', 'stop', 0.5));
    const io = capture();
    await runCli(['hooks', 'log', '--host', 'cursor', '--last', '1'], {
      installStateDir: state,
      stdout: io.stdout,
      hooksLog: { alive: () => true, now: () => NOW },
    });
    expect(io.out.trim().split('\n')).toHaveLength(1);
    expect(io.out).toMatch(/Cursor {2}stop {2}still running\n$/);
  });

  it('treats a run with no end older than a minute as unfinished even when its pid is alive', async () => {
    const state = await fixture();
    const io = capture();
    await runCli(['hooks', 'log', '--host', 'cursor', '--last', '1'], {
      installStateDir: state,
      stdout: io.stdout,
      hooksLog: { alive: () => true, now: () => NOW },
    });
    expect(io.out).toMatch(
      /Cursor {2}beforeSubmitPrompt {2}UNFINISHED: started but never finished/
    );
  });

  it('reads a run that left only its first line as stopped before the event arrived', async () => {
    const state = await stateDir();
    await write(state, 'cursor', opened('cursor', 'early', 2));
    const io = capture();
    await runCli(['hooks', 'log', '--json'], {
      installStateDir: state,
      stdout: io.stdout,
      hooksLog: { alive: () => false, now: () => NOW },
    });
    expect(JSON.parse(io.out).invocations).toMatchObject([
      { host: 'cursor', id: 'early', state: 'unfinished', event: null },
    ]);
    const human = capture();
    await runCli(['hooks', 'log'], {
      installStateDir: state,
      stdout: human.stdout,
      hooksLog: { alive: () => false, now: () => NOW },
    });
    expect(human.out).toMatch(
      /Cursor {2}unknown event {2}UNFINISHED: stopped before the coding tool finished sending the event\n$/
    );
  });

  it('reads VS Code Copilot runs and accepts --host copilot', async () => {
    const state = await fixture();
    await write(
      state,
      'copilot',
      start('copilot', 'v1', 'PreToolUse', 1),
      end('copilot', 'v1', 'PreToolUse', 1, {
        calls: [{ path: '/api/v1/hooks/injections', pending: true, ms: 4900 }],
      })
    );
    const io = capture();
    expect(
      await runCli(['hooks', 'log', '--host', 'copilot'], {
        installStateDir: state,
        stdout: io.stdout,
        hooksLog: { alive: () => false, now: () => NOW },
      })
    ).toBe(0);
    expect(io.out).toMatch(
      /VS Code Copilot {2}PreToolUse {2}allowed, no output {2}140 ms {2}server: injections no answer by exit 4900 ms\n$/
    );
    const all = capture();
    await runCli(['hooks', 'log'], { installStateDir: state, stdout: all.stdout });
    expect(all.out).toContain('VS Code Copilot');
  });

  it('prints the full records with --json', async () => {
    const state = await fixture();
    const io = capture();
    await runCli(['hooks', 'log', '--json', '--host', 'claude-code'], {
      installStateDir: state,
      stdout: io.stdout,
      hooksLog: { alive: () => false },
    });
    const document = JSON.parse(io.out) as {
      invocations: Array<{ host: string; state: string; start: object; end: object }>;
    };
    expect(document.invocations).toHaveLength(1);
    expect(document.invocations[0]).toMatchObject({
      host: 'claude-code',
      state: 'finished',
      start: { phase: 'start', processMs: 40 },
      input: { tool: 'Bash', sessionId: 'session-abc' },
      end: { output: { permission: 'deny' } },
    });
  });

  it('follows the trace and prints each run as it ends', async () => {
    const state = await fixture();
    const io = capture();
    const stop = new AbortController();
    const running = runCli(['hooks', 'log', '--follow', '--last', '1', '--host', 'codex'], {
      installStateDir: state,
      stdout: io.stdout,
      hooksLog: { alive: () => true, signal: stop.signal, pollMs: 10 },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await write(state, 'codex', start('codex', 'x2', 'PreToolUse', 0));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(io.out.trim().split('\n')).toHaveLength(1);
    await write(state, 'codex', end('codex', 'x2', 'PreToolUse', 0));
    const deadline = Date.now() + 2_000;
    while (io.out.trim().split('\n').length < 2 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    stop.abort();
    expect(await running).toBe(0);
    const lines = io.out.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/Codex {2}PreToolUse {2}allowed, no output {2}140 ms/);
  });

  it('leaves no abort listener behind however long it follows', async () => {
    const state = await fixture();
    const stop = new AbortController();
    const following = hooksLog({
      stateDir: state,
      hosts: ['codex'],
      last: 1,
      print: () => undefined,
      follow: { signal: stop.signal, pollMs: 2 },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(getEventListeners(stop.signal, 'abort').length).toBeLessThanOrEqual(1);
    stop.abort();
    await following;
    expect(getEventListeners(stop.signal, 'abort')).toHaveLength(0);
  });

  it("says none were found in this machine's state folder, and when recording is off", async () => {
    const state = await stateDir();
    const before = process.env.MNEMONIK_HOOK_TRACE;
    try {
      delete process.env.MNEMONIK_HOOK_TRACE;
      const io = capture();
      expect(await runCli(['hooks', 'log'], { installStateDir: state, stdout: io.stdout })).toBe(0);
      expect(io.out).toBe("No hook runs were found in this machine's Mnemonik state folder.\n");
      process.env.MNEMONIK_HOOK_TRACE = 'off';
      const off = capture();
      await runCli(['hooks', 'log'], { installStateDir: state, stdout: off.stdout });
      expect(off.out).toContain('MNEMONIK_HOOK_TRACE=off is set here');
    } finally {
      if (before === undefined) delete process.env.MNEMONIK_HOOK_TRACE;
      else process.env.MNEMONIK_HOOK_TRACE = before;
    }
  });

  it.each([
    [['hooks'], 'missing_subcommand'],
    [['hooks', 'log', '--host', 'grok'], 'invalid_value'],
    [['hooks', 'log', '--last', '0'], 'invalid_value'],
    [['hooks', 'log', 'extra'], 'invalid_value'],
    [['hooks', 'log', '--confirm'], 'invalid_flag'],
  ])('rejects %j as wrong usage', async (args, reason) => {
    const state = await stateDir();
    const io = capture();
    expect(
      await runCli([...args, '--json'], {
        installStateDir: state,
        stdout: io.stdout,
        stderr: io.stderr,
      })
    ).toBe(2);
    expect(JSON.parse(io.out)).toMatchObject({ status: 'usage_error', reason });
  });
});

describe('doctor hook activity', () => {
  it('says when each coding tool last ran its hooks, with no event names, ids or paths', async () => {
    const state = await fixture();
    expect(await hookActivityLines(state, NOW, () => false)).toEqual([
      'Claude Code hooks last ran 5 minutes ago.',
      'Codex hooks last ran 10 minutes ago.',
      'Cursor hooks last ran 2 minutes ago but were stopped before they finished. Run mnemonik hooks log --host cursor for detail.',
    ]);
  });

  it('prints those lines in doctor', async () => {
    const state = await fixture();
    await write(
      state,
      'cursor',
      start('cursor', 'c3', 'afterFileEdit', 1),
      end('cursor', 'c3', 'afterFileEdit', 1)
    );
    const io = capture();
    await runCli(['doctor'], {
      home: state,
      installStateDir: state,
      preflight: {
        nodeVersion: '24.21.0',
        pathExists: async () => false,
        fetch: async () => Response.json({}),
        resolveIdentity: async () => ({ kind: 'git_unavailable' as const, detail: 'fixture' }),
      },
      scannerStatus: async () => ({ roots: [], exclusions: [], repositories: [] }),
      stdout: io.stdout,
      stderr: io.stderr,
      hooksLog: { now: () => NOW, alive: () => false },
    });
    expect(io.out).toContain('Cursor hooks last ran 1 minute ago.\n');
    expect(io.out).toContain('Codex hooks last ran 10 minutes ago.\n');
    for (const hidden of [
      'session-abc',
      '/work/app',
      'c3',
      'hook-trace',
      'afterFileEdit',
      'Stop',
    ]) {
      const activity = io.out.split('\n').filter((line) => line.includes('hooks last ran'));
      expect(activity.join('\n')).not.toContain(hidden);
    }
  });
});
