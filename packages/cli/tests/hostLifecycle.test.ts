import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runCli } from '../src/router.js';
import { runHosts } from '../src/install/hosts.js';
import { ownershipPath, readOwnership, rollbackHost } from '../src/install/ownership.js';
import { bytesAt, digest, interrupted, type Journal } from '../src/install/journal.js';
import { hostPackageImports } from '../src/install/adapters.js';
import { RuntimeStore } from '../src/runtime/store.js';
import { bump, hostFixture, hostStateFixture, packedHosts } from './fixtures/hostRuntime.js';

let packed: Awaited<ReturnType<typeof packedHosts>>;
const homes: string[] = [];
beforeAll(async () => {
  packed = await packedHosts();
}, 120_000);
afterAll(async () => {
  await rm(packed.root, { recursive: true, force: true });
});
afterEach(async () => {
  await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const f = await hostFixture(packed.sources);
  homes.push(f.home);
  return f;
}

function execLauncher(path: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [path], (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
    child.stdin?.end();
  });
}
async function launcherFixture() {
  const f = await fixture();
  const store = new RuntimeStore(f.deps.stateDir);
  const runtime = await store.installRuntime(
    'codex',
    packed.sources.codex.manifest.version,
    packed.sources.codex
  );
  const adapter = (await hostPackageImports.codex(runtime)).createHostAdapter({
    env: { ...f.deps.env, HOME: f.home },
    target: {
      component: 'hooks',
      scope: 'user',
      credentialFamily: 'hook-family',
      runtimeEntry: runtime.entry,
      runtimeRoot: dirname(store.pointerPath('codex')),
    },
  });
  const launcher = (await adapter.plan()).changes.find((change) =>
    change.path.endsWith('/runtimes/codex/launcher.mjs')
  )!;
  await mkdir(dirname(launcher.path), { recursive: true, mode: 0o700 });
  await writeFile(launcher.path, launcher.content, { mode: 0o600 });
  return { f, store, runtime, launcherPath: launcher.path };
}

it('Codex launcher runs a runtime written and verified by RuntimeStore', async () => {
  const { launcherPath } = await launcherFixture();
  const result = await execLauncher(launcherPath);
  expect(result.stderr).toBe('');
  expect(result.stdout).toBe('');
}, 60_000);

it('CLI runtime verification refuses a mutated runtime entry before running it', async () => {
  const { f, store, runtime } = await launcherFixture();
  const marker = join(f.home, 'tampered-runtime-ran');
  await writeFile(
    runtime.entry,
    `import { writeFile } from 'node:fs/promises'; await writeFile(${JSON.stringify(marker)}, 'ran');`,
    { mode: 0o600 }
  );
  await expect(store.verifyRuntime('codex')).rejects.toMatchObject({
    reason: 'digest_mismatch',
  });
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
}, 60_000);

it('CLI runtime verification binds manifest bytes to current.manifestSha256', async () => {
  const { store, runtime } = await launcherFixture();
  await writeFile(
    join(runtime.directory, 'manifest.json'),
    JSON.stringify({ ...runtime.manifest, totalSize: runtime.manifest.totalSize + 1 }),
    { mode: 0o600 }
  );
  await expect(store.verifyRuntime('codex')).rejects.toMatchObject({
    reason: 'digest_mismatch',
  });
}, 60_000);

it('CLI runtime verification refuses an extra runtime file', async () => {
  const { store, runtime } = await launcherFixture();
  await writeFile(join(runtime.directory, 'extra.js'), 'extra', { mode: 0o600 });
  await expect(store.verifyRuntime('codex')).rejects.toMatchObject({
    reason: 'digest_mismatch',
  });
}, 60_000);

