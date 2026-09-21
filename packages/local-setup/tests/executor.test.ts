import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import lockfile from 'proper-lockfile';
import {
  parseIdentityFile,
  readIdentityFile,
  resolveRepositoryRoot,
  resolveProjectIdentity,
  selectRemote,
  protectedLocalPaths,
  type ProjectIdentityResolution,
} from '@mnemonik/shared';
import { RuntimeError } from '@mnemonik/shared/hook-runtime';
import { runIdentityFixtureSuite } from '../../shared/test-fixtures/identity/runner.mjs';
import {
  createProjectSetupExecutor,
  recordPath,
  stateDirectory,
  protectStateFile,
  withLock,
  type SetupRecord,
  type SetupTransport,
  type ConsumeInput,
  type SetupRequired,
} from '../src/index.js';
import type {
  consumeSetupSchema,
  SetupRequired as ServerSetupRequired,
  consumeSetupRequest,
} from '../../../src/agent/projectSetup.js';
import type { z } from 'zod';

const dirs: string[] = [];
const execFile = promisify(execFileCallback);
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const evidence = {
  deviceRootContext: { algorithmVersion: 1 as const, hash: 'a'.repeat(64) },
  repositoryFingerprint: null,
};
const projectId = '12345678-1234-4234-8234-123456789012';
const existing = Buffer.from(
  '{ "schemaVersion": 1, "projectId": "12345678-1234-4234-8234-123456789012" }\r\n'
);

/** Fixture only: production injects the resolver; never substitute path-name heuristics. */
class FixtureResolver {
  constructor(public resolution: ProjectIdentityResolution) {}
  async resolveProjectIdentity(): Promise<ProjectIdentityResolution> {
    return this.resolution;
  }
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'local-setup-'));
  dirs.push(dir);
  const root = join(dir, 'repo');
  await mkdir(root);
  const stateDir = join(dir, 'state');
  const resolver = new FixtureResolver({
    kind: 'absent',
    root,
    repository: { kind: 'plain', root },
    nested: [],
  });
  const operations = new Map<string, string>();
  const issued: SetupRequired & ServerSetupRequired = {
    status: 'project_setup_required',
    state: 'missing',
    allowedActions: ['link', 'create', 'cancel'],
    requestId: randomUUID(),
    expiresAt: new Date(Date.now() + 120000).toISOString(),
  };
  const transport = {
    issueSetupRequest: vi.fn(async (input: { projectId?: string }) =>
      input.projectId
        ? { status: 'complete' as const, projectId: input.projectId, displayName: 'repo' }
        : { ...issued, requestId: randomUUID() }
    ),
    consumeSetupRequest: vi.fn(async (input: ConsumeInput) => {
      const wire: z.input<typeof consumeSetupSchema> = input; // exact server request compatibility
      if (!operations.has(wire.operationId!))
        operations.set(wire.operationId!, operations.size ? randomUUID() : projectId);
      const response: Awaited<ReturnType<typeof consumeSetupRequest>> = {
        status: 'complete',
        projectId: operations.get(wire.operationId!)!,
        displayName: 'repo',
      };
      return response;
    }),
  } satisfies SetupTransport;
  const options = {
    cwd: root,
    allowCreate: true,
    allowNestedInherit: false,
    nonGitSelected: true as const,
  };
  const deps = {
    resolver,
    transport,
    scopeKey: 'user:device',
    bindContext: async () => evidence,
    stateDir,
  };
  const record = async () =>
    JSON.parse(await readFile(recordPath(root, stateDir), 'utf8')) as SetupRecord;
  return {
    root,
    stateDir,
    resolver,
    operations,
    transport,
    options,
    deps,
    record,
    file: join(root, '.mnemonik.json'),
  };
}

async function gitRepository(root: string, remote?: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await execFile('git', ['init', '--quiet'], { cwd: root });
  if (remote) await execFile('git', ['remote', 'add', 'origin', remote], { cwd: root });
}

it('records whether a completed remote step created or linked the retained UUID', async () => {
  const created = await fixture();
  await createProjectSetupExecutor(created.deps).stage(created.options);
  expect((await created.record()).steps.remote).toMatchObject({ outcome: 'created' });
  const linked = await fixture();
  await createProjectSetupExecutor(linked.deps).stage({
    ...linked.options,
    intent: { action: 'link', projectId },
  });
  expect((await linked.record()).steps.remote).toMatchObject({ outcome: 'linked' });
});

it('replaces an effect-free stale context for the same folder', async () => {
  const f = await fixture();
  const confirmation = {
    status: 'project_setup_required',
    state: 'confirmation_required',
    allowedActions: ['link', 'cancel'],
    candidates: [{ projectId, displayName: 'repo' }],
    requestId: randomUUID(),
    expiresAt: new Date(Date.now() + 120000).toISOString(),
  } satisfies SetupRequired;
  f.transport.issueSetupRequest.mockResolvedValueOnce(confirmation);
  const executor = createProjectSetupExecutor(f.deps);
  expect(
    await executor.stage({
      ...f.options,
      owner: { teamId: '22222222-2222-4222-8222-222222222222' },
      allowCreate: false,
    })
  ).toBe(confirmation);
  const staleOperation = (await f.record()).operationId;

  expect(await executor.ensureProject({ ...f.options, owner: 'personal' })).toMatchObject({
    status: 'done',
    projectId,
  });
  expect((await f.record()).operationId).not.toBe(staleOperation);
  expect(f.transport.consumeSetupRequest).toHaveBeenCalledTimes(1);
  expect(JSON.parse(await readFile(f.file, 'utf8')).projectId).toBe(projectId);
});

