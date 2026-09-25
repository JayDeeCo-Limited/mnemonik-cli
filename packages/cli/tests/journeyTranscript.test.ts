import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { serializeReadiness } from '@mnemonik/shared';
import { recordPath } from '@mnemonik/local-setup';
import {
  DEVICE_APPROVAL_INSTRUCTION,
  DEVICE_WARNING,
  REPOSITORY_APPROVAL_INSTRUCTION,
} from '../src/auth/device.js';
import { withInstall } from '../src/install/journal.js';
import type { HostResult, HostSelection } from '../src/install/hosts.js';
import { joinedInstall } from '../src/install/journey.js';
import { Output, type Writable } from '../src/output.js';
import type { PreparedScanner } from '../src/scanner/enable.js';
// Git-heavy fixtures; the CI runner has timed these out at the 5 s default under load.
vi.setConfig({ testTimeout: 30_000 });

const mocks = vi.hoisted(() => ({
  hosts: vi.fn(),
  prepare: vi.fn(),
  classify: vi.fn(),
  status: vi.fn(),
}));
const oscPattern = new RegExp(`^\u001b\\]8;;[^\u0007]*\u0007`, 'u');
const csiPattern = new RegExp(`^\u001b\\[(?:(\\d+)A|2K|J)`, 'u');

vi.mock('../src/install/hosts.js', async (original) => ({
  ...(await original<typeof import('../src/install/hosts.js')>()),
  runHosts: mocks.hosts,
}));
vi.mock('../src/scanner/enable.js', async (original) => ({
  ...(await original<typeof import('../src/scanner/enable.js')>()),
  prepareScanner: mocks.prepare,
}));
vi.mock('../src/scanner/discover.js', async (original) => ({
  ...(await original<typeof import('../src/scanner/discover.js')>()),
  classifyRepository: mocks.classify,
}));
vi.mock('../src/status.js', async (original) => ({
  ...(await original<typeof import('../src/status.js')>()),
  collectStatusDocument: mocks.status,
}));

class Terminal implements Writable {
  isTTY = true;
  supportsHyperlinks = false;
  private lines = [''];
  private row = 0;
  private column = 0;

  write(chunk: string): void {
    for (let index = 0; index < chunk.length;) {
      const rest = chunk.slice(index);
      const osc = oscPattern.exec(rest);
      if (osc) {
        index += osc[0].length;
        continue;
      }
      const csi = csiPattern.exec(rest);
      if (csi) {
        if (csi[1]) this.row = Math.max(0, this.row - Number(csi[1]));
        else if (csi[0].endsWith('2K')) this.lines[this.row] = '';
        else this.lines.splice(this.row);
        index += csi[0].length;
        continue;
      }
      const character = chunk[index++]!;
      if (character === '\r') this.column = 0;
      else if (character === '\n') {
        this.row++;
        this.column = 0;
        this.lines[this.row] ??= '';
      } else if (character === '\b') this.column = Math.max(0, this.column - 1);
      else {
        const line = (this.lines[this.row] ?? '').padEnd(this.column);
        this.lines[this.row] =
          `${line.slice(0, this.column)}${character}${line.slice(this.column + 1)}`;
        this.column++;
      }
    }
  }

  text(): string {
    return this.lines
      .map((line) => line.trimEnd())
      .join('\n')
      .trimEnd();
  }
}

const homes: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

it.each(['indexing-skipped marker', 'retired host ownership'])(
  'stops without writes or network when no supported editor has a stale %s',
  async (leftover) => {
    const home = await mkdtemp(join(tmpdir(), 'journey-no-editors-'));
    homes.push(home);
    const stateDir = join(home, 'state');
    await mkdir(stateDir);
    if (leftover === 'indexing-skipped marker')
      await writeFile(join(stateDir, 'indexing-skipped'), 'indexing was skipped\n');
    else
      await writeFile(
        join(stateDir, 'host-ownership.json'),
        JSON.stringify({
          schemaVersion: 1,
          generation: 0,
          targets: [
            {
              id: 'grok:hooks:user',
              host: 'grok',
              component: 'hooks',
              scope: 'user',
              home,
              profilePath: join(home, '.grok', 'hooks.json'),
              version: '0.1.0',
              artifactDigest: 'legacy',
              runtimePointer: join(stateDir, 'runtimes', 'grok', 'current'),
              files: [],
            },
          ],
        })
      );
    const before = await Promise.all(
      (await readdir(stateDir))
        .sort()
        .map(async (name) => [name, await readFile(join(stateDir, name))])
    );
    const terminal = new Terminal();
    const network = vi.fn(async () => Response.json({}));
    const authorize = vi.fn(async () => 'owner');
    const manage = vi.fn(async () => ({ stateDir, account: 'owner' }));

    const code = await joinedInstall(
      new Map(),
      {
        cwd: home,
        home,
        installStateDir: stateDir,
        input: Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() }),
        preflight: {
          nodeVersion: '24.21.0',
          fetch: network,
          resolveIdentity: async () => ({
            kind: 'absent',
            root: home,
            repository: { kind: 'plain', root: home },
            nested: [],
          }),
        },
      },
      new Output(terminal),
      authorize,
      manage
    );

    expect(code).toBe(130);
    expect(terminal.text()).toBe(`Mnemonik

  ✓ Computer checked

  No supported coding tools found.

  Learn more about supported coding tools:
  https://mnemonik.ai/install#support`);
    expect(network).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    expect(manage).not.toHaveBeenCalled();
    expect(
      await Promise.all(
        (await readdir(stateDir))
          .sort()
          .map(async (name) => [name, await readFile(join(stateDir, name))])
      )
    ).toEqual(before);
  }
);