it('CLI runtime verification refuses missing, symlinked, and wrong-mode runtime files', async () => {
  for (const mutation of ['missing', 'symlink', 'mode'] as const) {
    const { store, runtime } = await launcherFixture();
    if (mutation === 'missing') await rm(runtime.entry);
    if (mutation === 'symlink') {
      const target = join(runtime.directory, 'outside-entry.js');
      await writeFile(target, 'outside', { mode: 0o600 });
      await rm(runtime.entry);
      await symlink(target, runtime.entry);
    }
    if (mutation === 'mode') await chmod(runtime.entry, 0o644);
    await expect(store.verifyRuntime('codex')).rejects.toMatchObject({
      reason: mutation === 'missing' ? 'digest_mismatch' : 'permission',
    });
  }
}, 60_000);

it('CLI installs the three launch-host adapters with planned bytes, verified entries and before hashes', async () => {
  const f = await fixture();
  const originalPath = join(f.home, '.cursor', 'hooks.json');
  const original = Buffer.from('{"version":1,"hooks":{}}\n');
  await mkdir(dirname(originalPath), { recursive: true });
  await writeFile(originalPath, original);
  let journal: Journal | undefined;
  f.deps.fault = (event, j) => {
    if (event === 'complete') journal = j;
  };
  const stdout: string[] = [];
  const exit = await runCli(
    [
      'install',
      '--hosts',
      'claude-code,codex,cursor',
      '--components',
      'hooks',
      '--non-interactive',
      '--accept-limited',
      '--apply',
    ],
    {
      home: f.home,
      cwd: f.projectRoot,
      hostManagement: f.deps,
      cliAuth: {
        getCliBearer: async () => 'fixture',
        signIn: async () => {},
        logout: async () => {},
      },
      stdout: {
        write: (s) => {
          stdout.push(String(s));
        },
      },
    }
  );
  expect(exit).toBe(3);
  const owned = await readOwnership(f.deps.stateDir);
  expect(owned.targets).toHaveLength(3);
  expect(journal!.data.targets.find((t) => t.path === originalPath)!.beforeHash).toBe(
    digest(original)
  );
  const store = new RuntimeStore(f.deps.stateDir);
  for (const target of owned.targets) {
    const runtime = await store.verifyRuntime(target.host);
    expect(target.artifactDigest).toBe(runtime.reference.manifestSha256);
    expect(target.component).toBe('hooks');
    expect(target.credentialFamily).toBe('hook-family');
    expect(journal!.data.credentials).toContainEqual({
      reference: target.credentialFamily,
      kind: 'component',
    });
    const adapter = (
      await hostPackageImports[target.host as keyof typeof hostPackageImports](runtime)
    ).createHostAdapter({
      env: { ...f.deps.env, HOME: f.home },
      target: {
        component: 'hooks',
        scope: 'user',
        credentialFamily: target.credentialFamily!,
        runtimeEntry: runtime.entry,
        runtimeRoot: dirname(store.pointerPath(target.host)),
      },
    });
    for (const change of (await adapter.plan()).changes)
      expect(await readFile(change.path)).toEqual(change.content);
    const bytes = await readFile(target.profilePath, 'utf8');
    expect(bytes).toContain('--credential-family ' + target.credentialFamily);
    expect(JSON.stringify(journal!.data)).not.toContain('hook-access');
    expect(JSON.stringify(journal!.data)).not.toContain('hook-refresh');
    const entry =
      target.host === 'codex'
        ? join(dirname(store.pointerPath('codex')), 'launcher.mjs')
        : runtime.entry;
    expect(
      bytes.includes(entry) ||
        bytes.includes(Buffer.from(pathToFileURL(entry).href).toString('base64url'))
    ).toBe(true);
  }
  expect(stdout.join('')).toContain(
    'use its hook trust prompt to allow the Mnemonik hooks; then quit and reopen Codex'
  );
}, 60_000);

it('corrupt runtime fails before adapter plan and leaves config and current untouched', async () => {
  const f = await fixture();
  const source = packed.sources['claude-code'];
  f.deps.source = async () => ({
    manifest: source.manifest,
    files: {
      ...source.files,
      [source.manifest.entry]: Buffer.alloc(source.files[source.manifest.entry]!.length, 120),
    },
  });
  const path = join(f.home, '.claude', 'settings.json');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '{ "foreign": true }\n');
  const before = digest(await readFile(path));
  const result = await runHosts('install', [f.selections[0]!], f.deps);
  expect(result.results[0]!.reason).toBe('digest_mismatch');
  expect(result.results[0]!.action).toBe('mnemonik repair');
  expect(digest(await readFile(path))).toBe(before);
  expect(await bytesAt(new RuntimeStore(f.deps.stateDir).pointerPath('claude-code'))).toBeNull();
  expect(result.journal.targets.some((t) => t.kind === 'host')).toBe(false);
}, 60_000);

