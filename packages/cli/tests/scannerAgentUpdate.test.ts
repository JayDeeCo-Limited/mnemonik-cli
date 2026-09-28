import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { serializeReadiness } from '@mnemonik/shared';
import { runCli, type CliDependencies } from '../src/router.js';
import * as scannerEnable from '../src/scanner/enable.js';
import { OAuthProtocolError } from '../src/auth/pkce.js';

/**
 * `mnemonik scanner enable` as an agent runs it on the person's behalf: no
 * terminal, the consent flags, and the folders status printed. The browser
 * approval itself stays the person's (enableScanner is replaced here).
 */
let home: string, state: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'scanner-agent-update-'));
  state = join(home, 'state');
  await mkdir(join(state, 'scanner'), { recursive: true });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true });
});

const ready = () => serializeReadiness({ installation: { conditions: [] } });
/** A script, a pipe or an agent's shell: stdin is not a terminal. */
const agentShell = () => Object.assign(Readable.from([]), { isTTY: false as const });

async function run(args: string[], deps: Partial<CliDependencies> = {}) {
  let out = '';
  let err = '';
  const code = await runCli(args, {
    installStateDir: state,
    home,
    cwd: home,
    input: agentShell(),
    stdout: { write: (value: string) => void (out += value) },
    stderr: { write: (value: string) => void (err += value) },
    ...deps,
  });
  return { code, out, err };
}

async function approved(roots: string[], exclusions: string[] = []) {
  await writeFile(
    join(state, 'scanner/state.json'),
    JSON.stringify({
      schemaVersion: 1,
      config: { roots, exclusions, serverUrl: 'https://api.mnemonik.dev' },
      consent: { userId: 'owner', roots, exclusions, disclosureVersion: '2026.09.1' },
      paused: false,
      pauseIntervals: [],
    })
  );
}

it('accepts ~ in --scan-roots and --exclusions, the form status prints folders in', async () => {
  await mkdir(join(home, 'Projects', 'app', 'private'), { recursive: true });
  const enable = vi.spyOn(scannerEnable, 'enableScanner').mockResolvedValue(ready());
  const result = await run([
    'scanner',
    'enable',
    '--scan-roots=~/Projects/app',
    '--exclusions=~/Projects/app/private',
    '--accept-indexing',
    '--apply',
  ]);
  expect(result.err).toBe('');
  expect(result.code).toBe(0);
  expect(enable).toHaveBeenCalledWith(
    expect.objectContaining({
      roots: [join(home, 'Projects', 'app')],
      exclusions: [join(home, 'Projects', 'app', 'private')],
      nonInteractive: true,
    })
  );
});

it('a folder that does not exist is named with its fix, and nothing is started or rolled back', async () => {
  const enable = vi.spyOn(scannerEnable, 'enableScanner');
  const result = await run([
    'scanner',
    'enable',
    '--scan-roots=~/Projects/missing',
    '--accept-indexing',
    '--apply',
  ]);
  expect(result.code).toBe(3);
  expect(enable).not.toHaveBeenCalled();
  // The agent running it reads the fix; a person reads only the cause.
  expect(result.err).toBe(
    'This folder does not exist: ~/Projects/missing\n' +
      'Pass folders that exist in --scan-roots, or leave --scan-roots out to keep the folders already approved.\n'
  );
  const person = await run(
    ['scanner', 'enable', '--scan-roots=~/Projects/missing', '--accept-indexing', '--apply'],
    { input: Readable.from([]) }
  );
  expect(person.err).toBe('This folder does not exist: ~/Projects/missing\n');
  const json = await run([
    'scanner',
    'enable',
    '--scan-roots=~/Projects/missing',
    '--accept-indexing',
    '--apply',
    '--json',
  ]);
  expect(JSON.parse(json.out)).toMatchObject({
    status: 'ACTION_REQUIRED',
    reason: 'folder_missing',
    folder: '~/Projects/missing',
  });
});

