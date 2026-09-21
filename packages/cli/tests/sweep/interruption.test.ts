import { afterEach, describe, expect, it } from 'vitest';
import { readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MUTATION_KINDS, bytesAt, digest, type JournalData } from '../../src/install/journal.js';
import { makeSweepFixture, type SweepFixture } from '../fixtures/sweep.js';

const fixtures: SweepFixture[] = [];
afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup())));

const BOUNDARY_KINDS = [
  'journal_created',
  'planned',
  'stage_intent',
  'stage_written',
  'staged',
  'consent_recorded',
  'project_staged',
  'commit_intent',
  'commit_written',
  'committed',
  'service_start_intent',
  'service_started',
  'upload_intent',
  'upload_finished',
] as const;
const NON_BOUNDARY_KINDS = [
  'host_intent',
  'host_observed',
  'roots_confirmed',
  'project_stage_intent',
  'projects_staged',
  'final_review',
  'apply',
  'local_commit',
  'complete',
  'service_restored',
  'project_restored',
  'restored',
  'credential_revoked',
  'compensation_finished',
  'reconciled',
] as const;

async function fixture() {
  const result = await makeSweepFixture();
  fixtures.push(result);
  return result;
}

async function assertJournalMatchesDisk(f: SweepFixture, journal: JournalData) {
  expect(journal.mutations.map((entry) => entry.sequence)).toEqual(
    journal.mutations.map((_, index) => index + 1)
  );
  const saved = await f.journal();
  expect(saved.mutations).toEqual(journal.mutations);
  for (const target of journal.targets) {
    const written = journal.mutations.some(
      (entry) =>
        entry.target === target.id &&
        (entry.event === 'stage_written' || entry.event === 'commit_written')
    );
    const expected =
      target.status === 'restored'
        ? target.beforeHash
        : target.status === 'committed' || written
          ? target.proposedHash
          : target.staging === 'additive' && target.status === 'staged'
            ? target.proposedHash
            : target.beforeHash;
    expect(digest(await bytesAt(target.path)), `${target.id}:${target.path}`).toBe(expected);
  }
}

