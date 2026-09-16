import { createHostBinary, HostBinaryNotFoundError, quoteHostArgument, } from './hostBinary.js';
import { apiOrigin } from './apiOrigin.js';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual, promisify, stripVTControlCharacters } from 'node:util';
/** Common read/propose/stage lifecycle; the host's installer still owns its bytes. */
export function createFileHostAdapter(deps, host) {
    const emptyConfiguration = (content) => {
        if (!content.toString().trim())
            return true;
        try {
            const config = JSON.parse(content.toString());
            return Object.entries(config).every(([key, value]) => (['hooks', 'mcpServers'].includes(key) &&
                !!value &&
                typeof value === 'object' &&
                !Array.isArray(value) &&
                Object.keys(value).length === 0) ||
                (key === 'version' && value === 1));
        }
        catch {
            return false;
        }
    };
    const run = deps.execFile ?? promisify(execFile);
    const ownedTarget = deps.env?.MNEMONIK_CLI_OWNED_TARGET === '1';
    const targetFor = (target = deps.target) => {
        if (!target ||
            !['hooks', 'mcp'].includes(target.component) ||
            !['user', 'project'].includes(target.scope) ||
            (target.component === 'hooks' && !isAbsolute(target.runtimeEntry)) ||
            (target.component === 'hooks' && host.name === 'codex' && !isAbsolute(target.runtimeRoot)) ||
            (target.scope === 'project' && (!target.projectRoot || !isAbsolute(target.projectRoot))))
            throw new Error('invalid_target');
        return target;
    };
    // Validate host configuration before any native command can run.
    const nativeEnable = host.nativeEnable;
    for (const argument of nativeEnable ?? [])
        quoteHostArgument(argument);
    const binary = createHostBinary(deps, host.binary, host.windowsBinary, run, host.desktopPaths);
    let resolvedPath;
    let detection;
    const detect = () => (detection ??= (async () => {
        try {
            resolvedPath = await binary.resolve();
            const result = await binary.execute(['--version']);
            resolvedPath = await binary.resolve();
            const output = stripVTControlCharacters(`${result.stdout}\n${result.stderr}`).trim();
            const version = output.match(/\b\d+\.\d+\.\d+(?:-[\w.-]+)?\b/)?.[0] ?? '';
            if (output && !host.vendorMatch.test(output))
                return { supported: false, version, reason: 'wrong_vendor', resolvedPath };
            if (host.classifyVersion)
                return { ...host.classifyVersion(output), resolvedPath };
            if (version)
                return { supported: true, version, resolvedPath };
        }
        catch (error) {
            if (error instanceof HostBinaryNotFoundError) {
                resolvedPath = undefined;
                detection = undefined;
                return {
                    supported: false,
                    version: '',
                    reason: 'not_found',
                    searchedLocations: error.searchedLocations,
                };
            }
            /* Detection is read-only and otherwise fails closed. */
        }
        // Not cached: an absent or unreadable binary may be installed later in
        // this process, and the next detect() must look again.
        detection = undefined;
        return {
            supported: false,
            version: '',
            reason: 'unverified_version',
            ...(resolvedPath ? { resolvedPath } : {}),
        };
    })());
    const execute = async (args, target) => {
        const check = await detect();
        if (!check.supported)
            throw new Error(`${check.reason}: ${check.resolvedPath ?? host.binary}`);
        return binary.execute(args, target?.projectRoot);
    };
    const path = (target) => target.component === 'mcp' && host.mcp ? host.mcp.path(target) : host.path(target);
    const mcp = async (target, install) => {
        if (!host.mcp)
            throw new Error('unsupported_component');
        const file = path(target);
        const raw = await readFile(file, 'utf8').catch((error) => {
            if (error.code === 'ENOENT')
                return '';
            throw error;
        });
        const url = `${apiOrigin(deps.env)}/mcp`;
        let content;
        if (host.mcp.format === 'json') {
            const config = JSON.parse(raw || '{}');
            if (!config ||
                typeof config !== 'object' ||
                Array.isArray(config) ||
                (config.mcpServers !== undefined &&
                    (!config.mcpServers ||
                        typeof config.mcpServers !== 'object' ||
                        Array.isArray(config.mcpServers))))
                throw new Error('invalid_mcp_config');
            const servers = config.mcpServers ?? {};
            const expected = { ...(host.mcp.type ? { type: host.mcp.type } : {}), url };
            const current = servers.mnemonik;
            const exact = !!current &&
                typeof current === 'object' &&
                !Array.isArray(current) &&
                Object.keys(current).length === Object.keys(expected).length &&
                Object.entries(expected).every(([key, value]) => current[key] === value);
            if (install === undefined)
                return exact ? [{ path: file, content: Buffer.from(raw) }] : [];
            if (!install && !Object.hasOwn(servers, 'mnemonik'))
                return [];
            if (Object.hasOwn(servers, 'mnemonik') && !exact && !ownedTarget)
                throw new Error('mcp_name_conflict');
            if (install)
                servers.mnemonik = expected;
            else
                delete servers.mnemonik;
            config.mcpServers = servers;
            content = JSON.stringify(config, null, 2) + '\n';
        }
        else {
            // Preserve unrelated TOML bytes. Refuse layouts whose table boundaries are ambiguous.
            if (/'''|"""/.test(raw) ||
                /^\s*(?:mcp_servers\s*=|mcp_servers\s*\.)/m.test(raw) ||
                /=\s*\[[^\]\n]*$/m.test(raw))
                throw new Error('unsupported_mcp_toml_layout');
            if (/^\s*\[\s*["']?mcp_servers["']?\s*\]/m.test(raw) ||
                /^\s*\[\[\s*["']?mcp_servers/m.test(raw))
                throw new Error('unsupported_mcp_toml_layout');
            const table = /^\s*\[\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*\.\s*(?:mnemonik|"mnemonik"|'mnemonik')(?:\s*\.[^\]]+)?\s*\]\s*(?:#.*)?$/;
            let owned = false;
            let found = false;
            let connected = false;
            const kept = [];
            for (const line of raw.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
                const text = line.trimEnd();
                if (/^\s*\[/.test(text))
                    owned = table.test(text);
                if (owned) {
                    found = true;
                    connected ||= text.match(/^\s*url\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/)?.[1] === url;
                }
                else
                    kept.push(line);
            }
            if (install === undefined)
                return connected ? [{ path: file, content: Buffer.from(raw) }] : [];
            if (!install && !found)
                return [];
            if (found && !connected && !ownedTarget)
                throw new Error('mcp_name_conflict');
            content = kept.join('');
            if (install)
                content += `${content && !content.endsWith('\n') ? '\n' : ''}[mcp_servers.mnemonik]\nurl = "${url}"\n`;
        }
        return [{ path: file, content: Buffer.from(content) }];
    };
    const present = async (target) => target.component === 'mcp' ? (await mcp(target)).length > 0 : host.present(target);
    const changes = (target, install) => target.component === 'mcp' ? mcp(target, install) : host.changes(target, install);
    const inspect = async (input) => {
        const target = targetFor(input);
        const other = { ...target, scope: target.scope === 'user' ? 'project' : 'user' };
        const otherScopes = [];
        if ((other.scope === 'user' || other.projectRoot) &&
            path(other) !== path(target) &&
            (await present(other)))
            otherScopes.push({ scope: other.scope, path: path(other) });
        let authenticatedTools = false;
        if (target.component === 'mcp' && host.nativeListing !== false) {
            try {
                const { stdout } = await execute(['mcp', 'list'], target);
                // Native listing corroborates authentication; the CLI separately proves the live account grant.
                // No qualified listing currently prints a server grant/account: do not invent one.
                const origin = apiOrigin(deps.env).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const connected = new RegExp(String.raw `^\s*mnemonik(?:\s*:|\s+)\s*(?:${origin}/mcp(?:\s+\(HTTP\))?\s*-\s*)?[✓✔√]?\s*Connected\s*$`, 'i');
                const lines = stripVTControlCharacters(stdout).split(/\r?\n/);
                authenticatedTools = lines.some((line) => connected.test(line));
                if (host.name === 'codex') {
                    const oauth = new RegExp(String.raw `^\s*mnemonik\s+${origin}/mcp\s+-\s+enabled\s+OAuth\s*$`);
                    authenticatedTools ||= stripVTControlCharacters(stdout)
                        .split(/\r?\n/)
                        .some((line) => oauth.test(line));
                }
                if (host.name === 'grok' && !authenticatedTools) {
                    const { stdout: doctor } = await execute(['mcp', 'doctor', '--json'], target);
                    const result = JSON.parse(doctor);
                    authenticatedTools =
                        Array.isArray(result.servers) &&
                            result.servers.some((server) => server.name === 'mnemonik' &&
                                server.transport === 'http' &&
                                server.target === `${apiOrigin(deps.env)}/mcp` &&
                                server.healthy === true &&
                                Array.isArray(server.checks) &&
                                server.checks.some((check) => check.label === 'handshake OK' && check.passed === true));
                }
            }
            catch {
                /* Missing CLI, timeout or unqualified output leaves authentication unproven. */
            }
        }
        return {
            resolvedPath: await binary.resolve().catch(() => undefined),
            ...(host.nativeListing === false ? { declarationPath: path(target) } : {}),
            declarationPresent: await present(target),
            authenticatedTools,
            otherScopes,
        };
    };
    const plan = async (input) => {
        const target = targetFor(input);
        return {
            changes: await changes(target, true),
            staging: 'inactive',
            requestedScope: target.scope,
            effectiveScope: target.scope,
            version: deps.version ?? '',
            artifactDigest: deps.artifactDigest ?? '',
        };
    };
    const install = async (writer, target) => {
        for (const change of (await plan(target)).changes)
            await writer.stage(change);
    };
    const signedInInstruction = host.signedInInstruction ?? `${host.name} is already signed in to Mnemonik.`;
    return {
        name: host.name,
        detect,
        capabilities: () => ({
            scopes: ['user', 'project'],
            revoke: !!host.nativeLogout,
            components: host.mcp ? ['hooks', 'mcp'] : ['hooks'],
            nativeConnect: !!host.nativeConnect,
            ...(host.nativeListing === false ? { nativeListing: false } : {}),
        }),
        inspect,
        plan,
        install,
        // Updating and repairing both replace owned entries through plan + install.
        update: install,
        repair: install,
        launch: async ({ signedIn = false } = {}) => {
            if (host.nativeConnect && !signedIn) {
                try {
                    await execute(['mcp', 'login', 'mnemonik'], deps.target);
                }
                catch {
                    /* The recovery instruction remains usable when native login is unavailable. */
                }
            }
            return signedIn ? signedInInstruction : host.instruction;
        },
        ...(nativeEnable
            ? {
                enable: async () => {
                    try {
                        await execute(nativeEnable, deps.target);
                    }
                    catch {
                        /* The post-enable listing supplies the actionable result. */
                    }
                    return signedInInstruction;
                },
            }
            : {}),
        verify: inspect,
        async uninstall(writer, target) {
            const owned = targetFor(target);
            for (const change of await changes(owned, false)) {
                if (owned.originalFiles && Object.hasOwn(owned.originalFiles, change.path)) {
                    const original = owned.originalFiles[change.path];
                    if (change.path.endsWith('.json')) {
                        const before = JSON.parse(original
                            ?.toString()
                            .replace(/^\uFEFF/, '')
                            .trim() || '{}');
                        const after = JSON.parse(change.content.toString());
                        for (const key of ['hooks', 'mcpServers'])
                            if (!Object.hasOwn(before, key) && after[key] && Object.keys(after[key]).length === 0)
                                delete after[key];
                        change.content =
                            original && isDeepStrictEqual(before, after)
                                ? original
                                : Buffer.from(JSON.stringify(after, null, 2) + '\n');
                    }
                    else if (original &&
                        change.content.toString().trimEnd() === original.toString().trimEnd())
                        change.content = original;
                }
                await writer.stage({
                    ...change,
                    ...(owned.createdFiles?.includes(change.path) && emptyConfiguration(change.content)
                        ? { remove: true }
                        : {}),
                });
            }
        },
        ...(host.nativeLogout
            ? {
                revoke: async () => {
                    try {
                        await execute(['mcp', 'logout', 'mnemonik'], deps.target);
                        return true;
                    }
                    catch {
                        return false;
                    }
                },
            }
            : {}),
        revokeAction: host.revokeAction ??
            `Open ${host.name} connection settings and revoke the Mnemonik connection.`,
    };
}
//# sourceMappingURL=hostAdapter.js.map