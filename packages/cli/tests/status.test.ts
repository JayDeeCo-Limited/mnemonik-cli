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
      'Wait a minute for indexing to start.',
      'Mnemonik has not received context from an editor hook yet.',
      'Start a new session in that editor.',
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
  // A code with no words says a failure plainly; the old catch-all sentence is gone.
  expect(lines).not.toContain('This machine needs attention before Mnemonik can work fully.');
  expect(lines).toEqual([
    'Installation: Needs attention.',
    'An editor is signed out of Mnemonik on this machine.',
    'Sign in to Mnemonik from that editor to restore context.',
    'Mnemonik stopped before it finished.',
    'Run mnemonik repair.',
  ]);
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

it('a rolled-back automatic Mac update remains visible while the old scanner is healthy', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Readable } = await import('node:stream');
  const { collectStatusDocument } = await import('../src/status.js');
  const stateDir = await mkdtemp(join(tmpdir(), 'scanner-update-status-'));
  try {
    await mkdir(join(stateDir, 'scanner/service-replacement'), { recursive: true });
    await writeFile(
      join(stateDir, 'scanner/service-replacement/result.json'),
      JSON.stringify({ fallback: true, pid: process.pid, startedAt: Date.now() - 100 })
    );
    const options = {
      stateDir,
      cwd: stateDir,
      input: Readable.from(''),
      preflight: {
        status: 'ready' as const,
        node: { supported: true, version: '24' },
        os: 'macOS',
        hosts: [],
        project: { resolution: 'absent' as const },
        network: { reachable: true, discoveryUrl: '' },
      },
      scannerStatus: async () => ({ roots: [stateDir], exclusions: [], repositories: [] }),
      projectHookConditions: [],
    };
    await writeFile(
      join(stateDir, 'scanner/status.json'),
      JSON.stringify({
        recordedAt: Date.now(),
        snapshot: {
          lifecycle: { pid: process.pid, state: 'running' },
          heartbeat: { lastSuccess: Date.now() },
        },
      })
    );
    const failed = await collectStatusDocument(options);
    expect(failed.installation).toMatchObject({
      state: 'FAILED',
      reasons: ['scanner_replacement_rolled_back'],
      actions: ['Run mnemonik install to try again.'],
    });
    const lines: string[] = [];
    renderStatusSummaries(failed, {
      line: (value = '') => {
        lines.push(value);
        return 1;
      },
    });
    expect(lines).toContain('Background indexing went back to the previous version.');
    expect(lines).toContain('Run mnemonik install to try again.');
    expect(lines).not.toContain('This machine needs attention before Mnemonik can work fully.');
    const restoredAt = Date.now();
    await writeFile(
      join(stateDir, 'scanner/service-replacement/result.json'),
      JSON.stringify({
        fallback: true,
        pid: process.pid,
        startedAt: restoredAt - 100,
      })
    );
    await writeFile(
      join(stateDir, 'scanner/status.json'),
      JSON.stringify({
        recordedAt: restoredAt,
        snapshot: {
          lifecycle: { pid: process.pid, state: 'running' },
          heartbeat: { lastSuccess: restoredAt },
        },
      })
    );
    expect((await collectStatusDocument(options)).installation).toEqual(failed.installation);
    await writeFile(
      join(stateDir, 'scanner/service-replacement/result.json'),
      JSON.stringify({ pid: process.pid, startedAt: restoredAt - 100 })
    );
    const recovered = await collectStatusDocument(options);
    expect(recovered.installation.reasons).not.toContain(
      'Background indexing could not be started.'
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

it.each([
  {
    name: 'automatic legacy Mac update needs permission while its old scanner remains healthy',
    receipt: { authorizationRequired: true },
    reason: 'mac_authorization_required',
    sentence: 'Mnemonik needs your Mac password to set up background indexing.',
    action: 'Run mnemonik install in a terminal and enter your Mac password.',
  },
  {
    name: 'scanner is still within its startup window',
    receipt: { pid: process.pid, startedAt: Date.now() },
    reason: 'scanner_replacement_pending',
    sentence: 'Background indexing is restarting with a new version.',
    action: 'Wait a minute, then check again.',
  },
  {
    name: 'first install failed without any previous scanner',
    receipt: {
      candidateError: 'ENOENT',
      fallbackError: 'scanner_fallback_missing',
    },
    reason: 'scanner_replacement_candidate_failed',
    sentence: 'Background indexing could not be started.',
    action: 'Run mnemonik install to try again.',
  },
  {
    name: 'both versions failed',
    receipt: {
      candidateError: 'candidate_spawn_EACCES',
      fallbackError: 'fallback_spawn_ENOEXEC',
    },
    reason: 'scanner_replacement_failed',
    sentence:
      'Background indexing could not be started. Mnemonik tried the new version and the last working one.',
    action: 'Run mnemonik install to try again.',
  },
  {
    name: 'both versions failed without disk space',
    receipt: {
      candidateError: 'candidate_spawn_ENOSPC',
      fallbackError: 'fallback_spawn_ENOSPC',
    },
    reason: 'scanner_replacement_failed',
    sentence:
      'Background indexing could not be started. Mnemonik tried the new version and the last working one.',
    action: 'Free disk space on this computer, then run mnemonik install.',
  },
  {
    name: 'a deliberate stop is not an interrupted replacement',
    receipt: { stopped: true },
    reason: 'scanner_stopped',
    sentence: 'Background indexing is stopped on this computer.',
    action: 'Run mnemonik scanner start and enter your Mac password to start it again.',
  },
  {
    name: 'startup is overdue even if its PID is reused',
    receipt: { pid: process.pid, startedAt: 1 },
    reason: 'scanner_replacement_interrupted',
    sentence: 'Background indexing could not be started.',
    action: 'Run mnemonik install to try again.',
  },
])(
  'real status names $name and provides an SSH recovery action',
  async ({ receipt, reason, sentence, action }) => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { Readable } = await import('node:stream');
    const { collectStatusDocument } = await import('../src/status.js');
    const stateDir = await mkdtemp(join(tmpdir(), 'scanner-recovery-status-'));
    try {
      const directory = join(stateDir, 'scanner/service-replacement');
      await mkdir(directory, { recursive: true });
      if (receipt) await writeFile(join(directory, 'result.json'), JSON.stringify(receipt));
      const result = await collectStatusDocument({
        stateDir,
        cwd: stateDir,
        input: Readable.from(''),
        preflight: {
          status: 'ready',
          node: { supported: true, version: '24' },
          os: 'macOS',
          hosts: [],
          project: { resolution: 'absent' },
          network: { reachable: true, discoveryUrl: '' },
        },
        projectHookConditions: [],
        ...(reason === 'mac_authorization_required'
          ? { scannerStatus: async () => ({ roots: [stateDir], exclusions: [], repositories: [] }) }
          : {}),
      });
      expect(result.installation.state).toBe(
        reason === 'mac_authorization_required'
          ? 'ACTION_REQUIRED'
          : reason === 'scanner_replacement_pending' || reason === 'scanner_stopped'
            ? 'LIMITED'
            : 'FAILED'
      );
      expect(result.installation.reasons).toEqual([expect.stringContaining(reason)]);
      if (receipt && 'candidateError' in receipt) {
        expect(result.installation.reasons[0]).toContain(receipt.candidateError);
        expect(result.installation.reasons[0]).toContain(receipt.fallbackError);
      }
      const lines: string[] = [];
      renderStatusSummaries(result, {
        line: (line = '') => {
          lines.push(line);
          return 1;
        },
      });
      expect(lines.join('\n')).toContain(sentence);
      expect(lines.join('\n')).toContain(action);
      expect(lines.join('\n')).not.toContain('The scanner has not checked in yet.');
      expect(lines.join('\n')).not.toContain('after the scanner starts');
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  }
);

it.each(['candidate', 'fallback', 'stale-readiness', 'wrong-pid', 'stale-receipt'])(
  'offline local readiness gives truthful update status: %s',
  async (mode) => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { Readable } = await import('node:stream');
    const { collectStatusDocument } = await import('../src/status.js');
    const stateDir = await mkdtemp(join(tmpdir(), 'scanner-local-ready-status-'));
    try {
      const now = Date.now();
      const startedAt = now - 200000;
      await mkdir(join(stateDir, 'scanner/service-replacement'), { recursive: true });
      await writeFile(
        join(stateDir, 'scanner/service-replacement/result.json'),
        JSON.stringify({
          pid: process.pid,
          startedAt,
          fallback: mode === 'fallback',
        })
      );
      await writeFile(
        join(stateDir, 'scanner/state.json'),
        JSON.stringify({ config: { roots: [] } })
      );
      await writeFile(
        join(stateDir, 'scanner/status.json'),
        JSON.stringify({
          recordedAt: mode === 'stale-receipt' ? startedAt - 1 : now,
          snapshot: {
            lifecycle: {
              state: 'starting',
              pid: mode === 'wrong-pid' ? process.pid + 1 : process.pid,
            },
            startupTimings: {
              localReadyAt: mode === 'stale-readiness' ? startedAt - 1 : startedAt + 1,
            },
            heartbeat: { lastSuccess: null },
          },
        })
      );
      const document = await collectStatusDocument({
        stateDir,
        cwd: stateDir,
        input: Readable.from(''),
        projectHookConditions: [],
        scannerRecovery: { platform: 'linux' },
        preflight: {
          status: 'ready',
          node: { supported: true, version: '24' },
          os: 'macOS',
          hosts: [],
          project: { resolution: 'absent' },
          network: { reachable: false, discoveryUrl: '' },
        },
      });
      if (mode === 'candidate') {
        expect(
          document.installation.reasons.some((reason) => reason.startsWith('scanner_replacement_'))
        ).toBe(false);
        expect(document.installation.state).not.toBe('READY');
      } else if (mode === 'fallback') {
        const lines: string[] = [];
        renderStatusSummaries(document, {
          line: (line = '') => {
            lines.push(line);
            return 1;
          },
        });
        expect(lines).toContain('Background indexing went back to the previous version.');
        expect(lines).toContain('Run mnemonik install to try again.');
        expect(document.installation.reasons).not.toContain('scanner_replacement_interrupted');
      } else expect(document.installation.reasons).toContain('scanner_replacement_interrupted');
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  }
);

it('a state with nothing to do about it says so on one line', () => {
  const document = buildStatusDocument({
    installationConditions: [
      { kind: 'selected_component_failed', component: 'scanner', reason: 'scanner_other_account' },
    ],
    scannerStatus: { roots: [], exclusions: [], repositories: [] },
    projectHookConditions: [],
  });
  const lines: string[] = [];
  renderStatusSummaries(document, { line: (line = '') => lines.push(line) });
  const sentence = 'Background indexing is already set up for another account on this Mac.';
  expect(lines).toContain(sentence);
  expect(lines[lines.indexOf(sentence) + 1]).not.toBe('');
});

it('says the machine lines only from a folder that is not a project', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Readable } = await import('node:stream');
  const { collectStatusDocument } = await import('../src/status.js');
  const stateDir = await mkdtemp(join(tmpdir(), 'root-folder-status-'));
  try {
    const document = await collectStatusDocument({
      stateDir,
      cwd: stateDir,
      input: Readable.from(''),
      executor: {
        stage: async () => {
          throw new Error('a folder that is not a project must not be read as one');
        },
      } as never,
      preflight: {
        status: 'ready',
        node: { supported: true, version: '24' },
        os: 'Linux',
        hosts: [],
        // What a root projects folder resolves to: a folder, with no project file.
        project: { root: stateDir, resolution: 'absent' },
        network: { reachable: true, discoveryUrl: '' },
      },
      scannerStatus: async () => ({
        roots: ['/work/beta', '/work/Alpha'],
        exclusions: [],
        repositories: [],
      }),
      projectHookConditions: [],
    });
    expect(document.projects).toBeUndefined();
    const lines: string[] = [];
    renderStatusSummaries(document, { line: (line = '') => lines.push(line) });
    expect(lines).toEqual(['Mnemonik is installed and working.', 'Connected: Alpha, beta']);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

it('lists each connected project once, in alphabetical order', () => {
  const lines: string[] = [];
  renderStatusSummaries(
    buildStatusDocument({
      installationConditions: [],
      scannerStatus: {
        roots: ['/a/dokploy-mcp-server', '/b/dokploy-mcp-server', '/c/Bolt', '/d/apples'],
        exclusions: [],
        repositories: [],
      },
      projectHookConditions: [],
    }),
    { line: (line = '') => lines.push(line) }
  );
  expect(lines).toContain('Connected: apples, Bolt, dokploy-mcp-server');
});

it('says nothing about indexing once the scanner has reported', () => {
  const reported = buildStatusDocument({
    installationConditions: [],
    scannerReported: true,
    projectHookConditions: [],
  });
  expect(reported.installation).toEqual({ state: 'READY', reasons: [], actions: [] });
  expect(reported.conditions).toEqual([]);
  const silent = buildStatusDocument({ installationConditions: [], projectHookConditions: [] });
  expect(silent.installation.actions).toEqual(['Run mnemonik status after indexing starts.']);
});

it('says nothing under a heading it cannot fill', () => {
  const lines: string[] = [];
  const hook: ReadinessCondition = {
    kind: 'hook_not_verified',
    component: 'codex',
    reason: 'hook_not_verified',
    action: 'Start a new session in that editor.',
  };
  // The same hook condition reaches both sections; the second copy is dropped.
  renderStatusSummaries(
    buildStatusDocument({
      installationConditions: [hook],
      projectStatus: project,
      scannerStatus: { roots: ['/work'], exclusions: [], repositories: [] },
      projectHookConditions: [hook],
    }),
    { line: (line = '') => lines.push(line) }
  );
  expect(lines).toEqual([
    'Installation: Needs attention.',
    'Mnemonik has not received context from an editor hook yet.',
    'Start a new session in that editor.',
    'Connected: work',
  ]);
  expect(lines).not.toContain('This project: Needs attention.');
});

it('keeps the line for a repository nobody has connected yet', () => {
  const lines: string[] = [];
  renderStatusSummaries(
    buildStatusDocument({
      installationConditions: [],
      projectStatus: { ...project, identity: 'absent', projectId: null },
      scannerStatus: { roots: ['/elsewhere'], exclusions: [], repositories: [] },
      projectHookConditions: [],
    }),
    { line: (line = '') => lines.push(line) }
  );
  expect(lines).toEqual([
    'Mnemonik is installed and working.',
    'Connected: elsewhere',
    'This project: Needs attention.',
    'This project is not connected.',
    'Run mnemonik add /work/acme.',
  ]);
});

it('keeps the words a condition wrote for a root that is gone', () => {
  const lines: string[] = [];
  renderStatusSummaries(
    buildStatusDocument({
      installationConditions: [],
      projectStatus: { ...project, reachability: 'unreachable' },
      scannerStatus: { roots: [], exclusions: [], repositories: [] },
      projectHookConditions: [],
    }),
    { line: (line = '') => lines.push(line) }
  );
  expect(lines).toContain('The recorded project root is unreachable.');
  expect(lines).toContain('Run mnemonik project status /work/acme.');
  expect(lines).not.toContain('Part of Mnemonik did not finish setting up.');
});

it('reports a repository that has never been connected', async () => {
  const { mkdtemp, mkdir, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Readable } = await import('node:stream');
  const { collectStatusDocument } = await import('../src/status.js');
  const stateDir = await mkdtemp(join(tmpdir(), 'unconnected-repo-status-'));
  try {
    await mkdir(join(stateDir, '.git'));
    const document = await collectStatusDocument({
      stateDir,
      cwd: stateDir,
      input: Readable.from(''),
      preflight: {
        status: 'ready',
        node: { supported: true, version: '24' },
        os: 'Linux',
        hosts: [],
        project: { root: stateDir, resolution: 'absent' },
        network: { reachable: true, discoveryUrl: '' },
      },
      scannerStatus: async () => ({ roots: [], exclusions: [], repositories: [] }),
      projectHookConditions: [],
    });
    expect(document.projects).toHaveLength(1);
    const lines: string[] = [];
    renderStatusSummaries(document, { line: (line = '') => lines.push(line) });
    expect(lines).toContain('This project: Needs attention.');
    expect(lines).toContain('This project is not connected.');
    expect(lines).toContain(`Run mnemonik add ${stateDir}.`);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

// L-74: every attention pair sends the person somewhere that helps. Drafted
// wording, pending the owner's approval.
describe('attention pairs name the right next step', () => {
  const render = (conditions: ReadinessCondition[]): string[] => {
    const lines: string[] = [];
    renderStatusSummaries(
      buildStatusDocument({
        installationConditions: conditions,
        scannerReported: true,
        projectHookConditions: [],
      }),
      { line: (value = '') => lines.push(value) }
    );
    return lines;
  };

  it('tells a person with a paused scanner to resume it, not to wait', () => {
    const lines = render([
      { kind: 'scanner_not_verified', reason: 'scanner_paused', action: 'mnemonik scanner resume' },
    ]);
    expect(lines).toEqual([
      'Installation: Needs attention.',
      'Background indexing is paused on this computer.',
      'Run mnemonik scanner resume to start it again.',
    ]);
  });

  it('does not send a person running status back to status after a scanner restart', () => {
    const lines = render([
      {
        kind: 'scanner_not_verified',
        component: 'scanner',
        reason: 'scanner_restart_requested',
        action: 'Wait a minute, then check again.',
      },
    ]);
    expect(lines).toEqual([
      'Installation: Needs attention.',
      'Background indexing stopped responding. Mnemonik restarted it.',
      'Wait a minute, then check again.',
    ]);
    expect(lines.join('\n')).not.toContain('mnemonik status');
  });

  it('names mnemonik add when the scanner watches no projects', () => {
    expect(render([{ kind: 'scanner_omitted', reason: 'scanner_omitted' }])).toEqual([
      'Installation: Needs attention.',
      'The scanner is not watching projects on this machine.',
      'Run mnemonik add <folder> for each project you want indexed.',
    ]);
  });

  it('names mnemonik add for a project outside the watched folders', () => {
    expect(render([{ kind: 'project_uncovered', reason: 'project_uncovered' }])).toEqual([
      'Installation: Needs attention.',
      'A connected project is outside the folders watched by the scanner.',
      "Run mnemonik add <folder> with that project's folder.",
    ]);
  });

  it('names mnemonik install when Windows could not create the background task', () => {
    expect(
      render([{ kind: 'selected_component_failed', reason: 'windows_task_creation_failed' }])
    ).toEqual([
      'Installation: Needs attention.',
      'Windows could not start the scanner in the background.',
      'Run mnemonik install again from a terminal with permission to create tasks.',
    ]);
  });
});
