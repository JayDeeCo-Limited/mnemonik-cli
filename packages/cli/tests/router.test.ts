import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { maintenanceExitCode, runCli, type CliDependencies } from '../src/router.js';
import { helpScreen } from '../src/help.js';
import { createCliAuth } from '../src/auth/index.js';
import { isReadinessDocument, serializeReadiness } from '@mnemonik/shared';

const resolution = {
  kind: 'absent' as const,
  root: '/tmp/project',
  repository: { kind: 'plain' as const, root: '/tmp/project' },
  nested: [],
};

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function fixture(): { deps: CliDependencies; stdout: { text: string }; stderr: { text: string } } {
  const home = mkdtempSync(join(tmpdir(), 'router-home-'));
  homes.push(home);
  const stdout = {
    text: '',
    write(chunk: string) {
      this.text += chunk;
    },
  };
  const stderr = {
    text: '',
    write(chunk: string) {
      this.text += chunk;
    },
  };
  return {
    stdout,
    stderr,
    deps: {
      input: Readable.from('\n'.repeat(7)),
      stdout,
      stderr,
      cwd: '/tmp/project',
      home,
      installStateDir: join(home, 'state'),
      preflight: {
        nodeVersion: '24.21.0',
        platform: 'linux',
        resolveIdentity: async () => resolution,
        fetch: async () => new Response('{}', { status: 200 }),
        pathExists: async () => false,
      },
      cliAuth: {
        signIn: async () => undefined,
        getCliBearer: async () => 'access-token',
        logout: async () => undefined,
      },
    },
  };
}