describe('interruption after every install mutation boundary', () => {
  it('keeps the source mutation inventory exhaustively classified', () => {
    expect([...new Set([...BOUNDARY_KINDS, ...NON_BOUNDARY_KINDS])].sort()).toEqual(
      [...MUTATION_KINDS].sort()
    );
  });

  it('offers recovery at every boundary; resume is idempotent and rollback is exact', async () => {
    const traceFixture = await fixture();
    const trace: JournalData['mutations'] = [];
    traceFixture.install.fault = (_event, journal) => {
      trace.push({ ...journal.data.mutations.at(-1)! });
    };
    expect(await traceFixture.run()).toBe(3);
    const boundaries = trace.filter((entry) => BOUNDARY_KINDS.includes(entry.event as never));
    expect(new Set(boundaries.map((entry) => entry.event))).toEqual(new Set(BOUNDARY_KINDS));

    for (const boundary of boundaries) {
      const resumed = await fixture();
      resumed.install.fault = (_event, journal) => {
        if (journal.data.mutations.at(-1)?.sequence === boundary.sequence)
          throw new Error(`killed_after_${boundary.event}`);
      };
      expect(await resumed.run(), `interrupt ${boundary.sequence}:${boundary.event}`).toBe(1);
      await assertJournalMatchesDisk(resumed, await resumed.journal());
      resumed.install.fault = undefined;
      resumed.stdout.clear();
      resumed.stderr.clear();
      expect(await resumed.run(), `resume ${boundary.sequence}:${boundary.event}`).toBe(3);
      const complete = await resumed.journal();
      expect(resumed.counts.recoveries).toBe(1);
      expect(resumed.counts.remoteCreates).toBe(1);
      expect(resumed.counts.serviceStarts).toBe(1);
      expect(resumed.counts.uploads).toBe(1);
      expect(new Set(complete.targets.map((target) => target.path)).size).toBe(
        complete.targets.length
      );
      expect(complete.targets.filter((target) => target.kind === 'host')).toHaveLength(3);
      await assertJournalMatchesDisk(resumed, complete);

      const rolledBack = await fixture();
      rolledBack.recovery.choice = 'rollback';
      rolledBack.install.fault = (_event, journal) => {
        if (journal.data.mutations.at(-1)?.sequence === boundary.sequence)
          throw new Error(`killed_after_${boundary.event}`);
      };
      expect(await rolledBack.run()).toBe(1);
      await assertJournalMatchesDisk(rolledBack, await rolledBack.journal());
      rolledBack.install.fault = undefined;
      expect(await rolledBack.run(), `rollback ${boundary.sequence}:${boundary.event}`).toBe(130);
      const restored = await rolledBack.journal();
      expect(rolledBack.counts.recoveries).toBe(1);
      for (const target of restored.targets)
        expect(digest(await bytesAt(target.path)), target.path).toBe(target.beforeHash);
      for (const path of Object.values(rolledBack.hostPaths))
        expect(await readFile(path)).toEqual(rolledBack.original);
      await assertJournalMatchesDisk(rolledBack, restored);
    }
  }, 120_000);

  it('does not repeat a completed service start before its marker is saved', async () => {
    const service = await fixture();
    const ensureRunning = service.install.services!.start;
    let stopAfterEffect = true;
    service.install.services!.start = async (...args) => {
      const result = await ensureRunning(...args);
      if (stopAfterEffect) throw new Error('killed_after_service_effect');
      return result;
    };
    expect(await service.run()).toBe(1);
    stopAfterEffect = false;
    service.install.services!.start = ensureRunning;
    expect([0, 3]).toContain(await service.run());
    expect(service.counts.serviceStarts).toBe(1);
  });

  it('does not repeat a completed upload before its marker is saved', async () => {
    const upload = await fixture();
    const startUpload = upload.install.upload!.start;
    let stopAfterEffect = true;
    upload.install.upload!.start = async (...args) => {
      const result = await startUpload(...args);
      if (stopAfterEffect) throw new Error('killed_after_upload_effect');
      return result;
    };
    expect(await upload.run()).toBe(1);
    stopAfterEffect = false;
    upload.install.upload!.start = startUpload;
    expect([0, 3]).toContain(await upload.run());
    expect(upload.counts.uploads).toBe(1);
    const intents = (await upload.journal()).mutations.filter(
      (entry) => entry.event === 'upload_intent'
    );
    expect(intents).toHaveLength(1);
    expect(intents[0]?.target).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it.each(['outside backup', 'symlinked backup', 'undeclared target'] as const)(
    'refuses rollback with %s journal metadata',
    async (kind) => {
      const f = await fixture();
      f.install.fault = (event) => {
        if (event === 'final_review') throw new Error('interrupt_for_backup_check');
      };
      expect(await f.run()).toBe(1);
      const data = await f.journal();
      const [runId] = await readdir(join(f.stateDir, 'install'));
      const journalPath = join(f.stateDir, 'install', runId!, 'journal.json');
      const target = data.targets.find((entry) => entry.beforeHash !== null)!;
      if (kind === 'outside backup') target.backup = join(f.stateDir, 'outside.before');
      else if (kind === 'symlinked backup') {
        await rm(target.backup);
        await symlink(target.proposed, target.backup);
      } else target.path = join(f.home, 'not-declared-by-this-run');
      await writeFile(journalPath, JSON.stringify(data));
      f.install.fault = undefined;
      f.recovery.choice = 'rollback';
      f.stderr.clear();
      expect(await f.run()).toBe(1);
      expect(f.stderr.text).toContain(
        'This machine needs attention before Mnemonik can work fully.'
      );
      expect(f.stderr.text).not.toContain('journal_invalid');
    }
  );
});

it('restores a real Cursor adapter after interruption at host commit', async () => {
  const f = await fixture();
  const { mkdir } = await import('node:fs/promises');
  const { createHostAdapter } = await import('@mnemonik/cursor-hooks/adapter');
  const cursorDir = join(f.home, '.cursor');
  const bin = join(f.home, 'bin');
  await mkdir(cursorDir);
  await mkdir(bin);
  const path = join(cursorDir, 'mcp.json');
  await writeFile(path, f.original);
  await writeFile(
    join(bin, 'cursor'),
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "3.20.17"; else echo "Cursor Desktop"; fi\n',
    { mode: 0o700 }
  );
  const { RuntimeStore, hash } = await import('../../src/runtime/store.js');
  const dispatcher = Buffer.from('export {};\n');
  const runtime = await new RuntimeStore(f.stateDir).installRuntime('cursor', '1.0.0', {
    files: { 'hook.js': dispatcher },
    manifest: {
      schemaVersion: 1,
      artifact: 'cursor',
      version: '1.0.0',
      entry: 'hook.js',
      files: {
        'hook.js': { sha256: hash(dispatcher), size: dispatcher.length, executable: false },
      },
      totalSize: dispatcher.length,
      source: { kind: 'release', url: 'https://fixture.invalid/cursor' },
    },
  });
  const target = {
    component: 'mcp' as const,
    scope: 'user' as const,
    credentialFamily: 'hook-family',
    runtimeEntry: runtime.entry,
    runtimeRoot: join(f.stateDir, 'runtimes', 'cursor'),
    installationId: '11111111-1111-4111-8111-111111111111',
  };
  const adapter = createHostAdapter({
    target,
    env: { ...process.env, HOME: f.home, PATH: bin },
  });
  const previousConfig = (await adapter.plan(target)).changes[0]!.content;
  await writeFile(path, `${JSON.stringify(JSON.parse(previousConfig.toString()))}\n`);
  const original = await readFile(path);
  const verifyDesktop = adapter.verify.bind(adapter);
  expect(await verifyDesktop(target)).toMatchObject({
    declarationPresent: true,
    authenticatedTools: false,
  });
  f.install.adapters = [adapter];
  f.install.input.hosts = ['cursor'];
  f.install.targets = { cursor: target };
  f.install.fault = (event, journal) => {
    if (
      event === 'commit_written' &&
      journal.data.targets.find((t) => t.id === journal.data.mutations.at(-1)?.target)?.host ===
        'cursor'
    )
      throw new Error('interrupt_real_host_commit');
  };
  expect(await f.run()).toBe(1);
  expect(await readFile(path)).not.toEqual(original);
  f.install.fault = undefined;
  f.recovery.choice = 'rollback';
  expect(await f.run()).toBe(130);
  expect(await readFile(path)).toEqual(original);
}, 60_000);
