import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inventoryIdentityFiles, runIdentityMigration } from '../src/identity/migrate.js';
import { parseIdentityFile } from '@mnemonik/shared';

const ID = 'c457f817-1a7f-415d-b585-553999e2da09';
const OTHER_ID = '11111111-1111-4111-8111-111111111111';

describe('private identity migration', () => {
  let fixtureRoot = '';
  afterEach(async () => {
    if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  });

  async function fixture() {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'mnemonik-identity-migration-'));
    const home = join(fixtureRoot, 'home');
    const stateDir = join(fixtureRoot, 'state');
    const paths = Object.fromEntries(
      ['v0', 'v1', 'malformed', 'invalid'].map((name) => [name, join(fixtureRoot, name)])
    ) as Record<'v0' | 'v1' | 'malformed' | 'invalid', string>;
    await Promise.all([
      mkdir(home, { recursive: true }),
      mkdir(stateDir, { recursive: true }),
      ...Object.values(paths).map((path) => mkdir(path, { recursive: true })),
    ]);
    const originals = {
      v0: Buffer.from(
        `{\n  "projectId": "${ID}",\n  "projectName": "old",\n  "legacyHint": true\n}\n`
      ),
      v1: Buffer.from(
        `${JSON.stringify({ schemaVersion: 1, projectId: OTHER_ID, projectName: 'current' }, null, 2)}\n`
      ),
      malformed: Buffer.from(`{"schemaVersion":1,"projectId":"${ID}","unknown":true}\n`),
      invalid: Buffer.from('{"projectId":"not-a-uuid"}\n'),
      rule: Buffer.from(`---\nalwaysApply: true\n---\nprojectId: ${ID}\ncwd: ${paths.v0}\n`),
    };
    await Promise.all([
      writeFile(join(paths.v0, '.mnemonik.json'), originals.v0),
      writeFile(join(paths.v1, '.mnemonik.json'), originals.v1),
      writeFile(join(paths.malformed, '.mnemonik.json'), originals.malformed),
      writeFile(join(paths.invalid, '.mnemonik.json'), originals.invalid),
      mkdir(join(paths.v0, '.cursor', 'rules'), { recursive: true }).then(() =>
        writeFile(join(paths.v0, '.cursor', 'rules', 'memory_tools.mdc'), originals.rule)
      ),
    ]);
    return {
      home,
      stateDir,
      paths,
      originals,
      unreachable: join(fixtureRoot, 'disconnected-volume'),
    };
  }

  it('reports every state without writes, then backs up, applies, verifies and rolls back exact bytes', async () => {
    const f = await fixture();
    const selected = [...Object.values(f.paths), f.unreachable];
    const report = await inventoryIdentityFiles({
      mode: 'report',
      paths: selected,
      home: f.home,
      stateDir: f.stateDir,
    });
    expect(report.entries.map(({ state }) => state)).toEqual(
      expect.arrayContaining(['v0', 'v1', 'malformed', 'invalid_uuid', 'cursor_match'])
    );
    expect(report.entries.some((entry) => entry.projectPath === f.unreachable)).toBe(false);
    expect(report.entries.find((entry) => entry.state === 'v0')).toMatchObject({
      strictResult: 'unknown_version',
      droppedKeys: ['legacyHint'],
    });
    expect(report.entries.find((entry) => entry.state === 'malformed')).toMatchObject({
      actionRequired: true,
    });
    expect(report.entries.find((entry) => entry.state === 'invalid_uuid')).toMatchObject({
      actionRequired: true,
    });
    expect(await readFile(join(f.paths.v0, '.mnemonik.json'))).toEqual(f.originals.v0);
    expect(await readFile(join(f.paths.v1, '.mnemonik.json'))).toEqual(f.originals.v1);
    expect(await readFile(join(f.paths.malformed, '.mnemonik.json'))).toEqual(
      f.originals.malformed
    );
    expect(await readFile(join(f.paths.invalid, '.mnemonik.json'))).toEqual(f.originals.invalid);
    expect(await readFile(join(f.paths.v0, '.cursor', 'rules', 'memory_tools.mdc'))).toEqual(
      f.originals.rule
    );

    const backup = await runIdentityMigration({
      mode: 'backup',
      paths: selected,
      home: f.home,
      stateDir: f.stateDir,
    });
    expect(backup.status).toBe('backed_up');
    if (backup.status !== 'backed_up') throw new Error('backup failed');
    const index = JSON.parse(await readFile(backup.indexPath, 'utf8')) as {
      entries: Array<{ backupFile: string; droppedKeys: string[] }>;
    };
    const v0Backup = index.entries.find((entry) => entry.droppedKeys.includes('legacyHint'))!;
    expect(v0Backup.droppedKeys).toEqual(['legacyHint']);
    expect(await readFile(join(backup.indexPath, '..', v0Backup.backupFile))).toEqual(
      f.originals.v0
    );

    const apply = await runIdentityMigration({ mode: 'apply', home: f.home, stateDir: f.stateDir });
    expect(
      parseIdentityFile(await readFile(join(f.paths.v0, '.mnemonik.json'), 'utf8'))
    ).toMatchObject({ kind: 'ok', identity: { projectId: ID, projectName: 'old' } });
    expect(await readFile(join(f.paths.v1, '.mnemonik.json'))).toEqual(f.originals.v1);
    expect(await readFile(join(f.paths.malformed, '.mnemonik.json'))).toEqual(
      f.originals.malformed
    );
    expect(await readFile(join(f.paths.invalid, '.mnemonik.json'))).toEqual(f.originals.invalid);
    expect(await readFile(join(f.paths.v0, '.cursor', 'rules', 'memory_tools.mdc'))).toEqual(
      f.originals.rule
    );
    expect(backup.count).toBe(1);
    expect(apply).toMatchObject({ status: 'applied', passed: 1, failed: 0 });

    expect(
      await runIdentityMigration({ mode: 'verify', home: f.home, stateDir: f.stateDir })
    ).toMatchObject({ status: 'verified', passed: 1, failed: 0 });
    await writeFile(
      join(f.paths.v0, '.mnemonik.json'),
      `${JSON.stringify({ schemaVersion: 1, projectId: ID })}\n`
    );
    expect(
      await runIdentityMigration({ mode: 'verify', home: f.home, stateDir: f.stateDir })
    ).toMatchObject({ status: 'verified', passed: 0, failed: 1 });
    expect(
      await runIdentityMigration({
        mode: 'rollback',
        runId: backup.runId,
        home: f.home,
        stateDir: f.stateDir,
      })
    ).toMatchObject({ status: 'rolled_back', passed: 1, failed: 0 });
    expect(await readFile(join(f.paths.v0, '.mnemonik.json'))).toEqual(f.originals.v0);
  });

  it('reports a Cursor UUID mismatch and never guesses or rewrites it', async () => {
    const f = await fixture();
    const rule = join(f.paths.v0, '.cursor', 'rules', 'memory_tools.mdc');
    const mismatch = Buffer.from(`projectId: ${OTHER_ID}\ncwd: ${f.paths.v0}\n`);
    await writeFile(rule, mismatch);
    const report = await inventoryIdentityFiles({
      mode: 'report',
      paths: [f.paths.v0],
      home: f.home,
      stateDir: f.stateDir,
    });
    expect(report.entries.find((entry) => entry.kind === 'cursor_rule')).toMatchObject({
      state: 'cursor_mismatch',
      projectId: OTHER_ID,
    });
    await runIdentityMigration({
      mode: 'backup',
      paths: [f.paths.v0],
      home: f.home,
      stateDir: f.stateDir,
    });
    await runIdentityMigration({ mode: 'apply', home: f.home, stateDir: f.stateDir });
    expect(await readFile(rule)).toEqual(mismatch);
  });

  it('limits explicit discovery to byte-exact existing paths', async () => {
    const f = await fixture();
    const selected = [
      join(fixtureRoot, 'x', 'book-reader-2'),
      join(fixtureRoot, 'x', 'WTF Notebooks'),
    ];
    await Promise.all(
      selected.map(async (path) => {
        await mkdir(path, { recursive: true });
        await writeFile(join(path, '.mnemonik.json'), JSON.stringify({ projectId: ID }));
      })
    );
    await mkdir(join(f.home, '.claude', 'projects', '-tmp-x-does-not-exist'), {
      recursive: true,
    });
    await mkdir(join(f.home, '.mnemonik'), { recursive: true });
    await writeFile(
      join(f.home, '.mnemonik', 'scanner.json'),
      JSON.stringify({ roots: [f.paths.v1] })
    );

    const report = await inventoryIdentityFiles({
      mode: 'report',
      paths: selected,
      home: f.home,
      stateDir: f.stateDir,
      platform: 'linux',
    });

    expect(
      report.entries.map(({ projectPath, sources, state }) => ({ projectPath, sources, state }))
    ).toEqual(
      selected.map((projectPath) => ({ projectPath, sources: ['owner-selected'], state: 'v0' }))
    );

    const discovered = await inventoryIdentityFiles({
      mode: 'report',
      home: f.home,
      stateDir: f.stateDir,
      platform: 'linux',
    });
    expect(discovered.entries.map(({ projectPath }) => projectPath)).toEqual([f.paths.v1]);
  });

  it('collects the bounded scanner, CLI, host-config and recent-workspace sources', async () => {
    const f = await fixture();
    const target = f.paths.v1;
    const encoded = target.replaceAll('/', '-');
    const directories = [
      join(f.home, '.mnemonik'),
      join(f.stateDir, 'project-setup'),
      join(f.stateDir, 'project-commands', 'root'),
      join(f.home, '.claude', 'projects', encoded),
      join(f.home, '.codex', 'sessions'),
      join(f.home, '.cursor', 'projects', encoded.replace(/^-/, '')),
      join(f.home, '.grok', 'projects', encoded),
      join(f.home, '.config', 'Cursor', 'User', 'workspaceStorage', 'one'),
    ];
    await Promise.all(directories.map((path) => mkdir(path, { recursive: true })));
    await Promise.all([
      writeFile(
        join(f.home, '.mnemonik', 'scanner.json'),
        JSON.stringify({ roots: [target], disabledRoots: [target] })
      ),
      writeFile(join(f.stateDir, 'project-setup', 'one.json'), JSON.stringify({ root: target })),
      writeFile(
        join(f.stateDir, 'project-commands', 'root', 'one.json'),
        JSON.stringify({ resolvedRoot: target })
      ),
      mkdir(join(f.home, '.claude'), { recursive: true }).then(() =>
        writeFile(join(f.home, '.claude', 'settings.json'), JSON.stringify({ cwd: target }))
      ),
      writeFile(join(f.home, '.claude.json'), JSON.stringify({ projects: { [target]: {} } })),
      mkdir(join(f.home, '.codex'), { recursive: true }).then(() =>
        writeFile(
          join(f.home, '.codex', 'config.toml'),
          `[projects."${target}"]\ntrust_level = "trusted"\n`
        )
      ),
      writeFile(
        join(f.home, '.codex', 'sessions', 'one.jsonl'),
        `${JSON.stringify({ cwd: target })}\n`
      ),
      mkdir(join(f.home, '.cursor'), { recursive: true }).then(() =>
        Promise.all([
          writeFile(join(f.home, '.cursor', 'mcp.json'), JSON.stringify({ workspace: target })),
          writeFile(join(f.home, '.cursor', 'hooks.json'), JSON.stringify({ root: target })),
        ])
      ),
      mkdir(join(f.home, '.grok'), { recursive: true }).then(() =>
        writeFile(join(f.home, '.grok', 'config.toml'), `cwd = "${target}"\n`)
      ),
      writeFile(
        join(f.home, '.config', 'Cursor', 'User', 'workspaceStorage', 'one', 'workspace.json'),
        JSON.stringify({ folder: `file://${target}` })
      ),
    ]);
    const report = await inventoryIdentityFiles({
      mode: 'report',
      home: f.home,
      stateDir: f.stateDir,
      platform: 'linux',
    });
    expect(
      report.entries.find((entry) => entry.path === join(target, '.mnemonik.json'))?.sources
    ).toEqual(
      expect.arrayContaining([
        'scanner-active',
        'scanner-disabled',
        'cli-project-setup',
        'cli-project-commands',
        'claude-config',
        'claude-config-and-recent',
        'codex-config',
        'cursor-config',
        'grok-config',
        'claude-recent',
        'codex-recent',
        'cursor-recent',
        'cursor-workspaces',
        'grok-recent',
      ])
    );
  });
});