it('refuses to write every project UUID the shared identity parser refuses', async () => {
  const f = await fixture();
  const invalid = 'ABCDEF12-ABCD-4ABC-8ABC-ABCDEF123456';
  expect(parseIdentityFile(JSON.stringify({ schemaVersion: 1, projectId: invalid })).kind).toBe(
    'malformed'
  );
  f.transport.consumeSetupRequest.mockResolvedValueOnce({
    status: 'complete',
    projectId: invalid,
    displayName: 'repo',
  });
  expect(await createProjectSetupExecutor(f.deps).ensureProject(f.options)).toMatchObject({
    status: 'ACTION_REQUIRED',
    state: 'invalid_server_result',
  });
  await expect(readFile(f.file)).rejects.toMatchObject({ code: 'ENOENT' });
});

async function realGitFixture(remote?: string) {
  const f = await fixture();
  await gitRepository(f.root, remote);
  const bindContext = async (root: string) => {
    const url = await execFile('git', ['remote', 'get-url', 'origin'], { cwd: root }).then(
      ({ stdout }) => stdout.trim(),
      () => ''
    );
    const selection = selectRemote(
      url ? [{ name: 'origin', fetchUrls: [url], pushUrls: [url] }] : []
    );
    return {
      deviceRootContext: evidence.deviceRootContext,
      repositoryFingerprint:
        selection.status === 'fingerprint'
          ? {
              algorithmVersion: selection.fingerprint.algorithmVersion,
              hash: selection.fingerprint.hash,
            }
          : null,
    };
  };
  const deps = {
    ...f.deps,
    resolver: { resolveProjectIdentity },
    bindContext,
  };
  const options = { ...f.options, nonGitSelected: undefined };
  return { ...f, deps, options };
}

