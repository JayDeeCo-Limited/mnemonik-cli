import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createCliCredentials } from '../src/auth/credentials.js';
import { runCli } from '../src/router.js';

// `mnemonik project ensure` reads the sign-in `mnemonik status` reads: the CLI
// credential store. Each failure to reach the account is named for what it is,
// and only a missing sign-in says "not signed in".

const dirs: string[] = [];
afterEach(async () =>
  Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
);
const capture = () => ({
  text: '',
  write(chunk: string) {
    this.text += chunk;
  },
});

type Answer = (path: string, method: string) => Response | Promise<Response>;

async function fixture(options: { signedIn: boolean; answer: Answer; input?: Readable }) {
  const base = await mkdtemp(join(tmpdir(), 'ensure-sign-in-'));
  dirs.push(base);
  const stateDir = join(base, 'state');
  const root = join(base, 'repo');
  await mkdir(root, { recursive: true });
  if (options.signedIn)
    await createCliCredentials({ stateDir }).putCliOAuth(
      {
        issuer: 'https://api.mnemonik.dev',
        clientId: 'mnemonik-cli',
        familyId: 'cli',
        scopes: ['projects:create'],
        lastRotationTime: new Date().toISOString(),
      },
      {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        accessExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }
    );
  const requests: { method: string; path: string }[] = [];
  const grantFetch = (async (url: string | URL, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    const path = new URL(String(url)).pathname;
    requests.push({ method, path });
    return options.answer(path, method);
  }) as typeof fetch;
  const stdout = capture();
  const stderr = capture();
  const run = (args: string[]) =>
    runCli(args, {
      cwd: root,
      home: base,
      installStateDir: stateDir,
      grantFetch,
      input: options.input ?? Readable.from([]),
      stdout,
      stderr,
    });
  return { run, stdout, stderr, requests, root };
}

const projectId = randomUUID();
const server: Answer = (path) => {
  if (path === '/api/v1/project-setup/default-owner')
    return Response.json({ owner: 'personal', userId: 'user', deviceInstallationId: 'device' });
  if (path === '/api/v1/project-setup/issue')
    return Response.json({
      status: 'project_setup_required',
      state: 'missing',
      allowedActions: ['create'],
      requestId: randomUUID(),
    });
  if (path === '/api/v1/project-setup/consume')
    return Response.json({ status: 'complete', projectId, displayName: 'repo' });
  return new Response('{}', { status: 404 });
};

describe('project ensure reads the sign-in status reads', () => {
  it.each([[['--json']], [['--agent', '--json']]])(
    'connects the folder with a valid sign-in and nothing on stdin (%j)',
    async (flags) => {
      const f = await fixture({ signedIn: true, answer: server });
      expect(await f.run(['project', 'ensure', ...flags])).toBe(0);
      expect(JSON.parse(f.stdout.text)).toMatchObject({ status: 'done', projectId });
      expect(f.stdout.text).not.toContain('not_signed_in');
    }
  );

  it('does not wait on a stdin nobody writes to without --agent', async () => {
    // An agent's shell can leave stdin open and silent; only the hook hands over a request.
    const f = await fixture({ signedIn: true, answer: server, input: new PassThrough() });
    expect(await f.run(['project', 'ensure', '--json'])).toBe(0);
    expect(JSON.parse(f.stdout.text)).toMatchObject({ status: 'done', projectId });
  });

  it('says unreachable, never not signed in, when the server cannot be reached', async () => {
    const f = await fixture({
      signedIn: true,
      answer: () => {
        throw new TypeError('fetch failed');
      },
    });
    expect(await f.run(['project', 'ensure', '--json'])).toBe(3);
    expect(JSON.parse(f.stdout.text)).toEqual({
      status: 'action_required',
      reason: 'unreachable',
      action: 'retry',
    });
    expect(f.stdout.text).not.toContain('not_signed_in');
  });

  it('says renew when the server refuses the sign-in', async () => {
    const f = await fixture({
      signedIn: true,
      answer: (path) =>
        path === '/oauth/token'
          ? Response.json({ error: 'invalid_grant' }, { status: 400 })
          : Response.json({ error: 'invalid_token' }, { status: 401 }),
    });
    expect(await f.run(['project', 'ensure', '--json'])).toBe(3);
    expect(JSON.parse(f.stdout.text)).toEqual({
      status: 'action_required',
      reason: 'renew',
      action: 'mnemonik auth renew',
    });
  });

  it('says server_error when the server fails', async () => {
    const f = await fixture({
      signedIn: true,
      answer: () => Response.json({ error: 'boom' }, { status: 500 }),
    });
    expect(await f.run(['project', 'ensure', '--json'])).toBe(3);
    expect(JSON.parse(f.stdout.text)).toEqual({
      status: 'action_required',
      reason: 'server_error',
      action: 'retry',
    });
  });

  it('says not signed in only when there is no sign-in, without asking the server', async () => {
    const f = await fixture({ signedIn: false, answer: server });
    expect(await f.run(['project', 'ensure', '--json'])).toBe(3);
    expect(JSON.parse(f.stdout.text)).toEqual({
      status: 'action_required',
      reason: 'not_signed_in',
      action: 'mnemonik install',
    });
    expect(f.requests).toEqual([]);
  });

  it('refuses a hook request that is not the documented JSON', async () => {
    const f = await fixture({ signedIn: true, answer: server });
    const stdout = capture();
    expect(
      await runCli(['project', 'ensure', '--agent', '--json'], {
        cwd: f.root,
        installStateDir: join(f.root, '..', 'state'),
        input: Readable.from(['not json']),
        stdout,
        stderr: stdout,
      })
    ).toBe(3);
    expect(JSON.parse(stdout.text)).toEqual({
      status: 'action_required',
      reason: 'invalid_request',
      action: 'retry',
    });
  });
});
