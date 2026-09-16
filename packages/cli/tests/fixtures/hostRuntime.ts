import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hostOrder } from '../../src/install/adapters.js';
import {
  hostNpmSource,
  hash,
  type HostArtifact,
  type HostPackagePin,
  type RuntimeSource,
} from '../../src/runtime/store.js';
import type { HostDependencies, HostSelection } from '../../src/install/hosts.js';
import type { AccountGrant } from '../../src/auth/status.js';

export const FIXTURE_HOST_VERSIONS = {
  claude: '1.0.100 (Claude Code)',
  codex: 'codex-cli 0.145.0',
  cursor: '3.20.17',
  grok: 'grok 1.0.25 (f7e67d6988e2)',
} as const;
export async function packedHosts() {
  const root = await mkdtemp(join(tmpdir(), 'host-packs-'));
  const packs = new Map<string, { version: string; bytes: Buffer }>();
  for (const path of [
    ...hostOrder.map((h) => resolve('..', `${h}-hooks`)),
    resolve('../shared'),
    resolve('../credentials'),
    resolve('../local-setup'),
    ...['proper-lockfile', 'graceful-fs', 'retry', 'proper-lockfile/node_modules/signal-exit'].map(
      (name) => resolve('../../node_modules', name)
    ),
    resolve('../../node_modules/ignore'),
    resolve('../../node_modules/web-tree-sitter'),
  ]) {
    const pkg = JSON.parse(await readFile(join(path, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
    };
    const { stdout } = await promisify(execFile)('npm', [
      'pack',
      path,
      '--ignore-scripts',
      '--json',
      '--pack-destination',
      root,
    ]);
    const filename = (JSON.parse(stdout) as Array<{ filename: string }>)[0]!.filename;
    packs.set(pkg.name, { version: pkg.version, bytes: await readFile(join(root, filename)) });
  }
  const cli = JSON.parse(await readFile(resolve('../cli/package.json'), 'utf8')) as {
    mnemonik: { hosts: Record<HostArtifact, HostPackagePin> };
  };
  const pins = structuredClone(cli.mnemonik.hosts);
  for (const pin of Object.values(pins))
    for (const entry of pin.closure) {
      const pack = packs.get(entry.name)!;
      entry.integrity = `sha512-${createHash('sha512').update(pack.bytes).digest('base64')}`;
    }
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url.pathname);
    const tarball = url.pathname.endsWith('/archive.tgz');
    const encoded = url.pathname.slice(1).split('/')[0]!;
    const name = decodeURIComponent(encoded);
    const pack = packs.get(name);
    if (!pack) throw new Error(`unexpected_fixture_fetch: ${url}`);
    if (tarball) return new Response(new Uint8Array(pack.bytes));
    return Response.json({
      name,
      version: pack.version,
      dist: {
        integrity: `sha512-${createHash('sha512').update(pack.bytes).digest('base64')}`,
        tarball: `https://registry.npmjs.org/${encodeURIComponent(name)}/archive.tgz`,
      },
    });
  };
  const sources = Object.fromEntries(
    await Promise.all(
      hostOrder.map(async (host) => [host, await hostNpmSource(host, pins[host], fetcher)])
    )
  ) as Record<HostArtifact, RuntimeSource>;
  return { root, sources, pins, fetcher, requests };
}
export async function hostFixture(sources: Record<HostArtifact, RuntimeSource>) {
  const home = await mkdtemp(join(tmpdir(), 'host-home-'));
  const bin = join(home, 'bin');
  await mkdir(bin);
  const projectRoot = join(home, 'repo');
  await mkdir(projectRoot);
  // Each fake answers --version in its own vendor's format; the adapters refuse
  // another vendor's binary under the same name (the Windows agent.exe collision).
  for (const [name, version] of Object.entries(FIXTURE_HOST_VERSIONS))
    await writeFile(
      join(bin, name),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${JSON.stringify(version)}; else echo "mnemonik: Connected"; fi\n`,
      { mode: 0o700 }
    );
  let clock = 0;
  const deps: HostDependencies = {
    stateDir: join(home, 'state'),
    account: 'owner',
    getCliBearer: async () => 'fixture-cli-bearer',
    credentialFetch: async (_input, init) => {
      if (new Headers(init?.headers).get('authorization') !== 'Bearer fixture-cli-bearer')
        throw new Error('expected_cli_grant');
      if (init?.body !== JSON.stringify({ component_kind: 'hook' }))
        throw new Error('expected_hook_issuance');
      return Response.json({
        id: 'hook-family',
        access_token: 'hook-access',
        refresh_token: 'hook-refresh',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_expires_in: 7200,
        scope: 'hooks:use',
        display_prefix: 'hook',
      });
    },
    env: {
      ...process.env,
      PATH: bin,
      CODEX_HOME: join(home, '.codex'),
      GROK_HOME: join(home, '.grok'),
    },
    source: async (h) => sources[h],
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  };
  const selections: HostSelection[] = hostOrder.map((host) => ({
    host,
    scope: 'user',
    home,
    projectRoot,
  }));
  return { home, deps, selections, bin, projectRoot };
}
export async function hostStateFixture(sources: Record<HostArtifact, RuntimeSource>) {
  const fixture = await hostFixture(sources);
  const grants: AccountGrant[] = hostOrder.map((host) => ({
    id: `grant-${host}`,
    clientId: `registered-${host}`,
    clientName: host === 'claude-code' ? 'Claude Code' : host,
    softwareId: null,
    scopes: ['mcp:use', 'offline_access'],
    resource: 'https://api.mnemonik.dev/mcp',
    createdAt: '2026-09-11T00:00:00Z',
    activatedAt: '2026-09-11T00:01:00Z',
    lastUsedAt: null,
  }));
  const revoked: string[] = [];
  let account = 'owner';
  fixture.deps.grants = {
    approveHost: async () => 'installation',
    list: async () => ({
      account,
      deviceInstallationId: 'installation',
      grants: [
        ...grants,
        {
          ...grants[0]!,
          id: 'cli',
          clientId: 'mnemonik-cli',
          clientName: 'Mnemonik CLI',
          resource: 'https://api.mnemonik.dev/',
          scopes: ['install:manage', 'components:manage'],
          deviceInstallationId: 'installation',
          createdAt: '2026-09-10T00:00:00Z',
        },
      ],
    }),
    revoke: async (id) => {
      revoked.push(id);
      const index = grants.findIndex((grant) => grant.id === id);
      if (index >= 0) grants.splice(index, 1);
    },
  };
  return {
    ...fixture,
    grants,
    revoked,
    setGrantAccount(value: string) {
      account = value;
    },
    async hostOutput(
      binary: 'claude' | 'codex' | 'cursor' | 'grok',
      version: string,
      connected = true
    ) {
      await writeFile(
        join(fixture.bin, binary),
        `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${JSON.stringify(version)}; else echo ${JSON.stringify(`mnemonik: ${connected ? 'Connected' : 'Not connected'}`)}; fi\n`,
        { mode: 0o700 }
      );
    },
  };
}
export function bump(source: RuntimeSource, version = '99.0.0'): RuntimeSource {
  const manifest = structuredClone(source.manifest);
  manifest.version = version;
  const files = { ...source.files };
  files[manifest.entry] = Buffer.concat([
    files[manifest.entry]!,
    Buffer.from('\n// new release\n'),
  ]);
  manifest.files[manifest.entry] = {
    sha256: hash(files[manifest.entry]!),
    size: files[manifest.entry]!.length,
    executable: false,
  };
  manifest.totalSize = Object.values(files).reduce((n, b) => n + b.length, 0);
  return { manifest, files };
}
