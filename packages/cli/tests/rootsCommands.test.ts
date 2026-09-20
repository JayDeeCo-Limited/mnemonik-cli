import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { serializeReadiness } from '@mnemonik/shared';

const scanner = vi.hoisted(() => ({ enable: vi.fn(), update: vi.fn() }));
vi.mock('../src/scanner/enable.js', async (original) => ({
  ...(await original<typeof import('../src/scanner/enable.js')>()),
  enableScanner: scanner.enable,
  updateScannerRoots: scanner.update,
}));

import { runCli, type CliDependencies } from '../src/router.js';

const created: string[] = [];
const capture = () => ({
  text: '',
  write(chunk: string) {
    this.text += chunk;
  },
});

beforeEach(() => {
  scanner.enable.mockResolvedValue(serializeReadiness({ installation: { conditions: [] } }));
});

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'roots-command-'));
  created.push(home);
  const stateDir = join(home, 'state');
  const root = join(home, 'Projects', 'app');
  await mkdir(join(stateDir, 'scanner'), { recursive: true });
  await mkdir(root, { recursive: true });
  await writeFile(
    join(stateDir, 'scanner/state.json'),
    JSON.stringify({
      schemaVersion: 1,
      config: { roots: [], exclusions: [], serverUrl: 'https://api.mnemonik.dev' },
      consent: {
        userId: 'owner',
        roots: [],
        exclusions: [],
        disclosureVersion: '2026.09.1',
      },
      paused: false,
      pauseIntervals: [],
    })
  );
  const stdout = capture();
  const stderr = capture();
  const signIn = vi.fn();
  const ensureProject = vi.fn(async () => ({
    status: 'done' as const,
    operationId: '11111111-1111-4111-8111-111111111111',
    root,
    projectId: '22222222-2222-4222-8222-222222222222',
    permissionStatus: 'private' as const,
  }));
  const deps: CliDependencies = {
    home,
    cwd: home,
    installStateDir: stateDir,
    input: Readable.from('\n'),
    stdout,
    stderr,
    cliAuth: {
      signIn,
      getCliBearer: async () => 'cli-token',
      logout: async () => undefined,
    },
    projectExecutor: {
      resolveProjectIdentity: async () => ({
        kind: 'absent',
        root,
        repository: { kind: 'plain', root },
        nested: [],
      }),
      ensureProject,
      stage: vi.fn(),
      apply: vi.fn(),
      rollback: vi.fn(),
    } as CliDependencies['projectExecutor'],
  };
  return { deps, root, stateDir, stdout, signIn, ensureProject };
}

it('adds a root without opening consent when the disclosure is current', async () => {
  const f = await fixture();
  scanner.update.mockResolvedValue({
    status: 'updated',
    state: { config: { roots: [f.root] } },
  });

  expect(await runCli(['add', f.root], f.deps)).toBe(0);

  expect(f.stdout.text).toContain('Connect app to Mnemonik? [Y/n]');
  expect(f.stdout.text).toContain('✓ Connected app.');
  expect(f.ensureProject).toHaveBeenCalledOnce();
  expect(scanner.update).toHaveBeenCalledWith(
    expect.objectContaining({ add: [f.root], remove: [], bearer: 'cli-token' })
  );
  expect(scanner.enable).not.toHaveBeenCalled();
  expect(f.signIn).not.toHaveBeenCalled();
});

it('falls back to browser consent only when the disclosure changed', async () => {
  const f = await fixture();
  scanner.update.mockResolvedValue({ status: 'disclosure_required' });

  expect(await runCli(['add', f.root], f.deps)).toBe(0);

  expect(scanner.enable).toHaveBeenCalledOnce();
  expect(scanner.enable).toHaveBeenCalledWith(
    expect.objectContaining({ roots: [f.root], noBrowser: false })
  );
  expect(JSON.parse(await readFile(join(f.stateDir, 'scanner/state.json'), 'utf8'))).toBeTruthy();
});

it('explains the plan limit in two actionable lines', async () => {
  const f = await fixture();
  f.ensureProject.mockResolvedValue({
    status: 'ACTION_REQUIRED',
    state: 'project_limit_reached',
    allowedActions: ['upgrade', 'cancel'],
    used: 1,
    limit: 1,
    tier: 'free',
    existingProjectNames: ['existing'],
  } as never);

  expect(await runCli(['add', f.root], f.deps)).toBe(3);

  expect(f.stdout.text).toContain('app was not connected. The Free plan includes one project.');
  expect(f.stdout.text).toContain(
    'To connect more projects, upgrade your plan via the Mnemonik web console.'
  );
  expect(scanner.update).not.toHaveBeenCalled();
});

it('removes a connected folder only after the default-no confirmation', async () => {
  const f = await fixture();
  await writeFile(
    join(f.stateDir, 'scanner/state.json'),
    JSON.stringify({ config: { roots: [f.root], exclusions: [] } })
  );
  scanner.update.mockResolvedValue({
    status: 'updated',
    state: { config: { roots: [] } },
  });

  f.deps.input = Readable.from('\n');
  expect(await runCli(['remove', f.root], f.deps)).toBe(130);
  expect(scanner.update).not.toHaveBeenCalled();

  f.stdout.text = '';
  f.deps.input = Readable.from('yes\n');

  expect(await runCli(['remove', f.root], f.deps)).toBe(0);

  expect(f.stdout.text).toContain('Stop indexing app? Its memories stay in your account. [y/N]');
  expect(f.stdout.text).toContain('✓ app is no longer connected.');
  expect(scanner.update).toHaveBeenCalledWith(
    expect.objectContaining({ add: [], remove: [f.root], bearer: 'cli-token' })
  );
});
