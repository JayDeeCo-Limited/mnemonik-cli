import { codexHookHash, readHooksJson } from '../../codex-hooks/dist/install.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createProjectSetupExecutor } from '@mnemonik/local-setup';
import { SimulatedSecretStore } from '@mnemonik/credentials';
import {
  serializeReadiness,
  type Inspection,
  type ServiceOperation,
  type ServiceResult,
} from '@mnemonik/shared';
import {
  hostOrder,
  hostPackageImports,
  type AdapterDependencies,
  type HostPackageImports,
} from '../src/install/adapters.js';
import { Output } from '../src/output.js';
import { joinedInstall, hostReadinessConditions } from '../src/install/journey.js';
import { hookStatusConditions, runHosts } from '../src/install/hosts.js';
import { bytesAt, digest, interrupted, withInstall } from '../src/install/journal.js';
import { ownershipPath, readOwnership } from '../src/install/ownership.js';
import { runCli } from '../src/router.js';
import { createCliCredentials } from '../src/auth/credentials.js';
import { RuntimeStore, type Verified } from '../src/runtime/store.js';
import { bump, hostStateFixture, packedHosts } from './fixtures/hostRuntime.js';
import { buildStatusDocument } from '../src/status.js';
import { createCredentialAdapter } from '@mnemonik/credentials';
import { ensureLauncher, launcherStatus } from '../src/launcher.js';

const createCliAuthOptions = vi.hoisted(() => vi.fn());
vi.mock('../src/auth/index.js', async (original) => {
  const auth = await original<typeof import('../src/auth/index.js')>();
  return {
    ...auth,
    createCliAuth: (options: Parameters<typeof auth.createCliAuth>[0]) => {
      createCliAuthOptions(options);
      return auth.createCliAuth(options);
    },
  };
});

let packed: Awaited<ReturnType<typeof packedHosts>>;
const homes: string[] = [];
const secretStore = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock('@mnemonik/credentials', async (original) => ({
  ...(await original<typeof import('@mnemonik/credentials')>()),
  osSecretStore: () => secretStore.current,
}));

beforeAll(async () => {
  packed = await packedHosts();
}, 120_000);

afterAll(async () => {
  await rm(packed.root, { recursive: true, force: true });
});

afterEach(async () => {
  secretStore.current = undefined;
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function fixture() {
  const result = await hostStateFixture(packed.sources);
  homes.push(result.home);
  overrideInspection(result.deps, 'codex', () => ({ trustPending: false }));
  return result;
}

const targets = (
  fixture: Awaited<ReturnType<typeof hostStateFixture>>,
  component: 'hooks' | 'mcp'
) => fixture.selections.map((selection) => ({ ...selection, component }));

const capture = () => ({
  text: '',
  write(chunk: string) {
    this.text += chunk;
  },
});

function overrideInspection(
  deps: Awaited<ReturnType<typeof hostStateFixture>>['deps'],
  host: (typeof hostOrder)[number],
  state: () => Partial<Inspection>
) {
  const original = deps.imports ?? hostPackageImports;
  deps.imports = {
    ...original,
    [host]: async (runtime: Verified) => {
      const module = await original[host](runtime);
      return {
        createHostAdapter(adapterDeps?: AdapterDependencies) {
          const adapter = module.createHostAdapter(adapterDeps);
          const verify = adapter.verify.bind(adapter);
          adapter.verify = async (target) => ({ ...(await verify(target)), ...state() });
          return adapter;
        },
      };
    },
  } as HostPackageImports;
}

async function codexCommands(path: string) {
  const config = JSON.parse(await readFile(path, 'utf8')) as {
    hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  };
  return Object.keys(config.hooks)
    .sort()
    .map((event) => config.hooks[event]![0]!.hooks[0]!.command);
}

async function replaceJson(path: string, mutate: (value: Record<string, any>) => void) {
  const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, any>;
  mutate(value);
  await writeFile(path, JSON.stringify(value, null, 2) + '\n');
}

describe('joined install journal', () => {
  it('joined consent binds every connected host to this installation', async () => {
    const f = await fixture();
    const approve = vi.spyOn(f.deps.grants!, 'approveHost');
    await joinedInstall(
      new Map<string, string | true>([
        ['hosts', 'claude-code,codex,cursor'],
        ['integration-scope', 'user'],
        ['components', 'hooks,mcp'],
        ['accept-limited', true],
        ['apply', true],
        ['non-interactive', true],
      ]),
      {
        home: f.home,
        cwd: f.projectRoot,
        installStateDir: f.deps.stateDir,
        grantFetch: async () => Response.json({ id: 'fixture-session' }),
        preflight: {
          nodeVersion: '24.21.0',
          pathExists: async () => false,
          fetch: async () => new Response('{}'),
          resolveIdentity: async () => ({
            kind: 'absent',
            root: f.projectRoot,
            repository: { kind: 'plain', root: f.projectRoot },
            nested: [],
          }),
        },
      },
      new Output({ write: () => {} }),
      async () => 'owner',
      async () => f.deps
    );
    expect(approve).toHaveBeenCalledTimes(3);
    const owned = (await readOwnership(f.deps.stateDir)).targets.filter(
      (target) => target.component === 'mcp'
    );
    expect(owned).toHaveLength(3);
    expect(owned.map((target) => target.grant?.installationId)).toEqual([
      'installation',
      'installation',
      'installation',
    ]);
  }, 120000);

  it.each(['codex', 'cursor'])(
    'skipped %s activation keeps hooks and MCP and continues the joined journey',
    async (host) => {
      const f = await fixture();
      const pendingGrant = f.grants.find((grant) => grant.clientName === host)!;
      pendingGrant.activatedAt = null;
      if (host === 'codex') f.grants.push({ ...pendingGrant, id: 'another-codex-grant' });
      const selection = f.selections.find((s) => s.host === host)!;
      const next = f.selections.find((s) => s.host === 'cursor')!;
      let scannerReached = false;
      let clock = 0;
      const result = await runHosts(
        'install',
        [
          { ...selection, component: 'hooks' },
          { ...selection, component: 'mcp' },
          ...(host === 'codex'
            ? [
                { ...next, component: 'hooks' as const },
                { ...next, component: 'mcp' as const },
              ]
            : []),
        ],
        {
          ...f.deps,
          now: () => clock,
          sleep: async () => {
            clock += 120_000;
          },
          timeout: async () => {
            if (host === 'codex') {
              const config = join(f.home, '.codex/config.toml');
              await writeFile(config, (await readFile(config, 'utf8')) + '\n# native hook trust\n');
            }
            return 'skip';
          },
          afterHosts: async (journal) => {
            scannerReached = true;
            journal.data.state = 'LIMITED';
          },
        }
      );
      expect(result.journal.phase).toBe('complete');
      expect(scannerReached).toBe(true);
      for (const scanner of [false, true])
        expect(hostReadinessConditions(result.results, scanner)).toContainEqual({
          kind: 'login_pending',
          reason: `${host === 'codex' ? 'Codex' : 'Cursor'} is still connecting. Finish the sign-in in the app, then run mnemonik status.`,
          action: 'mnemonik status',
        });
      expect(
        result.results.filter((r) => r.target.startsWith(`${host}:`)).map((r) => r.status)
      ).toEqual(['READY', 'ACTION_REQUIRED']);
      expect(result.results.find((r) => r.target.startsWith(`${host}:mcp:`))?.reason).toBe(
        'login_pending'
      );
      if (host === 'codex') {
        expect(
          result.results.filter((r) => r.target.startsWith('cursor:')).map((r) => r.status)
        ).toEqual(['READY', 'READY']);
        expect(await readFile(join(f.home, '.codex/config.toml'), 'utf8')).toContain(
          '# native hook trust'
        );
      }
      const owned = (await readOwnership(f.deps.stateDir)).targets;
      expect(owned.filter((t) => t.host === host).map((t) => t.component)).toEqual([
        'hooks',
        'mcp',
      ]);
      const path =
        host === 'codex' ? join(f.home, '.codex/hooks.json') : join(f.home, '.cursor/hooks.json');
      expect(await bytesAt(path)).not.toBeNull();
      expect(
        await readFile(
          owned.find((t) => t.host === host && t.component === 'mcp')!.profilePath,
          'utf8'
        )
      ).toContain('/mcp');
    },
    120000
  );

  it('re-reads pending Codex trust before the completion document and final host result', async () => {
    const f = await fixture();
    let checks = 0;
    overrideInspection(f.deps, 'codex', () => ({ trustPending: checks++ === 0 }));
    let completion = serializeReadiness({ installation: { conditions: [] } });
    const result = await runHosts(
      'install',
      targets(f, 'hooks').filter(({ host }) => host === 'codex'),
      {
        ...f.deps,
        afterHosts: async (journal, results, refreshHosts) => {
          await refreshHosts();
          completion = serializeReadiness({
            installation: { conditions: hostReadinessConditions(results, false) },
          });
          journal.data.state = completion.installation.state;
        },
      }
    );
    expect(checks).toBe(2);
    expect(completion.installation).toEqual({ state: 'READY', reasons: [], actions: [] });
    expect(result.results[0]).toMatchObject({ status: 'READY' });
    expect(JSON.stringify({ completion, results: result.results })).not.toContain(
      'codex_trust_pending'
    );
  }, 60_000);

  it.each(['pending', 'partially rolled back'])(
    'Resume replaces a %s host proposal in the original journal',
    async (phase) => {
      const f = await fixture();
      const selected = targets(f, 'hooks').filter(({ host }) => host === 'claude-code');
      const path = join(f.home, '.claude/settings.json');
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, '{"foreign":true}\n');
      const id = `claude-code:hooks:user:${f.home}`;
      let runId = '';
      await withInstall(
        f.deps.stateDir,
        {
          account: f.deps.account,
          hosts: ['claude-code'],
          components: ['hooks'],
          roots: [],
          scopes: {},
          credentials: [],
          joined: true,
          hostRequest: { command: 'install', selections: selected, allowMigration: false },
          hostRuns: [
            { id, host: 'claude-code', status: phase === 'pending' ? 'pending' : 'complete' },
          ],
        },
        undefined,
        async (journal) => {
          runId = journal.data.runId;
          const target = await journal.plan(path, Buffer.from('{"partial":true}\n'), {
            kind: 'host',
            host: 'claude-code',
            group: id,
          });
          await journal.commit(target);
          if (phase !== 'pending') {
            await journal.restore(target);
            await writeFile(path, '{"foreign":"native app edit"}\n');
          }
          journal.data.phase = phase === 'pending' ? 'applying' : 'rolling_back';
          await journal.save();
        }
      );
      const result = await runHosts('install', selected, {
        ...f.deps,
        afterHosts: async (journal) => {
          journal.data.state = 'READY';
        },
        recovery: async () => 'resume',
        rollbackInstall: async () => {
          throw new Error('unexpected rollback');
        },
      });
      expect(result.journal.runId).toBe(runId);
      expect(result.results[0]?.status).toBe('READY');
      expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
        foreign: phase === 'pending' ? true : 'native app edit',
        hooks: expect.any(Object),
      });
      expect((await readOwnership(f.deps.stateDir)).targets).toHaveLength(1);
    },
    90000
  );

  it('scanner skip after three hosts uses the same journal', async () => {
    const f = await fixture();
    const selected = targets(f, 'hooks').filter(({ host }) => host !== 'grok');
    for (const selection of selected) {
      const path =
        selection.host === 'claude-code'
          ? join(f.home, '.claude/settings.json')
          : selection.host === 'codex'
            ? join(f.home, '.codex/config.toml')
            : join(f.home, '.cursor/hooks.json');
      await mkdir(dirname(path), { recursive: true });
      const bytes = Buffer.from(
        selection.host === 'codex' ? '# foreign setting\n' : '{"foreign":true}\n'
      );
      await writeFile(path, bytes);
    }
    const identity = join(f.home, 'repo/.mnemonik.json');
    let scannerReached = false;
    const afterHosts = async (journal: import('../src/install/journal.js').Journal) => {
      scannerReached = true;
      const target = await journal.plan(identity, Buffer.from('{"projectId":"created"}\n'), {
        kind: 'project',
      });
      await journal.commit(target);
      journal.data.reports.push('Scanner was skipped. Run mnemonik scanner enable to try again.');
      journal.data.state = 'LIMITED';
    };
    const result = await runHosts('install', selected, {
      ...f.deps,
      afterHosts,
    } as typeof f.deps);
    expect(scannerReached).toBe(true);
    expect(result.journal.phase).toBe('complete');
    expect((await readOwnership(f.deps.stateDir)).targets).toHaveLength(3);
    expect(result.reports.join(' ')).toContain('Scanner was skipped');
    expect(result.journal.state).toBe('LIMITED');
  }, 180_000);
});

