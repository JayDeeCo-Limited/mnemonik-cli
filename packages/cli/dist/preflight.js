import { homedir } from 'node:os';
import { join } from 'node:path';
import { apiOrigin, resolveProjectIdentity, } from '@mnemonik/shared';
import { hostDiscovery } from './hostDiscovery.js';
const osName = (platform) => platform === 'darwin'
    ? 'macOS'
    : platform === 'win32'
        ? 'Windows'
        : platform === 'linux'
            ? 'Linux'
            : platform;
export function nodeVersionHelp(version, platform) {
    return [
        `Node ${version} is installed. Mnemonik needs Node 24 or newer.`,
        platform === 'darwin'
            ? 'Run: brew install node@24 && export PATH="$(brew --prefix node@24)/bin:$PATH"'
            : platform === 'linux'
                ? 'Install Node 24: https://nodejs.org/en/download/package-manager'
                : 'Install Node 24: https://nodejs.org/en/download',
    ];
}
const hostPaths = (home, project) => [
    {
        name: 'Claude Code',
        supported: true,
        paths: [
            join(home, '.claude', 'settings.json'),
            join(home, '.claude.json'),
            join(home, '.claude'),
            join(project, '.claude', 'settings.json'),
            join(project, '.mcp.json'),
            join(project, '.claude'),
        ],
    },
    {
        name: 'Codex',
        supported: true,
        paths: [
            join(home, '.codex', 'config.toml'),
            join(home, '.codex', 'hooks.json'),
            join(home, '.codex'),
            join(project, '.codex', 'config.toml'),
            join(project, '.codex', 'hooks.json'),
            join(project, '.codex'),
        ],
    },
    {
        name: 'Cursor',
        supported: true,
        paths: [
            join(home, '.cursor', 'mcp.json'),
            join(home, '.cursor', 'hooks.json'),
            join(home, '.cursor'),
            join(project, '.cursor', 'mcp.json'),
            join(project, '.cursor', 'hooks.json'),
            join(project, '.cursor'),
        ],
    },
    {
        name: 'Grok',
        supported: true,
        paths: [
            join(home, '.grok', 'config.toml'),
            join(home, '.grok', 'hooks', 'mnemonik.json'),
            join(home, '.grok'),
            join(project, '.grok', 'config.toml'),
            join(project, '.grok', 'hooks', 'mnemonik.json'),
            join(project, '.grok'),
        ],
    },
];
export async function runPreflight(deps = {}) {
    const home = deps.home ?? homedir();
    const resolution = await (deps.resolveIdentity ?? resolveProjectIdentity)(deps.cwd ?? process.cwd());
    const root = 'root' in resolution ? resolution.root : (deps.cwd ?? process.cwd());
    const pathExists = deps.pathExists ?? hostDiscovery.pathExists;
    const hosts = [];
    for (const candidate of hostPaths(home, root)) {
        for (const path of candidate.paths) {
            if (await pathExists(path)) {
                hosts.push({ name: candidate.name, supported: candidate.supported, path });
                break;
            }
        }
    }
    const projectRoot = 'root' in resolution ? resolution.root : undefined;
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
        project: { ...(projectRoot ? { root: projectRoot } : {}), resolution: resolution.kind },
        network,
    };
}
export function renderPreflight(result, output) {
    output.setContext({ projectRoot: result.project.root });
    output.line('Mnemonik');
    output.line();
    const hosts = result.hosts.map((host) => `${host.name}${host.supported ? '' : ' (not supported yet)'}`);
    output.line(`  Found      ${hosts.length ? hosts.join(', ') : 'No supported editors'}`);
    output.line(`  Project    ${result.project.root ?? `Unavailable (${result.project.resolution})`}`);
    output.line(`  Node       ${result.node.version}, ${result.os}`);
    if (!result.network.reachable)
        output.line(`  Network    Unavailable (${result.network.detail ?? 'discovery failed'})`);
    output.line();
}
//# sourceMappingURL=preflight.js.map