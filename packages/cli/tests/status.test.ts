import { describe, expect, it } from 'vitest';
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
        reasons: ['/work/acme is outside approved scanner roots.'],
        actions: ['mnemonik roots add /work/acme'],
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
      reasons: ['Scanner was deliberately omitted for this installation.'],
      actions: ['Run mnemonik scanner enable to add this project.'],
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
      'Installation: Done. Your editors will use Mnemonik on their next session.',
      'This project: Done. Your editors will use Mnemonik on their next session.',
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
      'Installation: Done, with 2 things left. scanner_not_verified. hook_not_verified. run mnemonik status after the scanner service starts run mnemonik status after the codex hook starts',
    ]);
  });
});

it('distinguishes an unbound host from a bound host that has not connected', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Readable } = await import('node:stream');
  const { collectStatusDocument } = await import('../src/status.js');
  const { grantTransport } = await import('../src/auth/status.js');
  const stateDir = await mkdtemp(join(tmpdir(), 'host-status-'));
  try {
    await writeFile(
      join(stateDir, 'host-ownership.json'),
      JSON.stringify({
        schemaVersion: 1,
        generation: 0,
        targets: [
          {
            id: 'target',
            host: 'codex',
            component: 'mcp',
            profilePath: '/unused',
            files: [],
            grant: { id: 'host', account: 'owner' },
          },
        ],
      })
    );
    let deviceInstallationId: string | null = null;
    let activatedAt: string | null = new Date().toISOString();
    let includeHostGrant = false;
    let renewed = false;
    let renewedInstallation: string | null = null;
    const grants = grantTransport(
      async () => 'token',
      async (_url, init) => {
        if (init?.method === 'POST') {
          renewedInstallation = 'machine-a';
          return Response.json({ id: 'renewed', deviceInstallationId: 'machine-a' });
        }
        return Response.json({
          account: 'owner',
          deviceInstallationId: 'machine-a',
          grants: [
            ...(includeHostGrant
              ? [
                  {
                    id: 'host',
                    clientId: 'https://chatgpt.com/oauth/codex/client.json',
                    clientName: null,
                    softwareId: null,
                    scopes: ['mcp:use'],
                    resource: 'https://api.mnemonik.dev/mcp',
                    createdAt: new Date().toISOString(),
                    activatedAt,
                    lastUsedAt: null,
                    deviceInstallationId,
                  },
                ]
              : []),
            ...(renewed
              ? [
                  {
                    id: 'cli',
                    clientId: 'cli',
                    clientName: null,
                    softwareId: null,
                    scopes: ['install:manage', 'components:manage'],
                    resource: 'https://api.mnemonik.dev/',
                    createdAt: '2026-01-01T00:00:00Z',
                    activatedAt: null,
                    lastUsedAt: null,
                    deviceInstallationId: 'machine-a',
                  },
                  {
                    id: 'renewed',
                    clientId: 'https://chatgpt.com/oauth/codex/client.json',
                    clientName: null,
                    softwareId: null,
                    scopes: ['mcp:use'],
                    resource: 'https://api.mnemonik.dev/mcp',
                    createdAt: new Date().toISOString(),
                    activatedAt: new Date().toISOString(),
                    lastUsedAt: null,
                    deviceInstallationId: renewedInstallation,
                  },
                ]
              : []),
          ],
        });
      }
    );
    const collect = () =>
      collectStatusDocument({
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
    expect((await collect()).installation).toEqual({
      state: 'LIMITED',
      reasons: ['codex: host_grant_unbound'],
      actions: ['mnemonik connect codex'],
    });
    includeHostGrant = true;
    deviceInstallationId = 'machine-b';
    expect((await collect()).installation.state).toBe('LIMITED');
    deviceInstallationId = 'machine-a';
    activatedAt = null;
    const notConnected = await collect();
    expect(notConnected.installation).toEqual({
      state: 'LIMITED',
      reasons: ['codex: signed in, not connected yet'],
      actions: ['open Codex and start a session, then run mnemonik status'],
    });
    const lines: string[] = [];
    renderStatusSummaries(notConnected, { line: (line = '') => lines.push(line) });
    expect(lines).toContain('codex: signed in, not connected yet');
    expect(lines.join('\n')).not.toContain('mnemonik connect codex');
    activatedAt = new Date().toISOString();
    const bound = await collect();
    expect(bound.installation.state).toBe('READY');
    expect(bound.devicesAndGrants?.[0]?.device).toBe('connected to this machine');
    renewed = true;
    const relinked = await collect();
    expect(renewedInstallation).toBe('machine-a');
    expect(relinked.devicesAndGrants?.find((g) => g.id === 'renewed')?.device).toBe(
      'connected to this machine'
    );
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