describe('durable local setup', () => {
  it('requires and then remembers explicit non-git selection', async () => {
    const f = await fixture();
    const { nonGitSelected: _selection, ...withoutSelection } = f.options;
    expect(await createProjectSetupExecutor(f.deps).ensureProject(withoutSelection)).toMatchObject({
      status: 'ACTION_REQUIRED',
      state: 'non_git_selection_required',
      manualAction: 'mnemonik project init <path>',
    });
    expect(await readdir(f.stateDir).catch(() => [])).toEqual([]);
    await createProjectSetupExecutor(f.deps).stage(f.options);
    expect((await f.record()).nonGitSelected).toBe(true);
    expect(await createProjectSetupExecutor(f.deps).apply(withoutSelection)).toMatchObject({
      status: 'done',
    });
  });

  it('crash after remote create resumes saved UUID on explicit apply without another create', async () => {
    const f = await fixture();
    const fault = (point: string) => {
      if (point === 'after_remote_record') throw new Error('crash');
    };
    await expect(
      createProjectSetupExecutor({ ...f.deps, fault }).ensureProject(f.options)
    ).rejects.toThrow('crash');
    const before = await f.record();
    expect(before.remote?.projectId).toBe(projectId);
    expect(await readdir(f.root)).toEqual([]);
    const result = await createProjectSetupExecutor(f.deps).apply(f.options);
    expect(result).toMatchObject({ status: 'done', operationId: before.operationId, projectId });
    expect(f.transport.consumeSetupRequest).toHaveBeenCalledTimes(1);
    expect(f.operations.size).toBe(1);
    expect((await f.record()).steps.identity.complete).toBe(true);
  });

  it('offers the old UUID only as a candidate after a different repository replaces the path', async () => {
    const f = await realGitFixture('git@github.com:acme/old.git');
    await createProjectSetupExecutor(f.deps).ensureProject(f.options);
    await rm(f.root, { recursive: true, force: true });
    await gitRepository(f.root, 'git@github.com:acme/new.git');

    const result = await createProjectSetupExecutor(f.deps).ensureProject(f.options);

    expect(result).toMatchObject({
      status: 'project_setup_required',
      state: 'fingerprint_mismatch',
      candidates: [{ projectId }],
    });
    expect(await readFile(f.file).catch(() => null)).toBeNull();
    expect(f.transport.consumeSetupRequest).toHaveBeenCalledTimes(1);
  });

  it('canonical aliases reach the same record but never authorize its no-fingerprint UUID', async () => {
    const f = await realGitFixture();
    await createProjectSetupExecutor(f.deps).ensureProject(f.options);
    await unlink(f.file);
    const alias = join(f.root, '..', 'repo-alias');
    await symlink(f.root, alias, 'dir');
    const caseAlias = f.root.toUpperCase();
    const canonicalizingResolver = {
      resolveProjectIdentity: (cwd: string, options?: { allowNestedInherit?: boolean }) =>
        resolveProjectIdentity(cwd === caseAlias ? f.root : cwd, options),
    };

    for (const cwd of [alias, `${f.root}/`, caseAlias]) {
      const result = await createProjectSetupExecutor({
        ...f.deps,
        resolver: cwd === caseAlias ? canonicalizingResolver : f.deps.resolver,
      }).ensureProject({ ...f.options, cwd });
      expect(result).toMatchObject({
        status: 'project_setup_required',
        state: 'confirmation_required',
        candidates: [{ projectId }],
      });
      expect(await readFile(f.file).catch(() => null)).toBeNull();
    }
  });

  it('shows a changed origin as a fingerprint mismatch and does not rewrite identity', async () => {
    const f = await realGitFixture('https://github.com/acme/original.git');
    await createProjectSetupExecutor(f.deps).ensureProject(f.options);
    await unlink(f.file);
    await execFile('git', ['remote', 'set-url', 'origin', 'https://github.com/acme/changed.git'], {
      cwd: f.root,
    });

    expect(await createProjectSetupExecutor(f.deps).ensureProject(f.options)).toMatchObject({
      status: 'project_setup_required',
      state: 'fingerprint_mismatch',
      candidates: [{ projectId }],
    });
    expect(await readFile(f.file).catch(() => null)).toBeNull();
  });

  it('automatically resumes only when the saved versioned fingerprint still matches', async () => {
    const f = await realGitFixture('https://github.com/acme/unchanged.git');
    await createProjectSetupExecutor(f.deps).ensureProject(f.options);
    await unlink(f.file);

    expect(await createProjectSetupExecutor(f.deps).ensureProject(f.options)).toMatchObject({
      status: 'done',
      projectId,
    });
    expect(JSON.parse(await readFile(f.file, 'utf8')).projectId).toBe(projectId);
  });

  it.each([undefined, 'file:///tmp/rejected'])(
    'requires confirmation when the repository has no usable fingerprint (%s)',
    async (remote) => {
      const f = await realGitFixture(remote);
      await createProjectSetupExecutor(f.deps).ensureProject(f.options);
      await unlink(f.file);

      expect(await createProjectSetupExecutor(f.deps).ensureProject(f.options)).toMatchObject({
        status: 'project_setup_required',
        state: 'confirmation_required',
        candidates: [{ projectId }],
      });
      expect(await readFile(f.file).catch(() => null)).toBeNull();
    }
  );

  it('lost remote response replays the persisted operation ID and creates only once', async () => {
    const f = await fixture();
    const fault = (point: string) => {
      if (point === 'after_remote_response') throw new Error('lost response');
    };
    await expect(
      createProjectSetupExecutor({ ...f.deps, fault }).ensureProject(f.options)
    ).rejects.toThrow('lost response');
    await createProjectSetupExecutor(f.deps).ensureProject(f.options);
    expect(f.operations.size).toBe(1);
    const calls = f.transport.consumeSetupRequest.mock.calls;
    expect(calls[0]![0].operationId).toBe(calls[1]![0].operationId);
    expect(calls[0]![0].requestId).not.toBe(calls[1]![0].requestId);
  });

  it('permission failure after remote create resumes the same UUID and writes once', async () => {
    const f = await fixture();
    const writes = vi.fn();
    try {
      await expect(
        createProjectSetupExecutor({
          ...f.deps,
          fault: async (point) => {
            if (point === 'after_remote_response') {
              await chmod(f.root, 0o500);
              await writeFile(join(f.root, 'permission-check'), 'blocked');
            }
          },
        }).ensureProject(f.options)
      ).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      await chmod(f.root, 0o700);
    }
    const result = await createProjectSetupExecutor({
      ...f.deps,
      fault: (point) => {
        if (point === 'mid_write') writes();
      },
    }).ensureProject(f.options);
    expect(result).toMatchObject({ status: 'done', projectId });
    expect(JSON.parse(await readFile(f.file, 'utf8')).projectId).toBe(projectId);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(f.transport.consumeSetupRequest).toHaveBeenCalledTimes(2);
    const calls = f.transport.consumeSetupRequest.mock.calls;
    expect(calls[0]![0].operationId).toBe(calls[1]![0].operationId);
    expect(result).toMatchObject({ operationId: calls[0]![0].operationId });
    expect(f.operations.size).toBe(1);
  });

  it.each([null, existing])(
    'local identity-file write failure leaves prior bytes intact and reuses the UUID (%s)',
    async (prior) => {
      const f = await fixture();
      if (prior) await writeFile(f.file, prior);
      const fault = (point: string) => {
        if (point === 'mid_write') throw new Error('power loss');
      };
      await expect(
        createProjectSetupExecutor({ ...f.deps, fault }).ensureProject(f.options)
      ).rejects.toThrow('power loss');
      expect(await readFile(f.file).catch(() => null)).toEqual(prior);
      expect((await readdir(f.root)).filter((name) => name.endsWith('.tmp'))).toHaveLength(1);
      await createProjectSetupExecutor(f.deps).apply(f.options);
      expect(JSON.parse(await readFile(f.file, 'utf8')).projectId).toBe(projectId);
      expect(f.transport.consumeSetupRequest).toHaveBeenCalledTimes(1);
      expect(f.operations.size).toBe(1);
    }
  );

  it('ignores an inaccessible UUID until identity or access state changes', async () => {
    const f = await fixture();
    const identity = { schemaVersion: 1 as const, projectId };
    await writeFile(f.file, JSON.stringify(identity));
    f.resolver.resolution = {
      kind: 'ok',
      root: f.root,
      repository: { kind: 'plain', root: f.root },
      nested: [],
      identity,
    };
    const denied = {
      status: 'ACTION_REQUIRED' as const,
      state: 'not_found',
      allowedActions: ['switch_account', 'ask_owner', 'ignore', 'cancel'],
    };
    let access: Awaited<ReturnType<SetupTransport['issueSetupRequest']>> = denied;
    const executor = createProjectSetupExecutor({
      ...f.deps,
      transport: { ...f.transport, issueSetupRequest: async () => access },
    });
    expect(await executor.ensureProject(f.options)).toBe(denied);
    expect(await executor.ensureProject({ ...f.options, ignore: true })).toMatchObject({
      status: 'ignored',
      root: f.root,
    });
    expect(await executor.ensureProject(f.options)).toMatchObject({ status: 'ignored' });

    access = {
      status: 'complete',
      projectId,
      displayName: 'repo',
    };
    expect(await executor.ensureProject(f.options)).toMatchObject({ status: 'done', projectId });
    const settledIdentity = await readFile(f.file);

    access = denied;
    expect(await executor.ensureProject(f.options)).toBe(denied);
    expect(await executor.ensureProject({ ...f.options, ignore: true })).toMatchObject({
      status: 'ignored',
    });

    const changedId = randomUUID();
    await writeFile(f.file, JSON.stringify({ ...identity, projectId: changedId }));
    f.resolver.resolution = {
      ...f.resolver.resolution,
      identity: { ...identity, projectId: changedId },
    };
    expect(await executor.ensureProject(f.options)).toMatchObject({
      status: 'ACTION_REQUIRED',
      state: 'identity_changed',
    });

    await writeFile(f.file, settledIdentity);
    f.resolver.resolution = {
      ...f.resolver.resolution,
      identity,
    };
    expect(await executor.ensureProject(f.options)).toBe(denied);
    expect(await executor.ensureProject({ ...f.options, ignore: true })).toMatchObject({
      status: 'ignored',
    });
    expect(
      await createProjectSetupExecutor({
        ...f.deps,
        scopeKey: 'other-account:device',
      }).ensureProject(f.options)
    ).toMatchObject({ state: 'operation_context_changed' });
    expect((await f.record()).ignored).toBeUndefined();
  });

  it('rename before journal completion is recognized and does not rewrite the file', async () => {
    const f = await fixture();
    await expect(
      createProjectSetupExecutor({
        ...f.deps,
        fault: (point) => {
          if (point === 'after_identity_rename') throw new Error('crash');
        },
      }).ensureProject(f.options)
    ).rejects.toThrow('crash');
    const before = await stat(f.file);
    await createProjectSetupExecutor(f.deps).ensureProject(f.options);
    expect((await stat(f.file)).ino).toBe(before.ino);
    expect((await f.record()).steps.identity.complete).toBe(true);
  });

  it('concurrent sessions wait, share one operation and write the identity once', async () => {
    const f = await fixture();
    let unblock!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const fault = vi.fn(async (point: string) => {
      if (point === 'after_remote_record') {
        entered();
        await held;
      }
    });
    const first = createProjectSetupExecutor({ ...f.deps, fault }).ensureProject(f.options);
    await reached;
    let finished = false;
    const second = createProjectSetupExecutor({ ...f.deps, fault })
      .ensureProject(f.options)
      .then((r) => {
        finished = true;
        return r;
      });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(finished).toBe(false);
    unblock();
    expect(await first).toEqual(await second);
    expect(f.transport.consumeSetupRequest).toHaveBeenCalledTimes(1);
    expect(fault.mock.calls.filter(([point]) => point === 'mid_write')).toHaveLength(1);
  });

  it('dead process lock waits while fresh, then is reclaimed after heartbeat staleness', async () => {
    const f = await fixture();
    const path = recordPath(f.root, f.stateDir);
    await mkdir(join(f.stateDir, 'project-setup'), { recursive: true });
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import {withLock} from '@mnemonik/local-setup'; await withLock(process.argv[1], 200, async () => { console.log('locked'); await new Promise(() => {setInterval(()=>{},1000)}); });",
        path,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] }
    );
    try {
      await once(child.stdout!, 'data');
      child.kill('SIGKILL');
      await once(child, 'exit');
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    await expect(
      createProjectSetupExecutor({ ...f.deps, waitMs: 20 }).ensureProject(f.options)
    ).rejects.toEqual(new RuntimeError('lock_held'));
    const old = new Date(Date.now() - 31_000);
    await utimes(`${path}.lock`, old, old);
    expect(await createProjectSetupExecutor(f.deps).ensureProject(f.options)).toMatchObject({
      status: 'done',
    });
  });

  it.each(['generation', 'compromise'])(
    'rejects a lost %s even while the owner file still exists',
    async (cause) => {
      const f = await fixture();
      const path = recordPath(f.root, f.stateDir);
      const locked = vi.spyOn(lockfile, 'lock');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        await withLock(path, 200, async (assertOwned) => {
          await assertOwned();
          const owner = join(`${path}.lock`, 'owner');
          const generation = await readFile(owner, 'utf8');
          if (cause === 'generation') await writeFile(owner, randomUUID());
          else locked.mock.calls.at(-1)![1]!.onCompromised!(new Error('compromised'));
          await expect(assertOwned()).rejects.toThrow('lock_lost');
          if (cause === 'generation') await writeFile(owner, generation);
          await expect(assertOwned()).rejects.toThrow('lock_lost');
        });
        expect(await readdir(`${path}.lock`)).toEqual(['owner']);
      } finally {
        locked.mockRestore();
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    }
  );

  for (const v0 of [false, true]) {
    runIdentityFixtureSuite(
      (name, run) => {
        if (name === 'linked worktree resolves to the main root and identity')
          it(
            v0
              ? 'real worktree preserves v0 without remote calls'
              : 'real worktree writes only the main identity',
            run
          );
      },
      {
        parse: parseIdentityFile,
        read: readIdentityFile,
        resolveRoot: resolveRepositoryRoot,
        resolve: async (cwd) => {
          const resolved = await resolveProjectIdentity(cwd);
          if (resolved.kind !== 'ok') throw new Error('fixture must resolve');
          const f = await fixture();
          const mainFile = join(resolved.root, '.mnemonik.json');
          const linkedFile = join(cwd, '..', '.mnemonik.json');
          const linkedBefore = await readFile(linkedFile);
          if (v0)
            await writeFile(
              mainFile,
              JSON.stringify({ projectId: resolved.identity.projectId, projectName: 'v0' })
            );
          const before = await readFile(mainFile);
          const issueSetupRequest = vi.fn(async () => ({
            status: 'complete' as const,
            projectId,
            displayName: 'repo',
          }));
          const executor = createProjectSetupExecutor({
            ...f.deps,
            resolver: { resolveProjectIdentity },
            transport: { ...f.transport, issueSetupRequest },
          });
          const result = await executor.ensureProject({ ...f.options, cwd });
          if (v0) {
            expect(await readFile(mainFile)).toEqual(before);
            expect(result).toMatchObject({ status: 'ACTION_REQUIRED', state: 'unknown_version' });
            expect(f.transport.consumeSetupRequest).not.toHaveBeenCalled();
            expect(issueSetupRequest).not.toHaveBeenCalled();
            expect(await readdir(f.stateDir).catch(() => [])).toEqual([]);
          } else {
            expect(result).toMatchObject({ status: 'done', root: resolved.root });
            expect(JSON.parse(await readFile(mainFile, 'utf8')).projectId).toBe(projectId);
          }
          expect(await readFile(linkedFile)).toEqual(linkedBefore);
          return resolved;
        },
      }
    );
  }

  it('stage repairs completion after rename without rewriting identity', async () => {
    const f = await fixture();
    await expect(
      createProjectSetupExecutor({
        ...f.deps,
        fault: (point) => {
          if (point === 'after_identity_rename') throw new Error('crash');
        },
      }).ensureProject(f.options)
    ).rejects.toThrow('crash');
    const before = await stat(f.file);
    expect((await f.record()).steps.identity.complete).toBe(false);
    await createProjectSetupExecutor(f.deps).stage(f.options);
    expect((await f.record()).steps.identity.complete).toBe(true);
    expect((await stat(f.file)).ino).toBe(before.ino);
  });

  it.each([65536, 65537])('bounds original-byte retention at 64 KiB (%i)', async (size) => {
    const f = await fixture();
    const bytes = Buffer.concat([existing, Buffer.alloc(size - existing.length, ' ')]);
    await writeFile(f.file, bytes);
    const result = await createProjectSetupExecutor(f.deps).stage(f.options);
    const record = await f.record();
    expect(record.before.hash).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(record.before.base64).toBe(size > 65536 ? null : bytes.toString('base64'));
    if (size > 65536) {
      expect(result).toMatchObject({ state: 'identity_too_large' });
      expect(f.transport.issueSetupRequest).not.toHaveBeenCalled();
      expect(await createProjectSetupExecutor(f.deps).apply(f.options)).toMatchObject({
        state: 'identity_too_large',
      });
      expect(await createProjectSetupExecutor(f.deps).rollback(f.options)).toMatchObject({
        state: 'identity_too_large',
      });
    }
    expect(await readFile(f.file)).toEqual(bytes);
  });

  it('retains only a hash of authenticated scope', async () => {
    const f = await fixture();
    await createProjectSetupExecutor(f.deps).stage(f.options);
    expect((await f.record()).scopeKey).toBe(
      createHash('sha256').update(f.deps.scopeKey).digest('hex')
    );
    expect(JSON.stringify(await f.record())).not.toContain(f.deps.scopeKey);
  });

  it.each([
    'alice@example.com',
    'x'.repeat(201),
    'line\nbreak',
    'hidden\u007f',
    123,
    'Project café',
    'x'.repeat(200),
  ])('persists only a valid server display-name hint (%s)', async (displayName) => {
    const f = await fixture();
    const executor = createProjectSetupExecutor({
      ...f.deps,
      transport: {
        ...f.transport,
        consumeSetupRequest: async () => ({ status: 'complete', projectId, displayName }) as never,
      },
    });
    expect(await executor.ensureProject(f.options)).toMatchObject({ status: 'done' });
    const expected =
      typeof displayName === 'string' &&
      (displayName === 'Project café' || displayName.length === 200)
        ? displayName
        : undefined;
    expect((await f.record()).remote?.displayName).toBe(expected);
    expect(JSON.parse(await readFile(f.file, 'utf8')).projectName).toBe(expected);
  });

  it.each(['record', 'identity', 'rollback'] as const)(
    'paused lease holder cannot write %s after another process reclaims and rolls back',
    async (operation) => {
      const f = await fixture();
      await writeFile(f.file, existing);
      const executor = createProjectSetupExecutor(f.deps);
      if (operation === 'rollback') await executor.ensureProject(f.options);
      else if (operation === 'identity') await executor.stage(f.options);
      let enter!: () => void;
      let unblock!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        unblock = resolve;
      });
      // Suspend the holder's heartbeat as well as its operation. Age its lease by 31s below.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const holder = createProjectSetupExecutor({
        ...f.deps,
        fault: async (point) => {
          if (point === (operation === 'record' ? 'after_remote_record' : 'mid_write')) {
            enter();
            await gate;
          }
        },
      });
      const pending =
        operation === 'rollback'
          ? holder.rollback(f.options)
          : operation === 'identity'
            ? holder.apply(f.options)
            : holder.ensureProject(f.options);
      const outcome = pending.then(
        () => 'unexpected success',
        (error) => (error as Error).message
      );
      try {
        await entered;
        const path = recordPath(f.root, f.stateDir);
        const old = new Date(Date.now() - 31_000);
        await utimes(`${path}.lock`, old, old);
        const child = spawn(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `
          import { createProjectSetupExecutor } from '@mnemonik/local-setup';
          import { resolveProjectIdentity } from '@mnemonik/shared';
          const [root, stateDir] = process.argv.slice(1);
          const executor = createProjectSetupExecutor({resolver: {resolveProjectIdentity}, stateDir,
            scopeKey: 'user:device', bindContext: async () => {throw new Error('unexpected bind')},
            transport: {}});
          const result = await executor.rollback({cwd: root, allowCreate: true, allowNestedInherit: false});
          if (result.status !== 'rolled_back') throw new Error(JSON.stringify(result));
        `,
            f.root,
            f.stateDir,
          ],
          { stdio: ['ignore', 'ignore', 'pipe'] }
        );
        let stderr = '';
        child.stderr!.on('data', (data) => {
          stderr += data;
        });
        const [code] = await once(child, 'exit');
        expect(stderr).toBe('');
        expect(code).toBe(0);
        const journal = await readFile(path);
        expect(await readFile(f.file)).toEqual(existing);
        unblock();
        expect(await outcome).toBe('lock_lost');
        expect(await readFile(path)).toEqual(journal);
        expect(await readFile(f.file)).toEqual(existing);
      } finally {
        unblock();
        await outcome;
        vi.useRealTimers();
      }
    }
  );

  it.each([
    'candidate_confirmation_required',
    'not_found',
    'archived',
    'quota',
    'context_mismatch',
    'conflict',
  ])('returns server action %s unchanged without identity writes', async (state) => {
    const f = await fixture();
    const response = {
      status: 'ACTION_REQUIRED' as const,
      state,
      allowedActions: ['link', 'cancel'],
      candidates: [{ projectId, displayName: 'repo' }],
    };
    const executor = createProjectSetupExecutor({
      ...f.deps,
      transport: { ...f.transport, consumeSetupRequest: async () => response },
    });
    expect(await executor.ensureProject(f.options)).toBe(response);
    expect(await readdir(f.root)).toEqual([]);
    expect((await f.record()).remote).toBeUndefined();
  });

  it('passes issuance candidates through and never consumes or persists the request ID', async () => {
    const f = await fixture();
    const response: SetupRequired = {
      status: 'project_setup_required',
      state: 'ambiguous',
      allowedActions: ['link', 'cancel'],
      requestId: randomUUID(),
      candidates: [{ projectId, displayName: 'repo' }],
    };
    const executor = createProjectSetupExecutor({
      ...f.deps,
      transport: { ...f.transport, issueSetupRequest: async () => response },
    });
    expect(await executor.ensureProject(f.options)).toBe(response);
    expect(f.transport.consumeSetupRequest).not.toHaveBeenCalled();
    expect(JSON.stringify(await f.record())).not.toContain(response.requestId);
  });

  it('records an explicit link intent, consumes link, and can roll replacement back', async () => {
    const f = await fixture();
    await writeFile(f.file, existing);
    f.resolver.resolution = {
      kind: 'ok',
      root: f.root,
      repository: { kind: 'plain', root: f.root },
      nested: [],
      identity: JSON.parse(existing.toString()),
    };
    const replacement = randomUUID();
    f.transport.issueSetupRequest.mockResolvedValue({
      status: 'project_setup_required',
      state: 'confirmation_required',
      allowedActions: ['link', 'cancel'],
      requestId: randomUUID(),
    });
    f.transport.consumeSetupRequest.mockResolvedValue({
      status: 'complete',
      projectId: replacement,
      displayName: 'replacement',
    });
    const executor = createProjectSetupExecutor(f.deps);
    const options = {
      ...f.options,
      allowCreate: false,
      intent: { action: 'link' as const, projectId: replacement, replace: true as const },
    };
    expect(await executor.stage(options)).toMatchObject({
      status: 'staged',
      projectId: replacement,
    });
    expect((await f.record()).intent).toEqual(options.intent);
    expect(f.transport.consumeSetupRequest).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'link', projectId: replacement })
    );
    await executor.apply(options);
    expect(JSON.parse(await readFile(f.file, 'utf8')).projectId).toBe(replacement);
    await executor.rollback(options);
    expect(await readFile(f.file)).toEqual(existing);
  });

  it('never consumes a fingerprint mismatch for an explicit link intent', async () => {
    const f = await fixture();
    const mismatch = {
      status: 'project_setup_required' as const,
      state: 'fingerprint_mismatch',
      allowedActions: ['link', 'cancel'],
      requestId: randomUUID(),
    };
    f.transport.issueSetupRequest.mockResolvedValue(mismatch);
    const result = await createProjectSetupExecutor(f.deps).stage({
      ...f.options,
      intent: { action: 'link', projectId },
    });

    expect(result).toBe(mismatch);
    expect(f.transport.consumeSetupRequest).not.toHaveBeenCalled();
    expect(await readFile(f.file).catch(() => null)).toBeNull();
  });

  it.each(['stage', 'apply'] as const)(
    'rollback after %s restores exact before-state and retains remote UUID',
    async (mode) => {
      const f = await fixture();
      await writeFile(f.file, existing);
      const executor = createProjectSetupExecutor(f.deps);
      expect(await executor.stage(f.options)).toMatchObject({ status: 'staged' });
      expect(await readFile(f.file)).toEqual(existing);
      if (mode === 'apply') await executor.apply(f.options);
      expect(await executor.rollback(f.options)).toMatchObject({
        status: 'rolled_back',
        retainedRemoteUUID: projectId,
      });
      expect(await readFile(f.file)).toEqual(existing);
      expect(await executor.rollback(f.options)).toMatchObject({ status: 'rolled_back' });
      expect(await executor.ensureProject(f.options)).toMatchObject({
        state: 'operation_rolled_back',
      });
    }
  );

  it('reports an external edit and never overwrites it during apply or rollback', async () => {
    const f = await fixture();
    const executor = createProjectSetupExecutor(f.deps);
    await executor.stage(f.options);
    await writeFile(f.file, 'user edit');
    expect(await executor.apply(f.options)).toMatchObject({ state: 'identity_changed' });
    expect(await executor.rollback(f.options)).toMatchObject({ state: 'identity_changed' });
    expect(await readFile(f.file, 'utf8')).toBe('user edit');
  });

  it.each(['unknown_version', 'malformed', 'conflict', 'nested', 'git_unavailable'] as const)(
    'preserves local %s without any state or server writes',
    async (status) => {
      const f = await fixture();
      f.resolver.resolution = {
        kind: status,
        root: f.root,
        repository: { kind: 'plain', root: f.root },
        nested: [],
      } as ProjectIdentityResolution;
      expect(await createProjectSetupExecutor(f.deps).ensureProject(f.options)).toMatchObject({
        status: 'ACTION_REQUIRED',
        state: status,
      });
      expect(f.transport.issueSetupRequest).not.toHaveBeenCalled();
      expect(await readdir(f.stateDir).catch(() => [])).toEqual([]);
    }
  );

  it('refuses changed authenticated scope and detects corrupted stage hashes', async () => {
    const f = await fixture();
    await createProjectSetupExecutor(f.deps).stage(f.options);
    expect(
      await createProjectSetupExecutor({ ...f.deps, scopeKey: 'another-user:device' }).apply(
        f.options
      )
    ).toMatchObject({ state: 'operation_context_changed' });
    const record = await f.record();
    record.staged!.content += 'corruption';
    await writeFile(recordPath(f.root, f.stateDir), JSON.stringify(record));
    expect(await createProjectSetupExecutor(f.deps).apply(f.options)).toMatchObject({
      state: 'record_invalid',
    });
  });

  it('refuses changed repository evidence before applying a staged identity', async () => {
    const f = await fixture();
    await createProjectSetupExecutor(f.deps).stage(f.options);
    const executor = createProjectSetupExecutor({
      ...f.deps,
      bindContext: async () => ({ ...evidence, repositoryFingerprint: evidence.deviceRootContext }),
    });
    expect(await executor.apply(f.options)).toMatchObject({ state: 'operation_context_changed' });
    expect(await readdir(f.root)).toEqual([]);
  });

  it('revalidates completed identities instead of treating the record as access authority', async () => {
    const f = await fixture();
    await createProjectSetupExecutor(f.deps).ensureProject(f.options);
    const denied = {
      status: 'ACTION_REQUIRED' as const,
      state: 'not_found',
      allowedActions: ['ask_owner', 'cancel'],
    };
    const executor = createProjectSetupExecutor({
      ...f.deps,
      transport: { ...f.transport, issueSetupRequest: async () => denied },
    });
    expect(await executor.ensureProject(f.options)).toBe(denied);
  });

  it('resolves all OS state locations and writes POSIX records privately', async () => {
    expect(stateDirectory('linux', {}, '/u')).toBe('/u/.local/state/mnemonik');
    expect(stateDirectory('linux', { XDG_STATE_HOME: '/s' }, '/u')).toBe('/s/mnemonik');
    expect(stateDirectory('darwin', {}, '/u')).toBe('/u/Library/Application Support/Mnemonik');
    expect(
      stateDirectory('win32', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'C:\\Users\\u')
    ).toBe('C:\\Users\\u\\AppData\\Local\\Mnemonik');
    expect(stateDirectory('linux', { MNEMONIK_STATE_DIR: '/override' }, '/u')).toBe('/override');
    for (const [platform, env, home] of [
      ['linux', {}, '/u'],
      ['darwin', {}, '/u'],
      ['win32', { LOCALAPPDATA: 'C:\\Local' }, 'C:\\Users\\u'],
    ] as const) {
      expect(protectedLocalPaths(platform, env, home)).toContain(
        stateDirectory(platform, env, home)
      );
    }
    const execFile = vi.fn((_file, _args, callback) => callback(null, '', ''));
    expect(
      await protectStateFile('C:\\state\\record.json', 'win32', {
        execFile,
        username: 'DOMAIN\\user',
      })
    ).toBe('private');
    expect(execFile).toHaveBeenCalledWith(
      'icacls.exe',
      ['C:\\state\\record.json', '/inheritance:r', '/grant:r', 'DOMAIN\\user:F'],
      expect.any(Function)
    );
    const f = await fixture();
    await createProjectSetupExecutor(f.deps).stage(f.options);
    if (process.platform !== 'win32')
      expect((await stat(recordPath(f.root, f.stateDir))).mode & 0o777).toBe(0o600);
  });
});

