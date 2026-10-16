import { lstat, readFile, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readIdentityFile } from './projectIdentityFile.js';
const GIT_TIMEOUT_MS = 2_000;
const GIT_ENV_KEYS = [
    'PATH',
    'HOME',
    'LANG',
    'LC_ALL',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'USERPROFILE',
];
function gitEnvironment() {
    const env = {};
    for (const key of GIT_ENV_KEYS) {
        if (process.env[key] !== undefined)
            env[key] = process.env[key];
    }
    env.LC_ALL = 'C';
    return env;
}
function runGit(cwd, args) {
    return new Promise((resolvePromise, reject) => {
        execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, encoding: 'utf8', env: gitEnvironment() }, (error, stdout, stderr) => {
            if (error)
                reject(Object.assign(error, { stdout, stderr }));
            else
                resolvePromise({ stdout, stderr });
        });
    });
}
async function boundaryAt(path) {
    try {
        const stat = await lstat(join(path, '.git'));
        if (stat.isDirectory())
            return { path, kind: 'directory' };
        if (stat.isFile())
            return { path, kind: 'file' };
    }
    catch (error) {
        const code = error.code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR')
            throw error;
    }
    return undefined;
}
async function confirmedBoundaryAt(path) {
    const boundary = await boundaryAt(path);
    if (!boundary)
        return undefined;
    try {
        const { stdout } = await runGit(path, ['rev-parse', '--git-dir']);
        return stdout.trim() ? boundary : undefined;
    }
    catch {
        return undefined;
    }
}
async function boundariesBetween(cwd, root) {
    const boundaries = [];
    let directory = cwd;
    while (!samePath(directory, root)) {
        const boundary = await confirmedBoundaryAt(directory);
        if (boundary)
            boundaries.push(boundary);
        const parent = dirname(directory);
        if (parent === directory)
            break;
        directory = parent;
    }
    return boundaries;
}
async function containingRepository(root) {
    let directory = dirname(root);
    while (true) {
        const boundary = await confirmedBoundaryAt(directory);
        if (boundary)
            return boundary;
        const parent = dirname(directory);
        if (parent === directory)
            return undefined;
        directory = parent;
    }
}
/**
 * A path as the file system knows it, symlinks resolved, so it compares equal
 * with the real paths of git's answers. A path that does not exist stays as given.
 */
