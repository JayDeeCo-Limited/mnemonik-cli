import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createProjectSetupExecutor } from '@mnemonik/local-setup';
import { resolveProjectIdentity } from '@mnemonik/shared';
import { hostOrder, SimulatedHostAdapter } from '../src/install/adapters.js';
import { bytesAt, digest, interrupted, withInstall, type Journal } from '../src/install/journal.js';
import {
  compensate,
  consentMatches,
  runInstall,
  type InstallDependencies,
} from '../src/install/transaction.js';
import { rollbackHost } from '../src/install/ownership.js';
import { runCli } from '../src/router.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const uuid = '12345678-1234-4234-8234-123456789012';
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'install-'));
  dirs.push(home);
  const stateDir = join(home, 'state');
  const root = join(home, 'repo');
  await mkdir(root);
  const original = Buffer.from('{ "existing": "keep exact bytes" }\r\n');
  const adapters = await Promise.all(
    hostOrder.map(async (name) => {
      const path = join(home, `${name}.json`);
      await writeFile(path, original, { mode: 0o640 });
      const adapter = new SimulatedHostAdapter(name, {
        path,
        content: Buffer.from('{"existing":"keep exact bytes","mnemonik":true}\n'),
        staging: 'inactive',
        requestedScope: 'user',
        effectiveScope: 'user',
        version: 'test-1',
        artifactDigest: 'test-digest',
      });
      adapter.grant = { id: name, account: 'owner', scopes: ['mcp'] };
      return adapter;
    })
  );
  const executor = createProjectSetupExecutor({
    stateDir,
    scopeKey: 'owner:device',
    resolver: { resolveProjectIdentity },
    bindContext: async () => ({
      deviceRootContext: { algorithmVersion: 1, hash: 'a'.repeat(64) },
      repositoryFingerprint: { algorithmVersion: 1, hash: 'b'.repeat(64) },
    }),
    transport: {
      issueSetupRequest: async (input) =>
        input.projectId
          ? { status: 'complete', projectId: input.projectId, displayName: 'repo' }
          : {
              status: 'project_setup_required',
              state: 'missing',
              requestId: 'request',
              allowedActions: ['create'],
            },
      consumeSetupRequest: async () => ({
        status: 'complete',
        projectId: uuid,
        displayName: 'repo',
      }),
    },
  });
  const deps: InstallDependencies = {
    stateDir,
    input: {
      account: 'owner',
      components: ['mcp', 'scanner'],
      hosts: [...hostOrder],
      scopes: {},
      roots: [],
      credentials: [
        { kind: 'cli', reference: 'cli-created' },
        { kind: 'component', reference: 'hook-created' },
        { kind: 'component', reference: 'scanner-created' },
      ],
    },
    adapters,
    executor,
    ui: {
      batch: vi.fn(async () => 'connect' as const),
      waiting: vi.fn(),
      timeout: vi.fn(async () => 'skip' as const),
      roots: vi.fn(async () => ({
        account: 'owner',
        disclosureVersion: 'v1',
        picked: {
          roots: [root],
          exclusions: [],
          repositories: [
            {
              path: root,
              state: 'not_set_up' as const,
              selected: true,
              nonGitSelected: true as const,
            },
          ],
        },
      })),
      consent: vi.fn(async () => true),
      review: vi.fn(async () => 'apply' as const),
      cancel: vi.fn(async () => 'revoke' as const),
      recovery: vi.fn(async () => 'resume' as const),
    },
    revokeCli: vi.fn(async () => {}),
    revokeComponent: vi.fn(async () => true),
    projectEmpty: async () => true,
    services: {
      verified: true,
      inspect: async () => [{ id: 'scanner', before: 'stopped' }],
      start: vi.fn(async () => ({ started: true as const, alreadyRunning: false as const })),
      restore: vi.fn(async () => {}),
    },
    upload: {
      start: vi.fn(async () => ({ uploaded: true, deduplicated: false })),
      deletionAction: 'Delete the cloud index in the console.',
    },
  };
  return { home, root, deps, adapters, original };
}