describe('host rulings', () => {
  it('status reports a changed Codex command through the real adapter', async () => {
    const f = await fixture();
    await runHosts(
      'install',
      targets(f, 'hooks').filter(({ host }) => host === 'codex'),
      f.deps
    );
    const owned = (await readOwnership(f.deps.stateDir)).targets.find(
      ({ host }) => host === 'codex'
    )!;
    const { hooksJson } = await readHooksJson(owned.profilePath);
    const states = Object.entries(hooksJson.hooks!)
      .flatMap(([event, groups]) =>
        groups.flatMap((group, i) =>
          group.hooks!.map(
            (hook, j) =>
              `[hooks.state.${JSON.stringify(`${owned.profilePath}:${event.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()}:${i}:${j}`)}]\ntrusted_hash = "${codexHookHash(event, group, hook)}"`
          )
        )
      )
      .join('\n');
    await writeFile(join(dirname(owned.profilePath), 'config.toml'), states);
    hooksJson.hooks!.SessionStart![0]!.hooks![0]!.command += ' --harmless';
    await writeFile(owned.profilePath, JSON.stringify(hooksJson));
    for (const args of [['status'], ['status', '--json']]) {
      const stdout = capture();
      expect(
        await runCli(args, {
          home: f.home,
          cwd: f.projectRoot,
          stdout,
          hostManagement: f.deps,
          preflight: {
            nodeVersion: '24.21.0',
            pathExists: async () => false,
            fetch: async () => new Response('{}'),
            resolveIdentity: async () => ({
              kind: 'absent',
              root: f.projectRoot,
              repository: { kind: 'plain', root: f.projectRoot },
              nested: [],
            }),
          },
        })
      ).toBe(3);
      expect(stdout.text).toContain(
        'Run the codex command in a terminal and use its hook trust prompt to allow the Mnemonik hooks; then quit and reopen Codex.'
      );
      if (args.includes('--json')) expect(stdout.text).toContain('codex_trust_pending');
    }
  }, 120_000);

  it('reports verified hooks READY, missing declarations ACTION_REQUIRED, and Codex trust first', async () => {
    const f = await fixture();
    const selected = targets(f, 'hooks').filter(({ host }) => host !== 'grok');
    await runHosts('install', selected, f.deps);
    const hosts = selected.map(({ host }) => host);
    let conditions = await hookStatusConditions(f.deps, hosts);
    expect(
      buildStatusDocument({
        installationConditions: conditions,
        projectHookConditions: conditions,
        scannerStatus: { roots: [], exclusions: [], repositories: [] },
      }).installation.state
    ).toBe('READY');

    const claude = (await readOwnership(f.deps.stateDir)).targets.find(
      ({ host }) => host === 'claude-code'
    )!;
    await rm(claude.profilePath);
    conditions = await hookStatusConditions(f.deps, hosts);
    expect(conditions.find(({ component }) => component === 'claude-code')).toEqual({
      kind: 'hooks_missing',
      component: 'claude-code',
      reason: 'claude-code hook declaration is missing.',
      action: 'mnemonik repair --host claude-code --component hooks',
    });
    expect(buildStatusDocument({ installationConditions: conditions }).installation.state).toBe(
      'ACTION_REQUIRED'
    );

    await runHosts('repair', [claude], f.deps);
    await createCredentialAdapter({ stateDir: f.deps.stateDir }).forget();
    conditions = await hookStatusConditions(f.deps, hosts);
    expect(conditions.find(({ component }) => component === 'claude-code')?.reason).toBe(
      'claude-code hook credential family is missing or revoked.'
    );

    overrideInspection(f.deps, 'codex', () => ({ trustPending: true }));
    conditions = await hookStatusConditions(f.deps, hosts);
    expect(conditions.find(({ component }) => component === 'codex')).toMatchObject({
      kind: 'host_trust_pending',
      reason: 'codex_trust_pending',
    });
  }, 120_000);

  it('uses device authorization while reopening an install session with --no-browser', async () => {
    const f = await fixture();
    const installation = '11111111-1111-4111-8111-111111111111';
    secretStore.current = Object.assign(new SimulatedSecretStore(true), {
      kind: 'credential-manager' as const,
    });
    await createCliCredentials({ stateDir: f.deps.stateDir }).putCliOAuth(
      {
        issuer: 'https://issuer.example.test',
        clientId: 'cli-client',
        familyId: 'cli-family',
        scopes: [],
        lastRotationTime: new Date().toISOString(),
      },
      {
        accessToken: 'private-token',
        refreshToken: 'private-refresh',
        accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      }
    );
    const list = f.deps.grants!.list;
    f.deps.grants!.list = async () => ({
      ...(await list()),
      deviceInstallationId: installation,
    });
    f.deps.timeout = async () => 'cancel';
    let requests = 0;
    f.deps.credentialFetch = vi.fn(async () => {
      if (requests++ === 0)
        return Response.json({ error: 'install_session_required' }, { status: 403 });
      if (requests === 2) return new Response(null, { status: 404 });
      throw new Error('authorization_transport_reached');
    });
    createCliAuthOptions.mockClear();
    const stdout = capture();
    const result = await runCli(
      [
        'install',
        '--no-browser',
        '--hosts=claude-code',
        '--components=hooks',
        '--integration-scope=user',
        '--accept-limited',
        '--apply',
        '--non-interactive',
      ],
      {
        home: f.home,
        cwd: f.projectRoot,
        installStateDir: f.deps.stateDir,
        stdout,
        cliAuth: {
          getCliBearer: async () => 'initial-cli-bearer',
          signIn: async () => {},
          logout: async () => {},
        },
        hostManagement: f.deps,
        preflight: {
          nodeVersion: '24.21.0',
          pathExists: async () => false,
          fetch: async () => new Response('{}'),
          resolveIdentity: async () => ({
            kind: 'absent',
            root: f.projectRoot,
            repository: { kind: 'plain', root: f.projectRoot },
            nested: [],
          }),
        },
      }
    );

    expect(result).toBe(3);
    expect(stdout.text).toContain('hook_credential_authorization_required');
    expect(createCliAuthOptions).toHaveBeenCalledWith(expect.objectContaining({ noBrowser: true }));
  }, 60_000);

  it('reopens an expired install session once and keeps the hook target READY', async () => {
    const f = await fixture();
    const installation = '11111111-1111-4111-8111-111111111111';
    const authorizeInstallSession = vi.fn(async (id: string) => {
      expect(id).toBe(installation);
      return 'reopened-cli-bearer';
    });
    const deps = f.deps as typeof f.deps & {
      authorizeInstallSession?: (installationId: string) => Promise<string>;
    };
    deps.authorizeInstallSession = authorizeInstallSession;
    const list = deps.grants!.list;
    deps.grants!.list = async () => ({ ...(await list()), deviceInstallationId: installation });
    let issuance = 0;
    deps.credentialFetch = vi.fn(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/v1/install-sessions/current') return new Response(null, { status: 404 });
      expect(path).toBe('/api/v1/component-credentials');
      if (issuance++ === 0)
        return Response.json({ error: 'install_session_required' }, { status: 403 });
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer reopened-cli-bearer');
      return Response.json(
        {
          id: 'reopened-hook-family',
          access_token: 'hook-access',
          refresh_token: 'hook-refresh',
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_expires_in: 7200,
          scope: 'hooks:use',
          display_prefix: 'hook',
        },
        { status: 201 }
      );
    });

    const selection = {
      ...f.selections.find((candidate) => candidate.host === 'claude-code')!,
      component: 'hooks' as const,
    };
    const result = await runHosts('install', [selection], deps);

    expect(result.results[0]).toMatchObject({ status: 'READY', reason: 'hooks_not_verified' });
    expect(issuance).toBe(2);
    expect(authorizeInstallSession).toHaveBeenCalledOnce();
    expect(authorizeInstallSession).toHaveBeenCalledWith(installation);
    expect((await readOwnership(deps.stateDir)).targets[0]).toMatchObject({
      host: 'claude-code',
      credentialFamily: 'reopened-hook-family',
    });
  }, 60_000);

  it('rolls the hook target back after install-session reopening still gets a 403', async () => {
    const f = await fixture();
    const installation = '11111111-1111-4111-8111-111111111111';
    const authorizeInstallSession = vi.fn(async () => 'reopened-cli-bearer');
    const deps = f.deps as typeof f.deps & {
      authorizeInstallSession?: (installationId: string) => Promise<string>;
    };
    deps.authorizeInstallSession = authorizeInstallSession;
    const list = deps.grants!.list;
    deps.grants!.list = async () => ({ ...(await list()), deviceInstallationId: installation });
    deps.credentialFetch = vi.fn(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/v1/install-sessions/current') return new Response(null, { status: 404 });
      return Response.json({ error: 'install_session_required' }, { status: 403 });
    });
    const config = join(f.home, '.claude', 'settings.json');
    const before = Buffer.from('{"foreign":true}\n');
    await mkdir(dirname(config), { recursive: true });
    await writeFile(config, before);
    const selection = {
      ...f.selections.find((candidate) => candidate.host === 'claude-code')!,
      component: 'hooks' as const,
    };

    const result = await runHosts('install', [selection], deps);

    expect(result.results[0]).toMatchObject({
      status: 'ACTION_REQUIRED',
      reason: 'hook_credential_authorization_required',
      action: 'Run `mnemonik auth login --reopen-install` to start a new install session',
    });
    expect(authorizeInstallSession).toHaveBeenCalledOnce();
    expect(deps.credentialFetch).toHaveBeenCalledTimes(3);
    expect(await readFile(config)).toEqual(before);
    expect((await readOwnership(deps.stateDir)).targets).toEqual([]);
    expect(await bytesAt(new RuntimeStore(deps.stateDir).pointerPath('claude-code'))).toBeNull();
  }, 60_000);

  it('surfaces the authorization failure when interactive reopening fails', async () => {
    const f = await fixture();
    const installation = '11111111-1111-4111-8111-111111111111';
    const deps = f.deps as typeof f.deps & {
      authorizeInstallSession?: (installationId: string) => Promise<string>;
    };
    deps.authorizeInstallSession = vi.fn(async () => {
      throw new Error('oauth_callback_timeout');
    });
    const list = deps.grants!.list;
    deps.grants!.list = async () => ({ ...(await list()), deviceInstallationId: installation });
    deps.credentialFetch = vi.fn(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/v1/install-sessions/current') return new Response(null, { status: 404 });
      return Response.json({ error: 'install_session_required' }, { status: 403 });
    });
    const selection = {
      ...f.selections.find((candidate) => candidate.host === 'claude-code')!,
      component: 'hooks' as const,
    };

    const result = await runHosts('install', [selection], deps);

    expect(result.results[0]).toMatchObject({
      status: 'ACTION_REQUIRED',
      reason: 'hook_credential_authorization_required',
      detail: 'oauth_callback_timeout',
      action: 'Run `mnemonik auth login --reopen-install` to start a new install session',
    });

    const stdout = capture();
    expect(
      await runCli(
        [
          'install',
          '--hosts=claude-code',
          '--components=hooks',
          '--integration-scope=user',
          '--accept-limited',
          '--apply',
        ],
        {
          home: f.home,
          cwd: f.home,
          stdout,
          hostManagement: deps,
          cliAuth: {
            getCliBearer: async () => 'valid-cli-bearer',
            signIn: async () => {},
            logout: async () => {},
          },
        }
      )
    ).toBe(3);
    expect(stdout.text).toContain(
      'ACTION_REQUIRED (hook_credential_authorization_required: oauth_callback_timeout)'
    );
  }, 60_000);

  it('reopens from the non-interactive action command and retries to READY', async () => {
    const f = await fixture();
    const installation = '11111111-1111-4111-8111-111111111111';
    const list = f.deps.grants!.list;
    f.deps.grants!.list = async () => ({
      ...(await list()),
      deviceInstallationId: installation,
    });
    let reopened = false;
    f.deps.credentialFetch = vi.fn(async () => {
      if (!reopened) return Response.json({ error: 'install_session_required' }, { status: 403 });
      return Response.json(
        {
          id: 'reopened-hook-family',
          access_token: 'hook-access',
          refresh_token: 'hook-refresh',
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_expires_in: 7200,
          scope: 'hooks:use',
          display_prefix: 'hook',
        },
        { status: 201 }
      );
    });
    const selection = {
      ...f.selections.find((candidate) => candidate.host === 'claude-code')!,
      component: 'hooks' as const,
    };

    const first = await runHosts('install', [selection], f.deps);

    expect(first.results[0]).toMatchObject({
      status: 'ACTION_REQUIRED',
      reason: 'hook_credential_authorization_required',
      action: 'Run `mnemonik auth login --reopen-install` to start a new install session',
    });
    expect(f.deps.credentialFetch).toHaveBeenCalledOnce();

    const signIn = vi.fn(async () => {
      reopened = true;
    });
    expect(
      await runCli(['auth', 'login', '--reopen-install'], {
        stdout: capture(),
        cliAuth: {
          getCliBearer: async () => 'valid-cli-bearer',
          signIn,
          logout: async () => {},
        },
        grantFetch: async (input) => {
          if (new URL(String(input)).pathname === '/api/v1/install-sessions/current')
            return new Response(null, { status: 404 });
          expect(new URL(String(input)).pathname).toBe('/api/v1/auth/grants');
          return Response.json({
            account: 'owner',
            grants: [],
            deviceInstallationId: installation,
          });
        },
      })
    ).toBe(0);
    expect(signIn).toHaveBeenCalledOnce();

    const second = await runHosts('install', [selection], f.deps);
    expect(second.results[0]).toMatchObject({ status: 'READY' });
  }, 60_000);

  it('unsupported versions and absent hosts write no state and give exact recovery actions while supported hosts proceed', async () => {
    const first = await fixture();
    await first.hostOutput('codex', 'codex-cli 0.144.9');
    const protectedPaths = [
      join(first.home, '.codex', 'hooks.json'),
      join(first.home, '.claude', 'settings.json'),
      join(first.home, '.cursor', 'hooks.json'),
      join(first.home, '.grok', 'hooks', 'hooks.json'),
    ];
    for (const path of protectedPaths) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, '{"foreign":true}\n');
    }
    const before = await Promise.all(
      protectedPaths.map(async (path) => digest(await readFile(path)))
    );
    const result = await runHosts('install', targets(first, 'hooks'), first.deps);

    expect(result.results.find((row) => row.target.startsWith('codex:'))).toMatchObject({
      status: 'ACTION_REQUIRED',
      reason: 'unsupported_version',
      action: 'upgrade codex to 0.145.0 and retry',
    });
    expect(result.results.filter((row) => row.status === 'READY')).toHaveLength(3);
    expect(digest(await readFile(protectedPaths[0]!))).toBe(before[0]);
    expect(await bytesAt(new RuntimeStore(first.deps.stateDir).pointerPath('codex'))).toBeNull();
    await expect(
      stat(
        join(
          dirname(new RuntimeStore(first.deps.stateDir).pointerPath('codex')),
          packed.sources.codex.manifest.version
        )
      )
    ).rejects.toMatchObject({ code: 'ENOENT' });

    const second = await fixture();
    await Promise.all(['claude', 'cursor', 'grok'].map((binary) => rm(join(second.bin, binary))));
    const unverified = await runHosts('install', targets(second, 'hooks'), second.deps);
    expect(unverified.results.find((row) => row.target.startsWith('codex:'))?.status).toBe('READY');
    for (const host of ['claude-code', 'cursor', 'grok'] as const) {
      const row = unverified.results.find((candidate) => candidate.target.startsWith(`${host}:`));
      expect(row).toMatchObject({
        status: 'ACTION_REQUIRED',
        reason: 'not_found',
        action:
          host === 'cursor'
            ? 'Cursor was not found (looked on PATH and in /usr/share/cursor/bin/cursor, /opt/Cursor/resources/app/bin/cursor). Install it, or open a new terminal if you just installed it.'
            : `${host === 'claude-code' ? 'Claude Code' : 'Grok'} was not found on PATH. Install it, or open a new terminal if you just installed it.`,
      });
      expect(await bytesAt(new RuntimeStore(second.deps.stateDir).pointerPath(host))).toBeNull();
      await expect(
        stat(
          join(
            dirname(new RuntimeStore(second.deps.stateDir).pointerPath(host)),
            packed.sources[host].manifest.version
          )
        )
      ).rejects.toMatchObject({ code: 'ENOENT' });
    }
  }, 180_000);

  it('keeps the exact Codex command array through pending trust, update, repair, rollback and scope change', async () => {
    const f = await fixture();
    const user = {
      ...f.selections.find((selection) => selection.host === 'codex')!,
      component: 'hooks' as const,
    };
    let trust: 'pending' | 'approved' | 'declined' = 'pending';
    overrideInspection(f.deps, 'codex', () => ({
      trustPending: trust === 'pending',
      trustDeclined: trust === 'declined',
    }));

    const installed = await runHosts('install', [user], f.deps);
    expect(installed.results[0]).toMatchObject({
      status: 'ACTION_REQUIRED',
      reason: 'codex_trust_pending',
      action:
        'Run the codex command in a terminal and use its hook trust prompt to allow the Mnemonik hooks; then quit and reopen Codex.',
    });
    const owned = (await readOwnership(f.deps.stateDir)).targets[0]!;
    const launcher = join(dirname(owned.runtimePointer), 'launcher.mjs');
    const exact = Array(5).fill(
      `node ${JSON.stringify(launcher)} --credential-family hook-family --server https://api.mnemonik.dev --mnemonik-owner=codex-hooks`
    );
    expect(await codexCommands(owned.profilePath)).toEqual(exact);

    trust = 'approved';
    f.deps.source = async () => bump(packed.sources.codex);
    await runHosts('update', [owned], f.deps);
    let current = (await readOwnership(f.deps.stateDir)).targets[0]!;
    expect(await codexCommands(current.profilePath)).toEqual(exact);

    await runHosts('repair', [current], f.deps);
    current = (await readOwnership(f.deps.stateDir)).targets[0]!;
    expect(await codexCommands(current.profilePath)).toEqual(exact);

    trust = 'declined';
    f.deps.source = async () => bump(packed.sources.codex, '100.0.0');
    const declined = await runHosts('update', [current], f.deps);
    expect(declined.results[0]).toMatchObject({
      status: 'ACTION_REQUIRED',
      reason: 'codex_trust_declined',
    });
    expect(await codexCommands(current.profilePath)).toEqual(exact);
    expect((await new RuntimeStore(f.deps.stateDir).verifyRuntime('codex')).manifest.version).toBe(
      '99.0.0'
    );

    trust = 'approved';
    f.deps.source = async () => bump(packed.sources.codex);
    await runHosts('install', [{ ...user, scope: 'project' }], f.deps, true);
    current = (await readOwnership(f.deps.stateDir)).targets[0]!;
    expect(current.scope).toBe('project');
    expect(await codexCommands(current.profilePath)).toEqual(exact);
  }, 180_000);

  it('preserves native policy and foreign hook entries by value through update, repair and scope change', async () => {
    const f = await fixture();
    const selections = targets(f, 'hooks');
    const claude = join(f.home, '.claude', 'settings.json');
    const cursor = join(f.home, '.cursor', 'hooks.json');
    const grok = join(f.home, '.grok', 'hooks', 'hooks.json');
    await mkdir(dirname(claude), { recursive: true });
    await mkdir(dirname(cursor), { recursive: true });
    await mkdir(dirname(grok), { recursive: true });
    const permissions = { allow: ['Bash(git status)'], deny: ['Read(.env)'] };
    const cursorForeign = { command: '/opt/cursor-policy --keep', timeout: 9 };
    const grokForeign = { type: 'command', command: '/opt/grok-policy --keep' };
    await writeFile(claude, JSON.stringify({ permissions }, null, 2) + '\n');
    await writeFile(
      cursor,
      JSON.stringify({ version: 1, hooks: { preToolUse: [cursorForeign] } }, null, 2) + '\n'
    );
    await writeFile(
      grok,
      JSON.stringify({ hooks: { PreToolUse: [{ hooks: [grokForeign] }] } }, null, 2) + '\n'
    );
    await runHosts('install', selections, f.deps);

    f.deps.source = async (host) => bump(packed.sources[host]);
    await runHosts('update', (await readOwnership(f.deps.stateDir)).targets, f.deps);
    await runHosts('repair', (await readOwnership(f.deps.stateDir)).targets, f.deps);
    const user = (await readOwnership(f.deps.stateDir)).targets;
    await runHosts(
      'install',
      user.map((selection) => ({ ...selection, scope: 'project' as const })),
      f.deps,
      true
    );

    expect(JSON.parse(await readFile(claude, 'utf8')).permissions).toEqual(permissions);
    expect(JSON.parse(await readFile(cursor, 'utf8')).hooks.preToolUse).toContainEqual(
      cursorForeign
    );
    expect(JSON.parse(await readFile(grok, 'utf8')).hooks.PreToolUse[0].hooks).toContainEqual(
      grokForeign
    );
  }, 240_000);
});