async function canonicalPath(path) {
    const absolute = resolve(path);
    return realpath(absolute).catch(() => absolute);
}
/** Path equality; Windows paths compare without regard to case. */
function samePath(left, right) {
    return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
export async function resolveRepositoryRoot(cwd) {
    const absoluteCwd = await canonicalPath(cwd);
    try {
        const { stdout } = await runGit(absoluteCwd, [
            'rev-parse',
            '--show-toplevel',
            '--git-dir',
            '--git-common-dir',
        ]);
        const [rootLine, gitDirLine, commonLine, ...extra] = stdout.trim().split(/\r?\n/);
        if (!rootLine || !gitDirLine || !commonLine || extra.length) {
            return { kind: 'git_unavailable', detail: 'git rev-parse returned an unexpected response' };
        }
        // git prints --git-dir and --git-common-dir relative to the directory it
        // ran in (`../.git` from a subfolder) or absolute; every git version
        // agrees on that. Real paths make them comparable with each other and
        // with real paths from the file system.
        const fromGit = (line) => canonicalPath(resolve(absoluteCwd, line));
        const root = await fromGit(rootLine);
        const gitDir = await fromGit(gitDirLine);
        const commonDir = await fromGit(commonLine);
        // Only a linked worktree keeps its own git directory apart from the common
        // one. A submodule (`.git/modules/<name>`) and a `--separate-git-dir`
        // checkout keep both in one place, wherever that is.
        const isLinkedWorktree = !samePath(gitDir, commonDir);
        const nested = await boundariesBetween(absoluteCwd, root);
        if (!isLinkedWorktree && (await containingRepository(root))) {
            const boundary = await boundaryAt(root);
            if (boundary)
                nested.push(boundary);
        }
        return {
            kind: 'git',
            root,
            commonDir,
            isLinkedWorktree,
            nested,
        };
    }
    catch (error) {
        const failure = error;
        if (failure.code === 128 && /not a git repository/i.test(failure.stderr ?? failure.message)) {
            return { kind: 'plain', root: absoluteCwd };
        }
        return { kind: 'git_unavailable', detail: failure.message };
    }
}
/**
 * The common git directory when `dir` is the top of a linked worktree: its
 * `.git` is a file pointing at a git directory that has a `commondir`. A
 * submodule's `.git` file points at `.git/modules/<name>`, which has none.
 * Read from the files git writes, so it holds without a git command.
 */
async function linkedWorktreeCommonDir(dir) {
    try {
        if (!(await lstat(join(dir, '.git'))).isFile())
            return undefined;
        const pointer = /^gitdir:\s*(.+?)\s*$/im.exec(await readFile(join(dir, '.git'), 'utf8'))?.[1];
        if (!pointer)
            return undefined;
        const gitDir = resolve(dir, pointer);
        const common = (await readFile(join(gitDir, 'commondir'), 'utf8')).trim();
        return common ? await canonicalPath(resolve(gitDir, common)) : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * The project folder of a linked worktree's main checkout: the first entry of
 * `git worktree list --porcelain`. When that entry is a bare repository
 * (`proj/.bare` with worktrees beside it), the project folder is the folder
 * holding it, never the git directory itself. Without git, the folder holding
 * the common git directory, which is the same answer for both layouts.
 */
async function mainCheckout(worktreeTop, commonDir) {
    try {
        const { stdout } = await runGit(worktreeTop, ['worktree', 'list', '--porcelain']);
        const first = stdout.split(/\r?\n\r?\n/)[0] ?? '';
        const path = /^worktree (.+)$/m.exec(first)?.[1];
        if (path) {
            const main = await canonicalPath(resolve(worktreeTop, path));
            return /^bare$/m.test(first) ? dirname(main) : main;
        }
    }
    catch {
        /* fall through */
    }
    return dirname(commonDir);
}
async function readPlainIdentity(start) {
    const home = await canonicalPath(homedir());
    let directory = start;
    while (true) {
        const result = await readIdentityFile(directory, { configurationOnlyAbsent: true });
        if (result.kind !== 'absent')
            return { root: directory, result };
        if (samePath(directory, home))
            break;
        const parent = dirname(directory);
        if (parent === directory)
            break;
        directory = parent;
    }
    return { root: start, result: { kind: 'absent' } };
}
/**
 * Walk up from `start` to the nearest identity file, stopping at the home
 * folder (whose own file still counts). A configuration-only file (no
 * `projectId`) is not an identity and the walk passes it. Reaching the top of a linked worktree
 * first ends the walk there: the worktree belongs to its main checkout, and
 * the copy of the identity file at its top does not count.
 */
async function nearestIdentity(start) {
    const home = await canonicalPath(homedir());
    let directory = start;
    while (true) {
        const commonDir = await linkedWorktreeCommonDir(directory);
        if (commonDir)
            return { worktreeTop: directory, commonDir };
        const result = await readIdentityFile(directory, { configurationOnlyAbsent: true });
        if (result.kind !== 'absent')
            return { root: directory, result };
        if (samePath(directory, home))
            return undefined;
        const parent = dirname(directory);
        if (parent === directory)
            return undefined;
        directory = parent;
    }
}
/**
 * The project a working folder belongs to: the nearest `.mnemonik.json` above
 * it. Git repositories are not project boundaries; a clone, submodule,
 * subsystem or subproject inside a project belongs to that project unless it
 * has its own identity file. Git has one part in identity: a linked worktree
 * (and anything inside it without an identity file of its own below the
 * worktree's top, nested clones and submodules included) belongs to the
 * project of its main checkout; the worktree's own top-level copy of the
 * identity file does not count.
 */
export async function resolveNearestProjectIdentity(cwd) {
    const start = await canonicalPath(cwd);
    const resolved = await resolveRepositoryRoot(start);
    const repository = resolved.kind === 'git_unavailable' ? { kind: 'plain', root: start } : resolved;
    const nested = repository.kind === 'git' ? repository.nested : [];
    let found = await nearestIdentity(start);
    if (found && 'worktreeTop' in found) {
        found = await readPlainIdentity(await mainCheckout(found.worktreeTop, found.commonDir));
    }
    if (found) {
        return shapedIdentity(found, await projectFolderRepository(found.root, repository), nested);
    }
    return { ...withBase(repository, repository.root, nested), kind: 'absent' };
}
/**
 * The identity of exactly the folder named, for commands that create or link
 * a project there on purpose, even inside another project. The top of a
 * linked worktree stands for its main checkout.
 */
async function resolveNamedProjectIdentity(cwd, options) {
    const start = await canonicalPath(cwd);
    const resolved = await resolveRepositoryRoot(start);
    const repository = resolved.kind === 'git_unavailable' ? { kind: 'plain', root: start } : resolved;
    const commonDir = await linkedWorktreeCommonDir(start);
    const root = commonDir ? await mainCheckout(start, commonDir) : start;
    return shapedIdentity({ root, result: await readIdentityFile(root, options) }, await projectFolderRepository(root, repository), repository.kind === 'git' ? repository.nested : []);
}
function shapedIdentity(found, repository, nested) {
    const base = withBase(repository, found.root, nested);
    if (found.result.kind === 'ok')
        return { ...base, ...found.result };
    if (found.result.kind === 'unknown_version')
        return { ...base, ...found.result, path: found.root };
    if (found.result.kind === 'malformed')
        return { ...base, ...found.result, path: found.root };
    return { ...base, kind: 'absent' };
}
/** The project folder counts as a git repository only when it is the repository's top. */
async function projectFolderRepository(projectRoot, known) {
    if (known.kind === 'git' && samePath(known.root, projectRoot))
        return known;
    const repository = await resolveRepositoryRoot(projectRoot);
    if (repository.kind === 'git' && samePath(repository.root, projectRoot))
        return repository;
    return { kind: 'plain', root: projectRoot };
}
function withBase(repository, root, nested) {
    return { root, repository, nested };
}
/**
 * Which project a folder is in. By default this is the rule every reader
 * shares with the hooks (resolveNearestProjectIdentity). `namedRoot` and
 * `selectedRoot` read exactly the folder given instead, for commands that make
 * that folder a project on purpose; `selectedRoot` (folders ticked during
 * install) also treats a configuration-only file as no identity, as the
 * nearest-file walk always does.
 */
export async function resolveProjectIdentity(cwd, options = {}) {
    if (options.selectedRoot || options.namedRoot) {
        return resolveNamedProjectIdentity(cwd, { selectedRoot: options.selectedRoot });
    }
    return resolveNearestProjectIdentity(cwd);
}
//# sourceMappingURL=repositoryRoot.js.map