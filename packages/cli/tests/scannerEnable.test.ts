import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { promisify } from 'node:util';
import { setImmediate as immediate } from 'node:timers/promises';
import { createProjectSetupExecutor, withLock } from '@mnemonik/local-setup';
import { resolveProjectIdentity } from '@mnemonik/shared';
import { bytesAt, withInstall } from '../src/install/journal.js';
import { compensate, type InstallDependencies } from '../src/install/transaction.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createCredentialAdapter } from '@mnemonik/credentials';
import { RuntimeReader } from '@mnemonik/shared/hook-runtime';
import {
  enableScanner,
  prepareScanner,
  updateScannerRoots,
  type EnableOptions,
} from '../src/scanner/enable.js';
import { scannerService } from '../src/scanner/service.js';
import { controlScanner, scannerReceipt } from '../src/scanner/control.js';
import { updateScanner } from '../src/scanner/update.js';
import { deleteScannerIndex } from '../src/scanner/data.js';
import { hash, RuntimeStore } from '../src/runtime/store.js';
import { scannerReleaseSource } from '../src/runtime/releaseSource.js';
import { Output } from '../src/output.js';
import { collectStatusDocument } from '../src/status.js';
import { runCli } from '../src/router.js';
let home: string, state: string, releases: string, options: EnableOptions, store: RuntimeStore;
let allowInstalledCredential: boolean;
let events: string[],
  consent: { userId: string; roots: string[]; exclusions: string[]; disclosureVersion: string };