describe('host state matrix', () => {
  it('commits an unchanged proposal without replacing the file and still writes changed bytes', async () => {
    const f = await fixture();
    const unchanged = join(f.home, 'unchanged.json');
    const changed = join(f.home, 'changed.json');
    await Promise.all([writeFile(unchanged, 'same\n'), writeFile(changed, 'before\n')]);
    await Promise.all([utimes(unchanged, 1, 1), utimes(changed, 1, 1)]);
    const before = await stat(unchanged);
    const changedBefore = await stat(changed);

    const targets = await withInstall(
      f.deps.stateDir,
      {
        account: 'owner',
        components: [],
        hosts: [],
        scopes: {},
        roots: [],
        credentials: [],
      },
      undefined,
      async (journal) => {
        const same = await journal.plan(unchanged, Buffer.from('same\n'), { kind: 'host' });
        const different = await journal.plan(changed, Buffer.from('after\n'), { kind: 'host' });
        await journal.stage(same);
        await journal.stage(different);
        await journal.commit(same);
        await journal.commit(different);
        return { same, different, mutations: journal.data.mutations };
      }
    );

    const after = await stat(unchanged);
    expect({ ino: after.ino, mtimeMs: after.mtimeMs }).toEqual({
      ino: before.ino,
      mtimeMs: before.mtimeMs,
    });
    expect(targets.same.status).toBe('committed');
    expect(targets.mutations).toContainEqual(
      expect.objectContaining({ event: 'commit_written', target: targets.same.id })
    );
    expect(await readFile(changed, 'utf8')).toBe('after\n');
    expect((await stat(changed)).ino).not.toBe(changedBefore.ino);
    expect(targets.different.status).toBe('committed');
  });

  it('clean: installs hooks and MCP for four hosts as eight READY targets', async () => {
    const f = await fixture();
    const result = await runHosts(
      'install',
      f.selections.flatMap((selection) => [
        { ...selection, component: 'hooks' as const },
        { ...selection, component: 'mcp' as const },
      ]),
      f.deps
    );
    expect(result.results).toHaveLength(8);
    expect(result.results.every((row) => row.status === 'READY')).toBe(true);
    expect(result.journal.state).toBe('READY');
    const owned = (await readOwnership(f.deps.stateDir)).targets;
    expect(owned).toHaveLength(8);
    expect(owned.find((target) => target.host === 'claude-code')?.editorVersion).toBe('1.0.100');
  }, 300_000);

  it.each([false, true])(
    'maintenance verification: update checks three connected hosts without waiting (revoked: %s)',
    async (revoked) => {
      const f = await fixture();
      const selections = f.selections.filter((selection) => selection.host !== 'grok');
      await runHosts(
        'install',
        selections.flatMap((selection) => [
          { ...selection, component: 'hooks' as const },
          { ...selection, component: 'mcp' as const },
        ]),
        f.deps
      );
      const before = await readOwnership(f.deps.stateDir);
      const imports = f.deps.imports ?? hostPackageImports;
      let clock = 0;
      const verify = vi.fn(async () => {
        clock += 7;
        return { declarationPresent: true, authenticatedTools: false };
      });
      const launch = vi.fn(async () => 'Open the editor.');
      for (const { host } of selections) {
        f.deps.imports = {
          ...(f.deps.imports ?? imports),
          [host]: async (runtime: Verified) => {
            const module = await imports[host](runtime);
            return {
              createHostAdapter(deps?: AdapterDependencies) {
                return { ...module.createHostAdapter(deps), verify, launch };
              },
            };
          },
        } as HostPackageImports;
      }
      if (revoked) await f.deps.grants!.revoke('grant-codex');
      f.deps.now = () => clock;
      const sleep = vi.fn(async (ms: number) => {
        clock += ms;
      });
      f.deps.sleep = sleep;
      const list = vi.spyOn(f.deps.grants!, 'list');
      f.deps.source = async (host) => bump(packed.sources[host]);
      const result = await runHosts('update', before.targets, f.deps);
      expect(result.results.map(({ status, reason }) => ({ status, reason }))).toEqual(
        before.targets.map((target) => ({
          status:
            revoked && target.host === 'codex' && target.component === 'mcp'
              ? 'ACTION_REQUIRED'
              : 'READY',
          reason:
            revoked && target.host === 'codex' && target.component === 'mcp'
              ? 'host_grant_unverified'
              : 'hooks_not_verified',
        }))
      );
      expect(sleep).not.toHaveBeenCalled();
      expect(launch).not.toHaveBeenCalled();
      expect(verify).toHaveBeenCalledTimes(6);
      expect(list).toHaveBeenCalledTimes(3);
      expect(result.results.map((row) => row.elapsedMs)).toEqual([7, 7, 7, 7, 7, 7]);
      const journal = JSON.parse(
        await readFile(
          join(f.deps.stateDir, 'install', result.journal.runId, 'journal.json'),
          'utf8'
        )
      );
      expect(journal.hostRuns.map((run: { elapsedMs: number }) => run.elapsedMs)).toEqual([
        7, 7, 7, 7, 7, 7,
      ]);
      if (revoked)
        expect(result.results.find((row) => row.reason === 'host_grant_unverified')?.action).toBe(
          'Run mnemonik connect codex.'
        );
    },
    120_000
  );

  it('upgrade: advances hosts independently and rolls one failed native verification back with mixed results', async () => {
    const f = await fixture();
    await runHosts('install', targets(f, 'hooks'), f.deps);
    const before = await readOwnership(f.deps.stateDir);
    const cursor = before.targets.find((target) => target.host === 'cursor')!;
    const cursorBytes = await readFile(cursor.profilePath);
    f.deps.source = async (host) => bump(packed.sources[host]);
    overrideInspection(f.deps, 'cursor', () => ({ declarationPresent: false }));

    const result = await runHosts('update', before.targets, f.deps);
    const after = await readOwnership(f.deps.stateDir);
    expect(result.results.filter((row) => row.status === 'READY')).toHaveLength(3);
    expect(result.results.find((row) => row.target === cursor.id)).toMatchObject({
      status: 'ACTION_REQUIRED',
      reason: 'hooks_missing',
      elapsedMs: expect.any(Number),
    });
    expect(after.targets.find((target) => target.id === cursor.id)?.version).toBe(cursor.version);
    expect(await readFile(cursor.profilePath)).toEqual(cursorBytes);
    expect(after.targets.filter((target) => target.version === '99.0.0')).toHaveLength(3);
  }, 240_000);

  it('update with READY targets exits zero', async () => {
    const f = await fixture();
    await runHosts('install', targets(f, 'hooks'), f.deps);
    f.deps.source = async (host) => bump(packed.sources[host]);
    f.deps.now = Date.now;
    const stdout = capture();
    expect(
      await runCli(['update', '--json'], {
        home: f.home,
        hostManagement: f.deps,
        stdout,
      })
    ).toBe(0);
    expect(
      JSON.parse(stdout.text).targets.every(
        (row: { elapsedMs: number }) => Number.isFinite(row.elapsedMs) && row.elapsedMs > 0
      )
    ).toBe(true);
  }, 240_000);

  it.each([true, false])(
    'Desktop update requires an activated grant: %s',
    async (active) => {
      const f = await fixture();
      const selection = f.selections.find((selection) => selection.host === 'cursor')!;
      await runHosts(
        'install',
        [
          { ...selection, component: 'hooks' },
          { ...selection, component: 'mcp' },
        ],
        f.deps
      );
      if (!active) f.grants.find((grant) => grant.clientName === 'cursor')!.activatedAt = null;
      f.deps.source = async () => bump(packed.sources.cursor);
      const stdout = capture();
      const exit = await runCli(['update', '--json'], {
        home: f.home,
        hostManagement: f.deps,
        stdout,
      });
      const output = JSON.parse(stdout.text);
      expect(exit).toBe(active ? 0 : 3);
      const mcp = output.targets.find((row: { target: string }) => row.target.includes(':mcp:'));
      expect(mcp).toMatchObject(
        active
          ? { status: 'READY' }
          : { status: 'ACTION_REQUIRED', reason: 'host_grant_unverified' }
      );
      if (!active) expect(mcp.action).toBe('Run mnemonik connect cursor.');
    },
    120_000
  );

  it('partial: resumes the remaining two hosts from the journal without re-staging the completed two', async () => {
    const f = await fixture();
    let intents = 0;
    f.deps.fault = (event) => {
      if (event === 'host_intent' && ++intents === 3) throw new Error('stop_after_two');
    };
    await expect(runHosts('install', targets(f, 'hooks'), f.deps)).rejects.toThrow(
      'stop_after_two'
    );
    expect((await readOwnership(f.deps.stateDir)).targets).toHaveLength(2);
    expect(await interrupted(f.deps.stateDir)).toHaveLength(1);

    const plans = new Map(hostOrder.map((host) => [host, 0]));
    f.deps.fault = undefined;
    f.deps.imports = Object.fromEntries(
      hostOrder.map((host) => [
        host,
        async (runtime: Parameters<HostPackageImports[typeof host]>[0]) => {
          const module = await hostPackageImports[host](runtime);
          return {
            createHostAdapter(adapterDeps: Parameters<typeof module.createHostAdapter>[0]) {
              const adapter = module.createHostAdapter(adapterDeps);
              const plan = adapter.plan.bind(adapter);
              adapter.plan = async (target) => {
                plans.set(host, plans.get(host)! + 1);
                return plan(target);
              };
              return adapter;
            },
          };
        },
      ])
    ) as HostPackageImports;
    const resumed = await runHosts('install', targets(f, 'hooks'), f.deps);
    expect(resumed.results).toHaveLength(4);
    expect([...plans.values()]).toEqual([0, 0, 1, 1]);
    expect((await readOwnership(f.deps.stateDir)).targets).toHaveLength(4);
  }, 180_000);

  it('conflicting: adds our Claude hook beside a foreign one and refuses a foreign Mnemonik MCP URL', async () => {
    const f = await fixture();
    const settings = join(f.home, '.claude', 'settings.json');
    const mcp = join(f.home, '.claude.json');
    const foreignHook = { type: 'command', command: '/opt/foreign-policy', timeout: 17 };
    await mkdir(dirname(settings), { recursive: true });
    await writeFile(
      settings,
      JSON.stringify(
        { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [foreignHook] }] } },
        null,
        2
      ) + '\n'
    );
    const foreignMcp = { type: 'http', url: 'https://foreign.invalid/mcp', note: 'keep' };
    await writeFile(mcp, JSON.stringify({ mcpServers: { mnemonik: foreignMcp } }, null, 2) + '\n');
    const beforeMcp = await readFile(mcp);

    const selection = f.selections.find((candidate) => candidate.host === 'claude-code')!;
    const result = await runHosts(
      'install',
      [
        { ...selection, component: 'hooks' },
        { ...selection, component: 'mcp' },
      ],
      f.deps
    );
    expect(result.results.map((row) => row.status)).toEqual(['READY', 'ACTION_REQUIRED']);
    expect(result.results[1]).toMatchObject({ reason: 'mcp_name_conflict' });
    expect(JSON.parse(await readFile(settings, 'utf8')).hooks.PreToolUse[0].hooks).toContainEqual(
      foreignHook
    );
    expect(await readFile(mcp)).toEqual(beforeMcp);
  }, 90_000);

  it('trust-denied: restores staged Codex files and leaves another host untouched', async () => {
    const f = await fixture();
    const codexPath = join(f.home, '.codex', 'hooks.json');
    await mkdir(dirname(codexPath), { recursive: true });
    const original = Buffer.from('{"foreign":"codex"}\n');
    await writeFile(codexPath, original);
    overrideInspection(f.deps, 'codex', () => ({ trustDeclined: true }));
    const selected = targets(f, 'hooks').filter((selection) =>
      ['codex', 'claude-code'].includes(selection.host)
    );
    const result = await runHosts('install', selected, f.deps);
    expect(result.results.find((row) => row.target.startsWith('codex:'))).toMatchObject({
      status: 'ACTION_REQUIRED',
      reason: 'codex_trust_declined',
      action: 'Approve the Mnemonik hook in Codex.',
    });
    expect(await readFile(codexPath)).toEqual(original);
    expect(result.results.find((row) => row.target.startsWith('claude-code:'))?.status).toBe(
      'READY'
    );
    expect(await readFile(join(f.home, '.claude', 'settings.json'), 'utf8')).toContain(
      'mnemonik-owner'
    );
  }, 90_000);

  it('policy-disabled: repair requires action before restoring Codex hooks and --apply re-enables them', async () => {
    const f = await fixture();
    const codex = targets(f, 'hooks').find((selection) => selection.host === 'codex')!;
    await runHosts('install', [codex], f.deps);
    const config = join(f.home, '.codex', 'config.toml');
    await writeFile(
      config,
      (await readFile(config, 'utf8')).replace('hooks = true', 'hooks = false')
    );
    const stdout = capture();
    const common = { home: f.home, hostManagement: f.deps, stdout };
    expect(
      await runCli(
        ['repair', '--host', 'codex', '--component', 'hooks', '--non-interactive', '--json'],
        common
      )
    ).toBe(3);
    expect(JSON.parse(stdout.text).targets[0]).toMatchObject({
      status: 'ACTION_REQUIRED',
      reason: 'codex_hooks_policy_disabled',
    });
    expect(await readFile(config, 'utf8')).toContain('hooks = false');

    stdout.text = '';
    expect(
      await runCli(
        [
          'repair',
          '--host',
          'codex',
          '--component',
          'hooks',
          '--non-interactive',
          '--json',
          '--apply',
        ],
        common
      )
    ).toBe(0);
    expect(JSON.parse(stdout.text).targets[0].status).toBe('READY');
    expect(await readFile(config, 'utf8')).toContain('hooks = true');
  }, 90_000);

  it('project-shared collaborator: adopts an identical declaration and refuses a different unowned one', async () => {
    const f = await fixture();
    const project = targets(f, 'hooks')
      .filter((selection) => ['claude-code', 'cursor'].includes(selection.host))
      .map((selection) => ({ ...selection, scope: 'project' as const }));
    await runHosts('install', project, f.deps);
    const record = await readOwnership(f.deps.stateDir);
    const claude = record.targets.find((target) => target.host === 'claude-code')!;
    const cursor = record.targets.find((target) => target.host === 'cursor')!;
    const claudeBytes = await readFile(claude.profilePath);
    const claudeStat = await stat(claude.profilePath);
    await replaceJson(cursor.profilePath, (json) => {
      for (const groups of Object.values(json.hooks as Record<string, any[]>))
        for (const hook of groups as any[])
          if (typeof hook.command === 'string' && hook.command.includes('mnemonik-owner'))
            hook.command = hook.command.replace(
              '--credential-family hook-family',
              '--credential-family colleague-family'
            );
    });
    const cursorBytes = await readFile(cursor.profilePath);
    await writeFile(
      ownershipPath(f.deps.stateDir),
      JSON.stringify({ schemaVersion: 1, generation: record.generation, targets: [] }, null, 2) +
        '\n'
    );

    const result = await runHosts('install', project, f.deps);
    expect(result.results.find((row) => row.target.startsWith('claude-code:'))?.status).toBe(
      'READY'
    );
    expect(result.results.find((row) => row.target.startsWith('cursor:'))).toMatchObject({
      status: 'ACTION_REQUIRED',
      reason: 'project_shared_declaration_conflict',
    });
    expect(await readFile(claude.profilePath)).toEqual(claudeBytes);
    expect((await stat(claude.profilePath)).mtimeMs).toBe(claudeStat.mtimeMs);
    expect(result.journal.targets.some((target) => target.path === claude.profilePath)).toBe(false);
    expect(await readFile(cursor.profilePath)).toEqual(cursorBytes);
  }, 120_000);

  it('install-time account switch: leaves the host target unbound and gives the sign-out step', async () => {
    const f = await fixture();
    f.setGrantAccount('other-account');
    const selection = {
      ...f.selections.find((candidate) => candidate.host === 'claude-code')!,
      component: 'mcp' as const,
    };
    const result = await runHosts('install', [selection], f.deps);
    expect(result.results[0]).toMatchObject({
      status: 'ACTION_REQUIRED',
      reason: 'host_account_mismatch',
    });
    expect(result.results[0]?.action).toContain('Sign out of Mnemonik in claude-code');
    const owned = (await readOwnership(f.deps.stateDir)).targets[0]!;
    expect(owned.grant).toBeUndefined();
    expect(await readFile(owned.profilePath, 'utf8')).toContain('https://api.mnemonik.dev/mcp');
  }, 60_000);

  it('later-profile account switch: warns with the second profile and leaves the first binding unchanged', async () => {
    const f = await fixture();
    const base = {
      ...f.selections.find((candidate) => candidate.host === 'codex')!,
      component: 'mcp' as const,
    };
    await runHosts('install', [{ ...base }], f.deps);
    const first = (await readOwnership(f.deps.stateDir)).targets[0]!;
    f.deps.env = { ...f.deps.env, CODEX_HOME: join(f.home, 'other-codex') };
    f.setGrantAccount('other-account');
    const result = await runHosts('install', [{ ...base }], f.deps);
    const second = (await readOwnership(f.deps.stateDir)).targets.find(
      (target) => target.profilePath !== first.profilePath
    )!;
    expect(result.results[0]).toMatchObject({
      status: 'ACTION_REQUIRED',
      reason: 'host_account_mismatch',
    });
    expect(result.results[0]?.action).toContain(second.profilePath);
    expect(
      (await readOwnership(f.deps.stateDir)).targets.find((target) => target.id === first.id)?.grant
    ).toEqual(first.grant);
    expect(second.grant).toBeUndefined();
  }, 90_000);

  it('CLI/host mismatch: mocked consume refuses changed root evidence and writes no identity', async () => {
    const f = await fixture();
    const expectedHash = 'a'.repeat(64);
    const recomputedHash = 'b'.repeat(64);
    const consume = vi.fn(async (input: { deviceRootContext: { hash: string } }) =>
      input.deviceRootContext.hash === expectedHash
        ? { status: 'complete' as const, projectId: randomUUID(), displayName: 'repo' }
        : {
            status: 'ACTION_REQUIRED' as const,
            state: 'context_mismatch',
            allowedActions: ['retry', 'cancel'],
          }
    );
    const executor = createProjectSetupExecutor({
      resolver: {
        resolveProjectIdentity: async () => ({
          kind: 'absent' as const,
          root: f.projectRoot,
          repository: {
            kind: 'git' as const,
            root: f.projectRoot,
            gitDir: join(f.projectRoot, '.git'),
            commonDir: join(f.projectRoot, '.git'),
            isLinkedWorktree: false,
            nested: [],
          },
          nested: [],
        }),
      },
      transport: {
        issueSetupRequest: async () => ({
          status: 'project_setup_required' as const,
          state: 'missing',
          allowedActions: ['create', 'cancel'],
          requestId: randomUUID(),
        }),
        consumeSetupRequest: consume as any,
      },
      scopeKey: 'owner:device',
      bindContext: async () => ({
        deviceRootContext: { algorithmVersion: 1, hash: recomputedHash },
        repositoryFingerprint: null,
      }),
      stateDir: f.deps.stateDir,
    });
    const result = await executor.ensureProject({
      cwd: f.projectRoot,
      allowCreate: true,
      allowNestedInherit: false,
    });
    expect(result).toMatchObject({ status: 'ACTION_REQUIRED', state: 'context_mismatch' });
    expect(consume).toHaveBeenCalledOnce();
    expect(await bytesAt(join(f.projectRoot, '.mnemonik.json'))).toBeNull();
  });

  it('repair: restores one hand-edited and one deleted owned file while keeping foreign entries', async () => {
    const f = await fixture();
    const selected = targets(f, 'hooks').filter((selection) =>
      ['claude-code', 'cursor'].includes(selection.host)
    );
    await runHosts('install', selected, f.deps);
    const owned = await readOwnership(f.deps.stateDir);
    const claude = owned.targets.find((target) => target.host === 'claude-code')!;
    const cursor = owned.targets.find((target) => target.host === 'cursor')!;
    const permissions = { allow: ['Bash(git diff)'], deny: ['Read(.env)'] };
    await replaceJson(claude.profilePath, (json) => {
      json.permissions = permissions;
      json.hooks = {};
    });
    await rm(cursor.profilePath);

    const result = await runHosts('repair', owned.targets, f.deps);
    expect(result.results.every((row) => row.status === 'READY')).toBe(true);
    expect(JSON.parse(await readFile(claude.profilePath, 'utf8')).permissions).toEqual(permissions);
    expect(await readFile(claude.profilePath, 'utf8')).toContain('mnemonik-owner');
    expect(await readFile(cursor.profilePath, 'utf8')).toContain('mnemonik-owner');
  }, 90_000);

  it('uninstall: recovery counts an already removed target as READY and exits zero', async () => {
    const f = await fixture();
    const selected = targets(f, 'hooks').slice(0, 2);
    await runHosts('install', selected, f.deps);
    let intents = 0;
    f.deps.fault = (event) => {
      if (event === 'host_intent' && ++intents === 2) throw new Error('stop_after_uninstall');
    };
    await expect(runHosts('uninstall', selected, f.deps)).rejects.toThrow('stop_after_uninstall');
    expect((await readOwnership(f.deps.stateDir)).targets).toHaveLength(1);
    f.deps.fault = undefined;
    const stdout = capture();
    const exit = await runCli(['uninstall', '--non-interactive', '--confirm', '--json'], {
      home: f.home,
      hostManagement: f.deps,
      stdout,
    });
    expect(exit).toBe(0);
    expect(JSON.parse(stdout.text).targets).toEqual([
      expect.objectContaining({ status: 'READY', reason: 'uninstalled' }),
      expect.objectContaining({ status: 'READY', reason: 'uninstalled' }),
    ]);
    expect((await readOwnership(f.deps.stateDir)).targets).toEqual([]);
  }, 120_000);

  it('uninstall: removes hosts, scanner and launcher in one pass and reports every result', async () => {
    const f = await fixture();
    await runHosts('install', targets(f, 'hooks').slice(0, 1), f.deps);
    const launcher = { home: f.home, stateDir: f.deps.stateDir };
    await ensureLauncher(launcher);
    const pointer = new RuntimeStore(f.deps.stateDir).pointerPath('scanner');
    await mkdir(dirname(pointer), { recursive: true });
    await writeFile(pointer, 'pointer');
    const operations: ServiceOperation[] = [];
    const command = vi.fn(async (operation: ServiceOperation): Promise<ServiceResult> => {
      operations.push(operation);
      expect((await readOwnership(f.deps.stateDir)).targets).toEqual([]);
      expect((await launcherStatus(launcher)).ownership).toBe('ours');
      return {
        status: 'ok',
        supervisor: {
          kind: 'systemd',
          installed: operation !== 'uninstall',
          running: false,
          pid: null,
        },
      };
    });
    const stdout = capture();

    expect(
      await runCli(['uninstall', '--non-interactive', '--confirm', '--json'], {
        home: f.home,
        hostManagement: f.deps,
        scannerService: { stateDir: f.deps.stateDir, command },
        launcher,
        stdout,
      })
    ).toBe(0);

    expect(operations).toEqual(['stop', 'uninstall']);
    expect((await launcherStatus(launcher)).ownership).toBe('missing');
    expect(JSON.parse(stdout.text)).toMatchObject({
      targets: [expect.objectContaining({ status: 'READY', reason: 'uninstalled' })],
      scanner: { status: 'uninstalled' },
      launcher: { status: 'removed' },
    });
  }, 120_000);

  it('uninstall: keeps the launcher and reports failure when scanner removal fails', async () => {
    const f = await fixture();
    await runHosts('install', targets(f, 'hooks').slice(0, 1), f.deps);
    const launcher = { home: f.home, stateDir: f.deps.stateDir };
    await ensureLauncher(launcher);
    const pointer = new RuntimeStore(f.deps.stateDir).pointerPath('scanner');
    await mkdir(dirname(pointer), { recursive: true });
    await writeFile(pointer, 'pointer');
    const stdout = capture();
    const stderr = capture();

    expect(
      await runCli(['uninstall', '--non-interactive', '--confirm', '--json'], {
        home: f.home,
        hostManagement: f.deps,
        scannerService: {
          stateDir: f.deps.stateDir,
          command: async () => {
            throw new Error('scanner_uninstall_failed');
          },
        },
        launcher,
        stdout,
        stderr,
      })
    ).toBe(1);

    expect((await launcherStatus(launcher)).ownership).toBe('ours');
    expect(JSON.parse(stdout.text)).toMatchObject({
      status: 'FAILED',
      targets: [expect.objectContaining({ status: 'READY', reason: 'uninstalled' })],
      scanner: { status: 'failed', reason: expect.stringContaining('scanner_uninstall_failed') },
      launcher: { status: 'retained' },
    });
    expect(stderr.text).toContain('scanner_uninstall_failed');
  }, 120_000);

  it('uninstall: removes all owned declarations and runtime pointers but keeps foreign and other-scope files without revoking grants', async () => {
    const f = await fixture();
    const all = f.selections.flatMap((selection) => [
      { ...selection, component: 'hooks' as const },
      { ...selection, component: 'mcp' as const },
    ]);
    await runHosts('install', all, f.deps);
    const owned = await readOwnership(f.deps.stateDir);
    const otherScope = join(f.projectRoot, '.claude', 'settings.json');
    await mkdir(dirname(otherScope), { recursive: true });
    const otherBytes = Buffer.from('{"foreignProject":true}\n');
    await writeFile(otherScope, otherBytes);
    for (const target of owned.targets) {
      if (target.profilePath.endsWith('.json'))
        await replaceJson(target.profilePath, (json) => {
          json.foreignPolicy = { keep: target.host };
        });
      else
        await writeFile(
          target.profilePath,
          `${await readFile(target.profilePath, 'utf8')}\n[foreign_policy]\nkeep = ${JSON.stringify(target.host)}\n`
        );
    }
    const foreignBefore = await Promise.all(
      [...new Set(owned.targets.map((target) => target.profilePath))].map(async (path) => ({
        path,
        host: owned.targets.find((target) => target.profilePath === path)!.host,
      }))
    );
    const stdout = capture();
    expect(
      await runCli(['uninstall', '--non-interactive', '--confirm'], {
        home: f.home,
        hostManagement: f.deps,
        stdout,
      })
    ).toBe(0);

    expect((await readOwnership(f.deps.stateDir)).targets).toEqual([]);
    for (const host of hostOrder)
      expect(await bytesAt(new RuntimeStore(f.deps.stateDir).pointerPath(host))).toBeNull();
    for (const entry of foreignBefore) {
      const raw = await readFile(entry.path, 'utf8');
      expect(raw).toContain('foreign');
      expect(raw).not.toContain('mnemonik-owner');
      expect(raw).not.toContain('api.mnemonik.dev/mcp');
    }
    expect(await readFile(otherScope)).toEqual(otherBytes);
    expect(f.revoked).toEqual([]);
    expect(f.grants).toHaveLength(4);
  }, 300_000);
});