describe('command router', () => {
  it('prints scanner roots as plain lines unless --json is present', async () => {
    const { mkdtemp, mkdir, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const stateDir = await mkdtemp(join(tmpdir(), 'roots-list-'));
    try {
      await mkdir(join(stateDir, 'scanner'), { recursive: true });
      await writeFile(
        join(stateDir, 'scanner/state.json'),
        JSON.stringify({ config: { roots: ['/repo/one', '/repo/two'] } })
      );
      const f = fixture();
      f.deps.installStateDir = stateDir;
      expect(await runCli(['roots', 'list'], f.deps)).toBe(0);
      expect(f.stdout.text).toBe('/repo/one\n/repo/two\n');
      expect(f.stdout.text).not.toContain('[');

      f.stdout.text = '';
      expect(await runCli(['roots', 'list', '--json'], f.deps)).toBe(0);
      expect(JSON.parse(f.stdout.text)).toEqual(['/repo/one', '/repo/two']);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('advertises add and remove while keeping roots as a hidden alias', async () => {
    const f = fixture();
    expect(await runCli(['--help'], f.deps)).toBe(0);
    expect(f.stdout.text).toContain('add <folder>');
    expect(f.stdout.text).toContain('remove <folder>');
    expect(f.stdout.text).not.toMatch(/\b(?:scanner|roots)\b/iu);
  });

  it.each([
    [
      ['project', 'delete', '--help'],
      ['project', 'delete'],
    ],
    [['connect', '--help'], ['connect']],
  ])('prints the command screen for %j', async (args, path) => {
    const f = fixture();
    expect(await runCli(args, f.deps)).toBe(0);
    expect(f.stdout.text).toBe(helpScreen(path));
    expect(f.stderr.text).toBe('');
  });

  it('prints the project screen for an unknown project subcommand', async () => {
    const f = fixture();
    expect(await runCli(['project', 'frobnicate'], f.deps)).toBe(2);
    expect(f.stderr.text).toBe(helpScreen(['project']));
  });

  it('prints the add screen when the folder is missing', async () => {
    const f = fixture();
    expect(await runCli(['add'], f.deps)).toBe(2);
    expect(f.stderr.text).toBe(helpScreen(['add']));
  });

  it('rejects the unimplemented scanner preview subcommand and omits it from help', async () => {
    const f = fixture();
    expect(await runCli(['scanner', 'preview'], f.deps)).toBe(2);
    expect(f.stderr.text).toContain('Usage: mnemonik scanner');
    f.stdout.text = '';
    expect(await runCli(['--help'], f.deps)).toBe(0);
    expect(f.stdout.text).not.toContain('scanner <enable|start|stop|pause|resume|status|preview|');
  });

  it.each(['repair', 'update', 'uninstall'])(
    'accepts the advertised --no-browser flag for %s',
    async (command) => {
      const f = fixture();
      expect(
        await runCli(
          [
            command,
            '--no-browser',
            '--non-interactive',
            '--json',
            ...(command === 'uninstall' ? ['--confirm'] : []),
          ],
          f.deps
        )
      ).not.toBe(2);
      expect(f.stderr.text).not.toContain('Unknown flag');
    }
  );
  it('recognizes the session-unavailable error across public bundle entrypoints', async () => {
    const f = fixture();
    f.deps.cliAuth!.getCliBearer = async () => {
      throw Object.assign(
        new Error(
          'Not signed in in this session. The sign-in is in the login keychain; run mnemonik auth login here or use Terminal.'
        ),
        {
          name: 'CredentialSessionUnavailableError',
          reason: 'credential_session_unavailable',
          store: 'keychain',
        }
      );
    };
    expect(await runCli(['auth', 'status', '--json'], f.deps)).toBe(3);
    expect(JSON.parse(f.stdout.text)).toMatchObject({
      status: 'ACTION_REQUIRED',
      reason: 'credential_session_unavailable',
      detail: expect.stringContaining('login keychain'),
    });
  });

  it.each([false, true])('auth status omits retired host grants (json=%s)', async (json) => {
    const f = fixture();
    const stateDir = f.deps.installStateDir;
    if (!stateDir) throw new Error('fixture state directory missing');
    const grant = (id: string, clientName: string) => ({
      id,
      clientId: `https://${id}.example.test/client`,
      clientName,
      softwareId: null,
      scopes: ['mcp:use'],
      resource: 'https://api.mnemonik.dev/mcp',
      createdAt: '2026-09-21T00:00:00.000Z',
      activatedAt: '2026-09-21T00:01:00.000Z',
      lastUsedAt: null,
    });
    f.deps.hostManagement = {
      stateDir,
      account: 'owner',
      grants: {
        list: async () => ({
          account: 'owner',
          grants: [
            grant('codex', 'Codex'),
            grant('grok', 'Grok'),
            grant('copilot', 'GitHub Copilot'),
          ],
        }),
        revoke: async () => undefined,
      },
    };

    expect(await runCli(['auth', 'status', ...(json ? ['--json'] : [])], f.deps)).toBe(0);
    expect(f.stdout.text).toContain('codex');
    expect(f.stdout.text.toLowerCase()).not.toMatch(/grok|copilot/u);
    if (json)
      expect(JSON.parse(f.stdout.text).grants.map(({ id }: { id: string }) => id)).toEqual([
        'codex',
      ]);
  });

  it('maps completed maintenance target states to the documented exit codes', () => {
    expect(maintenanceExitCode([])).toBe(0);
    expect(maintenanceExitCode([{ status: 'READY' }])).toBe(0);
    expect(maintenanceExitCode([{ status: 'ACTION_REQUIRED' }])).toBe(3);
    expect(maintenanceExitCode([{ status: 'FAILED' }])).toBe(1);
  });
  it.each([
    ['install', '--json', '--non-interactive', '--accept-indexing', '--apply'],
    ['connect', 'codex', '--json', '--non-interactive'],
    ['project', 'init', '--json', '--non-interactive', '--apply'],
    ['project', 'setup', '--json', '--non-interactive', '--apply'],
    ['project', 'status', '--json', '--non-interactive'],
    [
      'project',
      'link',
      '11111111-1111-4111-8111-111111111111',
      '--json',
      '--non-interactive',
      '--apply',
    ],
    ['project', 'ensure', '--agent', '--json', '--non-interactive'],
    ['scanner', 'enable', '--json', '--non-interactive', '--accept-indexing', '--apply'],
    ['scanner', 'status', '--json', '--non-interactive'],
    ['status', '--json', '--non-interactive'],
    ['doctor', '--json', '--non-interactive'],
    ['uninstall', '--json', '--non-interactive', '--confirm'],
    ['logout', '--json', '--non-interactive'],
    ['--version'],
    ['--help'],
    ['identity', 'migrate', '--report', '--json'],
  ])('resolves %s', async (...args) => {
    const f = fixture();
    expect(await runCli(args, f.deps)).not.toBe(2);
  });

  it('keeps the private identity command out of help', async () => {
    const f = fixture();
    await runCli(['--help'], f.deps);
    expect(f.stdout.text).not.toContain('identity migrate');

    expect(await runCli(['identity', 'unknown'], f.deps)).toBe(2);
    expect(f.stderr.text).toBe(helpScreen(['identity', 'migrate']));
  });

  it('emits the reconciliation report as one JSON document', async () => {
    const f = fixture();
    expect(await runCli(['identity', 'migrate', '--report', '--json'], f.deps)).toBe(0);
    expect(f.stdout.text.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(f.stdout.text)).toMatchObject({
      status: 'reported',
      report: { schemaVersion: 1, entries: [] },
    });
  });

  it('rejects unknown commands and flags with exit 2', async () => {
    const command = fixture();
    expect(await runCli(['mystery'], command.deps)).toBe(2);
    expect(command.stderr.text).toBe(helpScreen([]));

    const flag = fixture();
    expect(await runCli(['doctor', '--mystery'], flag.deps)).toBe(2);
    expect(flag.stderr.text).toBe('Unknown flag: --mystery\n');
  });

  it.each([
    { args: ['install', '--accept-scanner', '--apply'], flag: 'accept-scanner' },
    { args: ['roots', 'list', '--accept-indexing'], flag: 'accept-indexing' },
    { args: ['roots', 'list', '--apply'], flag: 'apply' },
    { args: ['repair', '--scope', 'user'], flag: 'scope' },
    { args: ['repair', '--confirm'], flag: 'confirm' },
    { args: ['update', '--scope', 'user'], flag: 'scope' },
    { args: ['update', '--component', 'hooks'], flag: 'component' },
    { args: ['update', '--confirm'], flag: 'confirm' },
    { args: ['update', '--component', 'scanner', '--confirm'], flag: 'confirm' },
    { args: ['update', '--apply'], flag: 'apply' },
    { args: ['uninstall', '--scope', 'user'], flag: 'scope' },
    { args: ['uninstall', '--apply'], flag: 'apply' },
    { args: ['connect', 'codex', '--scope', 'user'], flag: 'scope' },
    {
      args: ['project', 'link', '11111111-1111-4111-8111-111111111111', '--owner', 'team:x'],
      flag: 'owner',
    },
    { args: ['auth', 'login', '--confirm'], flag: 'confirm' },
    { args: ['auth', 'status', '--confirm'], flag: 'confirm' },
  ])('rejects the dropped flag in $args', async ({ args, flag }) => {
    const f = fixture();
    expect(await runCli(args, f.deps)).toBe(2);
    expect(f.stderr.text).toBe(`Unknown flag: --${flag}\n`);
  });

  it.each([
    { args: ['install', '--non-interactive'], flag: '--accept-indexing' },
    { args: ['project', 'init', '--non-interactive'], flag: '--apply' },
    { args: ['scanner', 'enable', '--non-interactive'], flag: '--accept-indexing' },
    { args: ['uninstall', '--non-interactive'], flag: '--confirm' },
  ])('names a missing non-interactive consent flag', async ({ args, flag }) => {
    const f = fixture();
    expect(await runCli(args, f.deps)).toBe(3);
    expect(f.stderr.text).toContain(flag);
  });

  it('honours JSON output as one machine-readable line', async () => {
    const f = fixture();
    expect(await runCli(['scanner', 'status', '--json', '--non-interactive'], f.deps)).toBe(3);
    expect(f.stdout.text.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(f.stdout.text)).toMatchObject({
      status: 'LIMITED',
      reason: 'scanner_service_unavailable',
    });
  });

  it('doctor and scanner status emit the canonical readiness document', async () => {
    const diagnosticsRequests = vi.fn();
    vi.stubGlobal('fetch', diagnosticsRequests);
    const doctor = fixture();
    expect(await runCli(['doctor', '--json'], doctor.deps)).toBe(3);
    expect(JSON.parse(doctor.stdout.text)).toMatchObject({
      schemaVersion: 1,
      installation: {
        state: 'LIMITED',
        reasons: ['background_indexing_not_verified'],
      },
      scanner: null,
    });

    const scanner = fixture();
    scanner.deps.scannerStatus = async () => ({
      roots: ['/work'],
      exclusions: ['/work/skipped'],
      repositories: [
        { path: '/work/ready', state: 'existing_project', selected: true },
        { path: '/work/skipped', state: 'existing_project', selected: false },
      ],
    });
    expect(await runCli(['scanner', 'status', '--json'], scanner.deps)).toBe(3);
    expect(JSON.parse(scanner.stdout.text)).toMatchObject({
      schemaVersion: 1,
      installation: { state: 'LIMITED' },
      projects: [{ summary: { state: 'READY' } }, { summary: { state: 'LIMITED' } }],
    });
    expect(diagnosticsRequests).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('labels the installation summary and omits a folder that is not a project', async () => {
    const current = fixture();
    expect(await runCli(['status'], current.deps)).not.toBe(2);
    expect(current.stdout.text).toContain('Installation: ');
    // The fixture folder holds no project file, so status says nothing about one.
    expect(current.stdout.text).not.toContain('This project: ');

    const doctor = fixture();
    expect(await runCli(['doctor'], doctor.deps)).toBe(3);
    expect(doctor.stdout.text).toContain('Installation: ');
    expect(doctor.stdout.text).not.toContain('This project: ');

    const omitted = fixture();
    omitted.deps.preflight!.resolveIdentity = async () => ({
      kind: 'git_unavailable',
      detail: 'not a project',
    });
    expect(await runCli(['status'], omitted.deps)).toBe(1);
    expect(omitted.stdout.text).toContain('The scanner has not checked in yet.');
    expect(omitted.stdout.text).not.toContain('background_indexing_not_verified');
    expect(omitted.stdout.text).not.toContain('hooks are not installed.');

    const trust = fixture();
    trust.deps.codexTrustConditions = async () => [
      {
        kind: 'host_trust_pending',
        reason: 'codex_trust_pending',
        action:
          'Run the codex command in a terminal, enter /hooks, and trust the Mnemonik hooks; then quit and reopen Codex.',
      },
    ];
    expect(await runCli(['status'], trust.deps)).not.toBe(0);
    expect(trust.stdout.text).not.toContain('allow the Mnemonik hooks');
    expect(trust.stdout.text).not.toContain('codex_trust_pending');
  });

  it('reports a repository discovered after install as not set up with one action', async () => {
    const f = fixture();
    f.deps.scannerStatus = async () => ({
      roots: ['/work'],
      exclusions: [],
      repositories: [{ path: '/work/later', state: 'not_set_up', selected: true }],
    });
    expect(await runCli(['scanner', 'status'], f.deps)).toBe(3);
    expect(f.stdout.text).toContain(
      '/work/later  Not set up yet - mnemonik project init /work/later\n'
    );
    expect(f.stdout.text).toContain('Done.');
  });

  it('status posts its canonical document only when signed in', async () => {
    const signedIn = fixture();
    signedIn.deps.statusGeneratedAt = '2026-09-14T00:00:00.000Z';
    signedIn.deps.configuredHosts = [];
    signedIn.deps.projectHookConditions = [];
    signedIn.deps.scannerStatus = async () => ({ roots: [], exclusions: [], repositories: [] });
    signedIn.deps.grantFetch = vi.fn(async (input, init) => {
      const path = new URL(String(input)).pathname;
      expect(path).toBe('/api/v1/installations/current/readiness');
      expect(JSON.parse(String(init?.body)).readiness).toEqual(
        serializeReadiness(JSON.parse(signedIn.stdout.text))
      );
      return Response.json({ status: 'recorded' });
    });
    expect(await runCli(['status', '--json'], signedIn.deps)).not.toBe(2);
    expect(signedIn.deps.grantFetch).toHaveBeenCalledOnce();

    const signedOut = fixture();
    signedOut.deps.cliAuth!.getCliBearer = async () => ({
      status: 'missing',
      reason: 'not_signed_in',
    });
    signedOut.deps.grantFetch = vi.fn();
    await runCli(['status', '--json'], signedOut.deps);
    expect(signedOut.deps.grantFetch).not.toHaveBeenCalled();
  });

  it('status keeps the development marker out of its readiness upload', async () => {
    vi.stubEnv('MNEMONIK_DEV_RELEASE_DIR', '/tmp/mnemonik-dev-release');
    const f = fixture();
    f.deps.statusGeneratedAt = '2026-09-15T00:00:00.000Z';
    f.deps.configuredHosts = [];
    f.deps.projectHookConditions = [];
    f.deps.scannerStatus = async () => ({ roots: [], exclusions: [], repositories: [] });
    let posted: unknown;
    f.deps.grantFetch = vi.fn(async (input, init) => {
      expect(new URL(String(input)).pathname).toBe('/api/v1/installations/current/readiness');
      posted = JSON.parse(String(init?.body)).readiness;
      return Response.json({ status: 'recorded' });
    });

    expect(await runCli(['status', '--json'], f.deps)).not.toBe(2);
    expect(JSON.parse(f.stdout.text)).toHaveProperty('devReleaseSource', true);
    expect(posted).not.toHaveProperty('devReleaseSource');
    expect(isReadinessDocument(posted)).toBe(true);
  });

  it.each(['repair', 'update'])(
    '%s posts after its terminal result and a refusal changes nothing it printed',
    async (command) => {
      const f = fixture();
      f.deps.configuredHosts = [];
      f.deps.projectHookConditions = [];
      f.deps.scannerStatus = async () => ({ roots: [], exclusions: [], repositories: [] });
      f.deps.grantFetch = vi.fn(async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === '/api/v1/auth/grants')
          return Response.json({ account: 'owner', deviceInstallationId: 'device', grants: [] });
        expect(path).toBe('/api/v1/installations/current/readiness');
        return new Response('{}', { status: 500 });
      });
      const args =
        command === 'update' ? [command, '--host', 'codex', '--json'] : [command, '--json'];
      const code = await runCli(args, f.deps);
      expect(code).toBe(command === 'repair' ? 0 : 3);
      expect(JSON.parse(f.stdout.text)).toMatchObject(
        command === 'repair'
          ? { status: 'READY', targets: [], remaining: { installation: { state: 'READY' } } }
          : { status: 'ACTION_REQUIRED', reason: 'no_recorded_targets' }
      );
      expect(f.stderr.text).toBe('');
      expect(f.deps.grantFetch).toHaveBeenCalledOnce();
    }
  );

  it('automatic update reports unverified scanner coverage after failure without terminal output', async () => {
    const f = fixture();
    f.deps.configuredHosts = [];
    f.deps.projectHookConditions = [];
    let posted: unknown;
    f.deps.grantFetch = vi.fn(async (input, init) => {
      expect(new URL(String(input)).pathname).toBe('/api/v1/installations/current/readiness');
      posted = JSON.parse(String(init?.body)).readiness;
      return Response.json({ status: 'recorded' });
    });
    expect(await runCli(['update', '--host', 'codex', '--automatic'], f.deps)).toBe(3);
    expect(f.deps.grantFetch).toHaveBeenCalledOnce();
    expect(isReadinessDocument(posted)).toBe(true);
    expect(posted).toMatchObject({
      installation: {
        state: 'LIMITED',
        reasons: ['background_indexing_not_verified'],
      },
    });
    expect(f.stdout.text + f.stderr.text).toBe('');
  });
});

it('auth login signs in without starting installation', async () => {
  const { deps, stdout } = fixture();
  let signedIn = false;
  deps.cliAuth!.getCliBearer = async () =>
    signedIn ? 'access-token' : { status: 'missing', reason: 'not_signed_in' };
  deps.cliAuth!.signIn = async () => {
    signedIn = true;
  };
  deps.preflight!.fetch = async () => {
    throw Error('must not install');
  };
  deps.cliAuth!.accountEmail = createCliAuth({
    resource: 'https://api.example.test/',
    fetch: async (url) => {
      expect(String(url)).toBe('https://api.example.test/api/v1/auth/grants');
      return new Response(
        JSON.stringify({ account: 'owner', email: 'owner@example.test', grants: [] })
      );
    },
  }).accountEmail;
  expect(await runCli(['auth', 'login'], deps)).toBe(0);
  expect(signedIn).toBe(true);
  expect(stdout.text).toContain('Signed in as owner@example.test');
  expect(stdout.text).not.toContain('Installation');
});

it('auth login keeps a valid credential without reopening an install session', async () => {
  const { deps } = fixture();
  const signIn = vi.fn(async () => {});
  deps.cliAuth = {
    getCliBearer: async () => 'valid-cli-bearer',
    signIn,
    logout: async () => {},
  };
  deps.grantFetch = vi.fn(async () => {
    throw new Error('must not inspect or create an install session');
  });

  expect(await runCli(['auth', 'login'], deps)).toBe(0);
  expect(signIn).not.toHaveBeenCalled();
  expect(deps.grantFetch).not.toHaveBeenCalled();
});

it('forced install reopen reports an active session without starting authorization', async () => {
  const { deps, stdout } = fixture();
  const expiresAt = '2026-09-13T02:19:01.000Z';
  const signIn = vi.fn(async () => {});
  deps.cliAuth = {
    getCliBearer: async () => 'valid-cli-bearer',
    signIn,
    logout: async () => {},
  };
  deps.grantFetch = vi.fn(async (input) => {
    expect(new URL(String(input)).pathname).toBe('/api/v1/install-sessions/current');
    return Response.json({ id: 'session-1', expires_at: expiresAt });
  });

  expect(await runCli(['auth', 'login', '--reopen-install'], deps)).toBe(0);
  expect(stdout.text).toContain(
    `An install session is already open until ${expiresAt}; run the install again`
  );
  expect(signIn).not.toHaveBeenCalled();
  expect(deps.grantFetch).toHaveBeenCalledOnce();
});

/** A stand-in for the editor's own login command: it prints one authorize URL and listens. */
async function fakeEditor(
  state: string,
  options: { origin?: string; exitOnCallback?: boolean } = {}
) {
  const { createServer } = await import('node:http');
  const { PassThrough } = await import('node:stream');
  const { EventEmitter } = await import('node:events');
  const received: string[] = [];
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr: new PassThrough(),
    kill: () => true,
  });
  const server = createServer((request, response) => {
    received.push(request.url ?? '');
    response.writeHead(204);
    response.end(() => {
      if (options.exitOnCallback !== false) child.emit('close', 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const authorizeUrl = `${options.origin ?? 'https://auth.mnemonik.ai'}/oauth/authorize?client_id=codex&state=${state}`;
  return {
    received,
    authorizeUrl,
    callbackUrl: `http://127.0.0.1:${port}/callback?code=editor-code&state=${state}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    spawn: (() => {
      stdout.write(`Open this URL to sign in:\n${authorizeUrl}\n`);
      return child;
    }) as unknown as NonNullable<CliDependencies['editorLogin']>['spawn'],
  };
}

async function readyCodexHome(deps: CliDependencies) {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  await mkdir(join(deps.home as string, '.codex'), { recursive: true });
  await writeFile(
    join(deps.home as string, '.codex/config.toml'),
    '[mcp_servers.mnemonik]\nenabled = true\n'
  );
}

it('connect signs codex in on a machine the browser cannot reach', async () => {
  const { deps, stdout } = fixture();
  await readyCodexHome(deps);
  const state = 'state-connect-signs-in';
  const editor = await fakeEditor(state);
  try {
    deps.editorLogin = {
      spawn: editor.spawn,
      sleep: async () => undefined,
      fetch: (async (input: unknown, init?: { headers?: Record<string, string> }) => {
        const url = String(input);
        if (!url.includes('/api/v1/auth/editor-callback/')) return globalThis.fetch(url);
        expect(url).toContain(state);
        expect(init?.headers?.authorization).toBe('Bearer access-token');
        return Response.json({ url: editor.callbackUrl });
      }) as typeof fetch,
    };
    expect(await runCli(['connect', 'codex'], deps)).toBe(0);
    expect(stdout.text).toBe(
      'Open this link to sign in:\n' +
        `${editor.authorizeUrl}\n` +
        'Codex is signed in to Mnemonik.\n'
    );
    expect(editor.received).toEqual([`/callback?code=editor-code&state=${state}`]);
  } finally {
    await editor.close();
  }
});

it('connect reports an unapproved sign-in and how to try again', async () => {
  const { deps, stdout } = fixture();
  await readyCodexHome(deps);
  const state = 'state-connect-never-approved';
  const editor = await fakeEditor(state);
  try {
    deps.editorLogin = {
      spawn: editor.spawn,
      sleep: async () => undefined,
      timeoutMs: 0,
      fetch: (async () => new Response('{}', { status: 404 })) as typeof fetch,
    };
    expect(await runCli(['connect', 'codex'], deps)).toBe(1);
    expect(stdout.text).toBe(
      'Open this link to sign in:\n' +
        `${editor.authorizeUrl}\n` +
        'Sign-in timed out. Run mnemonik connect codex to try again.\n'
    );
    expect(editor.received).toEqual([]);
  } finally {
    await editor.close();
  }
});

const CODEX_INSTRUCTIONS =
  'Finish signing in to Mnemonik in the editor.\n' +
  'Codex CLI        run codex mcp login mnemonik\n' +
  'Codex Desktop    open Settings, Plugins, MCPs, then Authenticate\n';

it('connect stops waiting when the editor keeps running after its callback', async () => {
  const { deps, stdout } = fixture();
  await readyCodexHome(deps);
  const state = 'state-connect-editor-lingers';
  const editor = await fakeEditor(state, { exitOnCallback: false });
  try {
    deps.editorLogin = {
      spawn: editor.spawn,
      sleep: async () => undefined,
      timeoutMs: 1500,
      fetch: (async (input: unknown) => {
        const url = String(input);
        if (!url.includes('/api/v1/auth/editor-callback/')) return globalThis.fetch(url);
        return Response.json({ url: editor.callbackUrl });
      }) as typeof fetch,
    };
    expect(await runCli(['connect', 'codex'], deps)).toBe(3);
    expect(editor.received).toHaveLength(1);
    expect(stdout.text).toBe(
      `Open this link to sign in:\n${editor.authorizeUrl}\n${CODEX_INSTRUCTIONS}`
    );
  } finally {
    await editor.close();
  }
});

it('connect ignores an authorize URL that is not this server', async () => {
  const { deps, stdout } = fixture();
  await readyCodexHome(deps);
  const editor = await fakeEditor('state-connect-foreign-origin', {
    origin: 'https://auth.mnemonik.ai.evil.example',
  });
  try {
    deps.editorLogin = {
      spawn: editor.spawn,
      sleep: async () => undefined,
      fetch: (() => {
        throw new Error('the CLI must not poll for a foreign authorize URL');
      }) as typeof fetch,
    };
    expect(await runCli(['connect', 'codex'], deps)).toBe(3);
    expect(stdout.text).toBe(CODEX_INSTRUCTIONS);
  } finally {
    await editor.close();
  }
});

it('connect refuses to deliver a callback that is not a loopback address', async () => {
  const { deps, stdout } = fixture();
  await readyCodexHome(deps);
  const state = 'state-connect-offsite-callback';
  const editor = await fakeEditor(state);
  const requested: string[] = [];
  try {
    deps.editorLogin = {
      spawn: editor.spawn,
      sleep: async () => undefined,
      timeoutMs: 1500,
      fetch: (async (input: unknown) => {
        requested.push(String(input));
        return requested.length > 1
          ? new Response(null, { status: 204 })
          : Response.json({ url: `https://evil.example/callback?code=stolen&state=${state}` });
      }) as typeof fetch,
    };
    expect(await runCli(['connect', 'codex'], deps)).toBe(3);
    // The offsite callback is never requested at all.
    expect(requested).toHaveLength(1);
    expect(editor.received).toEqual([]);
    expect(stdout.text).toBe(
      `Open this link to sign in:\n${editor.authorizeUrl}\n${CODEX_INSTRUCTIONS}`
    );
  } finally {
    await editor.close();
  }
});

it('connect reports local editor setup consistently in plain text and JSON', async () => {
  const { mkdir, mkdtemp, readFile, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const home = await mkdtemp(join(tmpdir(), 'connect-host-'));
  const config = join(home, '.codex/config.toml');
  try {
    const { deps, stdout } = fixture();
    deps.home = home;
    const { EventEmitter } = await import('node:events');
    // An editor with no login command on this machine keeps its own instructions.
    deps.editorLogin = {
      spawn: (() => {
        const child = Object.assign(new EventEmitter(), { kill: () => true });
        setTimeout(() => child.emit('error', new Error('ENOENT')), 0);
        return child;
      }) as unknown as NonNullable<CliDependencies['editorLogin']>['spawn'],
    };
    expect(await runCli(['connect', 'codex'], deps)).toBe(3);
    expect(stdout.text).toBe(
      'Codex connection is missing.\nRun mnemonik install to set it up again.\n'
    );
    await expect(readFile(config)).rejects.toMatchObject({ code: 'ENOENT' });

    await mkdir(join(home, '.codex'));
    await writeFile(config, '[mcp_servers.mnemonik]\nenabled = true\n');
    stdout.text = '';
    expect(await runCli(['connect', 'codex'], deps)).toBe(3);
    expect(stdout.text).toBe(
      'Finish signing in to Mnemonik in the editor.\n' +
        'Codex CLI        run codex mcp login mnemonik\n' +
        'Codex Desktop    open Settings, Plugins, MCPs, then Authenticate\n'
    );

    stdout.text = '';
    expect(await runCli(['connect', 'codex', '--json'], deps)).toBe(3);
    expect(JSON.parse(stdout.text)).toEqual({
      status: 'ACTION_REQUIRED',
      reason: 'Finish signing in to Mnemonik in the editor.',
      actions: [
        'Codex CLI        run codex mcp login mnemonik',
        'Codex Desktop    open Settings, Plugins, MCPs, then Authenticate',
      ],
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

describe('consent for removal and deletion', () => {
  const projectId = '22222222-2222-4222-8222-222222222222';

  async function watched() {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const f = fixture();
    const stateDir = f.deps.installStateDir!;
    const root = join(f.deps.home!, 'Projects', 'app');
    await mkdir(join(stateDir, 'scanner'), { recursive: true });
    await mkdir(root, { recursive: true });
    await writeFile(
      join(stateDir, 'scanner/state.json'),
      JSON.stringify({ config: { roots: [root], exclusions: [] } })
    );
    const roots = async () => {
      const { readFile } = await import('node:fs/promises');
      return (
        JSON.parse(await readFile(join(stateDir, 'scanner/state.json'), 'utf8')) as {
          config: { roots: string[] };
        }
      ).config.roots;
    };
    return { ...f, root, roots };
  }

  it('remove --json without --apply asks for the flag and removes nothing', async () => {
    const f = await watched();
    f.deps.grantFetch = vi.fn();
    expect(await runCli(['remove', f.root, '--json'], f.deps)).toBe(3);
    expect(JSON.parse(f.stdout.text)).toMatchObject({
      status: 'action_required',
      flag: '--apply',
    });
    expect(await f.roots()).toEqual([f.root]);
    expect(f.deps.grantFetch).not.toHaveBeenCalled();
  });

  it('remove --non-interactive --apply removes the folder as before', async () => {
    const f = await watched();
    f.deps.grantFetch = vi.fn(async (input) => {
      expect(new URL(String(input)).pathname).toBe('/api/v1/scanner-consent/current');
      return Response.json({ consent: { roots: [] } });
    });
    expect(await runCli(['remove', f.root, '--non-interactive', '--apply'], f.deps)).toBe(0);
    expect(f.stdout.text).toContain('✓ app is no longer connected.');
    expect(await f.roots()).toEqual([]);
  });

  it('data delete --json without --confirm asks for the flag and sends nothing', async () => {
    const f = fixture();
    f.deps.grantFetch = vi.fn();
    expect(await runCli(['data', 'delete', '--project', projectId, '--json'], f.deps)).toBe(3);
    expect(JSON.parse(f.stdout.text)).toMatchObject({
      status: 'action_required',
      flag: '--confirm',
    });
    expect(f.deps.grantFetch).not.toHaveBeenCalled();
  });

  it('data delete asks first and deletes nothing unless the answer is yes', async () => {
    const f = fixture();
    f.deps.grantFetch = vi.fn();
    f.deps.input = Readable.from('no\n');
    expect(await runCli(['data', 'delete', '--project', projectId], f.deps)).toBe(130);
    expect(f.stdout.text).toBe(
      `This deletes everything background indexing has sent for ${projectId} from your account. Type yes to continue.\nNothing was deleted.\n`
    );
    expect(f.deps.grantFetch).not.toHaveBeenCalled();
  });

  it('data delete --confirm --json deletes without asking', async () => {
    const f = fixture();
    f.deps.grantFetch = vi.fn(async (input, init) => {
      expect(new URL(String(input)).pathname).toBe(`/api/v1/projects/${projectId}/index`);
      return init?.method === 'DELETE'
        ? Response.json({ projectId, status: 'deleted', deletedChunks: 4 })
        : Response.json({ projectId, chunkCount: 0 });
    });
    expect(
      await runCli(['data', 'delete', '--project', projectId, '--confirm', '--json'], f.deps)
    ).toBe(0);
    expect(JSON.parse(f.stdout.text)).toMatchObject({ projectId, deletedChunks: 4 });
    expect(f.deps.grantFetch).toHaveBeenCalledTimes(2);
  });
});

describe('project ensure needs no flags', () => {
  async function ensureFixture() {
    const { mkdtemp } = await import('node:fs/promises');
    const f = fixture();
    const root = await mkdtemp(join(tmpdir(), 'router-ensure-'));
    homes.push(root);
    const ensureProject = vi.fn(async () => ({
      status: 'done' as const,
      operationId: '11111111-1111-4111-8111-111111111111',
      root,
      projectId: '22222222-2222-4222-8222-222222222222',
      permissionStatus: 'private' as const,
    }));
    f.deps.cwd = root;
    f.deps.projectExecutor = {
      resolveProjectIdentity: async () => ({
        kind: 'absent',
        root,
        repository: { kind: 'plain', root },
        nested: [],
      }),
      ensureProject,
      stage: vi.fn(),
      apply: vi.fn(),
      rollback: vi.fn(),
    } as CliDependencies['projectExecutor'];
    return { ...f, ensureProject };
  }

  it.each([[['project', 'ensure']], [['project', 'ensure', '--agent', '--json']]])(
    '%j reaches the ensure executor and prints JSON',
    async (args) => {
      const f = await ensureFixture();
      expect(await runCli(args, f.deps)).toBe(0);
      expect(f.ensureProject).toHaveBeenCalledOnce();
      expect(JSON.parse(f.stdout.text)).toMatchObject({ status: 'done' });
    }
  );

  it('rejects any other flag', async () => {
    const f = await ensureFixture();
    expect(await runCli(['project', 'ensure', '--apply'], f.deps)).toBe(2);
    expect(f.ensureProject).not.toHaveBeenCalled();
  });
});

describe('files the server could not index', () => {
  const line = (files: string, project: string) =>
    `${files} in ${project} could not be indexed. Run mnemonik doctor for details.`;
  async function withRefusals(
    f: ReturnType<typeof fixture>,
    refusedBatches: Array<{ project: string; files: number; issue: string }>
  ) {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const dir = f.deps.installStateDir!;
    await mkdir(join(dir, 'scanner'), { recursive: true });
    await writeFile(
      join(dir, 'scanner/status.json'),
      JSON.stringify({
        recordedAt: 0,
        snapshot: {
          version: null,
          lifecycle: { state: 'stopped', reason: 'stopped', pid: null, pauseIntervals: [] },
          heartbeat: { lastSuccess: null },
          roots: [],
          exclusions: [],
          refusedBatches,
        },
      })
    );
  }
  const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

  it('status prints one line per project with the summed count and no field path', async () => {
    const f = fixture();
    await withRefusals(f, [
      { project: 't3code', files: 2, issue: 'files.0.chunks.0.metadata.signature' },
      { project: 't3code', files: 3, issue: 'commits.68.files' },
    ]);
    await runCli(['status'], f.deps);
    expect(occurrences(f.stdout.text, 'could not be indexed')).toBe(1);
    expect(f.stdout.text).toContain(`${line('5 files', 't3code')}\n`);
    expect(f.stdout.text).not.toContain('metadata.signature');
    expect(f.stdout.text).not.toContain('commits.68.files');
  });

  it('scanner status uses the singular for one file', async () => {
    const f = fixture();
    await withRefusals(f, [{ project: 'demo', files: 1, issue: 'files.0.path' }]);
    const live = { kind: 'systemd' as const, installed: true, running: true, pid: 42 };
    f.deps.scannerService = {
      stateDir: f.deps.installStateDir!,
      command: vi.fn(async () => ({ status: 'ok' as const, supervisor: live })),
    };
    expect(await runCli(['scanner', 'status'], f.deps)).toBe(0);
    expect(f.stdout.text).toBe(
      `Scanner status: ok (service: systemd, running)\n${line('1 file', 'demo')}\n`
    );
  });

  it('doctor follows the line with one indented line per distinct issue path', async () => {
    const f = fixture();
    await withRefusals(f, [
      { project: 't3code', files: 2, issue: 'files.0.chunks.0.metadata.signature' },
      { project: 't3code', files: 1, issue: 'files.0.chunks.0.metadata.signature' },
      { project: 't3code', files: 4, issue: 'commits.68.files' },
    ]);
    await runCli(['doctor'], f.deps);
    expect(f.stdout.text).toContain(
      `${line('7 files', 't3code')}\n  files.0.chunks.0.metadata.signature\n  commits.68.files\n`
    );
    expect(occurrences(f.stdout.text, '  files.0.chunks.0.metadata.signature')).toBe(1);
  });

  it('prints nothing when there are no refusals', async () => {
    const f = fixture();
    await withRefusals(f, []);
    await runCli(['status'], f.deps);
    const doctor = fixture();
    await runCli(['doctor'], doctor.deps);
    expect(f.stdout.text + doctor.stdout.text).not.toContain('could not be indexed');
  });
});