it('orders Recommended install and keeps every host hash unchanged until Apply', async () => {
  const f = await fixture();
  let journal: Journal | undefined;
  f.deps.fault = async (event, current) => {
    journal = current;
    if (!current.data.mutations.some((m) => m.event === 'apply'))
      for (const adapter of f.adapters)
        expect(digest(await bytesAt(adapter.declaration.path))).toBe(digest(f.original));
    if (event === 'final_review') expect(await bytesAt(join(f.root, '.mnemonik.json'))).toBeNull();
  };
  for (const adapter of f.adapters) {
    const launch = adapter.launch.bind(adapter);
    adapter.launch = async () => {
      expect(journal!.data.approvals[adapter.name]?.intent.attempt).toBe(1);
      expect(
        journal!.data.targets.filter((t) => t.kind === 'host').every((t) => t.status === 'staged')
      ).toBe(true);
      return launch();
    };
  }
  const result = await runInstall(f.deps);
  expect(result.state).toBe('LIMITED');
  expect(result.reports).toEqual(expect.arrayContaining(['hook_not_verified']));
  const events = result.mutations.map((m) => m.event);
  const ordered = [
    'journal_created',
    'staged',
    'host_intent',
    'host_launched',
    'host_observed',
    'roots_confirmed',
    'consent_recorded',
    'projects_staged',
    'final_review',
    'apply',
    'local_commit',
    'service_started',
    'upload_intent',
  ];
  for (let i = 1; i < ordered.length; i++)
    expect(events.indexOf(ordered[i]!)).toBeGreaterThan(events.indexOf(ordered[i - 1]!));
  expect(result.mutations.filter((m) => m.event === 'host_launched').map((m) => m.target)).toEqual(
    hostOrder
  );
  expect(JSON.parse(await readFile(join(f.root, '.mnemonik.json'), 'utf8')).projectId).toBe(uuid);
  for (const adapter of f.adapters)
    expect((await stat(adapter.declaration.path)).mode & 0o777).toBe(0o640);
});

it('retries only one host timer and Skip restores its bytes before remaining commits', async () => {
  const f = await fixture();
  const host = f.adapters[1]!;
  host.grant = undefined;
  host.authenticatedTools = false;
  let time = 0;
  const ticks: number[] = [];
  f.deps.now = () => time;
  f.deps.sleep = async (ms) => {
    ticks.push(ms);
    time += ms;
  };
  f.deps.ui.timeout = vi.fn().mockResolvedValueOnce('retry').mockResolvedValueOnce('skip');
  f.deps.ui.review = async (journal) => {
    expect(journal.data.hosts).not.toContain('codex');
    expect(await readFile(host.declaration.path)).toEqual(f.original);
    return 'apply';
  };
  const result = await runInstall(f.deps);
  expect(time).toBe(240000);
  expect(new Set(ticks)).toEqual(new Set([2000]));
  expect(f.adapters.map((a) => a.launches)).toEqual([1, 2, 1, 1]);
  expect(result.state).toBe('LIMITED');
  expect(result.reports.join(' ')).toContain('mnemonik connect codex');
  expect(await readFile(host.declaration.path)).toEqual(f.original);
});

it.each([false, true])(
  'cancel restores files and revokes staged families (keep CLI=%s)',
  async (keep) => {
    const f = await fixture();
    f.deps.ui.review = async () => 'cancel';
    f.deps.ui.cancel = async () => (keep ? 'keep-cli' : 'revoke');
    const result = await runInstall(f.deps);
    expect(result.phase).toBe('rolled_back');
    expect(f.deps.revokeCli).toHaveBeenCalledTimes(keep ? 0 : 1);
    expect(f.deps.revokeComponent).toHaveBeenCalledWith('hook-created');
    expect(f.deps.revokeComponent).toHaveBeenCalledWith('scanner-created');
    for (const adapter of f.adapters) {
      expect(await readFile(adapter.declaration.path)).toEqual(f.original);
      expect(adapter.revoked).toEqual([adapter.name]);
    }
    expect(result.projects[0]).toMatchObject({ uuid, effect: 'created', empty: true });
    expect(result.reports.join(' ')).toContain('explicitly archive');
    expect(await bytesAt(join(f.root, '.mnemonik.json'))).toBeNull();
    expect(f.deps.upload!.start).not.toHaveBeenCalled();
  }
);

it.each(['inactive', 'additive'] as const)(
  'reconciles intent without observed (%s), attributing declarations from BEFORE hashes',
  async (staging) => {
    const f = await fixture();
    const adapter = f.adapters[0]!;
    adapter.declaration.staging = staging;
    if (staging === 'inactive') adapter.declaration.content = f.original;
    f.deps.fault = (event) => {
      if (event === 'host_intent') throw new Error('crash');
    };
    await expect(runInstall(f.deps)).rejects.toThrow('crash');
    const pending = (await interrupted(f.deps.stateDir))[0]!;
    expect(pending.data.approvals['claude-code']?.observed).toBeUndefined();
    expect(await bytesAt(adapter.declaration.path)).toEqual(
      staging === 'inactive' ? f.original : adapter.declaration.content
    );
    f.deps.fault = undefined;
    f.deps.ui.recovery = async (reports) => {
      expect(reports.join(' ')).not.toContain('Conflict:');
      expect(reports.join(' ')).toContain(
        staging === 'inactive' ? 'pre-existing or inactive declaration' : 'CLI-created declaration'
      );
      expect(reports.join(' ')).toContain('cannot be attributed');
      return 'rollback';
    };
    const result = await runInstall(f.deps, pending);
    expect(result.phase).toBe('rolled_back');
    expect(adapter.revoked).toEqual([]);
    expect(result.reports.join(' ')).toContain(adapter.revokeAction);
    expect(await readFile(adapter.declaration.path)).toEqual(f.original);
  }
);

