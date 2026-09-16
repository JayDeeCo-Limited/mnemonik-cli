import { stat } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { homedir } from 'node:os';
/** Native locations shared by preflight discovery and verified host adapters. */
export function hostBinaryDescriptor(host, deps = {}) {
    if (host === 'claude-code')
        return {
            binary: 'claude',
            windowsBinary: {
                locations: [
                    ['APPDATA', 'npm/claude.cmd'],
                    ['USERPROFILE', '.local/bin/claude.exe'],
                ],
                extensions: ['.cmd', '.exe'],
            },
        };
    if (host === 'codex')
        return {
            binary: 'codex',
            desktopPaths: (deps.platform ?? process.platform) === 'darwin'
                ? [
                    '/Applications/ChatGPT.app/Contents/Resources/codex',
                    join(deps.env?.HOME ?? homedir(), 'Applications/ChatGPT.app/Contents/Resources/codex'),
                ]
                : [],
            windowsBinary: {
                locations: [
                    ['APPDATA', 'npm/codex.cmd'],
                    ['LOCALAPPDATA', 'Programs/OpenAI/Codex/bin/codex.exe'],
                ],
                extensions: ['.cmd', '.exe'],
            },
        };
    return {
        binary: 'cursor',
        desktopPaths: (deps.platform ?? process.platform) === 'darwin'
            ? ['/Applications/Cursor.app/Contents/Resources/app/bin/cursor']
            : ['/usr/share/cursor/bin/cursor', '/opt/Cursor/resources/app/bin/cursor'],
        windowsBinary: {
            locations: [
                ['LOCALAPPDATA', 'Programs/cursor/resources/app/bin/cursor.cmd'],
                ['LOCALAPPDATA', 'Programs/cursor/Cursor.exe'],
            ],
            extensions: ['.cmd', '.exe'],
            productVersion: true,
        },
    };
}
export class HostBinaryNotFoundError extends Error {
    searchedLocations;
    constructor(searchedLocations) {
        super('host_binary_not_found');
        this.searchedLocations = searchedLocations;
    }
}
/** cmd parses shell syntax even with execFile's shell:false. Only fixed, safe arguments.
 * Parentheses are ordinary inside a quoted token, and a profile path may carry
 * them (`C:\\Users\\Jane (Admin)\\...`). */
export function quoteHostArgument(value) {
    if (/["%!?^&|<>\r\n\0]/.test(value))
        throw new Error('unsafe_host_argument');
    return `"${value.replace(/\\+$/, '$&$&')}"`;
}
export function createHostBinary(deps, name, windows, run, desktopPaths = []) {
    const env = deps.env ?? process.env;
    const onWindows = (deps.platform ?? process.platform) === 'win32';
    const variable = (name) => env[Object.keys(env)
        .sort()
        .find((key) => key.toUpperCase() === name.toUpperCase()) ?? name];
    const absolute = (file) => win32.isAbsolute(file) && win32.parse(file).root.length > 1;
    const system = win32.join(variable('SystemRoot') ?? 'C:\\Windows', 'System32');
    const exists = deps.binaryExists ??
        (async (file) => (await stat(file).catch(() => undefined))?.isFile() === true);
    const options = { env, timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true };
    // A failed lookup is not cached: the vendor binary may appear later in the
    // same process (an install in progress), and the next call must see it.
    let pending;
    const resolve = () => (pending ??= (async () => {
        if (!onWindows)
            return name;
        const searchedLocations = [];
        const accept = async (file) => absolute(file) &&
            windows.extensions.includes(win32.extname(file).toLowerCase()) &&
            (await exists(file));
        for (const [key, relative] of windows.locations) {
            const root = variable(key);
            if (!root)
                continue;
            const file = win32.join(root, relative);
            searchedLocations.push(file);
            if (await accept(file))
                return file;
        }
        if (!absolute(system))
            throw new Error('invalid_system_root');
        const { stdout } = await run(win32.join(system, 'where.exe'), [name], options).catch((error) => {
            if (error.code === 1)
                throw new HostBinaryNotFoundError(searchedLocations);
            throw error;
        });
        for (const candidate of stdout.split(/\r?\n/)) {
            const file = candidate.trim();
            if (await accept(file))
                return file;
        }
        throw new HostBinaryNotFoundError(searchedLocations);
    })().catch((error) => {
        pending = undefined;
        throw error;
    }));
    return {
        resolve,
        async findOnDisk() {
            const native = onWindows
                ? windows.locations.flatMap(([key, path]) => {
                    const root = variable(key);
                    return root ? [win32.join(root, path)] : [];
                })
                : [];
            const paths = (variable('PATH') ?? '').split(onWindows ? ';' : ':');
            const candidates = [
                ...native,
                ...paths.flatMap((path) => onWindows
                    ? windows.extensions.map((extension) => win32.join(path.replace(/^"|"$/g, ''), name + extension))
                    : [join(path, name)]),
                ...(!onWindows ? desktopPaths : []),
            ];
            for (const file of candidates)
                if ((!onWindows || absolute(file)) && (await exists(file)))
                    return file;
            return undefined;
        },
        async execute(args, cwd) {
            const file = await resolve();
            const execution = {
                ...options,
                cwd,
                timeout: args[1] === 'login' ? 120_000 : onWindows ? 30_000 : 5000,
            };
            if (!onWindows) {
                try {
                    return await run(file, args, execution);
                }
                catch (error) {
                    if (error.code !== 'ENOENT')
                        throw error;
                    for (const candidate of desktopPaths) {
                        if (!(await exists(candidate)))
                            continue;
                        const result = await run(candidate, args, execution);
                        pending = Promise.resolve(candidate);
                        return result;
                    }
                    throw new HostBinaryNotFoundError(desktopPaths);
                }
            }
            if (windows.productVersion && /\.exe$/i.test(file) && args[0] === '--version')
                return run(win32.join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
                    '-NoProfile',
                    '-NonInteractive',
                    '-Command',
                    `(Get-Item -LiteralPath '${file.replace(/'/g, "''")}').VersionInfo.ProductVersion`,
                ], execution);
            if (!/\.(cmd|bat)$/i.test(file))
                return run(file, args, execution);
            const command = [quoteHostArgument(file), ...args.map(quoteHostArgument)];
            command[0] = '"' + command[0];
            command[command.length - 1] += '"';
            const comspec = variable('ComSpec') ?? win32.join(system, 'cmd.exe');
            if (!absolute(comspec))
                throw new Error('invalid_comspec');
            return run(comspec, ['/d', '/s', '/c', ...command], {
                ...execution,
                windowsVerbatimArguments: true,
            });
        },
    };
}
//# sourceMappingURL=hostBinary.js.map