const binary = Buffer.from(`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const dir=process.env.MNEMONIK_STATE_DIR, p=path.join(dir,'scanner'), op=process.argv[3];
const read=(name,fallback)=>{try{return JSON.parse(fs.readFileSync(path.join(p,name)))}catch{return fallback}};
const write=(name,data)=>{const target=path.join(p,name),stage=target+'.'+process.pid+'.tmp';fs.writeFileSync(stage,JSON.stringify(data),{mode:0o600});fs.renameSync(stage,target)};
const alive=()=>{let pid=read('supervisor.json',{}).pid;try{process.kill(pid,0);return pid}catch{return null}};
if(process.argv[2]==='run') {
 const snapshot={version:'fixture',roots:[],exclusions:[],lifecycle:{state:'running',pid:process.pid,controlId:read('control.json',{}).id,pauseIntervals:[]},heartbeat:{lastSuccess:Date.now()},transfers:{sinceStart:{files:0,bytes:0},sinceInstall:{files:0,bytes:0}}};
 const state=read('state.json',{});state.config=Object.fromEntries(Object.entries(state.config||{}).sort());write('state.json',state);
 const tick=()=>write('status.json',{recordedAt:Date.now(),snapshot});
 if(!fs.readFileSync(__filename,'utf8').endsWith('// MISS_HEARTBEAT')) tick();
 const timer=setInterval(()=>{const c=read('control.json',{});if(c.id && c.id!==snapshot.lifecycle.controlId){snapshot.lifecycle.controlId=c.id;snapshot.lifecycle.state=c.action==='pause'?'paused':'running';state.paused=c.action==='pause';write('state.json',state);tick()}},20);
 process.on('SIGTERM',()=>{clearInterval(timer);process.exit(0)});
} else if(op==='describe') console.log(JSON.stringify({binaryPath:__filename,arguments:['start'],workingDirectory:__dirname,environment:{MNEMONIK_STATE_DIR:dir},runAtLogin:true,restart:{policy:'on-failure',delayMs:1},logDestination:path.join(p,'log')}));
else {
 let s=read('supervisor.json',{installed:false,pid:null});
 if(op==='install'){s.installed=true;s.binaryPath=JSON.parse(fs.readFileSync(0,'utf8')).binaryPath;try{process.kill(s.pid,'SIGTERM')}catch{}s.pid=null;}
 if(op==='install'||(op==='start'&&!alive())) {const child=cp.spawn(process.execPath,[s.binaryPath||__filename,'run'],{detached:true,stdio:'ignore',env:process.env});s.pid=child.pid;child.unref();}
 if(op==='stop'||op==='uninstall'){try{process.kill(s.pid,'SIGTERM')}catch{}s.pid=null;if(op==='uninstall')s.installed=false;}
 write('supervisor.json',s);console.log(JSON.stringify({status:'ok',supervisor:{kind:'systemd',installed:s.installed,running:!!s.pid,pid:s.pid}}));
}
`);
async function source(version = '1.0.0', tamper = false, missed = false) {
  const bytes = missed ? Buffer.concat([binary, Buffer.from('\n// MISS_HEARTBEAT')]) : binary;
  const name = `scanner-${version}.cjs`;
  const files = { [name]: { sha256: hash(bytes), size: bytes.length, executable: true } };
  const digests = Buffer.from(JSON.stringify({ files }));
  await writeFile(
    join(releases, name),
    tamper ? Buffer.concat([bytes, Buffer.from('\n// tampered')]) : bytes
  );
  await writeFile(join(releases, 'digests.json'), digests);
  return scannerReleaseSource({
    version,
    digestsSha256: hash(digests),
    platforms: {
      [`${process.platform}-${process.arch}`]: {
        schemaVersion: 1,
        artifact: 'scanner',
        version,
        entry: name,
        totalSize: bytes.length,
        files,
        signingStatus: 'unsigned',
        source: {
          kind: 'release',
          url: `https://github.com/JayDeeCo-Limited/mnemonik-cli/releases/download/scanner-v${version}/`,
        },
      },
    },
  });
}
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'scanner-enable-'));
  state = join(home, 'state');
  releases = join(home, 'releases');
  await mkdir(releases);
  vi.stubEnv('HOME', home);
  vi.stubEnv('MNEMONIK_DEV_RELEASE_DIR', releases);
  store = new RuntimeStore(state, undefined, { allowUnsigned: true });
  allowInstalledCredential = false;
  events = [];
  consent = {
    userId: 'user-one',
    roots: [join(home, 'repo')],
    exclusions: [],
    disclosureVersion: '2026.09.1',
  };
  await mkdir(consent.roots[0]!);
  await mkdir(join(home, 'different'));
  options = {
    stateDir: state,
    cwd: home,
    input: Readable.from([]),
    output: new Output({ write() {} }),
    store,
    roots: consent.roots,
    nonInteractive: true,
    source: async () => {
      events.push('runtime');
      return source();
    },
    credentials: createCredentialAdapter({
      stateDir: state,
      secretStore: { isAvailable: async () => false } as never,
    }),
    authorize: async () => {
      events.push('auth');
      return 'cli-token';
    },
    projectExecutor: {
      resolveProjectIdentity: (cwd) => resolveProjectIdentity(cwd, { allowNestedInherit: false }),
      ensureProject: async ({ cwd }) => ({
        status: 'done',
        operationId: '11111111-1111-4111-8111-111111111111',
        root: cwd,
        projectId: '22222222-2222-4222-8222-222222222222',
        permissionStatus: 'private',
      }),
      stage: async () => ({
        status: 'ACTION_REQUIRED',
        state: 'unused',
        allowedActions: [],
      }),
      apply: async () => ({
        status: 'ACTION_REQUIRED',
        state: 'unused',
        allowedActions: [],
      }),
      rollback: async () => ({
        status: 'ACTION_REQUIRED',
        state: 'unused',
        allowedActions: [],
      }),
    },
    fetch: vi.fn(async (url, init) => {
      const path = new URL(String(url)).pathname;
      events.push(path);
      if (path === '/api/v1/auth/grants')
        return Response.json({
          account: 'user-one',
          email: 'user@example.test',
          deviceInstallationId: '11111111-1111-4111-8111-111111111111',
          grants: [],
        });
      if (path.endsWith('/current') && path.includes('install-sessions'))
        return Response.json({
          id: 'session',
          device_installation_id: '11111111-1111-4111-8111-111111111111',
        });
      if (path.includes('scanner-consent'))
        return Response.json({ consent, disclosure: { version: '2026.09.1', statements: [] } });
      if (path.endsWith('/cancel')) return Response.json({ status: 'cancelled' });
      if (path.endsWith('component-credentials')) {
        expect(await readFile(join(state, 'scanner/state.json'), 'utf8')).toContain('user-one');
        expect((await store.verifyRuntime('scanner')).manifest.version).toBe('1.0.0');
        const supervisor = JSON.parse(
          await readFile(join(state, 'scanner/supervisor.json'), 'utf8').catch(() => 'null')
        );
        if (!allowInstalledCredential) expect(supervisor?.installed ?? false).toBe(false);
        return Response.json({
          id: 'family-one',
          access_token: 'scanner-secret',
          refresh_token: 'refresh-secret',
          scope: 'scanner:upload',
          expires_in: 3600,
          refresh_expires_in: 86400,
          token_type: 'Bearer',
        });
      }
      throw new Error(`Unexpected ${init?.method} ${path}`);
    }) as typeof fetch,
  };
});
afterEach(async () => {
  await scannerService({ stateDir: state, store })
    .stop()
    .catch(() => {});
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});
it('fresh enable verifies runtime, stores browser consent and credential, starts one supervised pid and sees heartbeat', async () => {
  const result = await enableScanner(options);
  expect(result.installation).toMatchObject({ state: 'LIMITED', reasons: ['dev_release_source'] });
  expect(result.scanner?.heartbeatAt).toBeTruthy();
  expect(events.indexOf('runtime')).toBeGreaterThan(
    events.indexOf('/api/v1/scanner-consent/current')
  );
  expect(events.indexOf('/api/v1/component-credentials')).toBeGreaterThan(
    events.indexOf('runtime')
  );
  expect(await options.credentials!.readFamily('family-one')).toMatchObject({
    accessToken: 'scanner-secret',
  });
  const bytes = await readFile(join(state, 'scanner/state.json'), 'utf8');
  expect(bytes).toContain('family-one');
  expect(bytes).not.toContain('scanner-secret');
  const pid = (await scannerReceipt(state))!.snapshot.lifecycle.pid;
  let output = '';
  expect(
    await runCli(['scanner', 'start', '--json'], {
      installStateDir: state,
      scannerService: { stateDir: state, store },
      stdout: {
        write: (s) => {
          output += s;
        },
      },
    })
  ).toBe(3);
  expect(JSON.parse(output)).toMatchObject({ reason: 'instance_running', pid });
  expect((await scannerService({ stateDir: state, store }).status()).pid).toBe(pid);
  output = '';
  expect(
    await runCli(['scanner', 'start'], {
      installStateDir: state,
      scannerService: { stateDir: state, store },
      stdout: { write: (s) => void (output += s) },
    })
  ).toBe(3);
  expect(output).toBe(`Scanner is already running (PID ${pid}).\n`);
  expect(output).not.toContain('{');
  await controlScanner('pause', { stateDir: state, store });
  expect((await scannerReceipt(state))!.snapshot.lifecycle.state).toBe('paused');
  await controlScanner('resume', { stateDir: state, store });
  await expect(new RuntimeReader(state).verifyRuntime('scanner')).rejects.toMatchObject({
    reason: 'unsigned',
  });
});
it('sends boundary candidates and configures only the approved subset', async () => {
  const git = promisify(execFile);
  const boundary = join(home, 'Projects');
  const app = join(boundary, 'app');
  const notes = join(boundary, 'notes');
  await git('git', ['init', '--quiet', app]);
  await mkdir(notes);
  const identity = `${JSON.stringify({
    schemaVersion: 1,
    projectId: '33333333-3333-4333-8333-333333333333',
    projectName: 'notes',
  })}\n`;
  await writeFile(join(notes, '.mnemonik.json'), identity);
  options.cwd = boundary;
  options.home = home;
  options.input = Readable.from('\n');
  options.nonInteractive = false;
  options.roots = undefined;
  const authorize = vi.fn(async (selection) => {
    if (selection) consent = { ...consent, roots: [app], exclusions: [] };
    return 'cli-token';
  });
  options.authorize = authorize;

  await enableScanner(options);

  expect(authorize).toHaveBeenCalledWith(
    {
      roots: [],
      exclusions: [],
      boundary,
      candidates: [
        { path: app, name: 'app', kind: 'git' },
        { path: notes, name: 'notes', kind: 'folder' },
      ],
    },
    '11111111-1111-4111-8111-111111111111'
  );
  expect(JSON.parse(await readFile(join(state, 'scanner/state.json'), 'utf8'))).toMatchObject({
    boundary,
    config: { roots: [app] },
  });
  expect(await readFile(join(notes, '.mnemonik.json'), 'utf8')).toBe(identity);
});
it('says it will wait for scanner consent for the full approval lifetime', async () => {
  let text = '';
  options.output = new Output({ write: (chunk) => void (text += chunk) });
  options.nonInteractive = false;
  options.input = Readable.from('\n');
  options.roots = [consent.roots[0]!];
  consent.roots = [join(home, 'different')];
  options.authorize = async (selection) => {
    if (selection) consent.roots = [options.roots![0]!];
    return 'cli-token';
  };

  await enableScanner(options);

  expect(text).toContain('Waiting for approval in your browser, up to 10 minutes.');
});
it('uses the repository approval instruction in the joined installer', async () => {
  let text = '';
  options.output = new Output({ write: (chunk) => void (text += chunk) });
  options.nonInteractive = false;
  options.approvalAnnounced = true;
  options.input = Readable.from('\n');
  options.roots = [consent.roots[0]!];
  consent.roots = [join(home, 'different')];
  options.authorize = async (selection) => {
    if (selection) consent.roots = [options.roots![0]!];
    return 'cli-token';
  };

  await enableScanner(options);

  expect(text).toContain('Please choose your repositories by opening the link below.');
  expect(text).not.toContain('Waiting for approval');
});
it('atomically adopts the current-consent root update', async () => {
  await enableScanner(options);
  const added = join(home, 'added');
  await mkdir(added);
  const request = vi.fn(
    async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      expect(JSON.parse(String(init?.body))).toEqual({ add: [added], remove: [] });
      return Response.json({
        consent: { ...consent, roots: [...consent.roots, added] },
        disclosure: { version: consent.disclosureVersion, statements: [] },
      });
    }
  );

  await expect(
    updateScannerRoots({
      stateDir: state,
      bearer: 'cli-token',
      add: [added],
      remove: [],
      fetch: request as typeof fetch,
    })
  ).resolves.toMatchObject({ status: 'updated' });
  const saved = JSON.parse(await readFile(join(state, 'scanner/state.json'), 'utf8'));
  expect(saved.config.roots).toEqual([...consent.roots, added]);
  expect(saved.consent.roots).toEqual([...consent.roots, added]);
  expect(request).toHaveBeenCalledOnce();
});
it('creates every approved project once across repeated enables', async () => {
  const git = promisify(execFile);
  const app = join(home, 'app');
  const shop = join(home, 'shop');
  await git('git', ['init', '--quiet', app]);
  await git('git', ['init', '--quiet', shop]);
  consent.roots = [app, shop];
  options.roots = [app, shop];
  const ids = new Map([
    [app, '44444444-4444-4444-8444-444444444444'],
    [shop, '55555555-5555-4555-8555-555555555555'],
  ]);
  const pathByHash = new Map(
    [...ids].map(([path]) => [createHash('sha256').update(path).digest('hex'), path])
  );
  const transport = {
    issueSetupRequest: vi.fn(async (input: { projectId?: string }) =>
      input.projectId
        ? { status: 'complete' as const, projectId: input.projectId, displayName: 'existing' }
        : {
            status: 'project_setup_required' as const,
            state: 'missing',
            allowedActions: ['create', 'cancel'],
            requestId: randomBytes(16).toString('hex'),
          }
    ),
    consumeSetupRequest: vi.fn(async (input: { deviceRootContext: { hash: string } }) => {
      const path = pathByHash.get(input.deviceRootContext.hash)!;
      return {
        status: 'complete' as const,
        projectId: ids.get(path)!,
        displayName: path.split('/').at(-1)!,
      };
    }),
  };
  const setup = createProjectSetupExecutor({
    resolver: { resolveProjectIdentity },
    transport,
    scopeKey: 'user:device',
    bindContext: async (root) => ({
      deviceRootContext: {
        algorithmVersion: 1,
        hash: createHash('sha256').update(root).digest('hex'),
      },
      repositoryFingerprint: null,
    }),
    stateDir: state,
  });
  options.projectExecutor = {
    resolveProjectIdentity: (cwd) => resolveProjectIdentity(cwd, { allowNestedInherit: false }),
    ...setup,
  };

  await enableScanner(options);
  allowInstalledCredential = true;
  await enableScanner(options);

  expect(transport.consumeSetupRequest).toHaveBeenCalledTimes(2);
  expect(JSON.parse(await readFile(join(app, '.mnemonik.json'), 'utf8')).projectId).toBe(
    ids.get(app)
  );
  expect(JSON.parse(await readFile(join(shop, '.mnemonik.json'), 'utf8')).projectId).toBe(
    ids.get(shop)
  );
});
it('configures only roots whose projects survive a plan limit', async () => {
  const app = join(home, 'app');
  const shop = join(home, 'shop');
  await Promise.all([mkdir(app), mkdir(shop)]);
  consent.roots = [app, shop];
  options.roots = [app, shop];
  const executor = options.projectExecutor;
  if (!executor) throw new Error('missing project executor');
  executor.ensureProject = vi.fn(async ({ cwd }) =>
    cwd === shop
      ? {
          status: 'ACTION_REQUIRED' as const,
          state: 'project_limit_reached',
          allowedActions: ['upgrade', 'cancel'],
          used: 1,
          limit: 1,
          tier: 'free',
          existingProjectNames: ['app'],
        }
      : {
          status: 'done' as const,
          operationId: '11111111-1111-4111-8111-111111111111',
          root: cwd,
          projectId: '22222222-2222-4222-8222-222222222222',
          permissionStatus: 'private' as const,
        }
  );

  await enableScanner(options);

  const saved = JSON.parse(await readFile(join(state, 'scanner/state.json'), 'utf8'));
  expect(saved.config.roots).toEqual([app]);
  expect(saved.consent.roots).toEqual([app, shop]);
});
it.each(['ownership', 'cli-grant', 'missing'])(
  'retries failed consent using %s installation evidence',
  async (evidence) => {
    const installation = '11111111-1111-4111-8111-111111111111';
    let active = true;
    const fetcher = options.fetch!;
    options.fetch = async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/cancel')) active = false;
      if (path === '/api/v1/install-sessions/current' && !active)
        return new Response(null, { status: 404 });
      if (path === '/api/v1/auth/grants')
        return Response.json({
          account: 'owner',
          grants: [],
          deviceInstallationId: evidence === 'cli-grant' ? installation : null,
        });
      return fetcher(url, init);
    };
    options.roots = [join(home, 'different')];
    const authorize = vi.fn(async (selection, _installation) => {
      if (selection) throw new Error('consent_failed');
      return 'cli-token';
    });
    options.authorize = authorize;
    await expect(enableScanner(options)).rejects.toThrow('consent_failed');
    await expect(readFile(join(state, 'scanner/state.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    if (evidence === 'ownership')
      await writeFile(
        join(state, 'host-ownership.json'),
        JSON.stringify({
          schemaVersion: 1,
          generation: 1,
          targets: [
            {
              id: 'grok',
              profilePath: home,
              component: 'mcp',
              files: [],
              grant: { account: 'owner', installationId: installation },
            },
          ],
        })
      );
    // Explicitly expire the session: a consent failure now correctly keeps it active.
    active = false;
    authorize.mockClear();
    await expect(enableScanner(options)).rejects.toThrow(
      evidence === 'missing' ? 'scanner_installation_missing' : 'consent_failed'
    );
    if (evidence === 'missing') expect(authorize).toHaveBeenCalledTimes(1);
    else
      expect(authorize).toHaveBeenLastCalledWith(
        { roots: options.roots, exclusions: [] },
        installation
      );
  }
);
it('a git repository that contains other repositories is a valid root; a plain folder of repositories is refused by name', async () => {
  const git = promisify(execFile);
  const repository = join(home, 'workspace-repo');
  await git('git', ['init', '--quiet', repository]);
  await git('git', ['init', '--quiet', join(repository, 'tool-a')]);
  await git('git', ['init', '--quiet', join(repository, 'tool-b')]);
  consent.roots = [repository];
  options.roots = [repository];
  const result = await enableScanner(options);
  expect(result.installation.state).toBe('LIMITED');
  expect(JSON.parse(await readFile(join(state, 'scanner/state.json'), 'utf8'))).toMatchObject({
    config: { roots: [repository] },
  });

  const container = join(home, 'workspace-plain');
  await git('git', ['init', '--quiet', join(container, 'tool-a')]);
  await git('git', ['init', '--quiet', join(container, 'tool-b')]);
  let errors = '';
  options.output = new Output(
    { write() {} },
    {
      write(text: string) {
        errors += text;
      },
    }
  );
  options.roots = [container];
  await expect(enableScanner(options)).rejects.toThrow('broad_workspace_parent');
  expect(errors).toContain(container);
  expect(errors).toContain('That folder cannot be used. Choose another folder.');
  expect(errors).not.toContain('broad_workspace_parent');
});

it('good update swaps; tamper never becomes current; missed heartbeat restores verified previous', async () => {
  await enableScanner(options);
  await updateScanner({ stateDir: state, store }, () => source('2.0.0'));
  expect((await store.verifyRuntime('scanner')).manifest.version).toBe('2.0.0');
  await expect(
    updateScanner({ stateDir: state, store }, () => source('3.0.0', true))
  ).rejects.toMatchObject({ reason: 'digest_mismatch' });
  expect((await store.verifyRuntime('scanner')).manifest.version).toBe('2.0.0');
  let time = Date.now();
  // The fixture daemon uses the real clock. Reset the accelerated timeout clock
  // before rollback so its genuinely new heartbeat is after restore began.
  const rollback = store.rollbackRuntime.bind(store);
  vi.spyOn(store, 'rollbackRuntime').mockImplementation(async (...args) => {
    const result = await rollback(...args);
    time = Date.now();
    return result;
  });
  await expect(
    updateScanner(
      {
        stateDir: state,
        store,
        now: () => time,
        sleep: async () => {
          time += 10000;
          await new Promise((r) => setTimeout(r, 30));
        },
      },
      () => source('3.0.0', false, true)
    )
  ).rejects.toThrow('heartbeat');
  expect((await store.verifyRuntime('scanner')).manifest.version).toBe('2.0.0');
}, 20000);
it('serializes consent updates with enable and preserves the enable state shape', async () => {
  await enableScanner(options);
  await scannerService({ stateDir: state, store }).stop();
  const changed = async () => {
    const candidate = await source('2.0.0');
    return {
      ...candidate,
      manifest: { ...candidate.manifest, disclosureVersion: '2026.10.1' },
    };
  };
  const sourceCall = vi.fn(changed);
  let update!: ReturnType<typeof updateScanner>;
  await withLock(join(state, 'scanner/enable'), 5000, async () => {
    update = updateScanner({ stateDir: state, store }, sourceCall);
    await immediate();
    expect(sourceCall).not.toHaveBeenCalled();
  });
  await expect(update).rejects.toThrow('release_consent_required');
  const afterUpdate = await readFile(join(state, 'scanner/state.json'), 'utf8');
  expect(JSON.parse(afterUpdate)).toMatchObject({
    schemaVersion: 1,
    paused: false,
    config: { roots: consent.roots, exclusions: [] },
    consent,
    pauseIntervals: [],
  });
  allowInstalledCredential = true;
  await enableScanner(options);
  expect(JSON.parse(await readFile(join(state, 'scanner/state.json'), 'utf8'))).toMatchObject({
    schemaVersion: 1,
    paused: false,
    consent,
  });
});
it('retains consent across refusal and uninstall, then reinstalls from retained state without a runtime pointer', async () => {
  await enableScanner(options);
  const path = join(state, 'scanner/state.json');
  const before = JSON.parse(await readFile(path, 'utf8')).consent;
  await expect(
    enableScanner({
      ...options,
      roots: [join(home, 'different')],
      authorize: async (selection) => {
        if (selection) throw new Error('declined');
        return 'token';
      },
    })
  ).rejects.toThrow('declined');
  expect(JSON.parse(await readFile(path, 'utf8')).consent).toEqual(before);
  let report = '';
  expect(
    await runCli(['uninstall', '--component', 'scanner', '--json'], {
      installStateDir: state,
      scannerService: {
        stateDir: state,
        store,
        // This fixture supervises its own child. Native commands must never reach
        // the host's systemd manager when exercising the CLI removal path.
        supervisorRun: async (file, args) => {
          if (file === 'ps') {
            try {
              process.kill(Number(args[1]), 0);
              return args[1]!;
            } catch {
              return '';
            }
          }
          if (file !== 'systemctl') throw Error('unexpected fixture supervisor command');
          if (args[1] === 'stop' || args[1] === 'disable') {
            const runtime = await store.verifyRuntime('scanner');
            await promisify(execFile)(runtime.entry, ['service', 'uninstall'], {
              env: { ...process.env, MNEMONIK_STATE_DIR: state },
            });
          }
          const saved = JSON.parse(await readFile(join(state, 'scanner/supervisor.json'), 'utf8'));
          return `LoadState=${saved.installed ? 'loaded' : 'not-found'}\nActiveState=${saved.pid ? 'active' : 'inactive'}\nMainPID=${saved.pid ?? 0}\nUnitFileState=${saved.installed ? 'enabled' : ''}`;
        },
      },
      stdout: {
        write: (text) => {
          report += text;
        },
      },
    })
  ).toBe(0);
  expect(JSON.parse(report)).toMatchObject({
    verbs: ['stop collection', 'remove local software'],
    retained: ['credentials', 'cloud data', 'consent'],
  });
  await expect(readFile(store.pointerPath('scanner'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(JSON.parse(await readFile(path, 'utf8')).consent).toEqual(before);
  expect(await options.credentials!.readFamily('family-one')).not.toBeNull();
  const result = await enableScanner(options);
  expect(result.scanner?.heartbeatAt).toBeTruthy();
  expect((await store.verifyRuntime('scanner')).manifest.version).toBe('1.0.0');
  expect(JSON.parse(await readFile(path, 'utf8')).consent).toEqual(before);
});
it('cloud deletion waits for confirmation and independently verifies zero', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        projectId: '11111111-1111-4111-8111-111111111111',
        status: 'deleted',
        deletedChunks: 2,
      })
    )
    .mockResolvedValueOnce(
      Response.json({ projectId: '11111111-1111-4111-8111-111111111111', chunkCount: 0 })
    );
  await expect(
    deleteScannerIndex('11111111-1111-4111-8111-111111111111', 'token', fetcher)
  ).resolves.toMatchObject({ chunkCount: 0 });
  expect(fetcher.mock.calls.map((c) => c[1].method)).toEqual(['DELETE', 'GET']);
});

it('a signed production fixture completes only after the real health receipt and clears scanner_not_verified', async () => {
  const candidate = await source();
  // A real minisign signature over the entry bytes, from a disposable key: the
  // CLI verifies it in process, so a placeholder would be refused as unsigned.
  const entryBytes = candidate.files[candidate.manifest.entry]!;
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keyId = randomBytes(8);
  const identity = Buffer.concat([
    Buffer.from('Ed'),
    keyId,
    publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
  ]).toString('base64');
  const fileSignature = sign(
    null,
    createHash('blake2b512').update(entryBytes).digest(),
    privateKey
  );
  const trustedComment = 'timestamp:1\tfile:scanner\thashed';
  const globalSignature = sign(
    null,
    Buffer.concat([fileSignature, Buffer.from(trustedComment)]),
    privateKey
  );
  const signature = Buffer.from(
    `untrusted comment: signature\n${Buffer.concat([Buffer.from('ED'), keyId, fileSignature]).toString('base64')}\ntrusted comment: ${trustedComment}\n${globalSignature.toString('base64')}\n`
  );
  candidate.files['scanner.sig'] = signature;
  candidate.manifest.files['scanner.sig'] = {
    sha256: hash(signature),
    size: signature.length,
    executable: false,
  };
  candidate.manifest.totalSize += signature.length;
  candidate.manifest.signer = {
    platform: 'linux',
    identity,
    signature: 'scanner.sig',
  };
  candidate.manifest.signingStatus = 'signed';
  vi.stubEnv('MNEMONIK_DEV_RELEASE_DIR', '');
  store = new RuntimeStore(state, async () => {}); // Signature command boundary; digests and execution remain real.
  await mkdir(state, { recursive: true, mode: 0o700 });
  await writeFile(
    join(state, 'host-ownership.json'),
    JSON.stringify({
      schemaVersion: 1,
      generation: 1,
      targets: [
        {
          id: 'hooks',
          host: 'claude-code',
          component: 'hooks',
          profilePath: '/fixture',
          files: [],
          version: '0.10.0',
          editorVersion: '2.1.0',
        },
      ],
    })
  );
  let completions = 0;
  const fetcher = options.fetch!;
  options.fetch = async (url, init) => {
    if (String(url).endsWith('/complete')) {
      completions++;
      const readiness = JSON.parse(String(init?.body)).readiness;
      expect(readiness.installation.state).toBe('READY');
      expect(readiness.platform).toBe(process.platform);
      expect(readiness.versions).toEqual({
        cli: JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
          .version,
        scanner: candidate.manifest.version,
        hosts: [{ host: 'claude-code', editor: '2.1.0', hooks: '0.10.0' }],
      });
      expect((await scannerReceipt(state))!.snapshot.lifecycle.pid).toBeTruthy();
      return Response.json({ status: 'completed' });
    }
    return fetcher(url, init);
  };
  const result = await enableScanner({ ...options, store, source: async () => candidate });
  expect(completions).toBe(1);
  expect(result.installation).toMatchObject({ state: 'READY', reasons: [] });
  expect(result.scanner?.heartbeatAt).toBeTruthy();
  const status = await collectStatusDocument({
    cwd: home,
    input: Readable.from([]),
    stateDir: state,
    configuredHosts: [],
    projectHookConditions: [],
    preflight: { status: 'ready', project: {} } as never,
  });
  expect(status.installation.state).toBe('READY');
  expect(status.scanner?.heartbeatAt).toBeTruthy();
});

it.each(['success', 'failure', 'existing-identity', 'skip'])(
  'joined scanner install: %s',
  async (ending) => {
    const root = consent.roots[0]!;
    await promisify(execFile)('git', ['init', root]);
    const executor = createProjectSetupExecutor({
      stateDir: state,
      scopeKey: 'owner:installation',
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
          projectId: '12345678-1234-4234-8234-123456789012',
          displayName: 'repo',
        }),
      },
    });
    const identity = join(root, '.mnemonik.json');
    if (ending === 'existing-identity')
      await executor.ensureProject({ cwd: root, allowCreate: true, allowNestedInherit: false });
    const before = await bytesAt(identity);
    if (ending === 'failure' || ending === 'existing-identity')
      options.source = async () => {
        throw new Error('scanner_step_failed');
      };
    if (ending === 'skip')
      options.command = async (operation) =>
        operation === 'install'
          ? {
              status: 'LIMITED',
              reason: 'windows_task_creation_failed',
              detail: 'Access is denied.',
              action: 'mnemonik scanner enable',
            }
          : ({
              status: 'ok',
              supervisor: { kind: 'windows-task', installed: false, running: false, pid: null },
            } as never);
    const fetcher = options.fetch!;
    options.fetch = async (url, init) =>
      String(url).endsWith('/revoke') ? Response.json({ status: 'revoked' }) : fetcher(url, init);
    let text = '';
    const code = await runCli(
      [
        'install',
        '--components=scanner',
        '--accept-scanner',
        '--apply',
        '--non-interactive',
        '--json',
        `--scan-roots=${root}`,
      ],
      {
        cwd: root,
        home,
        installStateDir: state,
        stdout: {
          write: (chunk) => {
            text += chunk;
          },
        },
        stderr: { write() {} },
        preflight: {
          nodeVersion: '24.21.0',
          fetch: async () => Response.json({}),
          pathExists: async () => false,
          resolveIdentity: resolveProjectIdentity,
        },
        cliAuth: {
          signIn: async () => {},
          getCliBearer: async () => 'cli-token',
          logout: async () => {},
        },
        hostManagement: {
          stateDir: state,
          account: 'owner',
          getCliBearer: async () => 'cli-token',
        },
        projectExecutor: { ...executor, resolveProjectIdentity },
        projectTransport: {
          getDefaultOwner: async () => 'personal',
          readProjectState: async () => ({ state: 'access' }),
        },
        scannerEnable: options,
      }
    );
    const report = JSON.parse(text);
    expect(report).toMatchObject({
      targets: [],
      reports: expect.any(Array),
      runId: expect.any(String),
    });
    if (ending === 'failure' || ending === 'existing-identity') {
      // A scanner failure or an unresolvable identity file never fails the
      // joined install: the editors stay, the scanner alone is rolled back,
      // and the run ends with a limitation or an action.
      expect(code).toBe(3);
      expect(report.status).not.toBe('FAILED');
      expect(['LIMITED', 'ACTION_REQUIRED']).toContain(report.installation.state);
      if (ending === 'existing-identity') expect(await bytesAt(identity)).toEqual(before);
      expect(await bytesAt(join(state, 'scanner/state.json'))).toBeNull();
    } else {
      expect(code).toBe(3);
      expect(report.installation.state).toBe('LIMITED');
      expect(await bytesAt(identity)).not.toBeNull();
      if (ending === 'skip') {
        expect(report.reports.join(' ')).toContain('Background indexing was skipped');
        expect(await bytesAt(join(state, 'scanner/state.json'))).toBeNull();
      } else
        expect(report.projects[0].summary).toEqual({
          state: 'LIMITED',
          reasons: ['dev_release_source'],
          actions: [],
        });
    }
  },
  30000
);

