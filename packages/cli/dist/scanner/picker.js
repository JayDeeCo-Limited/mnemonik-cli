import { createInterface } from 'node:readline';
import { readdir, realpath } from 'node:fs/promises';
import { parse, posix, resolve } from 'node:path';
import { isProtectedLocalPath, protectedLocalPaths, protectedPathsWithinRoot, } from '@mnemonik/shared';
import { evaluateRoot, repositoryAt } from '../project/eligibility.js';
import { classifyRepository, discoverRepositories, guessDiscoveryBoundary, repositoryName, repositoryStateLabel, } from './discover.js';
export const SCANNER_SELECTION_LIMIT = 32;
export const SCANNER_SELECTION_LIMIT_MESSAGE = 'You can leave out up to 32 repositories here. Choose a narrower folder, or watch only this project.';
export const scannerBoundaryPrompt = (shown) => shown ? `Where do your projects live? [${shown}]` : 'Where do your projects live?';
export async function runScannerBoundaryPicker(options) {
    const canonicalize = options.canonicalizePath ?? realpath;
    const home = options.home ?? process.env.HOME ?? '';
    const guess = await guessDiscoveryBoundary(options.currentFolder, home);
    const shown = home && (guess === home || guess.startsWith(`${home}/`))
        ? `~${guess.slice(home.length)}`
        : guess;
    const readline = options.readAnswer
        ? undefined
        : createInterface({ input: options.input, terminal: false });
    const answers = readline?.[Symbol.asyncIterator]();
    const next = async () => {
        if (options.readAnswer)
            return options.readAnswer();
        const response = await answers?.next();
        return response?.done ? undefined : String(response?.value ?? '');
    };
    try {
        for (;;) {
            options.output.line(scannerBoundaryPrompt(shown));
            const response = await next();
            if (response === undefined)
                throw new Error('project_folder_required');
            const answer = response.trim();
            const candidate = answer || guess;
            const expanded = candidate === '~'
                ? home
                : home && candidate.startsWith('~/')
                    ? resolve(home, candidate.slice(2))
                    : candidate;
            const absolute = expanded ? resolve(expanded) : '';
            if (!candidate || absolute === resolve(home)) {
                options.output.line('Choose a project folder inside your home folder.');
                continue;
            }
            if (absolute === parse(absolute).root) {
                options.output.line('Choose a project folder instead of the whole computer.');
                continue;
            }
            let boundary;
            try {
                boundary = await canonicalize(expanded);
            }
            catch (error) {
                options.output.line(error.code === 'ENOENT'
                    ? 'That folder does not exist. Choose another folder.'
                    : 'That folder could not be opened. Choose another folder.');
                continue;
            }
            const decision = await evaluateRoot({ kind: 'absent', root: boundary, repository: await repositoryAt(boundary), nested: [] }, {
                cwd: boundary,
                home: options.home,
                platform: options.platform,
                env: options.env,
            });
            if (!decision.allowed && decision.reason !== 'broad_workspace_parent') {
                options.output.line('That folder cannot be used. Choose another folder.');
                continue;
            }
            const protectedPaths = options.protectedPaths ?? protectedLocalPaths(options.platform, options.env, options.home);
            const enclosing = protectedPaths.find((path) => isProtectedLocalPath(boundary, [path], options.platform));
            if (enclosing) {
                options.output.line('That folder cannot be read. Choose another folder.');
                continue;
            }
            const found = await (options.discover ?? discoverRepositories)(boundary);
            const candidates = found.repositories.map((repository) => ({
                path: repository.path,
                name: repositoryName(found.root, repository.path),
                kind: repository.kind ?? 'git',
            }));
            if (!candidates.length) {
                options.output.line('No repositories were found there. Choose another folder.');
                continue;
            }
            if (found.omitted) {
                const noun = found.omitted === 1 ? 'repository was' : 'repositories were';
                options.output.line(`${found.omitted} ${noun} left out and can be added later with mnemonik add <folder>.`);
            }
            const exclusions = protectedPathsWithinRoot(boundary, protectedPaths, options.platform);
            if (exclusions.length > SCANNER_SELECTION_LIMIT)
                throw new RangeError(SCANNER_SELECTION_LIMIT_MESSAGE);
            return {
                roots: [],
                exclusions,
                boundary: found.root,
                candidates,
                repositories: found.repositories.map(({ path, state }) => ({
                    path,
                    state,
                    selected: true,
                })),
            };
        }
    }
    finally {
        readline?.close();
    }
}
function writeChoices(output, currentFolder) {
    output.line('  What should Mnemonik watch?');
    output.line();
    output.line('    1. This project');
    output.line(`  > 2. This folder and everything under it     ${currentFolder}`);
    output.line('    3. Another path');
    output.line();
}
function writeSummary(output, displayRoot, canonicalRoot, rows, truncated) {
    output.line(`  ${rows.length} repositories under ${displayRoot} will be indexed`);
    for (const row of rows.slice(0, 2)) {
        output.line(`    ${repositoryName(canonicalRoot, row.path).padEnd(15)}${repositoryStateLabel(row.state)}`);
    }
    if (rows.length > 2) {
        const more = rows.length - 2;
        output.line(`    ...            ${more} more ${more === 1 ? 'repository' : 'repositories'}`);
    }
    output.line();
    output.line('  Repositories up to 3 folders deep are included.');
    if (truncated)
        output.line('  32 shown; choose a narrower folder to see the rest');
    output.line('  Review the list and choose the ones you want.');
    output.line();
    output.line('  Repositories (all selected)');
    rows.forEach((row, index) => output.line(`    ${index + 1}. [x] ${repositoryName(canonicalRoot, row.path)} - ${repositoryStateLabel(row.state)}`));
    output.line('  Enter repository numbers to exclude, separated by commas.');
}
const pickRows = (repositories) => repositories.map(({ path, state }) => ({ path, state, selected: true }));
function exclude(answer, rows) {
    const indexes = new Set(answer
        .split(',')
        .map((value) => Number(value.trim()) - 1)
        .filter((value) => Number.isInteger(value) && value >= 0 && value < rows.length));
    rows.forEach((row, index) => (row.selected = !indexes.has(index)));
}
export async function runScannerPicker(options) {
    const readline = createInterface({ input: options.input, terminal: false });
    const answers = readline[Symbol.asyncIterator]();
    const next = async () => String((await answers.next()).value ?? '').trim();
    const canonicalize = options.canonicalizePath ?? realpath;
    const discover = options.discover ?? discoverRepositories;
    const classify = options.classify ?? classifyRepository;
    const protectedPaths = options.protectedPaths ?? protectedLocalPaths(options.platform, options.env, options.home);
    const guardRoot = async (candidate) => {
        if (options.platform !== 'win32' && posix.resolve(candidate) === '/tmp') {
            options.output.error('That folder cannot be used. Choose another folder.');
            return { status: 'cancelled', reason: 'temporary_directory' };
        }
        const repository = await repositoryAt(candidate);
        const decision = await evaluateRoot({
            kind: 'absent',
            root: candidate,
            repository,
            nested: [],
        }, {
            cwd: candidate,
            home: options.home,
            platform: options.platform,
            env: options.env,
        });
        if (!decision.allowed) {
            options.output.error('That folder cannot be used. Choose another folder.');
            return {
                status: 'cancelled',
                reason: decision.reason,
            };
        }
        const root = decision.root;
        const enclosing = protectedPaths.find((path) => isProtectedLocalPath(root, [path], options.platform));
        if (enclosing) {
            options.output.error(`Refusing ${root}: it is inside protected path ${enclosing}.`);
            return { status: 'cancelled', reason: 'protected_path' };
        }
        const exclusions = protectedPathsWithinRoot(root, protectedPaths, options.platform);
        if (exclusions.length > SCANNER_SELECTION_LIMIT) {
            options.output.error('Protected exclusions exceed 32; choose a narrower folder.');
            return { status: 'cancelled', reason: 'protected_exclusion_limit' };
        }
        for (const path of exclusions)
            options.output.line(`  Mnemonik will never read ${path}`);
        return { root, exclusions };
    };
    const loadFolder = async (path) => {
        const protectedResult = await guardRoot(path);
        if ('status' in protectedResult)
            return protectedResult;
        const canonicalRoot = await canonicalize(path);
        const found = await discover(path, {
            canonicalizePath: canonicalize,
            readDirectory: async (directory) => isProtectedLocalPath(directory, protectedPaths, options.platform)
                ? []
                : readdir(directory, { withFileTypes: true }),
        });
        return {
            root: canonicalRoot,
            rows: pickRows(found.repositories),
            autoExclusions: protectedResult.exclusions,
            truncated: found.truncated,
        };
    };
    try {
        writeChoices(options.output, options.currentFolder);
        const choice = (await next()) || '2';
        let displayRoot;
        let rows;
        let root;
        let autoExclusions;
        let truncated;
        if (choice === '1') {
            displayRoot = options.currentProject;
            const protectedResult = await guardRoot(options.currentProject);
            if ('status' in protectedResult)
                return protectedResult;
            root = await canonicalize(options.currentProject);
            autoExclusions = protectedResult.exclusions;
            truncated = false;
            const row = await classify(root, { canonicalizePath: canonicalize });
            root = row.path;
            rows = pickRows([row]);
        }
        else {
            displayRoot = choice === '3' ? await next() : options.currentFolder;
            const loaded = await loadFolder(displayRoot);
            if ('status' in loaded)
                return loaded;
            ({ root, rows, autoExclusions, truncated } = loaded);
            if (choice === '3' && rows.length === 0)
                rows = pickRows([await classify(root, { canonicalizePath: canonicalize })]);
        }
        while (true) {
            writeSummary(options.output, displayRoot, root, rows, truncated);
            exclude(await next(), rows);
            const exclusions = [
                ...new Set([
                    ...autoExclusions,
                    ...rows.filter((row) => !row.selected).map((row) => row.path),
                ]),
            ];
            if (exclusions.length <= SCANNER_SELECTION_LIMIT) {
                return { roots: [root], exclusions, repositories: rows };
            }
            options.output.line(`  ${SCANNER_SELECTION_LIMIT_MESSAGE}`);
            options.output.line('    1. Choose a narrower folder');
            options.output.line('    2. Watch only this project');
            options.output.line('    3. Back');
            const limitChoice = await next();
            if (limitChoice === '2') {
                const protectedResult = await guardRoot(options.currentProject);
                if ('status' in protectedResult)
                    return protectedResult;
                const currentRoot = await canonicalize(options.currentProject);
                const row = await classify(currentRoot, { canonicalizePath: canonicalize });
                return {
                    roots: [row.path],
                    exclusions: protectedResult.exclusions,
                    repositories: pickRows([row]),
                };
            }
            if (limitChoice !== '1') {
                return { status: 'cancelled', reason: 'selection_limit_back' };
            }
            options.output.line('  Narrower folder:');
            displayRoot = await next();
            const loaded = await loadFolder(displayRoot);
            if ('status' in loaded)
                return loaded;
            ({ root, rows, autoExclusions, truncated } = loaded);
            if (rows.length === 0)
                rows = pickRows([await classify(root, { canonicalizePath: canonicalize })]);
        }
    }
    finally {
        readline.close();
    }
}
export function consentDraft(picked) {
    if (picked.roots.length > SCANNER_SELECTION_LIMIT ||
        picked.exclusions.length > SCANNER_SELECTION_LIMIT) {
        throw new RangeError(SCANNER_SELECTION_LIMIT_MESSAGE);
    }
    return {
        roots: picked.roots,
        exclusions: picked.exclusions,
        ...(picked.candidates ? { candidates: picked.candidates, boundary: picked.boundary } : {}),
    };
}
export const scannerRootsParameter = (picked) => JSON.stringify(consentDraft(picked));
export async function reviewScannerProjects(picked, executor, output) {
    const handoff = { staged: [], actionRequired: [] };
    for (const repository of picked.repositories.filter((row) => row.selected)) {
        const result = await executor.stage({
            cwd: repository.path,
            allowCreate: true,
            allowNestedInherit: false,
        });
        if (result.status === 'staged')
            handoff.staged.push({ path: repository.path, result });
        else
            handoff.actionRequired.push({ path: repository.path, result });
        output?.line(`${repository.path}  ${result.status}`);
    }
    return handoff;
}
export function renderScannerStatus(status, output) {
    for (const repository of status.repositories) {
        const label = repositoryStateLabel(repository.state);
        output.line(repository.state === 'not_set_up'
            ? `${repository.path}  ${label} - mnemonik project init ${repository.path}`
            : `${repository.path}  ${label}`);
    }
}
//# sourceMappingURL=picker.js.map