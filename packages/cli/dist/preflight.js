import { humanReason } from './humanReason.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { apiOrigin, resolveProjectIdentity, } from '@mnemonik/shared';
import { hostDiscovery } from './hostDiscovery.js';
import { launchHostLabels, launchHosts } from './install/adapters.js';
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
const hostPaths = (home, project) => ({
    'claude-code': [
        join(home, '.claude', 'settings.json'),
        join(home, '.claude.json'),
        join(home, '.claude'),
        join(project, '.claude', 'settings.json'),
        join(project, '.mcp.json'),
        join(project, '.claude'),
    ],
    codex: [
        join(home, '.codex', 'config.toml'),
        join(home, '.codex', 'hooks.json'),
        join(home, '.codex'),
        join(project, '.codex', 'config.toml'),
        join(project, '.codex', 'hooks.json'),
        join(project, '.codex'),
    ],
    cursor: [
        join(home, '.cursor', 'mcp.json'),
        join(home, '.cursor', 'hooks.json'),
        join(home, '.cursor'),
        join(project, '.cursor', 'mcp.json'),
        join(project, '.cursor', 'hooks.json'),
        join(project, '.cursor'),
    ],
});
/** The launch editors present on this machine, by their files alone. */
export async function detectEditors(home, root, pathExists = hostDiscovery.pathExists) {
    const found = [];
    const paths = hostPaths(home, root);
    for (const host of launchHosts)
        for (const path of paths[host])
            if (await pathExists(path)) {
                found.push({ host, path });
                break;
            }
    return found;
}
export async function runPreflight(deps = {}) {
    const home = deps.home ?? homedir();
    const resolution = await (deps.resolveIdentity ?? resolveProjectIdentity)(deps.cwd ?? process.cwd());
    const root = 'root' in resolution ? resolution.root : (deps.cwd ?? process.cwd());
    const hosts = (await detectEditors(home, root, deps.pathExists ?? hostDiscovery.pathExists)).map(({ host, path }) => ({ name: launchHostLabels[host], supported: true, path }));
    const projectRoot = 'root' in resolution ? resolution.root : undefined;
    const discoveryUrl = deps.discoveryUrl ??
        new URL('/.well-known/oauth-protected-resource', deps.resource ?? apiOrigin()).href;
    let network;
    if (deps.skipNetworkWithoutHosts && !hosts.length) {
        network = { reachable: false, discoveryUrl, skipped: true };
    }
    else {
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
    output.line(`  Found      ${hosts.length ? hosts.join(', ') : 'No supported coding tools'}`);
    output.line(`  Project    ${result.project.resolution === 'absent' ? 'No project found' : result.project.root}`);
    output.line(`  Node       ${result.node.version}, ${result.os}`);
    // A check that never ran says nothing; a server that answered was reached.
    if (!result.network.reachable && !result.network.skipped)
        output.line(humanReason(result.network.detail?.startsWith('HTTP ') ? 'discovery_unavailable' : 'discovery_failed'));
    output.line();
}
//# sourceMappingURL=preflight.js.map