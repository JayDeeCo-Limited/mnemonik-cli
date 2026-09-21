import { describe, expect, it } from 'vitest';
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

it('keeps a plain host-specific next step', () => {
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
    'Codex needs permission to use the Mnemonik hooks.',
    action,
  ]);
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
    ).toBe(0);
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
    ).toBe(0);
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
