import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CliDependencies } from '../src/router.js';
import type { ReadinessCondition } from '@mnemonik/shared';
import { buildStatusDocument, renderStatusSummaries } from '../src/status.js';

const project = {
  resolvedRoot: '/work/acme',
  projectId: '11111111-1111-4111-8111-111111111111',
  identity: 'ok',
  reachability: 'reachable',
  server: 'access',
} as const;

describe('installation and project status', () => {
  it('keeps installation READY while an uncovered project is LIMITED', () => {
    const document = buildStatusDocument({
      installationConditions: [],
      projectStatus: project,
      scannerStatus: { roots: ['/elsewhere'], exclusions: [], repositories: [] },
      projectHookConditions: [],
      generatedAt: '2026-09-11T00:00:00.000Z',
    });

    expect(document.installation.state).toBe('READY');
    expect(document.projects?.[0]).toMatchObject({
      projectId: project.projectId,
      identityFile: null,
      summary: {
        state: 'LIMITED',
        reasons: ['This project is not connected.'],
        actions: ['mnemonik add /work/acme'],
      },
    });
  });

  it('applies a deliberate scanner omission to installation and covered project', () => {
    const document = buildStatusDocument({
      installationConditions: [
        { kind: 'scanner_omitted', reason: 'Scanner was deliberately omitted.' },
      ],
      projectStatus: project,
      scannerStatus: { roots: ['/work'], exclusions: [], repositories: [] },
      projectHookConditions: [],
      generatedAt: '2026-09-11T00:00:00.000Z',
    });

    expect(document.installation.state).toBe('LIMITED');
    expect(document.projects?.[0]?.summary).toEqual({
      state: 'LIMITED',
      reasons: ['Background indexing was deliberately omitted for this installation.'],
      actions: ['mnemonik add /work/acme'],
    });
  });

  it('keeps a READY project independent of a failed installation', () => {
    const document = buildStatusDocument({
      installationConditions: [
        { kind: 'selected_component_failed', reason: 'The selected scanner service failed.' },
      ],
      projectStatus: project,
      scannerStatus: { roots: ['/work'], exclusions: [], repositories: [] },
      projectHookConditions: [],
      generatedAt: '2026-09-11T00:00:00.000Z',
    });

    expect(document.installation.state).toBe('FAILED');
    expect(document.projects?.[0]?.summary).toEqual({ state: 'READY', reasons: [], actions: [] });
  });

  it('renders labelled sentences and treats absent scanner and hook probes as LIMITED', () => {
    const lines: string[] = [];
    const output = { line: (value = '') => lines.push(value) };
    const withProject = buildStatusDocument({
      installationConditions: [],
      projectStatus: project,
      scannerStatus: { roots: ['/work'], exclusions: [], repositories: [] },
      projectHookConditions: [],
      generatedAt: '2026-09-11T00:00:00.000Z',
    });
    renderStatusSummaries(withProject, output);
    expect(lines).toEqual([
      'Mnemonik is installed and working.',
      'Connected: work',
      'This project: Done.',
    ]);

    lines.length = 0;
    renderStatusSummaries(
      buildStatusDocument({
        installationConditions: [],
        configuredHosts: ['codex'],
        generatedAt: '2026-09-11T00:00:00.000Z',
      }),
      output
    );
    expect(lines).toEqual([
      'Installation: Needs attention.',
      'The scanner has not checked in yet.',
      'Run mnemonik status on this machine after the scanner starts.',
      'Mnemonik has not received context from an editor hook yet.',
      'Start a new editor session, then run mnemonik status.',
    ]);
  });
});