it.each([false, true])(
  'scanner compensation preserves original state after daemon writes (existing: %s)',
  async (existing) => {
    if (existing) await enableScanner(options);
    const path = join(state, 'scanner/state.json');
    const originalPid = existing ? (await scannerReceipt(state))!.snapshot.lifecycle.pid : null;
    const before = await bytesAt(path);
    const pointer = await bytesAt(store.pointerPath('scanner'));
    await withInstall(
      state,
      {
        account: 'owner',
        hosts: [],
        components: ['scanner'],
        scopes: {},
        roots: consent.roots,
        credentials: [],
        joined: true,
      },
      undefined,
      async (journal) => {
        const fetcher = options.fetch!;
        await expect(
          prepareScanner(
            {
              ...options,
              journal,
              fetch: async (url, init) =>
                String(url).endsWith('/revoke')
                  ? Response.json({ status: 'revoked' })
                  : fetcher(url, init),
              ...(existing
                ? {
                    source: async () => {
                      throw new Error('scanner_step_failed');
                    },
                  }
                : {}),
            },
            async (prepared) => {
              try {
                await prepared.apply(journal);
                throw new Error('report_failed_after_heartbeat');
              } finally {
                await prepared.rollback(journal);
              }
            }
          )
        ).rejects.toThrow(existing ? 'scanner_step_failed' : 'report_failed_after_heartbeat');
        if (existing) {
          const control = JSON.parse(
            await readFile(join(state, 'scanner/control.json'), 'utf8')
          ) as { id: string };
          await vi.waitFor(async () => {
            const receipt = await scannerReceipt(state);
            expect(receipt?.snapshot.lifecycle.pid).not.toBe(originalPid);
            expect(receipt?.snapshot.lifecycle.controlId).toBe(control.id);
          });
        }
        expect(await bytesAt(path)).toEqual(before);
        expect(await bytesAt(store.pointerPath('scanner'))).toEqual(pointer);
        if (existing) expect(JSON.parse((await bytesAt(path))!.toString()).paused).toBe(false);
      }
    );
  }
);

