import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { resolveProjectIdentity, serializeReadiness } from '@mnemonik/shared';
import { withLock } from '@mnemonik/local-setup';

const scanner = vi.hoisted(() => ({ prepare: vi.fn(), update: vi.fn() }));
vi.mock('../src/scanner/enable.js', async (original) => ({
  ...(await original<typeof import('../src/scanner/enable.js')>()),
  prepareScanner: scanner.prepare,
  updateScannerRoots: scanner.update,
}));

import {
  EARLIER_INSTALL_KEPT,
  EARLIER_INSTALL_REMOVED,
  EARLIER_INSTALL_RUNNING,
  joinedInstall,
} from '../src/install/journey.js';
import { withInstall } from '../src/install/journal.js';
import { Output } from '../src/output.js';
import { alreadyConnectedFolderLine, runCli, type CliDependencies } from '../src/router.js';
import type { ScannerConsentDraft } from '../src/scanner/picker.js';

const homes: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'agent-install-'));
  homes.push(home);
  return { home, stateDir: join(home, 'state') };
}

async function folder(home: string, name: string): Promise<string> {
  const path = join(home, 'Projects', name);
  await mkdir(path, { recursive: true });
  return path;
}

async function scannerState(stateDir: string, roots: string[]): Promise<void> {
  await mkdir(join(stateDir, 'scanner'), { recursive: true });
  await writeFile(
    join(stateDir, 'scanner/state.json'),
    JSON.stringify({
      schemaVersion: 1,
      config: { roots, exclusions: [], serverUrl: 'https://api.mnemonik.dev' },
      consent: { userId: 'owner', roots, exclusions: [], disclosureVersion: '2026.09.1' },
      paused: false,
      pauseIntervals: [],
    })
  );
}

/** A signed-in machine whose account has already approved `approved`, and no open install session. */
function server(approved: string[], posted: string[] = []) {
  return vi.fn(async (url: string | URL) => {
    const path = new URL(String(url)).pathname;
    if (path === '/api/v1/installations/current/readiness') {
      posted.push(path);
      return Response.json({ status: 'recorded' });
    }
    if (path === '/api/v1/auth/grants')
      return Response.json({
        account: 'owner',
        email: 'owner@example.test',
        deviceInstallationId: '11111111-1111-4111-8111-111111111111',
        grants: [],
      });
    if (path === '/api/v1/install-sessions/current')
      return Response.json({ error: 'active_session_not_found' }, { status: 404 });
    if (path === '/api/v1/scanner-consent/current')
      return Response.json({
        consent: {
          userId: 'owner',
          roots: approved,
          exclusions: [],
          disclosureVersion: '2026.09.1',
        },
        disclosure: { version: '2026.09.1', statements: [] },
      });
    return Response.json({});
  }) as unknown as typeof fetch;
}

/** Runs the scanner step of a non-interactive install, recording every browser approval asked for. */
async function scannerStep(
  f: Awaited<ReturnType<typeof fixture>>,
  roots: string[],
  approved: string[],
  asked: ScannerConsentDraft[],
  posted: string[] = []
): Promise<string[]> {
  await scannerState(f.stateDir, []);
  // The real step, not the stub the interrupted-install tests below install.
  const { prepareScanner } = await vi.importActual<typeof import('../src/scanner/enable.js')>(
    '../src/scanner/enable.js'
  );
  return prepareScanner(
    {
      stateDir: f.stateDir,
      projectStateDir: f.stateDir,
      cwd: f.home,
      home: f.home,
      input: Readable.from([]),
      output: new Output({ write() {} }),
      roots,
      exclusions: [],
      nonInteractive: true,
      noBrowser: true,
      fetch: server(approved, posted),
      authorize: async (selection) => {
        if (selection) asked.push(selection);
        return 'cli-token';
      },
      projectExecutor: {
        resolveProjectIdentity: (cwd: string) => resolveProjectIdentity(cwd),
      } as never,
    },
    async (prepared) => {
      await prepared.complete(serializeReadiness({ installation: { conditions: [] } }));
      return prepared.roots;
    }
  );
}

it('asks for nothing when the machine is signed in and every folder is already approved', async () => {
  const f = await fixture();
  const one = await folder(f.home, 'one');
  const two = await folder(f.home, 'two');
  const other = await folder(f.home, 'other');
  const asked: ScannerConsentDraft[] = [];
  const posted: string[] = [];

  const connected = await scannerStep(f, [one, two], [one, two, other], asked, posted);

  expect(asked).toEqual([]);
  // Only the folders this run asked for, never the rest of the account's list.
  expect(connected).toEqual([one, two]);
  // With no browser session, the readiness still reaches the account.
  expect(posted).toEqual(['/api/v1/installations/current/readiness']);
});

it('sends a run to the browser when a newer consent no longer covers a folder', async () => {
  const f = await fixture();
  const one = await folder(f.home, 'one');
  const two = await folder(f.home, 'two');
  const asked: ScannerConsentDraft[] = [];

  // The account's newest accepted consent has dropped `two`.
  await expect(scannerStep(f, [one, two], [one], asked)).rejects.toThrow();

  expect(asked).toHaveLength(1);
  expect(asked[0]?.roots).toContain(two);
});

