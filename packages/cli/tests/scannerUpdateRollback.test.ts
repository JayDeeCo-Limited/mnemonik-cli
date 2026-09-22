import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeStore, type RuntimeSource, type Verified } from '../src/runtime/store.js';
import { scannerService } from '../src/scanner/service.js';
import { updateScanner } from '../src/scanner/update.js';
import { restoreScannerInstall } from '../src/scanner/enable.js';
import type { Journal } from '../src/install/journal.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function fixture() {
  const stateDir = await mkdtemp(join(tmpdir(), 'scanner-rollback-'));
  directories.push(stateDir);
  await mkdir(join(stateDir, 'scanner'));
  await writeFile(
    join(stateDir, 'scanner/state.json'),
    JSON.stringify({ consent: { disclosureVersion: 'v1' } })
  );
  const calls = join(stateDir, 'calls.jsonl');
  const loaded = join(stateDir, 'loaded.json');
  await writeFile(loaded, JSON.stringify({ running: true, pid: 1234, version: 'old' }));
  const runtimes = {} as Record<'old' | 'new', Verified>;
  for (const version of ['old', 'new'] as const) {
    const entry = join(stateDir, `${version}.cjs`);
    await writeFile(
      entry,
      `#!/usr/bin/env node
const fs=require('node:fs'), path=require('node:path');
const version=${JSON.stringify(version)}, stateDir=${JSON.stringify(stateDir)}, calls=${JSON.stringify(calls)}, loaded=${JSON.stringify(loaded)};
const operation=process.argv[3];
fs.appendFileSync(calls,JSON.stringify({version,operation})+'\\n');
const definition={binaryPath:path.join(stateDir,version+'.cjs'),arguments:['start'],workingDirectory:stateDir,environment:{MNEMONIK_STATE_DIR:stateDir},runAtLogin:true,restart:{policy:'on-failure',delayMs:3000},logDestination:path.join(stateDir,'scanner.log')};
if(operation==='describe') { console.log(JSON.stringify(definition)); process.exit(0); }
if(version==='old' && operation!=='status') { console.log(JSON.stringify({status:'LIMITED',reason:'supervisor_operation_failed',detail:'old supervisor cannot replace service',action:'mnemonik scanner enable'})); process.exit(0); }
let state=JSON.parse(fs.readFileSync(loaded,'utf8'));
if(operation==='install') {
 const requested=JSON.parse(fs.readFileSync(0,'utf8'));
 state={running:true,pid:requested.binaryPath.endsWith('old.cjs')?1234:2345,version:requested.binaryPath.endsWith('old.cjs')?'old':'new'};
 if(state.version==='old') fs.writeFileSync(path.join(stateDir,'scanner/status.json'),JSON.stringify({snapshot:{lifecycle:{pid:1234},heartbeat:{lastSuccess:2000000}}}));
}
if(operation==='stop') state.running=false;
if(operation==='start') state.running=true;
fs.writeFileSync(loaded,JSON.stringify(state));
console.log(JSON.stringify({status:'ok',supervisor:{kind:'systemd',installed:true,running:state.running,pid:state.pid}}));
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
  let current = runtimes.old;
  vi.spyOn(store, 'verifyRuntime').mockImplementation(async () => current);
  const verifySupervisor = vi
    .spyOn(store, 'verifyRetainedRuntime')
    .mockImplementation(async (_artifact, reference) => {
      expect(reference).toEqual(runtimes.new.reference);
      return runtimes.new;
    });
  vi.spyOn(store, 'installRuntime').mockImplementation(async () => {
    current = runtimes.new;
    return current;
  });
  vi.spyOn(store, 'rollbackRuntime').mockImplementation(async () => {
    current = runtimes.old;
    return current;
  });
  return { stateDir, calls, loaded, runtimes, store, verifySupervisor };
}

it('restores an old scanner using the new verified supervisor after heartbeat failure', async () => {
  const { stateDir, calls, loaded, runtimes, store, verifySupervisor } = await fixture();
  let now = 1000000;
  await expect(
    updateScanner(
      {
        stateDir,
        store,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
      async () => ({ manifest: runtimes.new.manifest, files: {} }) as RuntimeSource
    )
  ).rejects.toMatchObject({ reason: 'heartbeat_timeout' });
  expect(JSON.parse(await readFile(loaded, 'utf8'))).toMatchObject({
    running: true,
    version: 'old',
    pid: 1234,
  });
  const executed = (await readFile(calls, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(executed).toContainEqual({ version: 'old', operation: 'describe' });
  expect(
    executed
      .filter((call) => !['describe', 'status'].includes(call.operation))
      .every((call) => call.version === 'new')
  ).toBe(true);
  expect(verifySupervisor).toHaveBeenCalled();
}, 15000);

it('installer compensation retains the new supervisor after restoring the old runtime pointer', async () => {
  const f = await fixture();
  await f.store.installRuntime('scanner', '2.0.0', {
    manifest: f.runtimes.new.manifest,
    files: {},
  });
  const pointer = f.store.pointerPath('scanner');
  await mkdir(join(pointer, '..'), { recursive: true });
  await writeFile(pointer, '{}');
  const definition = {
    binaryPath: f.runtimes.old.entry,
    arguments: ['start'],
    workingDirectory: f.stateDir,
    environment: { MNEMONIK_STATE_DIR: f.stateDir },
    runAtLogin: true,
    restart: { policy: 'on-failure', delayMs: 3000 },
    logDestination: join(f.stateDir, 'scanner.log'),
  };
  const journal = {
    data: {
      services: [
        {
          id: 'scanner',
          started: true,
          before: JSON.stringify({ installed: true, running: true, definition }),
        },
      ],
      targets: [{ path: pointer, group: 'scanner:0' }],
      credentials: [],
    },
    restore: async () => {
      await f.store.rollbackRuntime('scanner');
    },
    save: async () => {},
  } as unknown as Journal;
  await restoreScannerInstall(journal, {
    stateDir: f.stateDir,
    store: f.store,
    now: () => 1000000,
  });
  expect(JSON.parse(await readFile(f.loaded, 'utf8'))).toMatchObject({
    running: true,
    version: 'old',
  });
  const executed = (await readFile(f.calls, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(executed.every((call) => call.version === 'new')).toBe(true);
});

it('refuses a retained supervisor whose runtime no longer verifies', async () => {
  const store = new RuntimeStore('/unused');
  const verify = vi
    .spyOn(store, 'verifyRetainedRuntime')
    .mockRejectedValue(new Error('digest_mismatch'));
  await expect(
    scannerService({
      stateDir: '/unused',
      store,
      supervisorRuntime: { reference: { version: '2.0.0' } } as Verified,
    }).status()
  ).rejects.toThrow('digest_mismatch');
  expect(verify).toHaveBeenCalledWith('scanner', { version: '2.0.0' });
});
