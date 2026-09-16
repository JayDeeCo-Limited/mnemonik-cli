import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SetupTransport } from '@mnemonik/local-setup';
import type { resolveProjectIdentity } from '@mnemonik/shared';
import { projectExecutor } from '../src/project.js';
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
    expect(JSON.parse(stdout.text)).toMatchObject({ status: 'done', root, projectId });
  });

  it.each(['home', 'temp', 'host-config', 'broad-workspace', 'plain'])(
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
        root: kind === 'host-config' ? '~/.codex' : root,
      });
      expect(ensureProject).not.toHaveBeenCalled();
    }
  );
});