it.each(['connected', 'partial', 'missing', 'changed-consent', 'missing-session'] as const)(
  'interactive reinstall only requests needed repository approval (%s)',
  async (scenario) => {
    const secondRoot = join(home, 'different');
    consent.roots.push(secondRoot);
    if (scenario !== 'missing') {
      await mkdir(join(state, 'scanner'), { recursive: true });
      await writeFile(
        join(state, 'scanner/state.json'),
        JSON.stringify({
          schemaVersion: 1,
          config: {
            roots: scenario === 'partial' ? [consent.roots[0]] : consent.roots,
            exclusions: [],
            serverUrl: 'https://api.mnemonik.dev',
          },
          consent,
          paused: false,
          pauseIntervals: [],
        })
      );
    }
    const fetcher = options.fetch!;
    let approved = false;
    const authorize = vi.fn(async (selection?: unknown) => {
      if (selection) approved = true;
      return 'cli-token';
    });
    await prepareScanner(
      {
        ...options,
        nonInteractive: false,
        authorize,
        fetch: async (url, init) => {
          if (
            !approved &&
            scenario === 'missing-session' &&
            String(url).includes('install-sessions')
          )
            return new Response(null, { status: 404 });
          if (
            !approved &&
            scenario === 'changed-consent' &&
            String(url).includes('scanner-consent')
          )
            return Response.json({
              consent: { ...consent, disclosureVersion: 'old' },
              disclosure: { version: consent.disclosureVersion, statements: [] },
            });
          return fetcher(url, init);
        },
      },
      async (prepared) => {
        expect(prepared.roots).toEqual(consent.roots);
      }
    );
    const approvalCalls = authorize.mock.calls.filter(([selection]) => selection);
    expect(approvalCalls).toEqual(
      scenario === 'connected'
        ? []
        : [[{ roots: consent.roots, exclusions: [] }, '11111111-1111-4111-8111-111111111111']]
    );
  }
);