it('reinstalls an earlier-created identity and rolls back to the current bytes', async () => {
  const f = await fixture();
  const executor = createProjectSetupExecutor(f.deps);
  expect(await executor.ensureProject(f.options)).toHaveProperty('status', 'done');
  const firstOperation = (await f.record()).operationId;
  const current = Buffer.from(
    `{ "schemaVersion": 1, "projectId": "${projectId}", "projectName": "renamed" }\r\n`
  );
  await writeFile(f.file, current);
  f.resolver.resolution = {
    kind: 'ok',
    root: f.root,
    repository: { kind: 'plain', root: f.root },
    nested: [],
    identity: { schemaVersion: 1, projectId },
  };
  const options = { ...f.options, intent: { action: 'link' as const, projectId } };
  expect(await executor.stage(options)).toHaveProperty('status', 'staged');
  expect((await f.record()).operationId).not.toBe(firstOperation);
  expect(await executor.apply(options)).toHaveProperty('status', 'done');
  expect(f.operations.size).toBe(1);
  expect(f.transport.issueSetupRequest).toHaveBeenCalledTimes(2);
  expect(await executor.rollback(options)).toHaveProperty('status', 'rolled_back');
  expect(await readFile(f.file)).toEqual(current);
});

it('rechecks a completed identity on a new stage and refuses a changed fingerprint', async () => {
  const f = await fixture();
  const executor = createProjectSetupExecutor(f.deps);
  expect(await executor.ensureProject(f.options)).toHaveProperty('status', 'done');
  f.resolver.resolution = {
    kind: 'ok',
    root: f.root,
    repository: { kind: 'plain', root: f.root },
    nested: [],
    identity: { schemaVersion: 1, projectId },
  };
  const before = await readFile(f.file);
  f.transport.issueSetupRequest.mockResolvedValue({
    status: 'project_setup_required',
    state: 'fingerprint_mismatch',
    allowedActions: ['link', 'cancel'],
    requestId: randomUUID(),
  });
  expect(await executor.stage(f.options)).toHaveProperty('state', 'fingerprint_mismatch');
  expect(await readFile(f.file)).toEqual(before);
  expect(f.transport.consumeSetupRequest).toHaveBeenCalledTimes(1);
});
