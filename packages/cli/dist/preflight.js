import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { apiOrigin, createHostBinary, hostBinaryDescriptor, resolveProjectIdentity, } from '@mnemonik/shared';
import { hostDiscovery } from './hostDiscovery.js';
const osName = (platform) => platform === 'darwin'
    ? 'macOS'
    : platform === 'win32'
        ? 'Windows'
        : platform === 'linux'
            ? 'Linux'
            : platform;
const hostPaths = (home) => [
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
export async function runPreflight(deps = {}) {
    const home = deps.home ?? homedir();
    const pathExists = deps.pathExists ?? hostDiscovery.pathExists;
    const hosts = [];
    for (const candidate of hostPaths(home)) {
        for (const path of candidate.paths) {
            if (await pathExists(path)) {
                hosts.push({ name: candidate.name, supported: candidate.supported, path });
                break;
            }
        }
    }
    const env = { ...(deps.env ?? process.env), HOME: home, USERPROFILE: home };
    const binaryExists = deps.binaryExists ?? hostDiscovery.binaryExists;
    await Promise.all([
        ['claude-code', 'Claude Code'],
        ['codex', 'Codex'],
        ['cursor', 'Cursor'],
    ].map(async ([host, name]) => {
        if (hosts.some((found) => found.name === name))
            return;
        const descriptor = hostBinaryDescriptor(host, { ...deps, env });
        const binary = createHostBinary({ ...deps, env, binaryExists }, descriptor.binary, descriptor.windowsBinary, deps.execFile ?? promisify(execFile), descriptor.desktopPaths);
        try {
            const path = await binary.findOnDisk();
            if (path)
                hosts.push({ name, supported: true, path });
        }
        catch {
            // A missing or unusable binary adds no candidate; existing config still counts.
        }
    }));
    const order = hostPaths(home).map((host) => host.name);
    hosts.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
    const resolution = await (deps.resolveIdentity ?? resolveProjectIdentity)(deps.cwd ?? process.cwd());
    const root = 'root' in resolution ? resolution.root : undefined;
    const discoveryUrl = deps.discoveryUrl ??
        new URL('/.well-known/oauth-protected-resource', deps.resource ?? apiOrigin()).href;
    let network;
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
    }
    catch (error) {
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
export function renderPreflight(result, output) {
    output.setContext({ projectRoot: result.project.root });
    output.line('Mnemonik');
    output.line();
    const hosts = result.hosts.map((host) => `${host.name}${host.supported ? '' : ' (not supported yet)'}`);
    output.line(`  Found      ${hosts.length ? hosts.join(', ') : 'No supported editors'}`);
    output.line('  VS Code Copilot (not offered at launch)');
    output.line(`  Project    ${result.project.root ?? `Unavailable (${result.project.resolution})`}`);
    output.line(`  Node       ${result.node.version}, ${result.os}`);
    if (!result.network.reachable)
        output.line(`  Network    Unavailable (${result.network.detail ?? 'discovery failed'})`);
    output.line();
}
//# sourceMappingURL=preflight.js.map