import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import {
  HOOK_TRACE_MAX_BYTES,
  HookTrace,
  appendHookTraceLine,
  hookTraceEnabled,
  hookTraceFile,
  summarizeHookOutput,
  type HookTraceRecord,
} from '../src/hookTrace.js';

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mnemonik-hook-trace-'));
  roots.push(root);
  return root;
}
async function lines(file: string): Promise<HookTraceRecord[]> {
  return (await readFile(file, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as HookTraceRecord);
}

const PROMPT = 'please refactor the billing module SECRET-PROMPT-BODY';
const TOOL_BODY = 'TOOL-INPUT-BODY rm -rf /tmp/thing';
const RESULT_BODY = 'TOOL-OUTPUT-BODY 42 lines';
const CONTEXT = 'MNEMONIK-CONTEXT-BODY recalled memory text';

test('one invocation writes start, input and end lines with names and sizes only', async () => {
  const state = await tempRoot();
  const file = hookTraceFile('cursor', state);
  const trace = new HookTrace('cursor', file, '0.7.0');
  trace.begin(
    {
      hook_event_name: 'postToolUse',
      session_id: 'session-1',
      conversation_id: 'conv-1',
      generation_id: 'gen-1',
      cursor_version: '1.7.2',
      tool_name: 'Shell',
      tool_input: { command: TOOL_BODY },
      tool_output: RESULT_BODY,
      prompt: PROMPT,
      transcript_path: '/home/u/.cursor/transcript.jsonl',
      workspace_roots: ['/work/app'],
    },
    'postToolUse'
  );
  trace.project('11111111-1111-4111-8111-111111111111');
  trace.output(JSON.stringify({ additional_context: CONTEXT, permission: 'allow' }));
  trace.finish(0);
  trace.finish(0); // once only

  const [start, input, end, ...extra] = await lines(file);
  assert.equal(extra.length, 0);
  assert.equal(start?.phase, 'start');
  assert.equal(input?.phase, 'input');
  assert.equal(end?.phase, 'end');
  if (start.phase !== 'start' || input.phase !== 'input' || end.phase !== 'end')
    throw new Error('phases');
  assert.equal(start.id, input.id);
  assert.equal(start.id, end.id);
  assert.equal(start.hookVersion, '0.7.0');
  assert.equal(typeof start.processMs, 'number');
  assert.equal(input.event, 'postToolUse');
  assert.equal(input.sessionId, 'session-1');
  assert.equal(input.conversationId, 'conv-1');
  assert.equal(input.generationId, 'gen-1');
  assert.equal(input.hostVersion, '1.7.2');
  assert.equal(input.tool, 'Shell');
  assert.equal(input.cwd, '/work/app');
  assert.equal(input.fields.prompt, Buffer.byteLength(PROMPT));
  assert.ok(input.fields.tool_input! > 0);
  assert.equal(end.projectId, '11111111-1111-4111-8111-111111111111');
  assert.equal(end.output?.permission, 'allow');
  assert.equal(end.output?.sizes.additional_context, Buffer.byteLength(CONTEXT));
  assert.equal(end.exitCode, 0);

  const raw = await readFile(file, 'utf8');
  for (const body of [PROMPT, TOOL_BODY, RESULT_BODY, CONTEXT, 'transcript.jsonl'])
    assert.ok(!raw.includes(body), `trace must not contain ${body}`);
  if (process.platform !== 'win32') {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(join(state, 'hook-trace'))).mode & 0o777, 0o700);
  }
});

