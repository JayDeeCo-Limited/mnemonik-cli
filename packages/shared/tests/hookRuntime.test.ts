import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { bindHookContext } from '../src/hookRuntime.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function postedRootKind(prepare: (cwd: string) => Promise<void> | void) {
  const root = await mkdtemp(join(tmpdir(), 'mnemonik-hook-runtime-'));
  roots.push(root);
  const cwd = join(root, 'project');
  await mkdir(cwd);
  await prepare(cwd);
  const bodies: Array<Record<string, unknown>> = [];
  await bindHookContext(
    {
      host: 'claude_code',
      hostSessionId: 'session-1',
      cwd,
      server: 'http://server.invalid',
      stateFile: join(root, 'state', 'session', 'bound-context.json'),
    },
    'family',
    async () => ({ version: 1, hmac: 'abc' }),
    async (body) => {
      bodies.push(body as Record<string, unknown>);
      return 200;
    },
    { platform: 'linux' }
  );
  assert.equal(bodies.length, 1);
  return bodies[0]?.rootKind;
}

test('a plain folder with a valid .mnemonik.json posts selected_non_git', async () => {
  const rootKind = await postedRootKind((cwd) =>
    writeFile(join(cwd, '.mnemonik.json'), JSON.stringify({ schemaVersion: 1, projectId }))
  );
  assert.equal(rootKind, 'selected_non_git');
});

test('a plain folder with no identity file posts ineligible', async () => {
  assert.equal(await postedRootKind(() => undefined), 'ineligible');
});

test('a Git root posts git', async () => {
  const rootKind = await postedRootKind((cwd) => {
    execFileSync('git', ['init', '-q', cwd]);
  });
  assert.equal(rootKind, 'git');
});
