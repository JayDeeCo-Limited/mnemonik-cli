import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, expect, it } from 'vitest';
import { runCli, type CliDependencies } from '../src/router.js';
import { Output } from '../src/output.js';
import { renderJourney } from '../src/screens/journey.js';
import { DiagnosticsError } from '../src/diagnostics.js';

const directories: string[] = [];
it.each([401, 403])('explains a refused revocation sign-in (%s)', async (status) => {
  const f = await fixture();
  await mkdir(join(f.deps.installStateDir!, 'scanner'), { recursive: true });
  await writeFile(
    join(f.deps.installStateDir!, 'scanner/state.json'),
    JSON.stringify({ config: { credentialFamilyId: 'test-family' } })
  );
  f.deps.grantFetch = async () => new Response('', { status });
  expect(await runCli(['auth', 'logout', '--component', 'scanner'], f.deps)).toBe(3);
  expect(f.stderr.text).toContain('Mnemonik could not sign this computer out.');
  expect(f.stderr.text).toContain('Run mnemonik auth login, then try again.');
  expect(f.stderr.text).not.toMatch(/doctor|revoke_failed|mnemonik install/);
});
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
const stream = () => ({
  text: '',
  write(chunk: string) {
    this.text += chunk;
  },
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'human-errors-'));
  directories.push(home);
  const stdout = stream();
  const stderr = stream();
  const deps: CliDependencies = {
    home,
    cwd: home,
    installStateDir: join(home, 'state'),
    stdout,
    stderr,
    input: Readable.from([]),
    cliAuth: {
      signIn: async () => undefined,
      getCliBearer: async () => 'test-bearer',
      logout: async () => undefined,
    },
    getCliBearer: async () => 'test-bearer',
    grantFetch: async () => {
      throw new Error('future_reason');
    },
    diagnostics: {
      stateDir: join(home, 'state'),
      scannerBinary: async () => {
        throw new DiagnosticsError('permission');
      },
    },
    scannerService: {
      stateDir: join(home, 'state'),
      command: async () => {
        throw new Error('future_reason');
      },
    },
  };
  return { deps, stdout, stderr };
}

it.each([
  ['diagnostics', 'preview'],
  ['data', 'delete', '--project', 'test'],
  ['scanner', 'status'],
  ['uninstall', '--component', 'scanner', '--confirm'],
])('gives a next step when %j fails', async (...args) => {
  const f = await fixture();
  expect(await runCli(args, f.deps)).toBeGreaterThan(0);
  const text = f.stdout.text + f.stderr.text;
  expect(text).not.toMatch(/future_reason|permission|scanner_service_unavailable/);
  expect(text).toContain('Run mnemonik doctor on this machine and follow the first repair step.');
});

it('keeps diagnostics reason codes in JSON', async () => {
  const f = await fixture();
  expect(await runCli(['diagnostics', 'preview', '--json'], f.deps)).toBe(1);
  expect(JSON.parse(f.stdout.text)).toEqual({ status: 'error', error: 'permission' });
});

it('explains a Windows task failure without the operating-system reason', () => {
  const stdout = stream();
  renderJourney('windows', new Output(stdout), { reason: 'permission' });
  expect(stdout.text).toContain('Background indexing could not be started.');
  expect(stdout.text).toContain('Run mnemonik install to try again.');
  expect(stdout.text).not.toContain('permission');
});

it('turns an unexpected bare error code into an action at the output boundary', () => {
  const stdout = stream();
  const output = new Output(stdout);
  output.error('future_reason');
  expect(stdout.text).not.toContain('future_reason');
  expect(stdout.text).toContain('Run mnemonik doctor');
  output.json({ reason: 'future_reason' });
  expect(stdout.text).toContain('"reason":"future_reason"');
});

it('uses a folder instruction when a project is refused', async () => {
  const f = await fixture();
  const unused = async (): Promise<never> => {
    throw new Error('unexpected project write');
  };
  f.deps.projectExecutor = {
    resolveProjectIdentity: async () => ({
      kind: 'absent',
      root: f.deps.home!,
      repository: { kind: 'plain', root: f.deps.home! },
      nested: [],
    }),
    stage: unused,
    apply: unused,
    rollback: unused,
    ensureProject: unused,
  };
  expect(await runCli(['project', 'init'], f.deps)).toBe(3);
  expect(f.stderr.text).not.toContain('home_directory');
  expect(f.stderr.text).toContain('That folder cannot be used. Choose another folder.');
});

it('keeps detailed reasons out of preflight prose', async () => {
  const { renderPreflight } = await import('../src/preflight.js');
  const stdout = stream();
  renderPreflight(
    {
      status: 'action_required',
      hosts: [],
      node: { version: '24.21.0', supported: true },
      os: 'Windows',
      project: { resolution: 'git_unavailable' },
      network: {
        reachable: false,
        discoveryUrl: 'https://example.invalid',
        detail: 'future_reason',
      },
    },
    new Output(stdout)
  );
  expect(stdout.text).not.toMatch(/git_unavailable|future_reason/);
  expect(stdout.text).toContain('Mnemonik could not be reached.');
  expect(stdout.text).toContain('Check your internet connection, then try again.');
  expect(stdout.text).not.toContain('Run mnemonik doctor');
});