async function runJourney(
  uncheckCodex = false,
  onlyIndexing = false,
  beforeApply?: (terminal: Terminal, stage: ReturnType<typeof vi.fn>) => Promise<void>,
  signedIn: string[] = [],
  duringApproval?: (terminal: Terminal) => Promise<void>
) {
  const home = await mkdtemp(join(tmpdir(), 'journey-transcript-'));
  homes.push(home);
  const stateDir = join(home, 'state');
  const projects = Array.from({ length: 15 }, (_, index) =>
    join(home, 'projects', `repo-${index}`)
  );
  await Promise.all(projects.map((project) => mkdir(project, { recursive: true })));
  if (onlyIndexing) {
    await mkdir(join(stateDir, 'scanner'), { recursive: true });
    await writeFile(join(stateDir, 'scanner', 'state.json'), '{}');
    await writeFile(
      join(stateDir, 'host-ownership.json'),
      JSON.stringify({
        schemaVersion: 1,
        generation: 0,
        targets: [
          {
            id: `codex:hooks:user:${home}`,
            host: 'codex',
            component: 'hooks',
            scope: 'user',
            home,
            profilePath: join(home, '.codex', 'hooks.json'),
            version: '1.0.0',
            artifactDigest: 'fixture',
            runtimePointer: join(stateDir, 'runtimes', 'codex', 'current'),
            files: [],
          },
        ],
      })
    );
  }
  vi.stubEnv('PATH', join(home, '.local/bin'));
  let selections: HostSelection[] = [];
  mocks.hosts.mockImplementation(async (_command, chosen, dependencies) => {
    selections = chosen;
    let result!: {
      journal: { state: string; phase: string; runId: string };
      results: HostResult[];
      reports: string[];
    };
    await withInstall(
      stateDir,
      {
        account: 'owner',
        components: ['hooks', 'mcp', 'scanner'],
        hosts: [],
        scopes: {},
        roots: [],
        credentials: [],
        joined: true,
        hostRequest: { command: 'install', selections: chosen, allowMigration: false },
      },
      undefined,
      async (journal) => {
        const results = chosen.map(
          (selection: HostSelection) =>
            ({
              target: `${selection.host}:${selection.component}:user`,
              status: 'READY',
              reason: '',
              action: '',
              ...(signedIn.includes(selection.host) ? { signedIn: true } : {}),
            }) as HostResult
        );
        await dependencies.afterHosts?.(journal, results, async () => undefined);
        journal.data.state = 'READY';
        journal.data.phase = 'complete';
        await journal.save();
        result = { journal: journal.data, results, reports: [] };
      }
    );
    return result;
  });
  mocks.prepare.mockImplementation(async (options, work) => {
    options.output.line('Where do your projects live? [~/projects]');
    expect(await options.readAnswer?.()).toBe('~/projects');
    options.output.line(REPOSITORY_APPROVAL_INSTRUCTION);
    // The order of the real prepareScanner: announce, start waiting, then the device flow.
    options.awaitingApproval?.();
    options.output.line('https://auth.mnemonik.ai/oauth/device?user_code=WKSG-ZKHW');
    options.output.line(DEVICE_WARNING);
    await duringApproval?.(terminal);
    options.waiting?.('service', 120_000);
    return work({
      roots: [...projects],
      exclusions: [],
      files: [],
      session: { id: 'session' },
      apply: async () => serializeReadiness({ installation: { conditions: [] } }),
      rollback: vi.fn(),
      complete: vi.fn(),
    } as unknown as PreparedScanner);
  });
  mocks.classify.mockImplementation(async (path) => ({ path, state: 'not_set_up' }));
  mocks.status.mockResolvedValue({
    ...serializeReadiness({ installation: { conditions: [] } }),
    cliCredential: { present: true, diagnostics: [] },
  });
  const executor = {
    stage: vi.fn(async ({ cwd }: { cwd: string }) => {
      const path = recordPath(cwd, stateDir);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, '{}');
      return { status: 'staged' as const };
    }),
    apply: vi.fn(async ({ cwd }: { cwd: string }) => ({ status: 'done' as const, projectId: cwd })),
    rollback: vi.fn(),
  };
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
  const terminal = new Terminal();
  const output = new Output(terminal);
  const install = joinedInstall(
    new Map(),
    {
      cwd: home,
      home,
      input,
      installStateDir: stateDir,
      projectExecutor: executor as never,
      preflight: {
        nodeVersion: '24.21.0',
        fetch: async () => Response.json({}),
        pathExists: async (path) =>
          onlyIndexing
            ? /\.codex(?:\/|$)/u.test(path)
            : /\.(?:claude|codex|cursor)(?:\/|$)/u.test(path),
        resolveIdentity: async () => ({
          kind: 'absent',
          root: home,
          repository: { kind: 'plain', root: home },
          nested: [],
        }),
      },
      launcher: { platform: 'linux' },
    },
    output,
    async () => {
      output.line('https://auth.mnemonik.ai/oauth/device?user_code=XCDM-KZGJ');
      output.line(DEVICE_WARNING);
      return 'owner';
    },
    async () => ({ stateDir, account: 'owner', now: () => 0, sleep: async () => undefined })
  );

  await vi.waitFor(() => expect(terminal.text()).toContain('Automatic project indexing'), {
    timeout: 5_000,
  });
  input.write(onlyIndexing ? ' \u001b[B\r' : uncheckCodex ? '\u001b[B \r' : '\r');
  await vi.waitFor(() => expect(terminal.text()).toContain('Where do your projects live?'), {
    timeout: 5_000,
  });
  input.write('~/projects\r');
  await vi.waitFor(() => expect(terminal.text()).toContain('Install and upload'), {
    timeout: 5_000,
  });
  await beforeApply?.(terminal, executor.stage);
  input.write('\r');
  await expect(install).resolves.toBe(0);
  return { text: terminal.text(), selections };
}

