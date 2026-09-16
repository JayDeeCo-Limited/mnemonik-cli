import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  apiOrigin,
  createHostBinary,
  hostBinaryDescriptor,
  type AdapterDependencies,
  resolveProjectIdentity,
  type ProjectIdentityResolution,
} from '@mnemonik/shared';
import type { Output } from './output.js';

export type HostName = 'Claude Code' | 'Codex' | 'Cursor' | 'Grok' | 'VS Code Copilot';

export interface DetectedHost {
  name: HostName;
  supported: boolean;
  path: string;
}

export interface PreflightResult {
  status: 'ready' | 'action_required';
  node: { version: string; supported: boolean };
  os: string;
  hosts: DetectedHost[];
  project: { root?: string; resolution: ProjectIdentityResolution['kind'] };
  network: { reachable: boolean; discoveryUrl: string; detail?: string };
}

export interface PreflightDependencies {
  cwd?: string;
  home?: string;
  platform?: NodeJS.Platform;
  nodeVersion?: string;
  fetch?: typeof globalThis.fetch;
  resolveIdentity?: typeof resolveProjectIdentity;
  pathExists?: (path: string) => Promise<boolean>;
  discoveryUrl?: string;
  resource?: string;
  execFile?: AdapterDependencies['execFile'];
  binaryExists?: AdapterDependencies['binaryExists'];
  env?: NodeJS.ProcessEnv;
}

const osName = (platform: NodeJS.Platform): string =>
  platform === 'darwin'
    ? 'macOS'
    : platform === 'win32'
      ? 'Windows'
      : platform === 'linux'
        ? 'Linux'
        : platform;

const hostPaths = (
  home: string
): Array<{ name: HostName; supported: boolean; paths: string[] }> => [
  {
    name: 'Claude Code',
    supported: true,
    paths: [join(home, '.claude', 'settings.json'), join(home, '.claude.json')],
  },
  { name: 'Codex', supported: true, paths: [join(home, '.codex', 'config.toml')] },
  {
    name: 'Cursor',
    supported: true,
    paths: [join(home, '.cursor', 'mcp.json'), join(home, '.cursor', 'hooks.json')],
  },
  { name: 'Grok', supported: true, paths: [join(home, '.grok', 'config.toml')] },
];

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false
  );
}

export async function runPreflight(deps: PreflightDependencies = {}): Promise<PreflightResult> {
  const home = deps.home ?? homedir();
  const pathExists = deps.pathExists ?? exists;
  const hosts: DetectedHost[] = [];
  for (const candidate of hostPaths(home)) {
    for (const path of candidate.paths) {
      if (await pathExists(path)) {
        hosts.push({ name: candidate.name, supported: candidate.supported, path });
        break;
      }
    }
  }

  const env = { ...(deps.env ?? process.env), HOME: home, USERPROFILE: home };
  await Promise.all(
    (
      [
        ['claude-code', 'Claude Code'],
        ['codex', 'Codex'],
        ['cursor', 'Cursor'],
      ] as const
    ).map(async ([host, name]) => {
      if (hosts.some((found) => found.name === name)) return;
      const descriptor = hostBinaryDescriptor(host, { ...deps, env });
      const binary = createHostBinary(
        { ...deps, env },
        descriptor.binary,
        descriptor.windowsBinary,
        deps.execFile ?? promisify(execFile),
        descriptor.desktopPaths
      );
      try {
        const path = await binary.findOnDisk();
        if (path) hosts.push({ name, supported: true, path });
      } catch {
        // A missing or unusable binary adds no candidate; existing config still counts.
      }
    })
  );
  const order = hostPaths(home).map((host) => host.name);
  hosts.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));

  const resolution = await (deps.resolveIdentity ?? resolveProjectIdentity)(
    deps.cwd ?? process.cwd()
  );
  const root = 'root' in resolution ? resolution.root : undefined;
  const discoveryUrl =
    deps.discoveryUrl ??
    new URL('/.well-known/oauth-protected-resource', deps.resource ?? apiOrigin()).href;
  let network: PreflightResult['network'];
  try {
    const response = await (deps.fetch ?? globalThis.fetch)(discoveryUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(5_000),
    });
    network = {
      reachable: response.ok,
      discoveryUrl,
      ...(!response.ok ? { detail: `HTTP ${response.status}` } : {}),
    };
  } catch (error) {
    network = {
      reachable: false,
      discoveryUrl,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const version = (deps.nodeVersion ?? process.versions.node).replace(/^v/, '');
  const supported = Number(version.split('.')[0]) >= 24;
  return {
    status: supported && network.reachable ? 'ready' : 'action_required',
    node: { version, supported },
    os: osName(deps.platform ?? process.platform),
    hosts,
    project: { ...(root ? { root } : {}), resolution: resolution.kind },
    network,
  };
}

export function renderPreflight(result: PreflightResult, output: Output): void {
  output.setContext({ projectRoot: result.project.root });
  output.line('Mnemonik');
  output.line();
  const hosts = result.hosts.map(
    (host) => `${host.name}${host.supported ? '' : ' (not supported yet)'}`
  );
  output.line(`  Found      ${hosts.length ? hosts.join(', ') : 'No supported editors'}`);
  output.line('  VS Code Copilot (not offered at launch)');
  output.line(
    `  Project    ${result.project.root ?? `Unavailable (${result.project.resolution})`}`
  );
  output.line(`  Node       ${result.node.version}, ${result.os}`);
  if (!result.network.reachable)
    output.line(`  Network    Unavailable (${result.network.detail ?? 'discovery failed'})`);
  output.line();
}