it('post-commit upload failure retains data and committed local files', async () => {
  const f = await fixture();
  f.deps.upload!.start = async () => {
    throw new Error('partial upload failed');
  };
  const result = await runInstall(f.deps);
  expect(result.state).toBe('FAILED');
  expect(result.reports.join(' ')).toContain('remote data is retained. Delete the cloud index');
  expect(result.targets.every((t) => t.status === 'committed')).toBe(true);
  expect(f.deps.revokeCli).not.toHaveBeenCalled();
  for (const adapter of f.adapters)
    expect(await readFile(adapter.declaration.path)).toEqual(adapter.declaration.content);
});

it('Back reuses unchanged consent and requests new consent for changed exclusions', async () => {
  const f = await fixture();
  const roots = f.deps.ui.roots;
  let review = 0;
  f.deps.ui.review = async () => (++review < 3 ? 'back' : 'apply');
  f.deps.ui.roots = async () => {
    const selected = await roots();
    if (review === 2) selected.picked.exclusions = [join(f.root, 'private')];
    return selected;
  };
  expect((await runInstall(f.deps)).state).toBe('LIMITED');
  expect(f.deps.ui.consent).toHaveBeenCalledTimes(2);
  const fields = { account: 'owner', roots: [f.root], exclusions: [], disclosureVersion: 'v1' };
  expect(consentMatches(fields, { ...fields })).toBe(true);
  for (const change of [
    { account: 'other' },
    { roots: [] },
    { exclusions: ['secret'] },
    { disclosureVersion: 'v2' },
  ])
    expect(consentMatches(fields, { ...fields, ...change })).toBe(false);
});

it('finishes rollback while keeping an app-edited file and still refuses stale rollback', async () => {
  const f = await fixture();
  f.deps.fault = (event) => {
    if (event === 'final_review') throw new Error('crash');
  };
  await expect(runInstall(f.deps)).rejects.toThrow();
  const pending = (await interrupted(f.deps.stateDir))[0]!;
  const path = f.adapters[0]!.declaration.path;
  await writeFile(path, 'external edit');
  await withInstall(f.deps.stateDir, f.deps.input, pending, (j) => compensate(j, f.deps));
  expect(await readFile(path, 'utf8')).toBe('external edit');
  for (const adapter of f.adapters.slice(1))
    expect(await readFile(adapter.declaration.path)).toEqual(f.original);
  expect(f.deps.revokeCli).toHaveBeenCalled();
  expect(pending.data.reports).toContain(`rollback_kept_file: ${path}`);
  expect(pending.data.phase).toBe('rolled_back');
  pending.data.generation--;
  await expect(withInstall(f.deps.stateDir, f.deps.input, pending, async () => {})).rejects.toThrow(
    'Stale install generation'
  );
});

it('a corrupt host backup prevents every restore even when the app edited another file', async () => {
  const f = await fixture();
  await withInstall(f.deps.stateDir, f.deps.input, undefined, async (journal) => {
    const targets = [];
    for (const adapter of f.adapters.slice(0, 2)) {
      const target = await journal.plan(adapter.declaration.path, Buffer.from('installed'), {
        kind: 'host',
        group: 'host-test',
      });
      await journal.commit(target);
      targets.push(target);
    }
    await writeFile(targets[0]!.backup, 'corrupt');
    await writeFile(targets[1]!.path, 'app edit');
    await expect(rollbackHost(f.deps.stateDir, journal, 'host-test')).rejects.toThrow(
      'host_backup_invalid'
    );
    expect(await readFile(targets[0]!.path, 'utf8')).toBe('installed');
    expect(await readFile(targets[1]!.path, 'utf8')).toBe('app edit');
  });
});

it('router exposes a simulated dry run using the actual transaction screens', async () => {
  const f = await fixture();
  let text = '';
  const code = await runCli(['install', '--dry-run'], {
    installStateDir: f.deps.stateDir,
    input: Readable.from('1\n1\n1\n'),
    stdout: {
      write: (chunk) => {
        text += chunk;
      },
    },
  });
  expect(code).toBe(3);
  expect(text).toContain('Simulated dry run');
  expect(text).toContain('Ready to install');
  expect(text).toContain('LIMITED');
  expect(await interrupted(f.deps.stateDir)).toEqual([]);
});

