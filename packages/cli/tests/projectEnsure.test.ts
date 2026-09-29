import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SetupTransport } from '@mnemonik/local-setup';
import type { resolveProjectIdentity } from '@mnemonik/shared';
import { Readable } from 'node:stream';
import { PROJECT_ENSURE_DEADLINE_MS, projectExecutor } from '../src/project.js';
import {
  createServerTransport,
  PROJECT_REQUEST_TIMEOUT_MS,
  ServerActionRequiredError,
} from '../src/transport/server.js';
import { runCli } from '../src/router.js';

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
// The CLI shows a path inside the home directory as ~, and the isolated
// fixture puts its temporary directories there. The home directory itself is
// reported as it is.
const shown = (path: string) => path.replace(`${homedir()}/`, '~/');

describe('project ensure --agent --json', () => {
  it('prints the exact action when no credential adapter exists', async () => {
    const stdout = capture();
    expect(
      await runCli(['project', 'ensure', '--agent', '--json'], { stdout, stderr: stdout })
    ).toBe(3);
    expect(stdout.text).toBe(
      '{"status":"action_required","reason":"not_signed_in","action":"mnemonik install"}\n'
    );
  });

  it('prints the local-setup result with injected identity and authenticated transports', async () => {
    const base = await mkdtemp(join(tmpdir(), 'mnemonik-cli-ensure-'));
    dirs.push(base);
    const root = join(base, 'repo');
    await mkdir(root);
    const projectId = randomUUID();
    // The shared resolver's shape for a git repository with no identity file yet.
    const resolver: { resolveProjectIdentity: typeof resolveProjectIdentity } = {
      resolveProjectIdentity: async () => ({
        kind: 'absent',
        root,
        repository: {
          kind: 'git',
          root,
          commonDir: join(root, '.git'),
          isLinkedWorktree: false,
          nested: [],
        },
        nested: [],
      }),
    };
    const transport: SetupTransport = {
      issueSetupRequest: async () => ({
        status: 'project_setup_required',
        state: 'missing',
        allowedActions: ['create'],
        requestId: randomUUID(),
      }),
      consumeSetupRequest: async () => ({ status: 'complete', projectId, displayName: 'repo' }),
    };
    const executor = projectExecutor({
      resolver,
      transport,
      scopeKey: 'user:device',
      bindContext: async () => ({
        deviceRootContext: { algorithmVersion: 1, hash: 'a'.repeat(64) },
        repositoryFingerprint: null,
      }),
      stateDir: join(base, 'state'),
    });
    const stdout = capture();
    expect(
      await runCli(['project', 'ensure', '--agent', '--json'], {
        cwd: root,
        stdout,
        stderr: stdout,
        projectExecutor: executor,
      })
    ).toBe(0);
    expect(JSON.parse(stdout.text)).toMatchObject({
      status: 'done',
      root: shown(root),
      projectId,
    });
  });

  it.each(['home', 'temp', 'host-config', 'broad-workspace'])(
    'returns the exact init action without a create-capable request from %s',
    async (kind) => {
      const base = await mkdtemp(join(tmpdir(), 'mnemonik-cli-ensure-skip-'));
      dirs.push(base);
      let root = join(base, 'plain');
      await mkdir(root);
      if (kind === 'home') root = homedir();
      if (kind === 'temp') root = tmpdir();
      if (kind === 'host-config') root = join(homedir(), '.codex');
      if (kind === 'broad-workspace') {
        await Promise.all(
          ['one', 'two'].map((name) => mkdir(join(root, name, '.git'), { recursive: true }))
        );
      }
      const resolution = {
        kind: 'absent' as const,
        root,
        repository: { kind: 'plain' as const, root },
        nested: [],
      };
      const ensureProject = vi.fn();
      const stdout = capture();
      expect(
        await runCli(['project', 'ensure', '--agent', '--json'], {
          cwd: root,
          stdout,
          stderr: stdout,
          projectExecutor: {
            resolveProjectIdentity: async () => resolution,
            ensureProject,
            stage: vi.fn(),
            apply: vi.fn(),
            rollback: vi.fn(),
          },
        })
      ).toBe(3);
      expect(JSON.parse(stdout.text)).toMatchObject({
        status: 'action_required',
        action: 'mnemonik project init <path>',
        root: shown(root),
      });
      expect(ensureProject).not.toHaveBeenCalled();
    }
  );

  it('sets up a folder that is not a Git repository like any other folder', async () => {
    const base = await mkdtemp(join(tmpdir(), 'mnemonik-cli-ensure-plain-'));
    dirs.push(base);
    const root = join(base, 'plain');
    await mkdir(root);
    const projectId = randomUUID();
    const ensureProject = vi.fn(async () => ({
      status: 'done' as const,
      operationId: 'operation',
      root,
      projectId,
      permissionStatus: 'private' as const,
    }));
    const stdout = capture();

    expect(
      await runCli(['project', 'ensure', '--agent', '--json'], {
        cwd: root,
        stdout,
        stderr: stdout,
        projectExecutor: {
          resolveProjectIdentity: async () => ({
            kind: 'absent' as const,
            root,
            repository: { kind: 'plain' as const, root },
            nested: [],
          }),
          ensureProject,
          stage: vi.fn(),
          apply: vi.fn(),
          rollback: vi.fn(),
        },
      } as unknown as Parameters<typeof runCli>[1])
    ).toBe(0);

    expect(ensureProject).toHaveBeenCalledOnce();
    expect(JSON.parse(stdout.text)).toMatchObject({ status: 'done', projectId });
  });
});