it('hides launcher paths, credential diagnostics and readiness reason codes', () => {
  const lines: string[] = [];
  const document = buildStatusDocument({
    installationConditions: [
      { kind: 'login_pending', reason: 'host_grant_unbound' },
      {
        kind: 'future_readiness_code' as ReadinessCondition['kind'],
        reason: 'future_readiness_code',
      },
    ],
    scannerStatus: { roots: [], exclusions: [], repositories: [] },
    projectHookConditions: [],
  });
  renderStatusSummaries(
    {
      ...document,
      cliCredential: {
        store: 'file',
        present: true,
        diagnostics: ['os_store_unavailable'],
      },
      launcher: {
        path: '/home/dev/.local/bin/mnemonik',
        directory: '/home/dev/.local/bin',
        ownership: 'not_ours',
        onPath: false,
        action:
          'Move the existing /home/dev/.local/bin/mnemonik aside yourself, then run npx -y @mnemonik/cli@latest install.',
      },
    },
    { line: (line = '') => lines.push(line) }
  );

  expect(lines).toContain('An editor is signed out of Mnemonik on this machine.');
  expect(lines).toContain('Sign in to Mnemonik from that editor to restore context.');
  expect(lines).toContain('This machine needs attention before Mnemonik can work fully.');
  expect(document.installation.reasons).toEqual(['host_grant_unbound', 'future_readiness_code']);
  expect(lines.join('\n')).not.toMatch(
    /\/home\/dev|CLI credential|Launcher:|host_grant_unbound|future_readiness_code|os_store_unavailable/u
  );
});

it('says Codex has not trusted the hooks without promising a prompt', () => {
  const lines: string[] = [];
  const action =
    'Run the codex command in a terminal and use its hook trust prompt to allow the Mnemonik hooks; then quit and reopen Codex.';
  renderStatusSummaries(
    buildStatusDocument({
      installationConditions: [
        { kind: 'host_trust_pending', reason: 'codex_trust_pending', action },
      ],
      scannerStatus: { roots: [], exclusions: [], repositories: [] },
      projectHookConditions: [],
    }),
    { line: (line = '') => lines.push(line) }
  );

  expect(lines).toEqual([
    'Installation: Needs attention.',
    'Codex has not trusted the Mnemonik hooks yet.',
    'Open Codex settings, trust the Mnemonik hooks, then quit and reopen Codex.',
  ]);
  expect(lines.join('\n')).not.toMatch(/allow the .*hooks|will ask/u);
});