it('Back removing a project restores its staged identity and never applies it', async () => {
  const f = await fixture();
  const roots = f.deps.ui.roots;
  let back = false;
  f.deps.ui.roots = async () => {
    const value = await roots();
    if (back) {
      value.picked.roots = [];
      value.picked.repositories = [];
    }
    return value;
  };
  f.deps.ui.review = async () => {
    if (!back) {
      back = true;
      return 'back';
    }
    return 'apply';
  };
  const result = await runInstall(f.deps);
  expect(result.phase).toBe('complete');
  expect(await bytesAt(join(f.root, '.mnemonik.json'))).toBeNull();
  expect(result.projects[0]?.uuid).toBe(uuid);
});

it('account switch returns to consent before requesting new host validation', async () => {
  const f = await fixture();
  const roots = f.deps.ui.roots;
  f.deps.ui.roots = async () => ({ ...(await roots()), account: 'another-account' });
  expect((await runInstall(f.deps)).state).toBe('ACTION_REQUIRED');
  expect(f.deps.ui.consent).toHaveBeenCalledWith(
    expect.objectContaining({ account: 'another-account' })
  );
  expect(f.deps.upload!.start).not.toHaveBeenCalled();
});

it('cancel reports unsupported host revocation and never offers archive for nonempty projects', async () => {
  const f = await fixture();
  f.adapters[0] = new SimulatedHostAdapter('claude-code', f.adapters[0]!.declaration, false);
  f.adapters[0].grant = { id: 'host-owned', account: 'owner', scopes: ['mcp'] };
  f.deps.projectEmpty = async () => false;
  f.deps.ui.review = async () => 'cancel';
  const result = await runInstall(f.deps);
  expect(result.reports.join(' ')).toContain(f.adapters[0].revokeAction);
  expect(result.reports.join(' ')).not.toContain('explicitly archive');
});

it('captures service state before Apply and resume renews consent without restarting services', async () => {
  const f = await fixture();
  const start = f.deps.upload!.start;
  f.deps.upload!.start = async () => {
    throw new Error('upload');
  };
  f.deps.ui.review = async (journal) => {
    expect(journal.data.services[0]?.before).toBe('stopped');
    return 'apply';
  };
  expect((await runInstall(f.deps)).state).toBe('FAILED');
  const journal = (await interrupted(f.deps.stateDir))[0]!;
  const roots = f.deps.ui.roots;
  f.deps.ui.roots = async () => ({ ...(await roots()), disclosureVersion: 'v2' });
  f.deps.upload!.start = start;
  expect((await runInstall(f.deps, journal)).phase).toBe('complete');
  expect(f.deps.ui.consent).toHaveBeenCalledTimes(2);
  expect(f.deps.services!.start).toHaveBeenCalledTimes(1);
});

it('a lost install lease prevents the file write itself, including rollback', async () => {
  const f = await fixture();
  const path = f.adapters[0]!.declaration.path;
  await expect(
    withInstall(f.deps.stateDir, f.deps.input, undefined, async (journal) => {
      const target = await journal.plan(path, Buffer.from('new'), {
        kind: 'host',
        staging: 'additive',
      });
      await journal.stage(target);
      await writeFile(join(f.deps.stateDir, 'install-owner.json.lock', 'owner'), 'successor');
      await journal.restore(target);
    })
  ).rejects.toThrow('lock_lost');
  expect(await readFile(path, 'utf8')).toBe('new');
});

it('uses the scanner service verification seam and removes only the scanner pending report', async () => {
  const { deps } = await fixture();
  deps.services = undefined;
  deps.now = () => 1000000;
  deps.scannerService = {
    command: async () => ({
      status: 'ok',
      supervisor: { kind: 'systemd', installed: true, running: true, pid: 1234 },
    }),
  };
  await mkdir(join(deps.stateDir, 'scanner'), { recursive: true });
  await writeFile(
    join(deps.stateDir, 'scanner/status.json'),
    JSON.stringify({ snapshot: { lifecycle: { pid: 1234 }, heartbeat: { lastSuccess: 999999 } } })
  );
  const result = await runInstall(deps);
  expect(result.reports).not.toContain('scanner_not_verified');
  expect(result.reports).toContain('hook_not_verified');
  expect(result.mutations.some((m) => m.event === 'service_started')).toBe(true);
});

it('never starts a post-commit upload without a verified service receipt', async () => {
  const f = await fixture();
  Object.defineProperty(f.deps.services!, 'verified', { value: false });
  const upload = vi.spyOn(f.deps.upload!, 'start');
  const result = await runInstall(f.deps);
  expect(result.reports).toContain('scanner_not_verified');
  expect(upload).not.toHaveBeenCalled();
});