test('an error is recorded as its name or code and a scrubbed message of at most 80 characters', async () => {
  const state = await tempRoot();
  const file = hookTraceFile('codex', state);
  const trace = new HookTrace('codex', file);
  trace.begin({ hook_event_name: 'Stop' });
  trace.fail(
    new TypeError(
      `request failed: Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789 ${'tail '.repeat(40)}`
    )
  );
  trace.finish(0);
  const end = (await lines(file)).at(-1);
  assert.equal(end?.phase, 'end');
  if (end?.phase !== 'end') throw new Error('phase');
  assert.equal(end.errorKind, 'TypeError');
  assert.match(end.error ?? '', /\[REDACTED\]/);
  assert.ok(!end.error?.includes('abcdefghijklmnopqrstuvwxyz0123456789'));
  assert.ok((end.error ?? '').length <= 80);

  const codedFile = hookTraceFile('codex', await tempRoot());
  const coded = new HookTrace('codex', codedFile);
  coded.fail(Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' }));
  coded.finish(0);
  const codedEnd = (await lines(codedFile)).at(-1);
  assert.equal(codedEnd?.phase === 'end' && codedEnd.errorKind, 'ECONNREFUSED');
  assert.equal(codedEnd?.phase === 'end' && codedEnd.error, 'connect refused');
});

test('an event name that fails the name check is not recorded', async () => {
  const state = await tempRoot();
  const file = hookTraceFile('cursor', state);
  const trace = new HookTrace('cursor', file);
  trace.begin({ hook_event_name: 'stop' }, 'before submit\nPROMPT-TEXT');
  trace.finish(0);
  const [, input, end] = await lines(file);
  assert.equal(input?.phase === 'input' && input.event, 'stop');
  assert.equal(end?.phase === 'end' && end.event, 'stop');
  assert.ok(!(await readFile(file, 'utf8')).includes('PROMPT-TEXT'));
});

test('a full file rotates to one .1 file', async () => {
  const state = await tempRoot();
  const file = hookTraceFile('claude-code', state);
  await mkdir(join(state, 'hook-trace'), { recursive: true, mode: 0o700 });
  await writeFile(file, `${'x'.repeat(HOOK_TRACE_MAX_BYTES - 10)}\n`, { mode: 0o600 });
  const trace = new HookTrace('claude-code', file);
  trace.begin({ hook_event_name: 'SessionStart' });
  trace.finish(0);
  const rotated = await readFile(`${file}.1`, 'utf8');
  assert.ok(rotated.startsWith('xxx'));
  const current = await lines(file);
  assert.deepEqual(
    current.map((record) => record.phase),
    ['start', 'input', 'end']
  );
  assert.ok((await stat(file)).size < 4096);
});

test('an unwritable state folder never throws into the hook', async () => {
  const root = await tempRoot();
  const notADirectory = join(root, 'state-file');
  await writeFile(notADirectory, 'occupied');
  const trace = new HookTrace('cursor', hookTraceFile('cursor', notADirectory));
  assert.doesNotThrow(() => {
    trace.open();
    trace.begin({ hook_event_name: 'stop' });
    trace.output('{"continue":true}');
    trace.fail(new Error('boom'));
    trace.call('http://x.invalid/api/v1/hooks/injections', performance.now(), 200);
    trace.finish(1);
  });
  assert.throws(() =>
    appendHookTraceLine(hookTraceFile('cursor', notADirectory), {
      v: 1,
      phase: 'start',
      ts: '',
      host: 'cursor',
      pid: 1,
      id: 'x',
      processMs: 0,
    })
  );
});

test('MNEMONIK_HOOK_TRACE=off disables the recorder; anything else leaves it on', () => {
  assert.equal(hookTraceEnabled({ MNEMONIK_HOOK_TRACE: 'off' }), false);
  assert.equal(hookTraceEnabled({ MNEMONIK_HOOK_TRACE: '0' }), false);
  assert.equal(hookTraceEnabled({}), true);
  assert.equal(hookTraceEnabled({ MNEMONIK_HOOK_TRACE: 'on' }), true);
});

test('the output summary keeps field sizes and decision enums, never text', () => {
  const summary = summarizeHookOutput(
    JSON.stringify({
      decision: 'block',
      reason: 'REASON-TEXT',
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'WHY-TEXT',
        additionalContext: CONTEXT,
      },
    })
  );
  assert.equal(summary.decision, 'block');
  assert.equal(summary.permission, 'deny');
  assert.equal(summary.sizes['hookSpecificOutput.additionalContext'], Buffer.byteLength(CONTEXT));
  assert.ok(!JSON.stringify(summary).includes('TEXT'));
  assert.deepEqual(summarizeHookOutput('plain text'), { bytes: 10, sizes: {} });
});