it('uninstalls only Cursor user hooks and preserves foreign entries and other hosts byte for byte', async () => {
  const f = await fixture();
  const path = join(f.home, '.cursor', 'hooks.json');
  const foreign = { command: '/opt/foreign/mnemonik-wrapper --keep' };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({ version: 1, hooks: { beforeSubmitPrompt: [foreign] } }, null, 2) + '\n'
  );
  await runHosts('install', f.selections, f.deps);
  const old = await readOwnership(f.deps.stateDir);
  const unchanged = await Promise.all(
    old.targets
      .filter((t) => t.host !== 'cursor')
      .flatMap((t) => t.files)
      .map(async (t) => ({ ...t, bytes: await readFile(t.path) }))
  );
  await runCli(['uninstall', '--host', 'cursor', '--scope', 'user'], {
    hostManagement: f.deps,
    stdout: { write() {} },
  });
  expect((await readOwnership(f.deps.stateDir)).targets).toHaveLength(2);
  expect(JSON.parse(await readFile(path, 'utf8')).hooks.beforeSubmitPrompt).toEqual([foreign]);
  expect(await readFile(path, 'utf8')).toContain(
    JSON.stringify(foreign, null, 2).split('\n')[1]!.trim()
  );
  for (const file of unchanged) expect(await readFile(file.path)).toEqual(file.bytes);
}, 60_000);

it('uninstall deletes a created config but keeps a pre-existing empty config', async () => {
  for (const preExisting of [false, true]) {
    const f = await fixture();
    const path = join(f.home, '.cursor', 'hooks.json');
    if (preExisting) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, '{}\n');
    }
    const cursor = f.selections.find((selection) => selection.host === 'cursor');
    expect(cursor).toBeDefined();
    if (!cursor) throw new Error('cursor fixture missing');
    await runHosts('install', [cursor], f.deps);
    const owned = (await readOwnership(f.deps.stateDir)).targets[0];
    expect(owned).toBeDefined();
    if (!owned) throw new Error('cursor ownership missing');
    expect(owned.files.find((file) => file.path === path)?.created).toBe(
      preExisting ? undefined : true
    );
    await runHosts('uninstall', [owned], f.deps);
    if (preExisting) expect(await readFile(path, 'utf8')).toBeTruthy();
    else await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  }
}, 120_000);

it.each(['claude-code', 'codex'] as const)(
  '%s install and uninstall restore original config bytes',
  async (host) => {
    for (const existingSettings of [false, true]) {
      const f = await hostStateFixture(packed.sources);
      homes.push(f.home);
      const selection = f.selections.find((item) => item.host === host)!;
      const files =
        host === 'claude-code'
          ? [
              [
                join(f.home, '.claude/settings.json'),
                existingSettings ? '{"hooks":{},"theme":"dark"}' : '{"theme":"dark"}',
              ],
              [
                join(f.home, '.claude.json'),
                existingSettings ? '{"mcpServers":{},"theme":"dark"}' : '{"theme":"dark"}',
              ],
            ]
          : [
              [
                join(f.home, '.codex/config.toml'),
                'model = "fixture"\n' + (existingSettings ? '\n[features]\nhooks = true\n' : ''),
              ],
            ];
      for (const [path, content] of files) {
        await mkdir(dirname(path!), { recursive: true });
        await writeFile(path!, content!);
      }
      await runHosts(
        'install',
        [
          { ...selection, component: 'hooks' },
          { ...selection, component: 'mcp' },
        ],
        f.deps
      );
      await runHosts('repair', (await readOwnership(f.deps.stateDir)).targets, {
        ...f.deps,
        apply: true,
      });
      if (host === 'codex') {
        const path = files[0]![0]!;
        await writeFile(
          path,
          (await readFile(path, 'utf8')) +
            `\n[hooks.state.'${join(f.home, '.codex/hooks.json')}:pre_tool_use:0:0']\ntrusted_hash = "native-fixture"\n`
        );
      }
      const removed = await runHosts(
        'uninstall',
        (await readOwnership(f.deps.stateDir)).targets,
        f.deps
      );
      expect(removed.results.every((result) => result.status === 'READY')).toBe(true);
      for (const [path, content] of files) expect(await readFile(path!, 'utf8')).toBe(content);
    }
  },
  120_000
);

