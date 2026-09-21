import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseIdentityFile,
  readIdentityFile,
  resolveProjectIdentity,
  resolveRepositoryRoot,
} from '@mnemonik/shared';
import { runIdentityFixtureSuite } from '../../shared/test-fixtures/identity/runner.mjs';
import { nodeVersionHelp, renderPreflight, runPreflight } from '../src/preflight.js';
import { enableHostDiscovery } from './setup/hostDiscovery.js';
import { Output } from '../src/output.js';

const exec = promisify(execFile);
const dirs: string[] = [];
afterEach(async () =>
  Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
);

runIdentityFixtureSuite(it, {
  parse: parseIdentityFile,
  read: readIdentityFile,
  resolve: resolveProjectIdentity,
  resolveRoot: resolveRepositoryRoot,
});

describe('preflight', () => {
  it.each([
    ['darwin', 'Run: brew install node@24 && export PATH="$(brew --prefix node@24)/bin:$PATH"'],
    ['linux', 'Install Node 24: https://nodejs.org/en/download/package-manager'],
    ['win32', 'Install Node 24: https://nodejs.org/en/download'],
  ] as const)('gives a two-line Node gate for %s', (platform, action) => {
    expect(nodeVersionHelp('22.20.0', platform)).toEqual([
      'Node 22.20.0 is installed. Mnemonik needs Node 24 or newer.',
      action,
    ]);
  });

  it('ignores installed editor binaries when no host folder or config exists', async () => {
    const execFile = vi.fn(async () => {
      throw new Error('preflight must not spawn');
    });
    const result = await runPreflight({
      home: '/tmp/fresh-home',
      platform: 'linux',
      execFile,
      env: { PATH: '/tmp/vendor-bin' },
      binaryExists: async (file) =>
        ['/tmp/vendor-bin/claude', '/tmp/vendor-bin/codex', '/tmp/vendor-bin/cursor'].includes(
          file
        ),
      pathExists: async () => false,
      fetch: async () => Response.json({}),
    });
    expect(result.hosts).toEqual([]);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('uses the configured API resource origin for discovery', async () => {
    vi.stubEnv('MNEMONIK_API_RESOURCE', 'https://staging.example/mcp');
    try {
      const fetch = vi.fn(async () => new Response('{}'));
      const result = await runPreflight({
        cwd: '/tmp',
        pathExists: async () => false,
        execFile: async () => {
          throw Object.assign(new Error('not found'), { code: 'ENOENT' });
        },
        resolveIdentity: async () => ({
          kind: 'absent',
          root: '/tmp',
          repository: { kind: 'plain', root: '/tmp' },
          nested: [],
        }),
        fetch,
      });
      expect(result.network.discoveryUrl).toBe(
        'https://staging.example/.well-known/oauth-protected-resource'
      );
      expect(fetch).toHaveBeenCalledWith(
        result.network.discoveryUrl,
        expect.objectContaining({ method: 'GET' })
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('detects only the three launch editors when retired editors are also installed', async () => {
    // This test exercises the real file lookup against a home it owns; every
    // other test runs with discovery blinded by tests/setup/hostDiscovery.ts.
    await enableHostDiscovery();
    const base = await mkdtemp(
      join(process.platform === 'win32' ? tmpdir() : '/var/tmp', 'mnemonik-cli-preflight-')
    );
    dirs.push(base);
    const home = join(base, 'home');
    const root = join(base, 'repo');
    const files = [join(home, '.claude', 'settings.json'), join(home, '.codex', 'config.toml')];
    await Promise.all(
      files.map(async (file) => {
        await mkdir(join(file, '..'), { recursive: true });
        await writeFile(file, '{}');
      })
    );
    await mkdir(root, { recursive: true });
    await mkdir(join(root, '.cursor'), { recursive: true });
    await mkdir(join(root, '.grok'), { recursive: true });
    await mkdir(join(root, '.copilot'), { recursive: true });
    await exec('git', ['init', '--initial-branch=main'], {
      cwd: root,
      env: { ...process.env, GIT_CEILING_DIRECTORIES: base },
    });
    const priorCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = base;
    const result = await runPreflight({
      cwd: root,
      home,
      nodeVersion: '24.21.0',
      platform: 'linux',
      fetch: async () => new Response('{}', { status: 200 }),
    }).finally(() => {
      if (priorCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = priorCeiling;
    });
    expect(result.project).toEqual({ root, resolution: 'absent' });
    expect(result.hosts.map(({ name, supported }) => ({ name, supported }))).toEqual([
      { name: 'Claude Code', supported: true },
      { name: 'Codex', supported: true },
      { name: 'Cursor', supported: true },
    ]);
    let text = '';
    renderPreflight(result, new Output({ write: (chunk) => void (text += chunk) }));
    expect(text).not.toContain('VS Code Copilot');
    expect(text).not.toContain('Grok');
  });

  it('does exactly one discovery GET and reports an unsupported Node', async () => {
    const calls: Array<[string, string | undefined]> = [];
    const result = await runPreflight({
      cwd: '/tmp',
      home: '/tmp/home',
      nodeVersion: '23.1.0',
      resolveIdentity: async () => ({
        kind: 'absent',
        root: '/tmp',
        repository: { kind: 'plain', root: '/tmp' },
        nested: [],
      }),
      pathExists: async () => false,
      execFile: async () => {
        throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      },
      fetch: async (url, init) => {
        calls.push([String(url), init?.method]);
        return new Response('{}');
      },
    });
    expect(calls).toEqual([
      ['https://api.mnemonik.dev/.well-known/oauth-protected-resource', 'GET'],
    ]);
    expect(result).toMatchObject({ status: 'action_required', node: { supported: false } });
  });
});