it('failed reconnection keeps an approved existing watch while explicit removal still takes effect', async () => {
  const retained = consent.roots[0]!;
  const removed = join(home, 'different');
  await mkdir(join(state, 'scanner'), { recursive: true, mode: 0o700 });
  await writeFile(
    join(state, 'scanner/state.json'),
    JSON.stringify({
      schemaVersion: 1,
      config: { roots: [retained, removed], exclusions: [], serverUrl: 'https://api.mnemonik.dev' },
      consent: { ...consent, roots: [retained, removed] },
      paused: false,
      pauseIntervals: [],
    }),
    { mode: 0o600 }
  );
  await prepareScanner(options, async (prepared) => {
    prepared.roots.splice(0);
    const result = await prepared.apply(undefined, prepared.roots);
    expect(result.scanner?.roots).toEqual([retained]);
  });
  const saved = JSON.parse(await readFile(join(state, 'scanner/state.json'), 'utf8'));
  expect(saved.config.roots).toEqual([retained]);
  expect(saved.consent.roots).toEqual([retained]);
});

it('standalone scanner enable restores the running scanner when its replacement download fails', async () => {
  await enableScanner(options);
  const path = join(state, 'scanner/state.json');
  const before = await bytesAt(path);
  const pointer = await bytesAt(store.pointerPath('scanner'));
  await expect(
    enableScanner({
      ...options,
      source: async () => {
        throw new Error('download_failed');
      },
    })
  ).rejects.toThrow('download_failed');
  expect((await scannerService({ stateDir: state, store }).status()).running).toBe(true);
  expect(await bytesAt(path)).toEqual(before);
  expect(await bytesAt(store.pointerPath('scanner'))).toEqual(pointer);
});

