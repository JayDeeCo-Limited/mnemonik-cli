import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { createProjectSetupExecutor } from '@mnemonik/local-setup';
import { resolveProjectIdentity } from '@mnemonik/shared';
import { SimulatedHostAdapter, hostOrder, type HostName } from '../../src/install/adapters.js';
import { type JournalData } from '../../src/install/journal.js';
import { type InstallDependencies } from '../../src/install/transaction.js';
import { runCli, type CliDependencies } from '../../src/router.js';

const PROJECT_ID = '12345678-1234-4234-8234-123456789012';

export class Capture extends Writable {
  text = '';
  _write(chunk: Buffer | string, _encoding: string, done: (error?: Error) => void) {
    this.text += chunk.toString();
    done();
  }
  clear() {
    this.text = '';
  }
}

export interface SweepFixture {
  home: string;
  stateDir: string;
  root: string;
  hostPaths: Record<HostName, string>;
  original: Buffer;
  adapters: SimulatedHostAdapter[];
  install: InstallDependencies;
  cli: CliDependencies;
  stdout: Capture;
  stderr: Capture;
  counts: { remoteCreates: number; serviceStarts: number; uploads: number; recoveries: number };
  recovery: { choice: 'resume' | 'rollback' };
  run(args?: string[]): Promise<number>;
  journal(): Promise<JournalData>;
  cleanup(): Promise<void>;
}

export async function makeSweepFixture(): Promise<SweepFixture> {
  const home = await mkdtemp(join(tmpdir(), 'mnemonik-sweep-'));
  const stateDir = join(home, 'state');
  const root = join(home, 'repo');
  await Promise.all([mkdir(stateDir, { mode: 0o700 }), mkdir(root, { mode: 0o700 })]);
  const original = Buffer.from('{ "existing": "preserve exact bytes" }\r\n');
  const hostPaths = Object.fromEntries(
    hostOrder.map((host) => [host, join(home, 'hosts', `${host}.json`)])
  ) as Record<HostName, string>;
  await mkdir(join(home, 'hosts'), { mode: 0o700 });
  const adapters = await Promise.all(
    hostOrder.map(async (host) => {
      await writeFile(hostPaths[host], original, { mode: 0o600 });
      const adapter = new SimulatedHostAdapter(host, {
        path: hostPaths[host],
        content: Buffer.from(`{"existing":"preserve exact bytes","mnemonik":"${host}"}\n`),
        staging: host === 'codex' ? 'additive' : 'inactive',
        requestedScope: 'user',
        effectiveScope: 'user',
        version: 'sweep-1',
        artifactDigest: 'sweep-digest',
      });
      return adapter;
    })
  );
  const counts = { remoteCreates: 0, serviceStarts: 0, uploads: 0, recoveries: 0 };
  const runningServices = new Set<string>();
  const uploadOperations = new Set<string>();
  const recovery = { choice: 'resume' as const } as { choice: 'resume' | 'rollback' };
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
      consumeSetupRequest: async () => {
        counts.remoteCreates++;
        return { status: 'complete', projectId: PROJECT_ID, displayName: 'repo' };
      },
    },
  });
  const install: InstallDependencies = {
    stateDir,
    input: {
      account: 'owner',
      components: ['mcp', 'scanner'],
      hosts: [...hostOrder],
      scopes: {},
      roots: [],
      credentials: [],
    },
    adapters,
    executor,
    ui: {
      waiting: () => {},
      timeout: async () => 'skip',
      roots: async () => ({
        account: 'owner',
        disclosureVersion: 'v1',
        picked: {
          roots: [root],
          exclusions: [],
          repositories: [{ path: root, state: 'not_set_up', selected: true }],
        },
      }),
      consent: async () => true,
      review: async () => 'apply',
      cancel: async () => 'revoke',
      recovery: async () => {
        counts.recoveries++;
        return recovery.choice;
      },
    },
    prepare: async (journal) => {
      const target = await journal.plan(join(home, 'runtime.json'), Buffer.from('runtime-v1\n'), {
        kind: 'runtime',
      });
      await journal.stage(target);
    },
    revokeCli: async () => {},
    revokeComponent: async () => true,
    projectEmpty: async () => true,
    services: {
      verified: true,
      inspect: async () => [{ id: 'scanner', before: 'stopped' }],
      start: async (id) => {
        if (runningServices.has(id)) return { started: false, alreadyRunning: true };
        runningServices.add(id);
        counts.serviceStarts++;
        return { started: true, alreadyRunning: false };
      },
      restore: async () => {},
    },
    upload: {
      start: async (operationId) => {
        if (uploadOperations.has(operationId)) return { uploaded: false, deduplicated: true };
        uploadOperations.add(operationId);
        counts.uploads++;
        return { uploaded: true, deduplicated: false };
      },
      deletionAction: 'Delete the cloud index in the console.',
    },
  };
  const stdout = new Capture();
  const stderr = new Capture();
  const cli: CliDependencies = {
    home,
    cwd: root,
    stdout,
    stderr,
    install,
    cliAuth: {
      signIn: async () => undefined,
      getCliBearer: async () => 'access-token',
      accountEmail: async () => 'owner@example.test',
      logout: async () => {},
    },
  };
  return {
    home,
    stateDir,
    root,
    hostPaths,
    original,
    adapters,
    install,
    cli,
    stdout,
    stderr,
    counts,
    recovery,
    run: (args = ['install']) => runCli(args, cli),
    journal: async () => {
      const [runId] = await readdir(join(stateDir, 'install'));
      return JSON.parse(await readFile(join(stateDir, 'install', runId!, 'journal.json'), 'utf8'));
    },
    cleanup: async () => {
      for (const path of [home, stateDir, root, join(home, 'hosts')])
        if ((await lstat(path).catch(() => null))?.isDirectory()) await chmod(path, 0o700);
      await rm(home, { recursive: true, force: true });
    },
  };
}
