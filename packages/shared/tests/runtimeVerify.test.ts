/**
 * Runtime verification checks every file of a runtime before anything in it is
 * imported. It used to await each filesystem call in turn and inspect every
 * ancestor directory again for every file: a 1,929-file hook runtime took
 * 6.6 s, which `mnemonik status` paid on every run (26 Oct 2026). These tests
 * pin the bounded parallelism and the once-per-directory inspection, and that
 * every check still refuses what it refused before.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { RuntimeError, RuntimeReader, VERIFY_CONCURRENCY } from '../src/runtimeReader.js';

const posix = process.platform !== 'win32';
const fsPromises = createRequire(import.meta.url)(
  'node:fs/promises'
) as typeof import('node:fs/promises');
const realOpen = fsPromises.open;
const realLstat = fsPromises.lstat;
const calls = { open: 0, lstat: 0, inFlight: 0, maxInFlight: 0 };
const roots: string[] = [];

function observe(delayMs: number): void {
  fsPromises.open = (async (...args: Parameters<typeof realOpen>) => {
    calls.open += 1;
    calls.inFlight += 1;
    calls.maxInFlight = Math.max(calls.maxInFlight, calls.inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return await realOpen(...args);
    } finally {
      calls.inFlight -= 1;
    }
  }) as typeof realOpen;
  fsPromises.lstat = (async (...args: Parameters<typeof realLstat>) => {
    calls.lstat += 1;
    return realLstat(...args);
  }) as typeof realLstat;
  syncBuiltinESMExports();
}

function restore(): void {
  fsPromises.open = realOpen;
  fsPromises.lstat = realLstat;
  syncBuiltinESMExports();
}

beforeEach(() => {
  Object.assign(calls, { open: 0, lstat: 0, inFlight: 0, maxInFlight: 0 });
});
after(async () => {
  restore();
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** A codex runtime of `count` files spread over nested folders, laid out as installs leave it. */
async function runtime(count: number) {
  const state = await mkdtemp(join(tmpdir(), 'runtime-verify-'));
  roots.push(state);
  await chmod(state, 0o700);
  const directory = join(state, 'runtimes', 'codex', '1.0.0');
  const files: Record<string, { sha256: string; size: number; executable: boolean }> = {};
  let totalSize = 0;
  for (let index = 0; index < count; index++) {
    const name = `node_modules/pkg-${index % 4}/lib/deep/file-${index}.js`;
    const bytes = Buffer.from(`export const value = ${index};\n`);
    await mkdir(dirname(join(directory, name)), { recursive: true, mode: 0o700 });
    await writeFile(join(directory, name), bytes, { mode: 0o600 });
    files[name] = { sha256: sha256(bytes), size: bytes.length, executable: false };
    totalSize += bytes.length;
  }
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      artifact: 'codex',
      version: '1.0.0',
      entry: 'node_modules/pkg-0/lib/deep/file-0.js',
      files,
      totalSize,
      source: { kind: 'npm', packages: [], launchedFrom: '/fixture' },
    })
  );
  await writeFile(join(directory, 'manifest.json'), manifest, { mode: 0o600 });
  await writeFile(
    join(state, 'runtimes', 'codex', 'current'),
    JSON.stringify({ current: { version: '1.0.0', manifestSha256: sha256(manifest) } }),
    { mode: 0o600 }
  );
  return { state, directory, reader: new RuntimeReader(state) };
}

async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return error instanceof RuntimeError ? error.reason : String(error);
  }
  return 'accepted';
}

test(
  'verifies a runtime with up to VERIFY_CONCURRENCY files in flight, never more',
  { skip: !posix },
  async () => {
    const { reader } = await runtime(64);
    observe(5);
    try {
      const verified = await reader.verifyRuntime('codex');
      assert.equal(verified.reference.version, '1.0.0');
    } finally {
      restore();
    }
    assert.equal(calls.maxInFlight, VERIFY_CONCURRENCY);
    // Every file is still opened and read.
    assert.ok(calls.open >= 64, `opened ${calls.open}`);
  }
);

test('inspects each directory once, not once per file beneath it', { skip: !posix }, async () => {
  const { reader } = await runtime(64);
  observe(0);
  try {
    await reader.verifyRuntime('codex');
  } finally {
    restore();
  }
  // Inspecting every ancestor for every file cost about ten lstat calls per
  // file here; now the directories are inspected once and files by fstat.
  assert.ok(calls.lstat < 64, `lstat calls: ${calls.lstat}`);
});

test(
  'still refuses a changed byte, a wrong mode, a link and an extra file',
  { skip: !posix },
  async () => {
    const changed = await runtime(20);
    await writeFile(
      join(changed.directory, 'node_modules/pkg-1/lib/deep/file-5.js'),
      'export const value = 6;\n',
      { mode: 0o600 }
    );
    assert.equal(await refusal(changed.reader.verifyRuntime('codex')), 'digest_mismatch');

    const mode = await runtime(20);
    await chmod(join(mode.directory, 'node_modules/pkg-2/lib/deep/file-6.js'), 0o644);
    assert.equal(await refusal(mode.reader.verifyRuntime('codex')), 'permission');

    const link = await runtime(20);
    const target = join(link.directory, 'node_modules/pkg-3/lib/deep/file-7.js');
    await rm(target);
    await symlink(join(link.directory, 'node_modules/pkg-0/lib/deep/file-0.js'), target);
    assert.equal(await refusal(link.reader.verifyRuntime('codex')), 'permission');

    const extra = await runtime(20);
    await writeFile(join(extra.directory, 'node_modules/pkg-0/lib/deep/planted.js'), 'x', {
      mode: 0o600,
    });
    assert.equal(await refusal(extra.reader.verifyRuntime('codex')), 'digest_mismatch');
  }
);