it('Mac approval and final review leave existing indexing running without a pause', async () => {
  await enableScanner(options);
  const before = await bytesAt(join(state, 'scanner/state.json'));
  const pointer = await bytesAt(store.pointerPath('scanner'));
  await prepareScanner({ ...options, platform: 'darwin' }, async () => {
    expect((await scannerReceipt(state))?.snapshot.lifecycle.state).toBe('running');
    expect(await bytesAt(join(state, 'scanner/state.json'))).toEqual(before);
    expect(await bytesAt(join(state, 'scanner/control.json'))).toBeNull();
  });
  expect(await bytesAt(store.pointerPath('scanner'))).toEqual(pointer);
}, 20000);

it.each(['success', 'offline-ready', 'transport-lost'] as const)(
  'Mac reinstall stages a complete replacement before independent handoff (%s)',
  async (ending) => {
    await enableScanner(options);
    const statePath = join(state, 'scanner/state.json');
    const pointerPath = store.pointerPath('scanner');
    const beforeState = await bytesAt(statePath);
    const beforePointer = await bytesAt(pointerPath);
    const priorPid = (await scannerReceipt(state))!.snapshot.lifecycle.pid!;
    events = [];
    const command = vi.fn<NonNullable<EnableOptions['command']>>(async (operation, definition) => {
      expect(['status', 'install']).toContain(operation);
      if (operation === 'install') {
        // At this seam the independent supervisor has not yet accepted ownership.
        expect(await bytesAt(statePath)).toEqual(beforeState);
        expect(await bytesAt(pointerPath)).toEqual(beforePointer);
        expect((await scannerReceipt(state))?.snapshot.lifecycle.state).toBe('running');
        expect(await bytesAt(join(state, 'scanner/control.json'))).toBeNull();
        const replacement = definition!.replacement!;
        const nextState = JSON.parse(replacement.state!.after);
        expect(nextState.config.credentialFamilyId).toBe('family-one');
        expect(nextState.paused).toBe(false);
        expect(JSON.parse(replacement.pointer.after).current.version).toBe('2.0.0');
        expect(events).not.toContain('/api/v1/component-credentials');
        // The native supervisor owns these writes and may finish after its caller loses contact.
        await writeFile(statePath, replacement.state!.after);
        await writeFile(pointerPath, replacement.pointer.after);
        const receipt = (await scannerReceipt(state))!;
        const startedAt = Date.now();
        await mkdir(join(state, 'scanner/service-replacement'), { recursive: true });
        await writeFile(
          join(state, 'scanner/service-replacement/result.json'),
          JSON.stringify({ pid: priorPid, startedAt })
        );
        receipt.recordedAt = startedAt + 1;
        receipt.snapshot.heartbeat.lastSuccess = ending === 'offline-ready' ? null : startedAt + 1;
        if (ending === 'offline-ready') {
          receipt.snapshot.lifecycle.state = 'starting';
          receipt.snapshot.startupTimings = { localReadyAt: startedAt + 1 };
        }
        await writeFile(join(state, 'scanner/status.json'), JSON.stringify(receipt));
        if (ending === 'transport-lost') throw new Error('helper_transport_lost');
      }
      return {
        status: 'ok',
        supervisor: { kind: 'launchd', installed: true, running: true, pid: priorPid },
      };
    });
    const run = enableScanner({
      ...options,
      platform: 'darwin',
      command,
      source: async () => source('2.0.0'),
    });
    if (ending !== 'transport-lost')
      await expect(run).resolves.toMatchObject({
        scanner: { version: '2.0.0', ...(ending === 'offline-ready' ? { heartbeatAt: null } : {}) },
      });
    else await expect(run).rejects.toThrow('helper_transport_lost');
    expect(command.mock.calls.filter(([operation]) => operation === 'install')).toHaveLength(1);
    expect(JSON.parse((await bytesAt(pointerPath))!.toString()).current.version).toBe('2.0.0');
    expect(JSON.parse((await bytesAt(statePath))!.toString()).config.credentialFamilyId).toBe(
      'family-one'
    );
    expect(events.some((event) => event.endsWith('/revoke'))).toBe(false);
  },
  20000
);