// Review of CQ-033: project-setup requests had no timeout, so a server that
// accepted the connection and never answered held `project ensure` (the hook's
// detached helper) forever. Each request now ends as `unreachable` (retry).
describe('project-setup requests to a server that never answers', () => {
  const hanging = vi.fn(
    (_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      )
  );
  const transport = (extra: Partial<Parameters<typeof createServerTransport>[0]> = {}) =>
    createServerTransport({
      apiBase: 'https://api.example',
      fetch: hanging as unknown as typeof fetch,
      getCliBearer: async () => 'token',
      issueContext: async () => {
        throw new Error('unused');
      },
      ...extra,
    });

  it('fit inside the helper supervisor: request bound and ensure deadline', () => {
    expect(PROJECT_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(PROJECT_ENSURE_DEADLINE_MS);
    expect(PROJECT_ENSURE_DEADLINE_MS).toBeLessThan(30_000);
  });

  it('a request is abandoned at its bound and reported unreachable', async () => {
    hanging.mockClear();
    const failure = await transport({ requestTimeoutMs: 50 })
      .accountContext()
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ServerActionRequiredError);
    expect((failure as ServerActionRequiredError).result).toMatchObject({ state: 'unreachable' });
    expect(hanging).toHaveBeenCalledTimes(1);
  });

  it('past the deadline nothing is sent', async () => {
    hanging.mockClear();
    const failure = await transport({ deadline: Date.now() - 1 })
      .accountContext()
      .catch((error: unknown) => error);
    expect((failure as ServerActionRequiredError).result).toMatchObject({ state: 'unreachable' });
    expect(hanging).not.toHaveBeenCalled();
  });

  it('project ensure --agent ends with the retryable action', async () => {
    const base = await mkdtemp(join(tmpdir(), 'mnemonik-cli-ensure-hang-'));
    dirs.push(base);
    const stdout = capture();
    const started = Date.now();
    const code = await runCli(['project', 'ensure', '--agent', '--json'], {
      stdout,
      stderr: stdout,
      cwd: base,
      input: Readable.from([JSON.stringify({ requestId: randomUUID() })]),
      grantFetch: hanging as unknown as typeof fetch,
      cliAuth: { getCliBearer: async () => 'token' } as never,
      projectStateDir: join(base, 'state'),
    });
    expect(code).toBe(3);
    expect(JSON.parse(stdout.text)).toEqual({
      status: 'action_required',
      reason: 'unreachable',
      action: 'retry',
    });
    expect(Date.now() - started).toBeLessThan(PROJECT_REQUEST_TIMEOUT_MS + 3_000);
  }, 15_000);
});