it('updates independently with mixed digests and unchanged Codex command on corrupt artifact', async () => {
  const f = await fixture();
  await runHosts('install', f.selections, f.deps);
  const before = await readOwnership(f.deps.stateDir);
  const codex = before.targets.find((t) => t.host === 'codex')!;
  const codexBytes = await readFile(codex.profilePath);
  f.deps.source = async (host) => {
    const next = bump(packed.sources[host]);
    if (host === 'codex') next.files[next.manifest.entry] = Buffer.from('corrupt');
    return next;
  };
  const result = await runHosts('update', before.targets, f.deps);
  const after = await readOwnership(f.deps.stateDir);
  for (const target of after.targets) {
    const prior = before.targets.find((t) => t.id === target.id)!;
    expect(target.version).toBe(target.host === 'codex' ? prior.version : '99.0.0');
    if (target.host !== 'codex') expect(target.previous!.artifactDigest).toBe(prior.artifactDigest);
  }
  expect(await readFile(codex.profilePath)).toEqual(codexBytes);
  expect(result.results.find((r) => r.target === codex.id)!.reason).toBe('digest_mismatch');
  expect(result.results.filter((r) => r.status === 'READY')).toHaveLength(2);
  expect(result.reports.some((r) => r.includes('shared runtime'))).toBe(true);
}, 120_000);

it('installs editor entries at user level even when a project selection reaches the host boundary', async () => {
  const f = await fixture();
  await runHosts('install', [{ ...f.selections[0]!, scope: 'project' }], f.deps);
  const [target] = (await readOwnership(f.deps.stateDir)).targets;
  expect(target?.scope).toBe('user');
  expect(target?.profilePath).not.toContain(f.projectRoot);
}, 60_000);

it('stale ownership generation refuses rollback without changing any target', async () => {
  const f = await fixture();
  f.deps.fault = (event) => {
    if (event === 'host_observed') throw new Error('interrupt');
  };
  await expect(runHosts('install', [f.selections[0]!], f.deps)).rejects.toThrow('interrupt');
  const journal = (await interrupted(f.deps.stateDir))[0]!;
  const before = await Promise.all(
    journal.data.targets.map(async (t) => ({ path: t.path, bytes: await bytesAt(t.path) }))
  );
  await writeFile(
    join(f.deps.stateDir, 'install-owner.json'),
    JSON.stringify({ generation: journal.data.generation + 1, runId: 'later' })
  );
  await expect(
    rollbackHost(f.deps.stateDir, journal, journal.data.hostRuns![0]!.id)
  ).rejects.toThrow('stale_ownership_generation');
  for (const target of before) expect(await bytesAt(target.path)).toEqual(target.bytes);
}, 60_000);