it('keeps installed hooks READY before an editor has signed in', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Readable } = await import('node:stream');
  const { collectStatusDocument } = await import('../src/status.js');
  const stateDir = await mkdtemp(join(tmpdir(), 'unsigned-editor-status-'));
  try {
    await writeFile(
      join(stateDir, 'host-ownership.json'),
      JSON.stringify({
        schemaVersion: 1,
        generation: 0,
        targets: [
          {
            id: 'codex-hooks',
            host: 'codex',
            component: 'hooks',
            profilePath: '/unused',
            files: [],
          },
        ],
      })
    );
    const grants = {
      list: async () => {
        throw new Error('editor grants must not be read');
      },
    };
    const document = await collectStatusDocument({
      stateDir,
      grants,
      cwd: stateDir,
      input: Readable.from(''),
      preflight: {
        status: 'ready',
        node: { supported: true, version: '24' },
        os: 'Linux',
        hosts: [],
        project: { resolution: 'absent' },
        network: { reachable: true, discoveryUrl: '' },
      },
      scannerStatus: async () => ({ roots: [], exclusions: [], repositories: [] }),
      projectHookConditions: [],
    });
    expect(document.installation).toEqual({ state: 'READY', reasons: [], actions: [] });
    const lines: string[] = [];
    renderStatusSummaries(document, { line: (line = '') => lines.push(line) });
    expect(lines.join('\n').toLowerCase()).not.toMatch(/unbound|reconnect|connect/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

it.each([
  ['Grok', 'grok', '.grok'],
  ['Copilot', 'vscode-copilot', '.copilot'],
])('status and doctor ignore hooks left by an earlier %s install', async (name, host, dir) => {
  const { mkdir, mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { runCli } = await import('../src/router.js');
  const stateDir = await mkdtemp(join(tmpdir(), `legacy-${host}-status-`));
  try {
    await mkdir(join(stateDir, dir, 'hooks'), { recursive: true });
    await writeFile(join(stateDir, dir, 'hooks', 'hooks.json'), '{"mnemonik":"legacy"}\n');
    await writeFile(
      join(stateDir, 'host-ownership.json'),
      JSON.stringify({
        schemaVersion: 1,
        generation: 0,
        targets: [
          {
            id: `${host}:hooks:user`,
            host,
            component: 'hooks',
            scope: 'user',
            home: stateDir,
            profilePath: join(stateDir, dir, 'hooks', 'hooks.json'),
            version: '0.1.49',
            artifactDigest: 'legacy',
            runtimePointer: join(stateDir, 'runtimes', host, 'current'),
            files: [],
          },
        ],
      })
    );
    const preflight = {
      nodeVersion: '24.21.0',
      pathExists: async () => false,
      fetch: async () => Response.json({}),
      resolveIdentity: async () => ({ kind: 'git_unavailable' as const, detail: 'fixture' }),
    };
    let status = '';
    expect(
      await runCli(['status', '--json'], {
        home: stateDir,
        installStateDir: stateDir,
        preflight,
        scannerStatus: async () => ({ roots: [], exclusions: [], repositories: [] }),
        stdout: { write: (chunk) => void (status += chunk) },
      })
    ).toBe(1);
    expect(JSON.parse(status).versions.hosts).toEqual([]);
    expect(status.toLowerCase()).not.toContain(name.toLowerCase());

    status = '';
    expect(
      await runCli(['status'], {
        home: stateDir,
        installStateDir: stateDir,
        preflight,
        scannerStatus: async () => ({ roots: [], exclusions: [], repositories: [] }),
        stdout: { write: (chunk) => void (status += chunk) },
      })
    ).toBe(1);
    expect(status.toLowerCase()).not.toContain(name.toLowerCase());

    let doctor = '';
    expect(
      await runCli(['doctor'], {
        home: stateDir,
        installStateDir: stateDir,
        preflight,
        scannerStatus: async () => ({ roots: [], exclusions: [], repositories: [] }),
        stdout: { write: (chunk) => void (doctor += chunk) },
      })
    ).toBe(0);
    expect(doctor.toLowerCase()).not.toContain(name.toLowerCase());

    doctor = '';
    expect(
      await runCli(['doctor', '--json'], {
        home: stateDir,
        installStateDir: stateDir,
        preflight,
        scannerStatus: async () => ({ roots: [], exclusions: [], repositories: [] }),
        stdout: { write: (chunk) => void (doctor += chunk) },
      })
    ).toBe(0);
    expect(doctor.toLowerCase()).not.toContain(name.toLowerCase());
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

it('lists connected folder names without searching the discovery folder', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Readable } = await import('node:stream');
  const { collectStatusDocument } = await import('../src/status.js');
  const stateDir = await mkdtemp(join(tmpdir(), 'connected-projects-status-'));
  try {
    const roots = Array.from({ length: 10 }, (_, index) =>
      join(stateDir, `repo-${String(index + 1).padStart(3, '0')}`)
    );
    const document = await collectStatusDocument({
      stateDir,
      cwd: stateDir,
      input: Readable.from(''),
      scannerStatus: async () => ({ roots, exclusions: [], repositories: [] }),
      preflight: {
        status: 'ready',
        node: { supported: true, version: '24' },
        os: 'Linux',
        hosts: [],
        project: { resolution: 'absent' },
        network: { reachable: true, discoveryUrl: '' },
      },
      projectHookConditions: [],
    });
    expect(document).not.toHaveProperty('foundRepositories');
    const lines: string[] = [];
    renderStatusSummaries(document, { line: (line = '') => lines.push(line) });
    expect(lines).toContain(
      'Connected: repo-001, repo-002, repo-003, repo-004, repo-005, repo-006, repo-007, repo-008, and 2 more'
    );
    expect(lines.join('\n')).not.toContain(stateDir);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

it('checks only installed hook targets when other editors are present', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Readable } = await import('node:stream');
  const { collectStatusDocument } = await import('../src/status.js');
  const stateDir = await mkdtemp(join(tmpdir(), 'selected-host-status-'));
  try {
    await writeFile(
      join(stateDir, 'host-ownership.json'),
      JSON.stringify({
        schemaVersion: 1,
        generation: 0,
        targets: [
          {
            id: 'codex-hooks',
            host: 'codex',
            component: 'hooks',
            profilePath: '/unused',
            files: [],
          },
        ],
      })
    );
    const result = await collectStatusDocument({
      stateDir,
      cwd: stateDir,
      input: Readable.from(''),
      preflight: {
        status: 'ready',
        node: { supported: true, version: '24' },
        os: 'Windows',
        hosts: [],
        project: { resolution: 'absent' },
        network: { reachable: true, discoveryUrl: '' },
      },
      scannerStatus: async () => ({ roots: [], exclusions: [], repositories: [] }),
    });
    expect(result.installation.reasons).toEqual([
      'codex hook configuration could not be inspected.',
    ]);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

it.each(['starting', 'running'])(
  'accepts a fresh heartbeat from a live %s scanner',
  async (state) => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { Readable } = await import('node:stream');
    const { collectStatusDocument } = await import('../src/status.js');
    const stateDir = await mkdtemp(join(tmpdir(), 'scanner-start-status-'));
    try {
      await mkdir(join(stateDir, 'scanner'));
      await writeFile(
        join(stateDir, 'scanner/state.json'),
        JSON.stringify({ devReleaseSource: true, config: { roots: [stateDir] } })
      );
      await writeFile(
        join(stateDir, 'scanner/status.json'),
        JSON.stringify({
          recordedAt: Date.now(),
          snapshot: {
            version: 'win.40',
            lifecycle: { state, reason: 'start_requested', pid: process.pid, pauseIntervals: [] },
            heartbeat: { lastSuccess: Date.now() },
          },
        })
      );
      const result = await collectStatusDocument({
        stateDir,
        cwd: stateDir,
        input: Readable.from(''),
        preflight: {
          status: 'ready',
          node: { supported: true, version: '24' },
          os: 'Windows',
          hosts: [],
          project: { resolution: 'absent' },
          network: { reachable: true, discoveryUrl: '' },
        },
        projectHookConditions: [],
      });
      expect(result.installation.reasons).toEqual(['dev_release_source']);
      expect(result.installation.actions).toEqual([]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  }
);

const localFixtures: string[] = [];
afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  vi.unstubAllGlobals();
  for (const path of localFixtures.splice(0)) await rm(path, { recursive: true, force: true });
});

/**
 * A machine as status finds it: a real home, a real project folder and real
 * files, so the editor judgement is made from evidence rather than fixtures.
 */
async function localMachine() {
  const { enableHostDiscovery } = await import('./setup/hostDiscovery.js');
  // Preflight must really see ~/.codex and the project's .cursor folder; the
  // point of these cases is that finding them is not a reason to judge them.
  await enableHostDiscovery();
  const { mkdir, mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { dirname, join } = await import('node:path');
  const { runCli } = await import('../src/router.js');
  const home = await mkdtemp(join(tmpdir(), 'local-status-'));
  localFixtures.push(home);
  const stateDir = join(home, 'state');
  const cwd = join(home, 'project');
  await mkdir(cwd, { recursive: true });
  const put = async (path: string, value: unknown) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const hookEntry = join(home, 'hook.js');
  const hooksFile = (host: string, target = hookEntry) => ({
    hooks: {
      start: [{ command: `node ${JSON.stringify(target)} --mnemonik-owner=${host}-hooks` }],
    },
  });
  const invoke = async (command = 'status', extra: Partial<CliDependencies> = {}) => {
    let text = '';
    const code = await runCli([command], {
      home,
      cwd,
      installStateDir: stateDir,
      stdout: { write: (value) => void (text += value) },
      preflight: {
        nodeVersion: '24.21.0',
        resolveIdentity: async () => ({ kind: 'git_unavailable', detail: 'fixture' }),
      },
      scannerStatus: async () => ({ roots: [], exclusions: [], repositories: [] }),
      ...extra,
    });
    return { code, text };
  };
  return { home, stateDir, cwd, put, hookEntry, hooksFile, invoke };
}

/** Claude Code alone, in a repository that merely contains another editor's folder. */
async function claudeCodeOnly() {
  const { join } = await import('node:path');
  const { ensureLauncher } = await import('../src/launcher.js');
  const machine = await localMachine();
  await machine.put(machine.hookEntry, '// hook');
  await machine.put(join(machine.home, '.claude/settings.json'), machine.hooksFile('claude-code'));
  await machine.put(join(machine.home, '.claude.json'), {
    mcpServers: { mnemonik: { type: 'http' } },
  });
  // Codex is installed on this machine but was never chosen for Mnemonik.
  await machine.put(join(machine.home, '.codex/config.toml'), 'model = "gpt-5"\n');
  // The repository carries a Cursor folder; nobody set Cursor up.
  await machine.put(join(machine.cwd, '.cursor/rules/team.mdc'), '# rules\n');
  await ensureLauncher({ home: machine.home, stateDir: machine.stateDir });
  return machine;
}

it('reads as working with one editor set up beside editors nobody chose', async () => {
  const machine = await claudeCodeOnly();
  expect(await machine.invoke()).toMatchObject({
    code: 0,
    text: expect.stringContaining('Mnemonik is installed and working.'),
  });
  const repair = await machine.invoke('repair');
  expect(repair.code).toBe(0);
  expect(repair.text).not.toMatch(/Cursor|Codex/u);
}, 15_000);

it('keeps the same verdict and words when the network cannot be reached', async () => {
  const machine = await claudeCodeOnly();
  const reached: string[] = [];
  vi.stubGlobal('fetch', async (input: unknown) => {
    reached.push(new URL(String(input)).pathname);
    throw new Error('network unreachable');
  });
  const offline = await machine.invoke('status', {
    cliAuth: {
      signIn: async () => undefined,
      getCliBearer: async () => 'access-token',
      logout: async () => undefined,
    },
    grantFetch: async (input) => {
      reached.push(new URL(String(input)).pathname);
      throw new Error('network unreachable');
    },
  });
  expect(offline).toMatchObject({
    code: 0,
    text: expect.stringContaining('Mnemonik is installed and working.'),
  });
  expect(offline.text).not.toContain('could not be uploaded');
  // The readiness upload is the only authenticated call status makes: no
  // credential rotation, no grant listing, no server verification.
  expect(reached.filter((path) => path !== '/api/v1/installations/current/readiness')).toEqual([
    '/%40mnemonik%2Fcli/latest',
  ]);
  // A reachable network reaches exactly the same verdict, word for word.
  vi.stubGlobal('fetch', async () => Response.json({}));
  const online = await machine.invoke('status', {
    cliAuth: {
      signIn: async () => undefined,
      getCliBearer: async () => 'access-token',
      logout: async () => undefined,
    },
    grantFetch: async () => Response.json({ status: 'recorded' }),
  });
  expect(online.code).toBe(offline.code);
  expect(online.text).toBe(offline.text);
}, 20_000);

it('reports a hook entry whose launcher is gone', async () => {
  const { join } = await import('node:path');
  const machine = await claudeCodeOnly();
  await machine.put(
    join(machine.home, '.claude/settings.json'),
    machine.hooksFile('claude-code', join(machine.home, 'removed-hook.js'))
  );
  const result = await machine.invoke();
  expect(result.code).toBe(1);
  expect(result.text).toContain('Claude Code hooks are missing.');
  expect(result.text).toContain('Run mnemonik install to set them up again.');
}, 15_000);

it('reports a Codex connection turned off with an action a person can take', async () => {
  const { join } = await import('node:path');
  const machine = await claudeCodeOnly();
  await machine.put(
    join(machine.home, '.codex/config.toml'),
    '[mcp_servers.mnemonik]\nenabled = false\n'
  );
  await machine.put(join(machine.home, '.codex/hooks.json'), machine.hooksFile('codex'));
  const result = await machine.invoke();
  expect(result.code).toBe(1);
  expect(result.text).toContain('Codex connection is turned off.');
  expect(result.text).toContain('Open ~/.codex/config.toml, find mnemonik and set enabled = true.');
  expect(result.text).not.toContain('codex mcp enable');
}, 15_000);

it('reports Codex hooks that Codex has not trusted', async () => {
  const machine = await claudeCodeOnly();
  const result = await machine.invoke('status', {
    codexTrustConditions: async () => [
      { kind: 'host_trust_pending', reason: 'codex_trust_pending', component: 'codex' },
    ],
  });
  expect(result.code).not.toBe(0);
  expect(result.text).not.toContain('Mnemonik is installed and working.');
  expect(result.text).toContain('Codex has not trusted the Mnemonik hooks yet.');
  expect(result.text).toContain(
    'Open Codex settings, trust the Mnemonik hooks, then quit and reopen Codex.'
  );
}, 15_000);

it('reports default editor files locally, including a disabled Cursor connection', async () => {
  const { join } = await import('node:path');
  const { ensureLauncher } = await import('../src/launcher.js');
  const machine = await localMachine();
  await machine.put(machine.hookEntry, '// hook');
  for (const [host, file] of [
    ['claude-code', '.claude/settings.json'],
    ['codex', '.codex/hooks.json'],
    ['cursor', '.cursor/hooks.json'],
  ] as const)
    await machine.put(join(machine.home, file), machine.hooksFile(host));
  await machine.put(join(machine.home, '.claude.json'), {
    mcpServers: { mnemonik: { type: 'http' } },
  });
  await machine.put(
    join(machine.home, '.codex/config.toml'),
    '[mcp_servers.mnemonik]\nenabled = true\n'
  );
  await machine.put(join(machine.home, '.cursor/mcp.json'), { mcpServers: { mnemonik: {} } });
  await ensureLauncher({ home: machine.home, stateDir: machine.stateDir });

  expect(await machine.invoke()).toMatchObject({
    code: 0,
    text: expect.stringContaining('Mnemonik is installed and working.'),
  });
  expect(await machine.invoke('repair')).toMatchObject({
    code: 0,
    text: expect.stringContaining('Mnemonik is installed and working.'),
  });

  await machine.put(join(machine.home, '.cursor/mcp.json'), {
    mcpServers: { mnemonik: { disabled: true } },
  });
  expect(await machine.invoke()).toMatchObject({
    code: 1,
    text: expect.stringContaining('Cursor connection is turned off.'),
  });
  expect(await machine.invoke('repair')).toMatchObject({
    code: 1,
    text: expect.stringContaining('Cursor connection is turned off.'),
  });
}, 20_000);

it.each(['duplicate_project_id', 'fingerprint_mismatch'])(
  'maps installer %s diagnostics to human status text while preserving JSON',
  (state) => {
    const reason = `project_setup_required: ${state}: /home/alice/projects/a-copy`;
    const document = buildStatusDocument({
      installationConditions: [{ kind: 'project_identity_choice_pending', reason }],
      scannerStatus: { roots: [], exclusions: [], repositories: [] },
      projectHookConditions: [],
    });
    const lines: string[] = [];
    renderStatusSummaries(document, { line: (line = '') => lines.push(line) });
    expect(lines).toContain('A project on this machine still needs to be connected.');
    expect(lines.join('\n')).not.toMatch(
      /project_setup_required|duplicate_project_id|fingerprint_mismatch|\/home\/alice/
    );
    expect(JSON.parse(JSON.stringify(document)).installation.reasons).toEqual([reason]);
  }
);