it('Mac managed replacement is preserved by later general install compensation', async () => {
  await enableScanner(options);
  const path = join(state, 'scanner/state.json');
  const proposed = Buffer.from(
    JSON.stringify({ ...JSON.parse((await bytesAt(path))!.toString()), boundary: 'new' })
  );
  await withInstall(
    state,
    {
      account: 'owner',
      hosts: [],
      components: ['scanner'],
      scopes: {},
      roots: consent.roots,
      credentials: [],
      joined: true,
    },
    undefined,
    async (journal) => {
      const target = await journal.plan(path, proposed, {
        kind: 'runtime',
        group: 'scanner:managed-state',
      });
      await journal.commit(target);
      journal.data.services.push({ id: 'scanner', before: '{}', started: true, managed: true });
      journal.data.credentials.push({
        reference: 'candidate-family',
        kind: 'component',
        component: 'scanner',
      });
      const restore = vi.fn(async () => {});
      const revokeComponent = vi.fn(async () => true);
      await compensate(journal, {
        stateDir: state,
        services: { restore },
        revokeComponent,
      } as unknown as InstallDependencies);
      expect(restore).not.toHaveBeenCalled();
      expect(revokeComponent).not.toHaveBeenCalled();
      expect(await bytesAt(path)).toEqual(proposed);
    }
  );
});