test('startHookTrace times each fetch and writes the end line on process exit', async () => {
  const state = await tempRoot();
  const server = createServer((request, response) => {
    response.statusCode = request.url?.includes('missing') ? 404 : 200;
    response.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const dist = new URL('../dist/hookTrace.js', import.meta.url).href;
  const script = `
    const { startHookTrace } = await import(${JSON.stringify(dist)});
    const trace = startHookTrace({ host: 'codex', hookVersion: '9.9.9' });
    trace.begin({ hook_event_name: 'UserPromptSubmit', prompt: 'PROMPT-BODY', session_id: 's' });
    await fetch('http://127.0.0.1:${port}/api/v1/hooks/injections?key=QUERY-SECRET');
    await fetch('http://127.0.0.1:${port}/api/v1/component-credentials/fam0123456789abcdef/missing');
    process.stdout.write('{"continue":true}');
    process.exit(0);`;
  const child = await new Promise<{ stdout: string }>((resolve, reject) => {
    execFile(
      process.execPath,
      ['--input-type=module', '-e', script],
      { env: { ...process.env, MNEMONIK_STATE_DIR: state, MNEMONIK_HOOK_TRACE: '' } },
      (error, stdout) => (error ? reject(error) : resolve({ stdout }))
    );
  }).finally(() => server.close());
  assert.equal(child.stdout, '{"continue":true}');
  const [start, input, end] = await lines(hookTraceFile('codex', state));
  assert.equal(start?.phase, 'start');
  assert.equal(input?.phase, 'input');
  assert.equal(end?.phase, 'end');
  if (end?.phase !== 'end') throw new Error('phase');
  assert.deepEqual(
    end.calls.map(({ path, status }) => ({ path, status })),
    [
      { path: '/api/v1/hooks/injections', status: 200 },
      { path: '/api/v1/component-credentials/:id/missing', status: 404 },
    ]
  );
  const raw = await readFile(hookTraceFile('codex', state), 'utf8');
  assert.ok(!raw.includes('QUERY-SECRET'));
  assert.ok(!raw.includes('PROMPT-BODY'));
  assert.ok(!raw.includes('fam0123456789abcdef'));
});

test('a call still waiting at exit is recorded as pending', async () => {
  const state = await tempRoot();
  const server = createServer(() => {
    /* Never answers. */
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const dist = new URL('../dist/hookTrace.js', import.meta.url).href;
  const script = `
    const { startHookTrace } = await import(${JSON.stringify(dist)});
    const trace = startHookTrace({ host: 'cursor' });
    trace.begin({ hook_event_name: 'stop' });
    fetch('http://127.0.0.1:${port}/api/v1/hooks/injections').catch(() => {});
    setTimeout(() => process.exit(0), 200);`;
  await new Promise<void>((resolve, reject) => {
    execFile(
      process.execPath,
      ['--input-type=module', '-e', script],
      { env: { ...process.env, MNEMONIK_STATE_DIR: state, MNEMONIK_HOOK_TRACE: '' } },
      (error) => (error ? reject(error) : resolve())
    );
  }).finally(() => {
    server.closeAllConnections();
    server.close();
  });
  const end = (await lines(hookTraceFile('cursor', state))).at(-1);
  assert.equal(end?.phase, 'end');
  if (end?.phase !== 'end') throw new Error('phase');
  assert.equal(end.calls.length, 1);
  assert.equal(end.calls[0]?.path, '/api/v1/hooks/injections');
  assert.equal(end.calls[0]?.pending, true);
  assert.equal(end.calls[0]?.status, undefined);
});

test('a run killed before its event arrives leaves the start line alone', async () => {
  const dist = fileURLToPath(new URL('../dist/hookTrace.js', import.meta.url));
  const href = JSON.stringify(new URL(`file://${dist}`).href);
  const run = async (body: string) => {
    const state = await tempRoot();
    spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { startHookTrace } = await import(${href});
         const trace = startHookTrace({ host: 'cursor' });
         ${body}
         process.kill(process.pid, 'SIGKILL');`,
      ],
      { env: { ...process.env, MNEMONIK_STATE_DIR: state, MNEMONIK_HOOK_TRACE: '' } }
    );
    return (await lines(hookTraceFile('cursor', state))).map((record) => record.phase);
  };
  assert.deepEqual(await run(''), ['start']);
  assert.deepEqual(await run(`trace.begin({ hook_event_name: 'beforeSubmitPrompt' });`), [
    'start',
    'input',
  ]);
});

test('writers crossing the size limit together rotate once and keep the full file', async () => {
  const state = await tempRoot();
  const file = hookTraceFile('cursor', state);
  await mkdir(join(state, 'hook-trace'), { recursive: true, mode: 0o700 });
  await writeFile(`${file}.1`, 'OLDER-HISTORY\n', { mode: 0o600 });
  await writeFile(file, `${'#'.repeat(HOOK_TRACE_MAX_BYTES - 50)}\n`, { mode: 0o600 });
  const dist = new URL('../dist/hookTrace.js', import.meta.url).href;
  const writers = 12;
  const each = 40;
  const startAt = Date.now() + 1000;
  const script = `
    const { appendHookTraceLine } = await import(${JSON.stringify(dist)});
    while (Date.now() < ${startAt}) {}
    for (let i = 0; i < ${each}; i++)
      appendHookTraceLine(${JSON.stringify(file)}, {
        v: 1, phase: 'start', ts: new Date().toISOString(), host: 'cursor',
        pid: process.pid, id: process.pid + '-' + i, processMs: 0,
      });`;
  await Promise.all(
    Array.from(
      { length: writers },
      () =>
        new Promise<void>((resolve, reject) =>
          execFile(process.execPath, ['--input-type=module', '-e', script], (error) =>
            error ? reject(error) : resolve()
          )
        )
    )
  );
  const rotated = await readFile(`${file}.1`, 'utf8');
  const current = await readFile(file, 'utf8');
  assert.ok(rotated.startsWith('####'), 'the full file survives as .1');
  const ids = new Set<string>();
  for (const line of `${rotated}${current}`.split('\n'))
    if (line.startsWith('{')) ids.add((JSON.parse(line) as HookTraceRecord).id);
  assert.equal(ids.size, writers * each, 'no line is lost');
});