it('asks once, naming the folder the account has not approved yet', async () => {
  const f = await fixture();
  const one = await folder(f.home, 'one');
  const two = await folder(f.home, 'two');
  const asked: ScannerConsentDraft[] = [];

  // The fake server never records an approval, so the run cannot finish.
  await expect(scannerStep(f, [one, two], [one], asked)).rejects.toThrow();

  expect(asked).toHaveLength(1);
  expect(asked[0]?.roots).toContain(two);
});

it('says an already connected folder is connected and asks for nothing', async () => {
  const f = await fixture();
  const path = await folder(f.home, 'shop');
  await scannerState(f.stateDir, [path]);
  const stdout = {
    text: '',
    write(chunk: string) {
      this.text += chunk;
    },
  };

  const code = await runCli(['add', path, '--non-interactive', '--apply'], {
    home: f.home,
    cwd: f.home,
    installStateDir: f.stateDir,
    projectStateDir: f.stateDir,
    input: Readable.from(''),
    stdout,
    stderr: stdout,
  } as unknown as CliDependencies);

  expect(code).toBe(0);
  expect(stdout.text.trim()).toBe(alreadyConnectedFolderLine('shop').trim());
  expect(scanner.update).not.toHaveBeenCalled();
});

/** Leaves the record an install that was killed before it finished leaves behind. */
async function interruptedRecord(stateDir: string, account = 'owner'): Promise<void> {
  await withInstall(
    stateDir,
    {
      account,
      joined: true,
      hostRequest: { command: 'install', selections: [], allowMigration: false },
      components: ['hooks', 'mcp'],
      hosts: [],
      scopes: {},
      roots: [],
      credentials: [],
    },
    undefined,
    async (journal) => {
      journal.data.phase = 'preparing';
      await journal.save();
    }
  );
}

async function nonInteractiveInstall(
  f: Awaited<ReturnType<typeof fixture>>,
  roots: string[]
): Promise<{ code: number; text: string; posted: string[] }> {
  const posted: string[] = [];
  scanner.prepare.mockImplementation(async (_options: unknown, work: (p: unknown) => unknown) =>
    work({
      roots: [...roots],
      exclusions: [],
      files: [],
      apply: async () => serializeReadiness({ installation: { conditions: [] } }),
      projectExecutor: async () => ({ ensureProject: async () => ({ status: 'done' }) }),
      rollback: vi.fn(),
      complete: vi.fn(),
    })
  );
  let text = '';
  const code = await joinedInstall(
    new Map<string, string | true>([
      ['non-interactive', true],
      ['apply', true],
      ['accept-indexing', true],
      ['components', 'scanner'],
      ['no-browser', true],
      ['scan-roots', roots.join(',')],
    ]),
    {
      home: f.home,
      cwd: f.home,
      input: Readable.from(''),
      installStateDir: f.stateDir,
      projectStateDir: f.stateDir,
      preflight: { nodeVersion: '24.21.0', fetch: async () => Response.json({}) },
      grantFetch: async (url: string | URL) => {
        const path = new URL(String(url)).pathname;
        if (path === '/api/v1/install-sessions/current')
          return Response.json({ error: 'active_session_not_found' }, { status: 404 });
        if (path === '/api/v1/installations/current/readiness') posted.push(path);
        return Response.json({ status: 'completed' });
      },
    } as unknown as CliDependencies,
    new Output({ write: (chunk) => void (text += chunk) }),
    async () => 'owner',
    async () => ({
      stateDir: f.stateDir,
      account: 'owner',
      getCliBearer: async () => 'cli-token',
      now: () => 0,
      sleep: async () => {},
    })
  );
  return { code, text, posted };
}

it('removes an unfinished earlier installation and keeps going', async () => {
  const f = await fixture();
  const path = await folder(f.home, 'one');
  await interruptedRecord(f.stateDir);

  const result = await nonInteractiveInstall(f, [path]);

  expect(result.text).toContain(EARLIER_INSTALL_REMOVED);
  // No install session is open, so readiness goes to the session-less route.
  expect(result.posted).toEqual(['/api/v1/installations/current/readiness']);
  expect(result.text).not.toContain('Run mnemonik install interactively');
  expect(result.text).not.toContain(EARLIER_INSTALL_RUNNING);
});

it('stops when the earlier installation is still running', async () => {
  const f = await fixture();
  const path = await folder(f.home, 'one');
  await interruptedRecord(f.stateDir);
  const before = await readFile(join(f.stateDir, 'install-owner.json'), 'utf8');

  const result = await withLock(join(f.stateDir, 'install-owner.json'), 10, async () =>
    nonInteractiveInstall(f, [path])
  );

  expect(result.code).not.toBe(0);
  expect(result.text).toContain(EARLIER_INSTALL_RUNNING);
  expect(result.text).not.toContain(EARLIER_INSTALL_REMOVED);
  expect(await readFile(join(f.stateDir, 'install-owner.json'), 'utf8')).toBe(before);
});

it('keeps an unfinished installation that belongs to another account', async () => {
  const f = await fixture();
  const path = await folder(f.home, 'one');
  await interruptedRecord(f.stateDir, 'someone-else');
  await writeFile(
    join(f.stateDir, 'installation.json'),
    JSON.stringify({
      deviceInstallationId: '11111111-1111-4111-8111-111111111111',
      account: 'owner',
    })
  );

  const result = await nonInteractiveInstall(f, [path]);

  expect(result.code).toBe(1);
  expect(result.text).toContain(EARLIER_INSTALL_KEPT);
  expect(result.text).not.toContain(EARLIER_INSTALL_REMOVED);
});
