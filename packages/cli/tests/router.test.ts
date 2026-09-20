import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { maintenanceExitCode, runCli, type CliDependencies } from '../src/router.js';
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
    expect(f.stdout.text).toContain('--accept-indexing');
    expect(f.stdout.text).not.toMatch(/\b(?:scanner|roots)\b/iu);
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
        await runCli([command, '--no-browser', '--non-interactive', '--json', '--confirm'], f.deps)
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

  it('maps completed maintenance target states to the documented exit codes', () => {
    expect(maintenanceExitCode([])).toBe(0);
    expect(maintenanceExitCode([{ status: 'READY' }])).toBe(0);
    expect(maintenanceExitCode([{ status: 'ACTION_REQUIRED' }])).toBe(3);
    expect(maintenanceExitCode([{ status: 'FAILED' }])).toBe(1);
  });
  it.each([
    ['install', '--json', '--non-interactive', '--accept-scanner', '--apply'],
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
    ['scanner', 'enable', '--json', '--non-interactive', '--accept-scanner', '--apply'],
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
    expect(f.stderr.text).toBe(
      'Usage: mnemonik identity migrate [paths] [--report|--backup]\n' +
        '       mnemonik identity migrate [--apply|--verify|--rollback <run-id>]\n'
    );
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

  it('rejects unknown commands and flags with one line and exit 2', async () => {
    const command = fixture();
    expect(await runCli(['mystery'], command.deps)).toBe(2);
    expect(command.stderr.text).toBe('Unknown command: mystery\n');

    const flag = fixture();
    expect(await runCli(['doctor', '--mystery'], flag.deps)).toBe(2);
    expect(flag.stderr.text).toBe('Unknown flag: --mystery\n');
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

  it('labels installation and current-project summaries, and omits an ineligible project', async () => {
    const current = fixture();
    expect(await runCli(['status'], current.deps)).not.toBe(2);
    expect(current.stdout.text).toContain('Installation: ');
    expect(current.stdout.text).toContain('This project: ');

    const doctor = fixture();
    expect(await runCli(['doctor'], doctor.deps)).toBe(3);
    expect(doctor.stdout.text).toContain('Installation: ');
    expect(doctor.stdout.text).toContain('This project: ');

    const omitted = fixture();
    omitted.deps.preflight!.resolveIdentity = async () => ({
      kind: 'git_unavailable',
      detail: 'not a project',
    });
    expect(await runCli(['status'], omitted.deps)).toBe(3);
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
    expect(trust.stdout.text).toContain(
      'Open Codex, allow the Mnemonik hooks, then quit and reopen Codex.'
    );
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
      if (path === '/api/v1/auth/grants')
        return Response.json({ account: 'owner', deviceInstallationId: 'device', grants: [] });
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

  it.each(['repair'])(
    '%s posts after its terminal result without replacing stdout',
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
          ? { status: 'READY', targets: [] }
          : { status: 'ACTION_REQUIRED', reason: 'no_recorded_targets' }
      );
      expect(f.stderr.text).toBe('The final installation status could not be uploaded.\n');
      expect(f.deps.grantFetch).toHaveBeenCalledOnce();
    }
  );
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

it('connect runs only the editor native login', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { RuntimeStore } = await import('../src/runtime/store.js');
  const { SimulatedHostAdapter } = await import('../src/install/adapters.js');
  const stateDir = await mkdtemp(join(tmpdir(), 'connect-host-'));
  const verified = vi
    .spyOn(RuntimeStore.prototype, 'verifyRuntime')
    .mockResolvedValue({ entry: join(stateDir, 'hook.js') } as Awaited<
      ReturnType<InstanceType<typeof RuntimeStore>['verifyRuntime']>
    >);
  try {
    await writeFile(
      join(stateDir, 'host-ownership.json'),
      JSON.stringify({
        schemaVersion: 1,
        generation: 0,
        targets: [
          {
            id: 'codex:mcp:user',
            host: 'codex',
            component: 'mcp',
            scope: 'user',
            home: stateDir,
            profilePath: join(stateDir, 'config.toml'),
            files: [],
          },
        ],
      })
    );
    const adapter = new SimulatedHostAdapter('codex', {
      path: '/unused',
      content: Buffer.from('{}'),
      staging: 'inactive',
      requestedScope: 'user',
      effectiveScope: 'user',
      version: '1',
      artifactDigest: 'a',
    });
    adapter.launch = vi.fn(async () => 'native login');
    const grants = {
      list: vi.fn(async () => {
        throw new Error('must not poll grants');
      }),
    };
    const { deps, stdout } = fixture();
    deps.hostManagement = {
      stateDir,
      account: 'owner',
      imports: {
        codex: async () => ({ createHostAdapter: () => adapter }),
        'claude-code': async () => ({ createHostAdapter: () => adapter }),
        cursor: async () => ({ createHostAdapter: () => adapter }),
        grok: async () => ({ createHostAdapter: () => adapter }),
      },
      grants: grants as never,
    };
    expect(await runCli(['connect', 'codex'], deps)).toBe(0);
    expect(adapter.launch).toHaveBeenCalledOnce();
    expect(grants.list).not.toHaveBeenCalled();
    expect(stdout.text).toContain('native login');
  } finally {
    verified.mockRestore();
    await rm(stateDir, { recursive: true, force: true });
  }
});
