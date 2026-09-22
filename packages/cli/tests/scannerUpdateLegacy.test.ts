import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeStore, type RuntimeSource, type Verified } from '../src/runtime/store.js';
import { updateScanner } from '../src/scanner/update.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

it.each([false, true])(
  'an interrupted Mac update is finished by launchd, not left half done (pointer already advanced: %s)',
  async (advanced) => {
    const stateDir = await mkdtemp(join(tmpdir(), 'scanner-legacy-status-'));
    directories.push(stateDir);
    await mkdir(join(stateDir, 'scanner'));
    await writeFile(
      join(stateDir, 'scanner/state.json'),
      JSON.stringify({ consent: { disclosureVersion: 'v1' } })
    );
    const calls = join(stateDir, 'calls.jsonl');
    const loaded = join(stateDir, 'loaded.json');
    await writeFile(
      loaded,
      JSON.stringify({ running: true, pid: 1234, binaryPath: join(stateDir, 'old.cjs') })
    );
    await writeFile(
      join(stateDir, 'scanner/status.json'),
      JSON.stringify({
        snapshot: { lifecycle: { pid: 1234 }, heartbeat: { lastSuccess: 1000001 } },
      })
    );
    const runtimes = {} as Record<'old' | 'new', Verified>;
    for (const version of ['old', 'new'] as const) {
      const entry = join(stateDir, `${version}.cjs`);
      await writeFile(
        entry,
        `#!/usr/bin/env node
const fs = require('node:fs');
const version = ${JSON.stringify(version)}, calls = ${JSON.stringify(calls)}, loaded = ${JSON.stringify(loaded)};
const operation = process.argv[3];
fs.appendFileSync(calls, JSON.stringify({ version, operation }) + '\\n');
let state = JSON.parse(fs.readFileSync(loaded, 'utf8'));
if (operation === 'install') { const definition = JSON.parse(fs.readFileSync(0, 'utf8')); state.binaryPath = definition.binaryPath; fs.writeFileSync(loaded, JSON.stringify(state)); const path = require('node:path'), dir = process.env.MNEMONIK_STATE_DIR;
fs.writeFileSync(path.join(dir, 'runtimes/scanner/current'), definition.replacement.pointer.after);
// Stand in for the fixed launcher: record the attempt and its local readiness.
fs.mkdirSync(path.join(dir, 'scanner/service-replacement'), { recursive: true });
fs.writeFileSync(path.join(dir, 'scanner/service-replacement/result.json'), JSON.stringify({ version: '2.0.0', pid: 1234, startedAt: 1000000, failures: 0 }));
fs.writeFileSync(path.join(dir, 'scanner/status.json'), JSON.stringify({ recordedAt: 1000001, snapshot: { version: '2.0.0', lifecycle: { pid: 1234, state: 'running' }, heartbeat: { lastSuccess: null }, startupTimings: { localReadyAt: 1000001 } } })); }
console.log(JSON.stringify({ status: 'ok', supervisor: { kind: 'launchd', installed: true, ...state, ...(version === 'old' ? { running: false, pid: null, binaryPath: undefined } : {}) } }));
`,
        { mode: 0o700 }
      );
      runtimes[version] = {
        entry,
        directory: stateDir,
        reference: { version: version === 'old' ? '1.0.0' : '2.0.0', manifestSha256: version },
        manifest: {
          artifact: 'scanner',
          version: version === 'old' ? '1.0.0' : '2.0.0',
          disclosureVersion: 'v1',
        },
      } as Verified;
    }
    const store = new RuntimeStore(stateDir);
    const pointer = store.pointerPath('scanner');
    await mkdir(join(pointer, '..'), { recursive: true });
    let current = advanced ? runtimes.new : runtimes.old;
    const savePointer = () => writeFile(pointer, JSON.stringify({ current: current.reference }));
    await savePointer();
    vi.spyOn(store, 'verifyRuntime').mockImplementation(async () => current);
    vi.spyOn(store, 'verifyRetainedRuntime').mockImplementation(async (_artifact, reference) => {
      expect(reference).toEqual(runtimes.new.reference);
      return runtimes.new;
    });
    vi.spyOn(store, 'stageRuntime').mockResolvedValue(runtimes.new);
    vi.spyOn(store, 'installRuntime').mockImplementation(async () => {
      current = runtimes.new;
      await savePointer();
      return current;
    });
    vi.spyOn(store, 'rollbackRuntime').mockImplementation(async () => {
      current = runtimes.old;
      await savePointer();
      return current;
    });
    await expect(
      updateScanner(
        {
          stateDir,
          platform: 'darwin',
          store,
          now: () => 1000000,
          describe: async () => ({
            binaryPath: current.entry,
            arguments: ['start'],
            workingDirectory: stateDir,
            environment: { MNEMONIK_STATE_DIR: stateDir },
            runAtLogin: true,
            restart: { policy: 'on-failure', delayMs: 3000 },
            logDestination: join(stateDir, 'scanner/log'),
          }),
        },
        async () => ({ manifest: runtimes.new.manifest, files: {} }) as RuntimeSource
      )
    ).resolves.toBe(runtimes.new);
    expect(JSON.parse(await readFile(loaded, 'utf8'))).toEqual({
      running: true,
      pid: 1234,
      binaryPath: runtimes.new.entry,
    });
    expect(JSON.parse(await readFile(pointer, 'utf8')).current).toEqual(runtimes.new.reference);
    const executed = (await readFile(calls, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { version: string; operation: string });
    expect(executed).toEqual([
      ...(advanced ? [{ version: 'new', operation: 'status' }] : []),
      { version: 'new', operation: 'install' },
      { version: 'new', operation: 'status' },
    ]);
  },
  15000
);