it('mcp selection and ambiguous profiles stop with ACTION_REQUIRED', async () => {
  const f = await fixture();
  const output: string[] = [];
  expect(
    await runCli(['repair', '--component', 'mcp', '--json'], {
      hostManagement: f.deps,
      stdout: {
        write: (s) => {
          output.push(String(s));
        },
      },
    })
  ).toBe(3);
  expect(output.join('')).toContain('no_recorded_targets');
  expect((await readOwnership(f.deps.stateDir)).targets).toEqual([]);
  await mkdir(f.deps.stateDir, { mode: 0o700 });
  const targets = ['one', 'two'].map((name) => ({
    host: 'codex',
    component: 'hooks',
    scope: 'user',
    home: f.home,
    id: name,
    profilePath: join(f.home, name, 'hooks.json'),
    files: [],
    version: '1.0.0',
    artifactDigest: 'a'.repeat(64),
    runtimePointer: join(f.deps.stateDir, 'runtimes/codex/current'),
  }));
  const bytes = JSON.stringify({ schemaVersion: 1, generation: 0, targets });
  await writeFile(ownershipPath(f.deps.stateDir), bytes);
  output.splice(0);
  expect(
    await runCli(['repair', '--host', 'codex', '--scope', 'user', '--non-interactive', '--json'], {
      hostManagement: f.deps,
      stdout: {
        write: (s) => {
          output.push(String(s));
        },
      },
    })
  ).toBe(3);
  expect(JSON.parse(output.join(''))).toMatchObject({
    status: 'ACTION_REQUIRED',
    reason: 'ambiguous_profile',
    profiles: targets.map((t) => t.profilePath),
  });
  expect(await readFile(ownershipPath(f.deps.stateDir), 'utf8')).toBe(bytes);
});

it('repairs selected drift and updates hooks without an MCP connection', async () => {
  const f = await fixture();
  const selection = f.selections.find((t) => t.host === 'codex')!;
  await runHosts('install', [selection], f.deps);
  const owned = (await readOwnership(f.deps.stateDir)).targets[0]!;
  const original = await readFile(owned.profilePath);
  const launcher = owned.files.find((file) => file.path.endsWith('/runtimes/codex/launcher.mjs'))!;
  const originalLauncher = await readFile(launcher.path);
  expect(launcher.hash).toBe(digest(originalLauncher));
  const changed = JSON.parse(original.toString());
  delete changed.hooks.SessionStart;
  await writeFile(owned.profilePath, JSON.stringify(changed));
  const changedLauncher = Buffer.from('changed launcher');
  await writeFile(launcher.path, changedLauncher);
  const repair = await runHosts('repair', [owned], f.deps);
  const repaired = await readFile(owned.profilePath);
  expect(JSON.parse(repaired.toString())).toEqual(JSON.parse(original.toString()));
  expect(await readFile(launcher.path)).toEqual(originalLauncher);
  expect(repair.journal.targets).toContainEqual(
    expect.objectContaining({ path: launcher.path, beforeHash: digest(changedLauncher) })
  );
  await writeFile(
    join(f.bin, 'codex'),
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.145.0"; else echo "mnemonik: Not connected"; fi\n',
    { mode: 0o700 }
  );
  f.deps.source = async () => bump(packed.sources.codex);
  const result = await runHosts('update', [owned], f.deps);
  expect(result.results[0]!.reason).toBe('codex_trust_pending');
  expect(result.reports.join(' ')).not.toContain('codex mcp login mnemonik');
  expect(await readFile(owned.profilePath)).toEqual(repaired);
  expect(
    (await new RuntimeStore(f.deps.stateDir).verifyRuntime('codex')).reference.manifestSha256
  ).not.toBe(owned.artifactDigest);
}, 60_000);

it('records two profiles under one home independently and uninstalls the recorded profile', async () => {
  const f = await fixture();
  const selected = f.selections.find((t) => t.host === 'codex')!;
  await runHosts('install', [{ ...selected }], f.deps);
  const first = (await readOwnership(f.deps.stateDir)).targets[0]!;
  f.deps.env = { ...f.deps.env, CODEX_HOME: join(f.home, 'alternate-codex') };
  await runHosts('install', [{ ...selected }], f.deps);
  const targets = (await readOwnership(f.deps.stateDir)).targets;
  expect(targets).toHaveLength(2);
  const second = targets.find((t) => t.profilePath !== first.profilePath)!;
  const untouched = await readFile(second.profilePath);
  await runHosts('uninstall', [first], f.deps);
  expect(await readFile(second.profilePath)).toEqual(untouched);
  expect((await readOwnership(f.deps.stateDir)).targets.map((t) => t.profilePath)).toEqual([
    second.profilePath,
  ]);
}, 60_000);