it('fresh Mac install hands off only after its complete credential and state are staged', async () => {
  const statePath = join(state, 'scanner/state.json');
  const pointerPath = store.pointerPath('scanner');
  const fetcher = options.fetch!;
  const command = vi.fn<NonNullable<EnableOptions['command']>>(async (operation, definition) => {
    if (operation === 'status')
      return {
        status: 'ok',
        supervisor: { kind: 'launchd', installed: true, running: true, pid: 1234 },
      };
    expect(operation).toBe('install');
    expect(await bytesAt(statePath)).toBeNull();
    expect(await bytesAt(pointerPath)).toBeNull();
    const replacement = definition!.replacement!;
    expect(JSON.parse(replacement.state!.after).config.credentialFamilyId).toBe('new-family');
    expect(await options.credentials!.readFamily('new-family')).not.toBeNull();
    await writeFile(statePath, replacement.state!.after, { mode: 0o600 });
    await writeFile(pointerPath, replacement.pointer.after, { mode: 0o600 });
    const startedAt = Date.now();
    await mkdir(join(state, 'scanner/service-replacement'), { recursive: true });
    await writeFile(
      join(state, 'scanner/service-replacement/result.json'),
      JSON.stringify({ pid: 1234, startedAt })
    );
    await writeFile(
      join(state, 'scanner/status.json'),
      JSON.stringify({
        recordedAt: startedAt + 1,
        snapshot: {
          lifecycle: { pid: 1234, state: 'running' },
          heartbeat: { lastSuccess: startedAt + 1 },
        },
      })
    );
    return {
      status: 'ok',
      supervisor: { kind: 'launchd', installed: true, running: true, pid: 1234 },
    };
  });
  await expect(
    enableScanner({
      ...options,
      platform: 'darwin',
      command,
      fetch: async (url, init) => {
        if (String(url).endsWith('/component-credentials')) {
          expect(await bytesAt(statePath)).toBeNull();
          expect(await bytesAt(pointerPath)).toBeNull();
          return Response.json({
            id: 'new-family',
            access_token: 'fixture-access',
            refresh_token: 'fixture-refresh',
            scope: 'scanner:upload',
            expires_in: 3600,
            refresh_expires_in: 86400,
            token_type: 'Bearer',
          });
        }
        return fetcher(url, init);
      },
    })
  ).resolves.toMatchObject({ scanner: { version: '1.0.0' } });
  expect(command.mock.calls.filter(([operation]) => operation === 'install')).toHaveLength(1);
}, 20000);