it('renders the approved successful interactive journey line for line', async () => {
  const { text } = await runJourney();
  expect(text).toBe(`Mnemonik

  ✓ Computer checked

Step 1 of 5: Choose what to set up
  ✓ Claude Code, Codex, Cursor, automatic project indexing

Step 2 of 5: Sign in
  Please approve the device by opening the link below.

https://auth.mnemonik.ai/oauth/device?user_code=XCDM-KZGJ

  Approve only a request on a device you control.
  ✓ Signed in

Step 3 of 5: Configure coding tools
  ✓ 3 coding tools configured

Step 4 of 5: Connect project folders
  Where do your projects live? [~/projects]
  ~/projects
  Open the link below to choose your project folders.

https://auth.mnemonik.ai/oauth/device?user_code=WKSG-ZKHW

  Approve only a request on a device you control.
  ✓ Connected 15 project folders.
  To connect a folder somewhere else, run mnemonik add <folder>.

Step 5 of 5: Finish
  ✓ Installation finished

  One step is left in each coding tool: Authorize the Mnemonik MCP connection.
  You may need to restart your coding tool after authorizing.

  Claude Code      type /mcp, choose mnemonik, then Authenticate
  Codex CLI        run codex mcp login mnemonik
  Codex Desktop    open Settings, Plugins, MCPs, then Authenticate
  Cursor Desktop   open Cursor Settings, Customize, MCPs, then Authenticate`);
  expect(text).not.toMatch(/Waiting for|Repositories connected|Recommended/u);
});

it('leaves the finish menu still while waiting for the install decision', async () => {
  await runJourney(false, false, async (terminal, stage) => {
    const waiting = terminal.text();
    // L-101: nothing is staged, and nothing spins, before the choice.
    expect(stage).not.toHaveBeenCalled();
    expect(waiting).not.toContain('Connecting your project folders');
    expect(waiting).not.toContain('Waiting for approval');
    expect(waiting).toContain('  > Install and upload\n    Back\n    Cancel');
    await new Promise((resolve) => setTimeout(resolve, 240));
    expect(terminal.text()).toBe(waiting);
  });
});

