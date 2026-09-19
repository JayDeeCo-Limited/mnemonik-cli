import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  hostNpmSource,
  RuntimeStore,
  type HostArtifact,
  type HostPackagePin,
} from '../src/runtime/store.js';
import { packedHosts } from './fixtures/hostRuntime.js';

const repo = resolve('../..');
const exactVersion = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/;

describe('release-pinned host closures', () => {
  let fixture: Awaited<ReturnType<typeof packedHosts>>;
  beforeAll(async () => {
    fixture = await packedHosts();
  }, 30_000);
  afterAll(async () => {
    await rm(fixture.root, { recursive: true, force: true });
  });

  it('is regenerated from the lockfile without ranges or dependency drift', async () => {
    // The generator rebuilds dist; other package suites pack the live workspace.
    const scratch = await mkdtemp(join(tmpdir(), 'host-closure-workspace-'));
    const liveArtifact = join(repo, 'packages/codex-hooks/dist/hook.js');
    const before = await stat(liveArtifact);
    try {
      await mkdir(join(scratch, 'scripts'));
      await cp(join(repo, 'scripts/host-closure.mjs'), join(scratch, 'scripts/host-closure.mjs'));
      await cp(join(repo, 'package-lock.json'), join(scratch, 'package-lock.json'));
      await writeFile(
        join(scratch, 'package.json'),
        JSON.stringify({ private: true, workspaces: ['packages/*'] })
      );
      await symlink(join(repo, 'node_modules'), join(scratch, 'node_modules'), 'dir');
      for (const name of [
        'cli',
        'shared',
        'credentials',
        'local-setup',
        'claude-code-hooks',
        'codex-hooks',
        'cursor-hooks',
        'grok-hooks',
      ])
        await cp(join(repo, 'packages', name), join(scratch, 'packages', name), {
          recursive: true,
          filter: (path) => basename(path) !== 'node_modules',
        });
      try {
        execFileSync(process.execPath, ['scripts/host-closure.mjs', '--check'], {
          cwd: scratch,
          stdio: 'pipe',
          encoding: 'utf8',
        });
      } catch (error) {
        // The script's stderr names the failing build or pack; without it the
        // failure is one opaque line (CI run 35407482477).
        const { stderr, stdout } = error as { stderr?: string; stdout?: string };
        throw new Error(`host-closure --check failed\n${stdout ?? ''}${stderr ?? ''}`);
      }
      expect((await stat(liveArtifact)).mtimeMs).toBe(before.mtimeMs);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
    const lock = JSON.parse(await readFile(join(repo, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { name?: string; version?: string; integrity?: string }>;
    };
    const cli = JSON.parse(await readFile(join(repo, 'packages/cli/package.json'), 'utf8')) as {
      mnemonik: { hosts: Record<HostArtifact, HostPackagePin> };
    };
    const expectedNames: Record<HostArtifact, string[]> = {
      'claude-code': [
        '@mnemonik/claude-code-hooks',
        '@mnemonik/credentials',
        '@mnemonik/local-setup',
        '@mnemonik/shared',
        'ignore',
        'web-tree-sitter',
        'proper-lockfile',
        'graceful-fs',
        'retry',
        'signal-exit',
      ],
      codex: [],
      cursor: [],
      grok: [],
    };
    expectedNames.codex = ['@mnemonik/codex-hooks', ...expectedNames['claude-code'].slice(1)];
    expectedNames.cursor = ['@mnemonik/cursor-hooks', ...expectedNames['claude-code'].slice(1)];
    expectedNames.grok = ['@mnemonik/grok-hooks', ...expectedNames['claude-code'].slice(1)];
    for (const [host, pin] of Object.entries(cli.mnemonik.hosts) as Array<
      [HostArtifact, HostPackagePin]
    >) {
      expect(pin.closure.map(({ name }) => name)).toEqual(expectedNames[host]);
      expect(pin.closure[0]).toMatchObject({ name: pin.package, version: pin.version });
      for (const entry of pin.closure) {
        expect(entry.version).toMatch(exactVersion);
        expect(entry.integrity).toMatch(/^sha(?:256|512)-[A-Za-z0-9+/=]+$/);
        expect(
          Object.values(lock.packages).some(
            (locked) => locked.name === entry.name && locked.version === entry.version
          ) ||
            Object.entries(lock.packages).some(
              ([path, locked]) =>
                path.endsWith(`node_modules/${entry.name}`) && locked.version === entry.version
            )
        ).toBe(true);
      }
    }
  }, 30_000);

  it('installs exact packages and refuses a closure integrity mismatch before installation', async () => {
    const state = await mkdtemp(join(tmpdir(), 'host-closure-'));
    try {
      fixture.requests.length = 0;
      const source = await hostNpmSource('codex', fixture.pins.codex, fixture.fetcher);
      expect(fixture.requests).toEqual(
        fixture.pins.codex.closure.flatMap(({ name, version }) => [
          `/${encodeURIComponent(name)}/${version}`,
          `/${encodeURIComponent(name)}/archive.tgz`,
        ])
      );
      const installed = await new RuntimeStore(state).installRuntime(
        'codex',
        fixture.pins.codex.version,
        source
      );
      expect(installed.manifest.source).toMatchObject({
        kind: 'npm',
        packages: fixture.pins.codex.closure,
      });

      const bad = structuredClone(fixture.pins.codex);
      bad.closure[1]!.integrity = 'sha512-' + Buffer.alloc(64).toString('base64');
      const empty = join(state, 'empty');
      await expect(
        (async () => {
          const candidate = await hostNpmSource('codex', bad, fixture.fetcher);
          return new RuntimeStore(empty).installRuntime('codex', bad.version, candidate);
        })()
      ).rejects.toMatchObject({ reason: 'digest_mismatch' });
      await expect(readFile(join(empty, 'runtimes/codex/current'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(state, { recursive: true, force: true });
    }
  }, 15_000);

  it('names a missing exact entry and never requests a range version', async () => {
    const missing = fixture.pins.codex.closure[1]!;
    const missingPath = `/${encodeURIComponent(missing.name)}/${missing.version}`;
    await expect(
      hostNpmSource('codex', fixture.pins.codex, async (input, init) =>
        new URL(String(input)).pathname === missingPath
          ? new Response(null, { status: 404 })
          : fixture.fetcher(input, init)
      )
    ).rejects.toMatchObject({
      reason: 'manifest_missing',
      message: `manifest_missing: ${missing.name}@${missing.version}`,
    });

    fixture.requests.length = 0;
    await hostNpmSource('codex', fixture.pins.codex, fixture.fetcher);
    const versions = fixture.requests
      .filter((path) => !path.endsWith('/archive.tgz'))
      .map((path) => decodeURIComponent(path.split('/').at(-1)!));
    expect(versions.every((version) => exactVersion.test(version))).toBe(true);
    expect(fixture.requests.join('\n')).not.toMatch(/%5e|~|%3e|%3c|%2a|[><*]/i);
    expect(versions.join('/')).not.toMatch(/(?:^|\/)x(?:\/|$)/i);
  });
});
