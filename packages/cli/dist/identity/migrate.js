import { createHash, randomUUID } from 'node:crypto';
import { access, lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { atomicWrite, stateDirectory } from '@mnemonik/local-setup';
import { isCanonicalUuid, parseIdentityFile } from '@mnemonik/shared';
const RUN_ID = /^(\d{13})-(.+)$/;
const isRunId = (value) => {
    const match = RUN_ID.exec(value);
    return !!match && isCanonicalUuid(match[2]);
};
const IDENTITY = '.mnemonik.json';
const RULE = join('.cursor', 'rules', 'memory_tools.mdc');
const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const errorCode = (error) => error.code;
async function files(path) {
    return readdir(path).catch(() => []);
}
function pathStrings(value, key = '') {
    if (typeof value === 'string')
        return /(?:cwd|path|project|workspace|root|folder)/iu.test(key) && isAbsolute(value)
            ? [value]
            : [];
    if (Array.isArray(value))
        return value.flatMap((item) => pathStrings(item, key));
    if (!value || typeof value !== 'object')
        return [];
    return Object.entries(value).flatMap(([name, item]) => [
        ...(isAbsolute(name) ? [name] : []),
        ...pathStrings(item, name),
    ]);
}
function pathsFromText(text) {
    try {
        return pathStrings(JSON.parse(text));
    }
    catch {
        const assignments = [
            ...text.matchAll(/^\s*(?:cwd|path|project|workspace|root|folder)[\w.-]*\s*=\s*["']([^"']+)["']/gimu),
        ].flatMap((match) => (match[1] && isAbsolute(match[1]) ? [match[1]] : []));
        const sections = [
            ...text.matchAll(/^\s*\[(?:projects?|workspaces?)\.["']([^"']+)["']\]\s*$/gimu),
        ].flatMap((match) => (match[1] && isAbsolute(match[1]) ? [match[1]] : []));
        return [...assignments, ...sections];
    }
}
/** Decode host directory names by following real path components, preserving hyphens. */
async function decodeHostPath(encoded, platform) {
    if (platform === 'win32') {
        const windows = encoded.match(/^([A-Za-z])--(.+)$/u);
        const drive = windows?.[1];
        const rest = windows?.[2];
        return drive && rest ? `${drive}:\\${rest.replaceAll('-', '\\')}` : undefined;
    }
    const walk = async (current, rest) => {
        if (!rest)
            return current;
        const names = (await files(current))
            .filter((name) => rest === name || rest.startsWith(`${name}-`))
            .sort((a, b) => b.length - a.length);
        for (const name of names) {
            const next = join(current, name);
            const tail = rest === name ? '' : rest.slice(name.length + 1);
            const result = await walk(next, tail);
            if (result)
                return result;
        }
        return undefined;
    };
    const exact = await walk(sep, encoded.replace(/^-/, ''));
    if (exact)
        return exact;
    return /^-?(?:home|Users|tmp|mnt|Volumes|workspace|work)-/u.test(encoded)
        ? `${sep}${encoded.replace(/^-/, '').replaceAll('-', sep)}`
        : undefined;
}
async function addConfig(candidates, sourceStatuses, name, path) {
    try {
        const raw = await readFile(path, 'utf8');
        sourceStatuses.push({ name, path, status: 'found' });
        for (const candidate of pathsFromText(raw))
            addCandidate(candidates, candidate, name);
    }
    catch (error) {
        sourceStatuses.push({
            name,
            path,
            status: errorCode(error) === 'ENOENT' ? 'absent' : 'unreadable',
        });
    }
}
function addCandidate(map, raw, source) {
    const path = resolve(raw.endsWith(IDENTITY) || raw.endsWith(RULE) ? dirname(raw) : raw);
    const sources = map.get(path) ?? new Set();
    sources.add(source);
    map.set(path, sources);
}
async function addRecordPaths(map, statuses, stateDir) {
    for (const [name, directory, nested] of [
        ['cli-project-setup', join(stateDir, 'project-setup'), false],
        ['cli-project-commands', join(stateDir, 'project-commands'), true],
    ]) {
        let found = false;
        for (const first of await files(directory)) {
            const targets = nested
                ? (await files(join(directory, first))).map((x) => join(first, x))
                : [first];
            for (const relative of targets.filter((x) => x.endsWith('.json'))) {
                found = true;
                try {
                    const record = JSON.parse(await readFile(join(directory, relative), 'utf8'));
                    const root = typeof record.root === 'string' ? record.root : record.resolvedRoot;
                    if (typeof root === 'string')
                        addCandidate(map, root, name);
                }
                catch {
                    // The source is present but unusable; status below records that without inventing a path.
                }
            }
        }
        statuses.push({ name, path: directory, status: found ? 'found' : 'absent' });
    }
}
async function collectCandidates(options) {
    const home = options.home ?? homedir();
    const state = options.stateDir ?? stateDirectory(options.platform, process.env, home);
    const platform = options.platform ?? process.platform;
    const candidates = new Map();
    const sources = [];
    for (const scanner of [join(home, '.mnemonik', 'scanner.json'), join(state, 'scanner.json')]) {
        try {
            const parsed = JSON.parse(await readFile(scanner, 'utf8'));
            sources.push({ name: 'scanner-state', path: scanner, status: 'found' });
            for (const [field, label] of [
                ['roots', 'scanner-active'],
                ['disabledRoots', 'scanner-disabled'],
                ['excludedRoots', 'scanner-disabled'],
                ['exclusions', 'scanner-disabled'],
            ])
                if (Array.isArray(parsed[field]))
                    for (const root of parsed[field])
                        if (typeof root === 'string')
                            addCandidate(candidates, root, label);
        }
        catch (error) {
            sources.push({
                name: 'scanner-state',
                path: scanner,
                status: errorCode(error) === 'ENOENT' ? 'absent' : 'unreadable',
            });
        }
    }
    await addRecordPaths(candidates, sources, state);
    const configs = [
        ['claude-config', join(home, '.claude', 'settings.json')],
        ['claude-config-and-recent', join(home, '.claude.json')],
        ['codex-config', join(home, '.codex', 'config.toml')],
        ['cursor-config', join(home, '.cursor', 'mcp.json')],
        ['cursor-config', join(home, '.cursor', 'hooks.json')],
        ['grok-config', join(home, '.grok', 'config.toml')],
    ];
    for (const [name, path] of configs)
        await addConfig(candidates, sources, name, path);
    for (const [name, directory] of [
        ['claude-recent', join(home, '.claude', 'projects')],
        ['cursor-recent', join(home, '.cursor', 'projects')],
        ['grok-recent', join(home, '.grok', 'projects')],
    ]) {
        const entries = await files(directory);
        sources.push({ name, path: directory, status: entries.length ? 'found' : 'absent' });
        for (const entry of entries) {
            const decoded = await decodeHostPath(entry, platform);
            if (decoded)
                addCandidate(candidates, decoded, name);
        }
    }
    const codexSessions = join(home, '.codex', 'sessions');
    const sessionFiles = (await files(codexSessions)).filter((name) => name.endsWith('.jsonl'));
    sources.push({
        name: 'codex-recent',
        path: join(codexSessions, '*.jsonl'),
        status: sessionFiles.length ? 'found' : 'absent',
    });
    for (const name of sessionFiles) {
        const first = (await readFile(join(codexSessions, name), 'utf8').catch(() => '')).split('\n')[0];
        if (!first)
            continue;
        try {
            for (const path of pathStrings(JSON.parse(first)))
                addCandidate(candidates, path, 'codex-recent');
        }
        catch {
            // An invalid first line carries no trusted path.
        }
    }
    const cursorData = platform === 'darwin'
        ? join(home, 'Library', 'Application Support', 'Cursor', 'User', 'workspaceStorage')
        : platform === 'win32'
            ? join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Cursor', 'User', 'workspaceStorage')
            : join(home, '.config', 'Cursor', 'User', 'workspaceStorage');
    const workspaces = await files(cursorData);
    sources.push({
        name: 'cursor-workspaces',
        path: join(cursorData, '*', 'workspace.json'),
        status: workspaces.length ? 'found' : 'absent',
    });
    for (const directory of workspaces) {
        try {
            const workspace = JSON.parse(await readFile(join(cursorData, directory, 'workspace.json'), 'utf8'));
            if (typeof workspace.folder === 'string') {
                const folder = workspace.folder.replace(/^file:\/\//u, '');
                if (isAbsolute(folder))
                    addCandidate(candidates, decodeURIComponent(folder), 'cursor-workspaces');
            }
        }
        catch {
            // Optional recent-workspace entry.
        }
    }
    for (const selected of options.paths ?? [])
        addCandidate(candidates, resolve(options.cwd ?? process.cwd(), selected), 'owner-selected');
    return { candidates, sources };
}
function classify(bytes) {
    const strict = parseIdentityFile(bytes.toString('utf8'));
    if (strict.kind === 'ok')
        return { state: 'v1', strictResult: 'ok', projectId: strict.identity.projectId };
    let parsed;
    try {
        const value = JSON.parse(bytes.toString('utf8'));
        if (value && typeof value === 'object' && !Array.isArray(value))
            parsed = value;
    }
    catch {
        // strict parser supplies the detail.
    }
    if (parsed && typeof parsed.projectId === 'string' && !isCanonicalUuid(parsed.projectId))
        return {
            state: 'invalid_uuid',
            strictResult: strict.kind,
            detail: 'projectId is not a canonical RFC 4122 UUID',
        };
    if (strict.kind === 'unknown_version' &&
        parsed &&
        parsed.schemaVersion === undefined &&
        typeof parsed.projectId === 'string' &&
        isCanonicalUuid(parsed.projectId) &&
        (parsed.projectName === undefined || typeof parsed.projectName === 'string')) {
        const droppedKeys = Object.keys(parsed).filter((key) => !['projectId', 'projectName'].includes(key));
        return {
            state: 'v0',
            strictResult: 'unknown_version',
            projectId: parsed.projectId,
            droppedKeys,
        };
    }
    return {
        state: strict.kind,
        strictResult: strict.kind,
        detail: strict.kind === 'malformed' ? strict.detail : `schemaVersion=${String(strict.version)}`,
    };
}
async function inspectProject(projectPath, sources) {
    const identityPath = join(projectPath, IDENTITY);
    try {
        const directory = await lstat(projectPath);
        if (!directory.isDirectory())
            throw Object.assign(new Error('candidate is not a directory'), { code: 'ENOTDIR' });
        await access(projectPath);
    }
    catch (error) {
        return [
            {
                kind: 'identity',
                path: identityPath,
                projectPath,
                sources,
                reachable: false,
                state: 'unreachable',
                sha256: null,
                detail: `${errorCode(error) ?? 'ERROR'}: ${error.message}`,
            },
        ];
    }
    let identity;
    try {
        const stat = await lstat(identityPath);
        if (!stat.isFile() || stat.isSymbolicLink())
            throw new Error('identity path is not a regular file');
        const bytes = await readFile(identityPath);
        identity = {
            kind: 'identity',
            path: identityPath,
            projectPath,
            sources,
            reachable: true,
            sha256: digest(bytes),
            ...classify(bytes),
        };
    }
    catch (error) {
        identity =
            errorCode(error) === 'ENOENT'
                ? {
                    kind: 'identity',
                    path: identityPath,
                    projectPath,
                    sources,
                    reachable: true,
                    state: 'absent',
                    strictResult: 'absent',
                    sha256: null,
                }
                : {
                    kind: 'identity',
                    path: identityPath,
                    projectPath,
                    sources,
                    reachable: false,
                    state: 'unreachable',
                    sha256: null,
                    detail: error.message,
                };
    }
    const result = [identity];
    const rulePath = join(projectPath, RULE);
    try {
        const bytes = await readFile(rulePath);
        const content = bytes.toString('utf8');
        const ids = [...content.matchAll(/^projectId:\s*(\S+)\s*$/gmu)].map((match) => match[1]);
        const ruleId = ids.length === 1 && isCanonicalUuid(ids[0]) ? ids[0] : undefined;
        const expected = identity.projectId;
        result.push({
            kind: 'cursor_rule',
            path: rulePath,
            projectPath,
            sources,
            reachable: true,
            sha256: digest(bytes),
            state: !ruleId
                ? 'cursor_malformed'
                : !expected
                    ? 'cursor_orphan'
                    : ruleId === expected
                        ? 'cursor_match'
                        : 'cursor_mismatch',
            ...(ruleId ? { projectId: ruleId } : {}),
            ...(!ruleId
                ? { detail: 'expected exactly one projectId line' }
                : ruleId !== expected && expected
                    ? { detail: `rule UUID differs from identity UUID ${expected}; left unchanged` }
                    : {}),
        });
    }
    catch (error) {
        if (errorCode(error) !== 'ENOENT')
            result.push({
                kind: 'cursor_rule',
                path: rulePath,
                projectPath,
                sources,
                reachable: false,
                state: 'unreachable',
                sha256: null,
                detail: error.message,
            });
    }
    return result;
}
export async function inventoryIdentityFiles(options) {
    const home = options.home ?? homedir();
    const state = options.stateDir ?? stateDirectory(options.platform, process.env, home);
    const collected = await collectCandidates(options);
    const entries = (await Promise.all([...collected.candidates].map(([path, source]) => inspectProject(path, [...source].sort()))))
        .flat()
        .map((entry) => ({
        ...entry,
        actionRequired: entry.state !== 'v1' && entry.state !== 'cursor_match',
    }))
        .sort((a, b) => a.path.localeCompare(b.path));
    const summary = Object.fromEntries([
        'v0',
        'v1',
        'absent',
        'unknown_version',
        'malformed',
        'invalid_uuid',
        'unreachable',
        'cursor_match',
        'cursor_mismatch',
        'cursor_orphan',
        'cursor_malformed',
    ].map((state) => [state, entries.filter((entry) => entry.state === state).length]));
    return {
        schemaVersion: 1,
        generatedAt: (options.now ?? (() => new Date()))().toISOString(),
        host: { platform: options.platform ?? process.platform, home, stateDirectory: state },
        sources: collected.sources,
        entries,
        summary,
    };
}
async function loadIndex(state, runId) {
    const parent = join(state, 'identity-migration');
    if (runId && !isRunId(runId))
        throw new Error('invalid identity migration run id');
    let id = runId;
    if (!id)
        for (const candidate of (await files(parent)).filter(isRunId).sort().reverse())
            if (await access(join(parent, candidate, 'index.json')).then(() => true, () => false)) {
                id = candidate;
                break;
            }
    if (!id)
        throw new Error('identity migration backup run not found');
    const path = join(parent, id, 'index.json');
    const index = JSON.parse(await readFile(path, 'utf8'));
    if (index.runId !== id || !Array.isArray(index.entries))
        throw new Error('invalid backup index');
    for (const entry of index.entries)
        if (!isAbsolute(entry.path) ||
            !/^[a-f0-9]{64}\.json$/u.test(entry.backupFile) ||
            !isCanonicalUuid(entry.projectId) ||
            !/^sha256:[a-f0-9]{64}$/u.test(entry.sha256))
            throw new Error('invalid backup index entry');
    return { index, path };
}
async function readBackup(indexPath, entry) {
    const bytes = await readFile(join(dirname(indexPath), entry.backupFile));
    const legacy = classify(bytes);
    if (digest(bytes) !== entry.sha256 ||
        legacy.state !== 'v0' ||
        legacy.projectId !== entry.projectId)
        throw new Error('backup hash or UUID mismatch');
    return bytes;
}
export async function runIdentityMigration(options) {
    const state = options.stateDir ?? stateDirectory(options.platform, process.env, options.home ?? homedir());
    if (options.mode === 'report')
        return { status: 'reported', report: await inventoryIdentityFiles(options) };
    if (options.mode === 'backup') {
        const report = await inventoryIdentityFiles(options);
        const runId = `${String((options.now ?? (() => new Date()))().getTime()).padStart(13, '0')}-${randomUUID()}`;
        const directory = join(state, 'identity-migration', runId);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const entries = [];
        for (const item of report.entries.filter((entry) => entry.kind === 'identity' && entry.state === 'v0')) {
            const bytes = await readFile(item.path);
            const legacy = classify(bytes);
            if (legacy.state !== 'v0')
                continue;
            const backupFile = `${createHash('sha256').update(item.path).digest('hex')}.json`;
            await atomicWrite(join(directory, backupFile), bytes);
            const parsed = JSON.parse(bytes.toString('utf8'));
            entries.push({
                path: item.path,
                backupFile,
                sha256: digest(bytes),
                projectId: parsed.projectId,
                ...(parsed.projectName === undefined ? {} : { projectName: parsed.projectName }),
                droppedKeys: legacy.droppedKeys ?? [],
            });
        }
        const index = { schemaVersion: 1, runId, createdAt: report.generatedAt, entries };
        const indexPath = join(directory, 'index.json');
        await atomicWrite(indexPath, Buffer.from(`${JSON.stringify(index, null, 2)}\n`));
        return { status: 'backed_up', runId, indexPath, count: entries.length, report };
    }
    const loaded = await loadIndex(state, options.runId);
    const failures = [];
    let passed = 0;
    if (options.mode === 'apply') {
        for (const entry of loaded.index.entries) {
            try {
                await readBackup(loaded.path, entry);
                const before = await readFile(entry.path);
                if (digest(before) !== entry.sha256 || classify(before).state !== 'v0')
                    throw new Error('file changed since backup');
                const next = Buffer.from(`${JSON.stringify({ schemaVersion: 1, projectId: entry.projectId, ...(entry.projectName === undefined ? {} : { projectName: entry.projectName }) }, null, 2)}\n`);
                await atomicWrite(entry.path, next);
                entry.appliedSha256 = digest(next);
                entry.appliedAt = new Date().toISOString();
                passed++;
            }
            catch (error) {
                failures.push(`${entry.path}: ${error.message}`);
            }
        }
        await atomicWrite(loaded.path, Buffer.from(`${JSON.stringify(loaded.index, null, 2)}\n`));
    }
    else if (options.mode === 'verify') {
        for (const entry of loaded.index.entries.filter((item) => item.appliedSha256)) {
            try {
                await readBackup(loaded.path, entry);
                const bytes = await readFile(entry.path);
                const parsed = parseIdentityFile(bytes.toString('utf8'));
                if (parsed.kind !== 'ok' ||
                    parsed.identity.projectId !== entry.projectId ||
                    digest(bytes) !== entry.appliedSha256)
                    throw new Error('strict parse, UUID, or applied-byte hash mismatch');
                passed++;
            }
            catch (error) {
                failures.push(`${entry.path}: ${error.message}`);
            }
        }
    }
    else {
        for (const entry of loaded.index.entries.filter((item) => item.appliedSha256)) {
            try {
                const bytes = await readBackup(loaded.path, entry);
                await atomicWrite(entry.path, bytes);
                passed++;
            }
            catch (error) {
                failures.push(`${entry.path}: ${error.message}`);
            }
        }
    }
    return {
        status: options.mode === 'apply' ? 'applied' : options.mode === 'verify' ? 'verified' : 'rolled_back',
        runId: loaded.index.runId,
        passed,
        failed: failures.length,
        failures,
    };
}
//# sourceMappingURL=migrate.js.map