it('shows the same waiting indicator as step 2 while the folder approval is pending', async () => {
  let waiting = '';
  await runJourney(false, false, undefined, [], async (terminal) => {
    waiting = terminal.text();
  });
  expect(waiting.slice(waiting.indexOf('Step 4 of 5'))).toMatch(
    /\n {2}Approve only a request on a device you control\.\n {2}[|/\\-] Waiting for approval$/u
  );
});

/** The owner-approved layout rules of L-85, checked line by line. */
function expectApprovedLayout(text: string) {
  const lines = text.split('\n');
  expect(lines[0]).toBe('Mnemonik');
  for (const [index, line] of lines.entries()) {
    if (line.includes('://')) expect(line, 'a link is never indented').toMatch(/^https?:\/\//u);
    if (/^Step \d of 5:/u.test(line)) {
      // A blank line before each heading, and the heading is the step name only.
      expect(lines[index - 1], line).toBe('');
      expect(line).toMatch(/^Step \d of 5: [A-Z][a-z ]+$/u);
    } else if (/^https?:\/\//u.test(line)) {
      // Links flush left with a blank line above and below.
      expect(lines[index - 1], line).toBe('');
      expect(lines[index + 1], line).toBe('');
    } else if (line && index > 0)
      expect(line, 'everything else is indented').toMatch(/^ {2}\S| {4}/u);
  }
  // Waiting lines are replaced by their tick, and the closing block stands apart.
  expect(text).not.toMatch(/Waiting for|[|/\\-] (?:Signing in|Connecting)/u);
  expect(lines[lines.indexOf('  ✓ Installation finished') + 1]).toBe('');
}

it('follows the approved layout rules for the whole journey', async () => {
  const { text } = await runJourney();
  expectApprovedLayout(text);
  expect(text.match(/Connected \d+ project folders|Repositories connected/gu)).toHaveLength(1);
});

it.each([false, true])(
  'keeps approval links flush left with blank lines while progress redraws (hyperlinks: %s)',
  (supportsHyperlinks) => {
    vi.useFakeTimers();
    const terminal = new Terminal();
    terminal.supportsHyperlinks = supportsHyperlinks;
    const write = vi.spyOn(terminal, 'write');
    const output = new Output(terminal);
    output.beginInstallation();
    output.line(DEVICE_APPROVAL_INSTRUCTION);
    const progress = output.progressLine('Waiting for approval', true);

    expect(output.line('https://auth.mnemonik.ai/oauth/device?user_code=XCDM-KZGJ')).toBe(3);
    expect(terminal.text()).toBe(`Mnemonik

  Please approve the device by opening the link below.

https://auth.mnemonik.ai/oauth/device?user_code=XCDM-KZGJ

  / Waiting for approval`);
    expect(terminal.text().split('\n')).toHaveLength(7);
    const url = 'https://auth.mnemonik.ai/oauth/device?user_code=XCDM-KZGJ';
    expect(write).toHaveBeenCalledWith(
      supportsHyperlinks ? `\u001b]8;;${url}\u0007${url}\u001b]8;;\u0007\n` : `${url}\n`
    );

    progress.stop();
    vi.useRealTimers();
  }
);

it('Space on Codex then Enter configures only the other two editors', async () => {
  const { text, selections } = await runJourney(true);
  expect([...new Set(selections.map(({ host }) => host))]).toEqual(['claude-code', 'cursor']);
  expect(text).toContain('  ✓ Claude Code, Cursor, automatic project indexing');
  expect(text).toContain('  ✓ 2 coding tools configured');
});

it('omits authorization for a previously configured editor unticked at Step 1', async () => {
  const { text, selections } = await runJourney(false, true);
  expect(selections).toEqual([]);
  expect(text).toContain('  ✓ automatic project indexing');
  expect(text).not.toContain('Authorize the Mnemonik MCP connection');
  expect(text).not.toContain('Codex CLI');
});

it('asks only the editors that are not signed in to authorize', async () => {
  const { text } = await runJourney(false, false, undefined, ['claude-code', 'cursor']);
  expect(text).not.toContain('Claude Code      type /mcp');
  expect(text).not.toContain('Cursor Desktop');
  expect(text).toContain(
    '  One step is left in each coding tool: Authorize the Mnemonik MCP connection.'
  );
  expect(text).toContain('Codex CLI        run codex mcp login mnemonik');
});

it('says nothing about authorizing when every editor is signed in', async () => {
  const { text } = await runJourney(false, false, undefined, ['claude-code', 'codex', 'cursor']);
  expect(text).not.toContain('Authorize the Mnemonik MCP connection');
  expect(text).not.toContain('Codex CLI');
});