it('says the server is unavailable, not unreachable, when it answered with an error', async () => {
  const { renderPreflight } = await import('../src/preflight.js');
  const render = (network: {
    reachable: boolean;
    discoveryUrl: string;
    detail?: string;
    skipped?: true;
  }) => {
    const stdout = stream();
    renderPreflight(
      {
        status: 'action_required',
        hosts: [],
        node: { version: '24.21.0', supported: true },
        os: 'Windows',
        project: { resolution: 'git_unavailable' },
        network,
      },
      new Output(stdout)
    );
    return stdout.text;
  };
  const answered = render({
    reachable: false,
    discoveryUrl: 'https://example.invalid',
    detail: 'HTTP 500',
  });
  expect(answered).toContain('Mnemonik is not available right now.');
  expect(answered).toContain('Try again in a few minutes.');
  expect(answered).not.toContain('could not be reached');
  expect(answered).not.toContain('HTTP 500');
  const skipped = render({
    reachable: false,
    discoveryUrl: 'https://example.invalid',
    skipped: true,
  });
  expect(skipped).not.toMatch(/could not be reached|not available right now/);
});

it('keeps self-update failure codes out of human copy', async () => {
  const { cliUpdateLine } = await import('../src/runtime/selfUpdate.js');
  expect(cliUpdateLine({ status: 'FAILED', reason: 'permission' })).not.toContain('permission');
  expect(cliUpdateLine({ status: 'FAILED', reason: 'permission' })).toContain(
    'Run mnemonik doctor'
  );
});

it('renders reason-bearing journal reports while retaining approved instructions', async () => {
  const { terminalInstallUI } = await import('../src/install/ui.js');
  const stdout = stream();
  const terminal = terminalInstallUI(Readable.from('\n'), new Output(stdout), async () => {
    throw new Error('unused');
  });
  try {
    expect(
      await terminal.ui.recovery([
        'Scanner rollback needs attention: future_reason',
        'Credentials retained until local rollback succeeds; retry rollback.',
        'Could not restore /home/my_project/settings.json; backup: /tmp/backup.',
      ])
    ).toBe('resume');
    expect(stdout.text).not.toContain('future_reason');
    expect(stdout.text.replace(/\s+/gu, ' ')).toContain('Run mnemonik doctor');
    expect(stdout.text).toContain(
      'Credentials retained until local rollback succeeds; retry rollback.'
    );
    expect(stdout.text).toContain('/home/my_project/settings.json');
  } finally {
    terminal.close();
  }
});

it('uses plain language when the scanner picker refuses a protected root', async () => {
  const { runScannerPicker } = await import('../src/scanner/picker.js');
  const f = await fixture();
  const result = await runScannerPicker({
    input: Readable.from(`3\n${f.deps.home}\n`),
    output: new Output(f.stdout, f.stderr),
    currentProject: join(f.deps.home!, 'project'),
    currentFolder: join(f.deps.home!, 'project'),
    home: f.deps.home,
  });
  expect(result).toMatchObject({ status: 'cancelled', reason: 'home_directory' });
  expect(f.stderr.text).toContain('That folder cannot be used. Choose another folder.');
  expect(f.stderr.text).not.toContain('home_directory');
});

it('keeps legacy installation-summary reason codes out of the terminal', async () => {
  const { reportInstall } = await import('../src/installSession.js');
  const stdout = stream();
  await reportInstall(
    { installation: { conditions: [] }, steps: [{ name: 'Editor', status: 'not_implemented' }] },
    new Output(stdout)
  );
  expect(stdout.text).not.toMatch(/not_signed_in|not_implemented/);
  expect(stdout.text).toContain('Run mnemonik doctor');
});

it('explains an unsupported identity version and retains the state in JSON', async () => {
  const { writeFile } = await import('node:fs/promises');
  const f = await fixture();
  await writeFile(
    join(f.deps.home!, '.mnemonik.json'),
    JSON.stringify({ schemaVersion: 999, projectId: '11111111-1111-4111-8111-111111111111' })
  );
  expect(await runCli(['identity', 'migrate', f.deps.home!, '--report'], f.deps)).toBe(0);
  expect(f.stdout.text).not.toMatch(/unknown_version|schemaVersion=999/);
  expect(f.stdout.text).toContain('Run mnemonik doctor');
  f.stdout.text = '';
  expect(await runCli(['identity', 'migrate', f.deps.home!, '--report', '--json'], f.deps)).toBe(0);
  expect(JSON.parse(f.stdout.text).report.entries).toEqual(
    expect.arrayContaining([expect.objectContaining({ state: 'unknown_version' })])
  );
});