it.each([
  [
    'the browser approval did not cover the folders',
    new Error('browser_consent_required'),
    'The folders were not approved in your browser.\n',
    'Run mnemonik scanner enable --accept-indexing --apply.\n',
  ],
  [
    'the approval request expired',
    new OAuthProtocolError('expired_token', 'expired'),
    'The approval request expired before it was approved.\n',
    'Run mnemonik scanner enable --accept-indexing --apply.\n',
  ],
  [
    'the scanner this CLI carries needs a newer notice than the account approved',
    new Error('release_consent_required'),
    'This version of Mnemonik cannot install the newer scanner yet.\n',
    'Run mnemonik update.\n',
  ],
  [
    'a failure with no words of its own',
    new Error('scanner_receipt_missing'),
    'Background indexing could not be started.\n',
    'Run mnemonik scanner enable --accept-indexing --apply.\n',
  ],
])(
  'when %s, enable says the cause; the agent reads its step, a person no command',
  async (_case, error, cause, agentStep) => {
    await mkdir(join(home, 'app'));
    vi.spyOn(scannerEnable, 'enableScanner').mockRejectedValue(error);
    const args = [
      'scanner',
      'enable',
      `--scan-roots=${join(home, 'app')}`,
      '--accept-indexing',
      '--apply',
    ];
    const agent = await run(args);
    expect(agent.code).toBe(3);
    expect(agent.err).toBe(cause + agentStep);
    expect(agent.err).not.toContain('mnemonik install');
    const person = await run(args, { input: Readable.from([]) });
    expect(person.code).toBe(3);
    expect(person.err).toBe(cause);
  }
);

it('an agent run hands over the browser approval link on stdout as soon as it exists', async () => {
  const root = join(home, 'app');
  await mkdir(root);
  await approved([root]);
  const link = 'https://auth.mnemonik.ai/oauth/device?user_code=ABCD-EFGH';
  vi.spyOn(scannerEnable, 'enableScanner').mockImplementation(async (options) => {
    options.onApprovalLink?.(link, Date.now() + 600_000);
    return ready();
  });
  const result = await run(['scanner', 'enable', '--accept-indexing', '--apply']);
  expect(result.code).toBe(0);
  expect(result.out).toContain(
    `Give the person this link to approve the updated notice:\n\n${link}\n`
  );
});

it('with no --scan-roots, an agent run reuses the folders already approved', async () => {
  const root = join(home, 'app');
  const excluded = join(root, 'vendor');
  await mkdir(excluded, { recursive: true });
  await approved([root], [excluded]);
  const enable = vi.spyOn(scannerEnable, 'enableScanner').mockResolvedValue(ready());
  const result = await run(['scanner', 'enable', '--accept-indexing', '--apply']);
  expect(result.code).toBe(0);
  expect(enable).toHaveBeenCalledWith(
    expect.objectContaining({ roots: [root], exclusions: [excluded], nonInteractive: true })
  );
});

it('a person who runs the same command at a terminal gets the approved folders, not the picker', async () => {
  const root = join(home, 'app');
  await mkdir(root);
  await approved([root]);
  const enable = vi.spyOn(scannerEnable, 'enableScanner').mockResolvedValue(ready());
  const result = await run(['scanner', 'enable', '--accept-indexing', '--apply'], {
    input: Readable.from([]),
  });
  expect(result.code).toBe(0);
  expect(enable).toHaveBeenCalledWith(expect.objectContaining({ roots: [root] }));
  expect(enable.mock.calls[0]?.[0]).not.toHaveProperty('nonInteractive', true);
});

it('with no --scan-roots and nothing approved yet, an agent run still asks for the folders', async () => {
  const enable = vi.spyOn(scannerEnable, 'enableScanner');
  const result = await run(['scanner', 'enable', '--accept-indexing', '--apply', '--json']);
  expect(result.code).toBe(3);
  expect(enable).not.toHaveBeenCalled();
  expect(JSON.parse(result.out)).toMatchObject({ flag: '--scan-roots' });
});
