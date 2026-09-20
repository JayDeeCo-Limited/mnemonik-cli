import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import type { AdapterDependencies, FileChange, HostAdapter, Target } from '../hostAdapter.js';

export async function writeChanges(changes: FileChange[]) {
  for (const change of changes) {
    if (change.remove) {
      await rm(change.path, { force: true });
      continue;
    }
    await mkdir(dirname(change.path), { recursive: true });
    await writeFile(change.path, change.content, { mode: change.mode });
  }
}
async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    files[path] = entry.isDirectory() ? '<directory>' : (await readFile(path)).toString('base64');
  }
  return files;
}

/** Named, isolated checks that any package test runner can register. No test-framework dependency. */
export function hostAdapterConformance(
  create: (deps?: AdapterDependencies) => HostAdapter,
  options: {
    name: string;
    config: string;
    mcpConfig?: { user: string; project: string; toml?: boolean; type?: string };
    scopes: Target['scope'][];
    flat?: boolean;
    deferred?: boolean;
  }
): Record<string, () => Promise<void>> {
  const foreign = { type: 'command', command: 'node /foreign/hook.js', custom: '  keep exactly  ' };
  const event = options.flat ? 'preToolUse' : 'PreToolUse';
  const foreignEntry = options.flat ? foreign : { matcher: '.*', hooks: [foreign], custom: 'keep' };
  const fixture = async () => {
    const root = await mkdtemp(join(tmpdir(), 'mnemonik-adapter-'));
    const home = join(root, 'home');
    const project = join(root, 'project');
    await mkdir(home);
    await mkdir(project);
    await mkdir(join(root, 'empty-bin'));
    const runtimeRoot = join(home, '.mnemonik', 'runtimes', options.name);
    const target: Target = {
      component: 'hooks',
      scope: 'user',
      projectRoot: project,
      runtimeRoot,
      credentialFamily: 'hook-family',
      runtimeEntry: join(runtimeRoot, '1.0.0', 'dist', 'hook.js'),
      installationId: '11111111-1111-4111-8111-111111111111',
    };
    const deps: AdapterDependencies = {
      target,
      platform: 'linux',
      env: { HOME: home, USERPROFILE: home, PATH: join(root, 'empty-bin') },
      version: '1.0.0',
      artifactDigest: 'verified-receipt',
    };
    return {
      root,
      project,
      target,
      deps,
      adapter: create(deps),
      configPath: (scope: Target['scope']) =>
        join(scope === 'user' ? home : project, options.config),
    };
  };
  const checks: Record<string, () => Promise<void>> = {};
  const check = (name: string, run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) => {
    checks[`${options.name}: ${name}`] = async () => {
      const f = await fixture();
      try {
        await run(f);
      } finally {
        await rm(f.root, { recursive: true, force: true });
      }
    };
  };
  const assertForeign = async (path: string) => {
    const raw = await readFile(path, 'utf8');
    const config = JSON.parse(raw);
    assert.equal(JSON.stringify(config.hooks[event][0]), JSON.stringify(foreignEntry));
    const fragment = JSON.stringify(foreignEntry, null, 2)
      .split('\n')
      .map((line, index) => (index ? `      ${line}` : line))
      .join('\n');
    assert.ok(raw.includes(fragment), 'foreign entry bytes must survive');
  };
  check(
    'detect reports every searched location and writes nothing with host binaries absent',
    async ({ root, adapter }) => {
      const before = await snapshot(root);
      const { resolvedPath: _resolvedPath, ...detected } = await adapter.detect();
      assert.deepEqual(detected, {
        supported: false,
        version: '',
        reason: options.deferred ? 'deferred' : 'not_found',
        ...(options.deferred
          ? {}
          : {
              searchedLocations: [
                ...(options.name === 'cursor'
                  ? ['/usr/share/cursor/bin/cursor', '/opt/Cursor/resources/app/bin/cursor']
                  : []),
              ],
            }),
      });
      assert.deepEqual(await snapshot(root), before);
    }
  );
  if (options.deferred) {
    check('defers every other operation', async ({ adapter, target }) => {
      for (const operation of [
        () => adapter.capabilities(),
        () => adapter.inspect(),
        () => adapter.plan(),
        () => adapter.install({ stage: async () => {} }, target),
        () => adapter.update({ stage: async () => {} }, target),
        () => adapter.repair({ stage: async () => {} }, target),
        () => adapter.launch(),
        () => adapter.verify(),
        () => adapter.uninstall({ stage: async () => {} }, target),
        () => adapter.revoke?.({ id: 'grant', account: 'account', scopes: [] }),
      ])
        await assert.rejects(async (): Promise<unknown> => operation(), /not_supported/);
    });
    return checks;
  }
  const versionOutput = {
    cursor: '3.20.17',
    grok: 'grok 1.0.25',
    'claude-code': '2.1.268 (Claude Code)',
    codex: 'codex-cli 0.145.0',
  }[options.name];
  assert.ok(versionOutput);
  check('distinguishes wrong vendor output from an absent binary', async ({ deps }) => {
    const adapter = create({
      ...deps,
      execFile: async () => ({ stdout: 'another-product 1.2.3', stderr: '' }),
    });
    assert.deepEqual(await adapter.detect(), {
      supported: false,
      version: '1.2.3',
      reason: 'wrong_vendor',
      resolvedPath: options.name === 'claude-code' ? 'claude' : options.name,
    });
  });
  check('keeps unrecognised vendor output as an unverified version', async ({ deps }) => {
    const adapter = create({
      ...deps,
      execFile: async () => ({ stdout: '', stderr: '' }),
    });
    assert.deepEqual(await adapter.detect(), {
      supported: false,
      version: '',
      reason: 'unverified_version',
      resolvedPath: options.name === 'claude-code' ? 'claude' : options.name,
    });
  });
  check(
    'Windows prefers vendor installation, then filters ordered where candidates and caches the result',
    async ({ deps, target }) => {
      const name = options.name === 'claude-code' ? 'claude' : options.name;
      const extension = options.name === 'grok' ? '.exe' : '.cmd';
      const preferred =
        options.name === 'cursor'
          ? 'C:/Local/Programs/cursor/resources/app/bin/cursor.cmd'
          : options.name === 'grok'
            ? 'C:/User/.grok/bin/grok.exe'
            : `C:/Roaming/npm/${name}.cmd`;
      const normalize = win32.normalize;
      for (const installed of [true, false]) {
        const fallback = normalize(`C:/First Bin/${name}${extension}`);
        const expected = installed ? normalize(preferred) : fallback;
        const calls: string[][] = [];
        const host = create({
          ...deps,
          platform: 'win32',
          target: { ...target, component: 'mcp' },
          env: {
            ...deps.env,
            LOCALAPPDATA: 'C:/Local',
            USERPROFILE: 'C:/User',
            APPDATA: 'C:/Roaming',
            ComSpec: 'C:/Windows/System32/cmd.exe',
          },
          binaryExists: async (file) => installed || file === fallback || file.includes('Second'),
          execFile: async (file, args) => {
            calls.push([file, ...args]);
            return {
              stdout: file.endsWith('where.exe')
                ? `${name}${extension}\r\nC:\\Wrong\\${name}.ps1\r\n${fallback}\r\nC:\\Second\\${name}${extension}`
                : args.join(' ').includes('--version')
                  ? versionOutput
                  : 'mnemonik: Connected',
              stderr: '',
            };
          },
        });
        const [first, second] = await Promise.all([host.detect(), host.detect()]);
        assert.equal(first.supported, true);
        assert.equal(second.resolvedPath, expected);
        assert.equal((await host.inspect()).resolvedPath, expected);
        assert.equal(
          calls.filter(([file]) => file.endsWith('where.exe')).length,
          installed ? 0 : 1
        );
        assert.equal(calls.filter((call) => call.join(' ').includes('--version')).length, 1);
        for (const [file, ...args] of calls.filter(([file]) => !file.endsWith('where.exe'))) {
          if (extension === '.exe') assert.equal(file, expected);
          else {
            assert.equal(file, 'C:/Windows/System32/cmd.exe');
            assert.deepEqual(args.slice(0, 4), ['/d', '/s', '/c', `""${expected}"`]);
          }
        }
      }
    }
  );
  check('reports real scopes and leaves unobserved grants absent', async ({ adapter }) => {
    assert.deepEqual(adapter.capabilities(), {
      scopes: options.scopes,
      revoke: ['claude-code', 'codex'].includes(options.name),
      components: ['hooks', 'mcp'],
      nativeConnect: !['grok', 'claude-code', 'cursor'].includes(options.name),
      ...(options.name === 'cursor' ? { nativeListing: false } : {}),
    });
    const inspection = await adapter.verify();
    assert.equal(inspection.declarationPresent, false);
    assert.equal(inspection.authenticatedTools, false);
    assert.equal(inspection.grant, undefined);
    assert.match(await adapter.launch(), /mnemonik/i);
  });
  check('rejects shell metacharacters in the configured origin', async ({ deps }) => {
    const adapter = create({
      ...deps,
      env: { ...deps.env, MNEMONIK_API_RESOURCE: 'https://x;calc.test' },
    });
    await assert.rejects(() => adapter.plan(), /invalid_server_origin/);
  });
  for (const scope of options.scopes)
    check(
      `${scope}: deterministic plan; install stages and does not write; uninstall preserves foreign bytes`,
      async ({ root, target: base, deps, configPath }) => {
        const adapter = create({
          ...deps,
          env: { ...deps.env, MNEMONIK_API_RESOURCE: 'https://staging.example.test/api' },
        });
        const target = { ...base, scope };
        await writeChanges([
          {
            path: configPath(scope),
            content: Buffer.from(
              `${JSON.stringify({ hooks: { [event]: [foreignEntry] } }, null, 2)}\n`
            ),
          },
        ]);
        const before = await snapshot(root);
        const plan = await adapter.plan(target);
        assert.deepEqual(await adapter.plan(target), plan);
        assert.equal(plan.requestedScope, scope);
        assert.equal(plan.effectiveScope, scope);
        assert.equal(plan.version, '1.0.0');
        assert.equal(plan.artifactDigest, 'verified-receipt');
        assert.ok(
          plan.changes.some((change) =>
            change.content.includes('--credential-family ' + target.credentialFamily)
          )
        );
        const configuration = plan.changes.at(-1);
        assert.ok(configuration);
        const config = JSON.parse(configuration.content.toString());
        const commands: string[] = [];
        const collect = (value: unknown): void => {
          if (!value || typeof value !== 'object') return;
          for (const [key, child] of Object.entries(value)) {
            if (
              key === 'command' &&
              typeof child === 'string' &&
              child.includes('--mnemonik-owner=')
            )
              commands.push(child);
            else collect(child);
          }
        };
        collect(config);
        assert.ok(commands.length > 0);
        for (const command of commands)
          assert.ok(command.includes(' --server https://staging.example.test '), command);
        if (options.name !== 'codex') {
          const config = plan.changes.at(-1);
          assert.ok(config);
          const hooks = JSON.parse(config.content.toString()).hooks;
          const event = options.name === 'cursor' ? 'afterMCPExecution' : 'PostToolUse';
          assert.ok(
            hooks[event]
              .flatMap((entry: { hooks?: unknown[] }) => entry.hooks ?? [entry])
              .some(
                (entry: { command?: string; timeout?: number }) =>
                  entry.command?.includes('--credential-family ' + target.credentialFamily) &&
                  (entry.timeout ?? 0) >= 40
              )
          );
        }
        if (options.name !== 'codex')
          assert.ok(plan.changes.some((c) => c.content.includes(target.runtimeEntry)));
        else
          assert.ok(plan.changes.some((c) => c.path === join(target.runtimeRoot, 'launcher.mjs')));
        assert.deepEqual(await snapshot(root), before);
        const staged: FileChange[] = [];
        const writer = {
          stage: async (change: FileChange) => {
            staged.push(change);
          },
        };
        await adapter.install(writer, target);
        assert.deepEqual(staged, plan.changes);
        assert.deepEqual(await snapshot(root), before, 'install must not write');
        await writeChanges(staged);
        assert.equal((await adapter.inspect(target)).declarationPresent, true);
        await assertForeign(configPath(scope));
        const installed = await snapshot(root);
        for (const operation of [adapter.update, adapter.repair]) {
          staged.length = 0;
          await operation(writer, target);
          assert.deepEqual(staged, plan.changes);
          assert.deepEqual(await snapshot(root), installed);
        }
        staged.length = 0;
        await adapter.uninstall(writer, target);
        assert.deepEqual(await snapshot(root), installed);
        await writeChanges(staged);
        assert.equal((await adapter.inspect(target)).declarationPresent, false);
        assert.ok(!(await readFile(configPath(scope), 'utf8')).includes('mnemonik'));
        await assertForeign(configPath(scope));
      }
    );
  for (const scope of options.scopes)
    for (const component of options.mcpConfig ? (['hooks', 'mcp'] as const) : (['hooks'] as const))
      check(
        `${scope} ${component}: uninstall removes only a config created by install`,
        async ({ target: base, deps, project, configPath }) => {
          const target = { ...base, component, scope };
          const path =
            component === 'hooks'
              ? configPath(scope)
              : join(
                  scope === 'user' ? (deps.env?.HOME ?? '') : project,
                  options.mcpConfig?.[scope] ?? ''
                );
          target.createdFiles = [path];
          const adapter = create({ ...deps, target });
          await writeChanges((await adapter.plan()).changes);
          const staged: FileChange[] = [];
          await adapter.uninstall({ stage: async (change) => void staged.push(change) }, target);
          await writeChanges(staged);
          await assert.rejects(readFile(path), { code: 'ENOENT' });

          const empty = component === 'mcp' && options.mcpConfig?.toml ? '\n' : '{}\n';
          await writeFile(path, empty);
          const preExistingTarget = { ...base, component, scope };
          const preExisting = create({ ...deps, target: preExistingTarget });
          await writeChanges((await preExisting.plan()).changes);
          staged.length = 0;
          await preExisting.uninstall(
            { stage: async (change) => void staged.push(change) },
            preExistingTarget
          );
          await writeChanges(staged);
          assert.ok(!(await readFile(path, 'utf8')).includes('mnemonik'));
        }
      );
  check(
    'replacement rule: reports alternate-scope entries and never stages that config',
    async ({ adapter, target, configPath }) => {
      await writeChanges((await adapter.plan(target)).changes);
      const before = await readFile(configPath('user'));
      const projectTarget = { ...target, scope: 'project' as const };
      assert.deepEqual((await adapter.inspect(projectTarget)).otherScopes, [
        { scope: 'user', path: configPath('user') },
      ]);
      assert.ok(
        !(await adapter.plan(projectTarget)).changes.some((c) => c.path === configPath('user'))
      );
      await writeChanges((await adapter.plan(projectTarget)).changes);
      assert.deepEqual(await readFile(configPath('user')), before);
    }
  );
  if (options.mcpConfig)
    for (const scope of options.scopes)
      check(
        `${scope}: MCP declaration has the correct machine header and preserves foreign fields`,
        async ({ root, project, deps, target: base }) => {
          const target = { ...base, component: 'mcp' as const, scope };
          const adapter = create({ ...deps, target });
          const config = options.mcpConfig;
          assert.ok(config);
          const path = join(scope === 'user' ? (deps.env?.HOME ?? '') : project, config[scope]);
          const foreign = { url: 'https://foreign.example/mcp', custom: '  keep exactly  ' };
          const original = config.toml
            ? '[mcp_servers.foreign]\nurl = "https://foreign.example/mcp"\ncustom = "  keep exactly  "\n'
            : JSON.stringify({ mcpServers: { foreign }, setting: 'keep' }, null, 2) + '\n';
          await writeChanges([{ path, content: Buffer.from(original) }]);
          const before = await snapshot(root);
          const plan = await adapter.plan();
          assert.equal(plan.changes.length, 1);
          assert.equal(plan.changes[0]?.path, path);
          const raw = plan.changes[0]?.content.toString();
          assert.ok(raw);
          assert.ok(raw.includes('https://api.mnemonik.dev/mcp'));
          const sessionHeader = /headers\s*=.*"x-mcp-session-id"\s*=\s*"\{\{session_id\}\}"/u;
          const withoutSessionHeader =
            options.name === 'grok' && config.toml
              ? raw.replace(/,?\s*"x-mcp-session-id"\s*=\s*"\{\{session_id\}\}"/u, '')
              : raw;
          if (options.name === 'grok') assert.match(raw, sessionHeader);
          if (scope === 'user') assert.match(withoutSessionHeader, /x-mnemonik-installation-id/);
          else assert.doesNotMatch(withoutSessionHeader, /x-mnemonik-installation-id/);
          if (config.toml) assert.ok(raw.startsWith(original));
          else {
            const parsed = JSON.parse(raw);
            assert.deepEqual(parsed.mcpServers.foreign, foreign);
            assert.deepEqual(parsed.mcpServers.mnemonik, {
              ...(config.type ? { type: config.type } : {}),
              url: 'https://api.mnemonik.dev/mcp',
              ...(scope === 'user'
                ? {
                    headers: {
                      'x-mnemonik-installation-id': '11111111-1111-4111-8111-111111111111',
                    },
                  }
                : {}),
            });
          }
          const staged: FileChange[] = [];
          const writer = {
            stage: async (change: FileChange) => {
              staged.push(change);
            },
          };
          await adapter.install(writer, target);
          assert.deepEqual(staged, plan.changes);
          assert.deepEqual(await snapshot(root), before);
          await writeChanges(staged);
          assert.equal((await adapter.inspect()).declarationPresent, true);
          assert.deepEqual((await adapter.plan()).changes, plan.changes);

          if (scope === 'user') {
            const installed = await readFile(path, 'utf8');
            if (config.toml)
              await writeFile(
                path,
                installed
                  .replace(/,?\s*"x-mnemonik-installation-id"\s*=\s*"[^"]*"/u, '')
                  .replace(/\{\s*,/u, '{')
                  .replace(/,\s*\}/u, ' }')
                  .replace(
                    'url = "https://api.mnemonik.dev/mcp"\n',
                    'url = "https://api.mnemonik.dev/mcp"\ncustom = "keep exactly"\n'
                  )
              );
            else {
              const missing = JSON.parse(installed);
              missing.mcpServers.mnemonik.custom = 'keep exactly';
              missing.mcpServers.mnemonik.headers['x-foreign'] = 'keep exactly';
              delete missing.mcpServers.mnemonik.headers['x-mnemonik-installation-id'];
              await writeFile(path, JSON.stringify(missing, null, 2) + '\n');
            }
            const missingHeader = await readFile(path, 'utf8');
            staged.length = 0;
            await adapter.repair(writer, target);
            await writeChanges(staged);
            const repaired = await readFile(path, 'utf8');
            assert.match(repaired, /x-mnemonik-installation-id/);
            assert.match(repaired, /keep exactly/);
            if (options.name === 'grok') assert.match(repaired, /x-mcp-session-id/);
            if (config.toml) {
              const withoutManagedHeader = repaired
                .replace(
                  /(?:,\s*)?(?:["']x-mnemonik-installation-id["']|x-mnemonik-installation-id)\s*=\s*["'][^"']*["']\s*,?/u,
                  ''
                )
                .replace(/\{\s*,/u, '{')
                .replace(/,\s*\}/u, ' }');
              assert.equal(withoutManagedHeader, missingHeader);
            } else {
              const withoutManagedHeader = JSON.parse(repaired);
              delete withoutManagedHeader.mcpServers.mnemonik.headers['x-mnemonik-installation-id'];
              assert.equal(JSON.stringify(withoutManagedHeader, null, 2) + '\n', missingHeader);
            }
          }

          staged.length = 0;
          await adapter.uninstall(writer, target);
          await writeChanges(staged);
          const removed = await readFile(path, 'utf8');
          assert.ok(!removed.includes('mnemonik'));
          if (config.toml) assert.equal(removed, original);
          else assert.deepEqual(JSON.parse(removed).mcpServers.foreign, foreign);

          const sameName = config.toml
            ? '[mcp_servers.mnemonik]\nurl = "https://foreign.example/mcp"\ncustom = "keep"\n'
            : JSON.stringify({ mcpServers: { mnemonik: foreign }, setting: 'keep' }, null, 2) +
              '\n';
          await writeFile(path, sameName);
          const conflicted = await snapshot(root);
          await assert.rejects(adapter.plan(), /mcp_name_conflict/);
          await assert.rejects(
            adapter.uninstall({ stage: async () => assert.fail('must not stage') }, target),
            /mcp_name_conflict/
          );
          assert.deepEqual(await snapshot(root), conflicted);
        }
      );
  check(
    'native login/logout use the named server; missing executable returns manual instruction without writes',
    async ({ root, deps }) => {
      const calls: string[][] = [];
      const adapter = create({
        ...deps,
        execFile: async (_file, args) => {
          if (args[0] === '--version') return { stdout: versionOutput, stderr: '' };
          calls.push(args);
          return { stdout: '', stderr: '' };
        },
      });
      await adapter.launch();
      if (adapter.capabilities().nativeConnect)
        assert.deepEqual(calls.shift(), ['mcp', 'login', 'mnemonik']);
      else assert.deepEqual(calls, []);
      if (adapter.revoke) {
        assert.equal(await adapter.revoke({ id: 'grant', account: 'owner', scopes: [] }), true);
        assert.deepEqual(calls.shift(), ['mcp', 'logout', 'mnemonik']);
      }
      const before = await snapshot(root);
      assert.match(await create(deps).launch(), /mnemonik/i);
      assert.deepEqual(await snapshot(root), before);
    }
  );
  return checks;
}
