import { execFile } from 'node:child_process';
import { access, lstat, readdir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { resolveProjectIdentity, selectRemote, } from '@mnemonik/shared';
export const DIRECTORY_LIMIT = 10_000;
export const DISCOVERY_DEPTH = 3;
export const REPOSITORY_LIMIT = 200;
const gitEnvironment = () => {
    const env = { LC_ALL: 'C' };
    for (const key of ['PATH', 'HOME', 'LANG', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE'])
        if (process.env[key] !== undefined)
            env[key] = process.env[key];
    return env;
};
function git(path, args) {
    return new Promise((resolvePromise, reject) => {
        execFile('git', args, { cwd: path, timeout: 2_000, encoding: 'utf8', env: gitEnvironment() }, (error, stdout) => (error ? reject(error) : resolvePromise(stdout)));
    });
}
async function repositoryRemotes(path) {
    let names;
    try {
        names = (await git(path, ['remote'])).split(/\r?\n/u).filter(Boolean);
    }
    catch {
        return [];
    }
    return Promise.all(names.map(async (name) => {
        const urls = async (extra) => {
            try {
                return (await git(path, ['remote', 'get-url', '--all', ...extra, name]))
                    .split(/\r?\n/u)
                    .filter(Boolean);
            }
            catch {
                return [];
            }
        };
        return { name, fetchUrls: await urls([]), pushUrls: await urls(['--push']) };
    }));
}
export async function classifyRepository(path, options = {}) {
    const canonical = await (options.canonicalizePath ?? realpath)(path);
    const resolution = await (options.resolveIdentity ?? resolveProjectIdentity)(canonical, {
        selectedRoot: true,
    });
    const resolvedPath = resolution.kind === 'git_unavailable'
        ? canonical
        : await (options.canonicalizePath ?? realpath)(resolution.repository.kind === 'git' ? resolution.repository.root : resolution.root);
    const kind = resolution.kind !== 'git_unavailable' && resolution.repository.kind === 'git'
        ? 'git'
        : 'folder';
    if (resolution.kind === 'ok') {
        return {
            path: resolvedPath,
            state: 'existing_project',
            kind,
            projectId: resolution.identity.projectId,
        };
    }
    if (resolution.kind !== 'absent') {
        return { path: resolvedPath, state: 'action_required', kind, reason: resolution.kind };
    }
    if (resolution.repository.kind === 'git') {
        const selection = selectRemote(await (options.readRemotes ?? repositoryRemotes)(resolvedPath));
        if (selection.status === 'fingerprint') {
            return {
                path: resolvedPath,
                state: 'remote_setup',
                kind,
                fingerprint: {
                    algorithmVersion: selection.fingerprint.algorithmVersion,
                    hash: selection.fingerprint.hash,
                },
            };
        }
    }
    return { path: resolvedPath, state: 'not_set_up', kind };
}
export async function discoverRepositories(parentPath, options = {}) {
    const canonicalize = options.canonicalizePath ?? realpath;
    const root = await canonicalize(parentPath);
    const maxDepth = options.maxDepth ?? DISCOVERY_DEPTH;
    const limit = options.directoryLimit ?? DIRECTORY_LIMIT;
    const readDirectory = options.readDirectory ?? ((path) => readdir(path, { withFileTypes: true }));
    const queue = [{ path: root, depth: 0 }];
    const repositories = [];
    const repositoryPaths = new Set();
    let omitted = 0;
    let directoriesVisited = 0;
    const result = (status, truncated) => ({
        status,
        displayRoot: parentPath,
        root,
        directoriesVisited,
        repositories: repositories.sort((left, right) => left.path.localeCompare(right.path)),
        truncated: truncated || omitted > 0,
        omitted,
    });
    while (queue.length) {
        if (directoriesVisited >= limit)
            return result('list_truncated', true);
        const directory = queue.shift();
        if (!directory)
            break;
        const stat = await lstat(directory.path).catch(() => undefined);
        if (!stat?.isDirectory() || stat.isSymbolicLink())
            continue;
        const canonical = await canonicalize(directory.path).catch(() => undefined);
        if (!canonical)
            continue;
        const fromRoot = relative(root, canonical);
        if (fromRoot === '..' ||
            fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
            isAbsolute(fromRoot))
            continue;
        directoriesVisited++;
        let entries;
        try {
            entries = await readDirectory(canonical);
        }
        catch {
            continue;
        }
        const gitBoundary = entries.find((entry) => entry.name === '.git' && (entry.isDirectory() || entry.isFile()));
        const identityBoundary = entries.some((entry) => entry.name === '.mnemonik.json' && entry.isFile());
        if (gitBoundary || identityBoundary) {
            const repository = await classifyRepository(canonical, {
                canonicalizePath: canonicalize,
                resolveIdentity: options.resolveIdentity,
                readRemotes: repositories.length < REPOSITORY_LIMIT ? options.readRemotes : async () => [],
            });
            if (!repositoryPaths.has(repository.path)) {
                repositoryPaths.add(repository.path);
                if (repositories.length < REPOSITORY_LIMIT)
                    repositories.push(repository);
                else
                    omitted++;
            }
        }
        if (directory.depth >= maxDepth)
            continue;
        const children = entries
            .filter((entry) => !entry.name.startsWith('.') &&
            entry.name !== 'node_modules' &&
            entry.isDirectory() &&
            !entry.isSymbolicLink())
            .map((entry) => ({ path: join(canonical, entry.name), depth: directory.depth + 1 }))
            .sort((left, right) => left.path.localeCompare(right.path));
        queue.push(...children);
    }
    return result('complete', false);
}
export async function scannerCandidates(boundary) {
    const discovered = await discoverRepositories(boundary);
    return {
        boundary: discovered.root,
        repositories: discovered.repositories,
        omitted: discovered.omitted,
        candidates: discovered.repositories.map((repository) => scannerCandidate(discovered.root, repository)),
    };
}
export const scannerCandidate = (root, repository) => ({
    path: repository.path,
    name: repositoryName(root, repository.path),
    kind: repository.kind ?? 'git',
    ...(repository.projectId ? { projectId: repository.projectId } : {}),
});
export async function guessDiscoveryBoundary(cwd, home) {
    const current = resolve(cwd);
    const unsafe = current === resolve(home) || current === parse(current).root;
    if (!unsafe && (await discoverRepositories(cwd).catch(() => undefined))?.repositories.length)
        return cwd;
    for (const name of ['Projects', 'projects', 'code', 'src', 'dev', 'repos']) {
        const candidate = join(home, name);
        if (await access(candidate).then(() => true, () => false))
            return candidate;
    }
    return unsafe ? '' : cwd;
}
export const repositoryName = (root, path) => relative(root, path) || basename(resolve(path));
export const repositoryStateLabel = (state) => ({
    existing_project: 'Existing project',
    remote_setup: 'Set up from its Git remote',
    not_set_up: 'Not set up yet',
    action_required: 'Action required',
})[state];
//# sourceMappingURL=discover.js.map