import { protectWindowsDirectory } from './runtimeSigners.js';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { hookDeadlineMs } from './hookTimeouts.js';
import { randomUUID } from 'node:crypto';
import { RuntimeReader, hash } from './runtimeReader.js';
export const PROJECT_SETUP_MANUAL = 'Mnemonik project setup needs attention; ask the person to run `mnemonik project init` in this folder.';
const words = (value) => typeof value === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(value)
    ? value.replaceAll('_', ' ')
    : 'needs attention';
export function projectSetupActions(value) {
    return Array.isArray(value) ? value.slice(0, 20).map(words).join(', ') : 'retry, cancel';
}
const record = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
/** Parse the native tool response, never tool arguments or agent-authored command fields. */
export function setupResponse(value) {
    if (typeof value === 'string') {
        if (value.length > 64 * 1024)
            return;
        try {
            value = JSON.parse(value);
        }
        catch {
            return;
        }
    }
    if (!record(value))
        return;
    if (record(value.structuredContent))
        value = value.structuredContent;
    else {
        // Claude supplies the server's tool_response directly, not model-authored text.
        // Accept only the server envelope; no command/path extensions cross this boundary.
        const keys = ['status', 'state', 'allowedActions', 'requestId', 'expiresAt'];
        const envelope = value;
        if (!keys.every((key) => Object.hasOwn(envelope, key)) ||
            Object.keys(value).some((key) => ![...keys, 'manualAction'].includes(key)) ||
            typeof value.state !== 'string' ||
            !Array.isArray(value.allowedActions) ||
            !value.allowedActions.every((action) => typeof action === 'string') ||
            typeof value.requestId !== 'string' ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.requestId) ||
            typeof value.expiresAt !== 'string' ||
            !Number.isFinite(Date.parse(value.expiresAt)) ||
            (Object.hasOwn(value, 'manualAction') && typeof value.manualAction !== 'string'))
            return;
    }
    if (record(value) && value.status === 'project_setup_required')
        return value;
    return;
}
async function privateDirectory(path, session) {
    const created = await mkdir(path, { recursive: true, mode: 0o700 });
    const st = await lstat(path);
    if (!st.isDirectory() ||
        st.isSymbolicLink() ||
        (process.getuid && (st.uid !== process.getuid() || st.mode & 0o077)))
        throw new Error('diagnostic_unavailable');
    if (process.platform === 'win32') {
        await protectWindowsDirectory(path, created !== undefined, undefined, session);
    }
}
async function readPrivate(path) {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const st = await file.stat();
        if (!st.isFile() ||
            st.size > 64 * 1024 ||
            (process.getuid && (st.uid !== process.getuid() || st.mode & 0o077)))
            throw new Error('diagnostic_unavailable');
        return await file.readFile('utf8');
    }
    finally {
        await file.close();
    }
}
async function writeDiagnostic(path, value) {
    await privateDirectory(dirname(dirname(path)), dirname(path));
    await privateDirectory(dirname(path), dirname(path));
    const temp = `${path}.${randomUUID()}`;
    try {
        const file = await open(temp, 'wx', 0o600);
        try {
            await file.writeFile(JSON.stringify(value) + '\n');
        }
        finally {
            await file.close();
        }
        await rename(temp, path);
    }
    finally {
        await rm(temp, { force: true });
    }
}
/** What the agent is told while `project ensure` is still running detached. */
export const PROJECT_SETUP_RUNNING = 'Mnemonik project setup is still running; call session_bootstrap again in a few seconds.';
/** The CLI helper's own bound, enforced by the detached supervisor below. */
export const PROJECT_ENSURE_TIMEOUT_MS = 30_000;
const RUNNING = Symbol('running');
/**
 * The detached supervisor: runs the verified CLI bin (argv[2], args after it)
 * with the request on stdin under PROJECT_ENSURE_TIMEOUT_MS, then writes
 * { code, killed, stdout } to argv[1] through a rename, so a reader sees a
 * whole result or none. It outlives the hook process: the host may kill the
 * hook at its timeout (5 s on Claude Code and Grok) while the ensure, which
 * consumes a single-use setup request and writes .mnemonik.json, finishes.
 */
const SUPERVISOR = `
const { execFile } = require('node:child_process');
const { writeFileSync, renameSync } = require('node:fs');
const [out, bin, ...args] = process.argv.slice(1);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  const child = execFile(
    process.execPath,
    [bin, ...args],
    { shell: false, timeout: ${PROJECT_ENSURE_TIMEOUT_MS}, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, env: process.env },
    (error, stdout) => {
      const result = { code: error ? (typeof error.code === 'number' ? error.code : null) : 0, killed: !!(error && error.killed), stdout: String(stdout) };
      writeFileSync(out + '.tmp', JSON.stringify(result), { mode: 0o600 });
      renameSync(out + '.tmp', out);
    }
  );
  child.stdin.on('error', () => {});
  child.stdin.end(input);
});
`;
/** A run older than this is no longer waited for (the helper's bound plus slack). */
const RUN_STALE_MS = PROJECT_ENSURE_TIMEOUT_MS + 10_000;
async function readResult(path) {
    let raw;
    try {
        raw = await readPrivate(path);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
    const result = JSON.parse(raw);
    // Exit 3 is the helper's "action required", with its JSON on stdout.
    if (result.killed || (result.code !== 0 && result.code !== 3))
        throw new Error('helper_failed');
    try {
        return JSON.parse(String(result.stdout));
    }
    catch {
        throw new Error('helper_invalid_json');
    }
}
async function waitForResult(path, waitMs) {
    const deadline = Date.now() + waitMs;
    for (;;) {
        const result = await readResult(path);
        if (result !== undefined)
            return result;
        if (Date.now() >= deadline)
            return RUNNING;
        await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadline - Date.now())));
    }
}
/**
 * Run `project ensure` for this setup request, waiting at most `waitMs`.
 *
 * The helper runs detached (under SUPERVISOR) and its result lands in the
 * session's private directory, so a hook the host kills at its timeout loses
 * neither the setup nor its outcome. One run per session: while it is
 * running, a later handoff (the agent calls session_bootstrap again and gets a
 * fresh request id) waits for that run instead of starting another; a
 * finished run whose setup completed answers for the new request too.
 */
async function runEnsure(options) {
    await privateDirectory(dirname(options.directory), options.directory);
    await privateDirectory(options.directory, options.directory);
    const runFile = join(options.directory, 'project-setup-run.json');
    let previous;
    try {
        previous = JSON.parse(await readPrivate(runFile));
    }
    catch {
        previous = undefined;
    }
    if (previous && previous.root === options.root && typeof previous.result === 'string') {
        const result = join(options.directory, basename(previous.result));
        const finished = await readResult(result).catch(() => ({ status: 'failed' }));
        if (finished === undefined && Date.now() - previous.startedAt < RUN_STALE_MS) {
            const outcome = await waitForResult(result, options.waitMs);
            if (outcome !== RUNNING)
                await rm(runFile, { force: true });
            return outcome;
        }
        await rm(runFile, { force: true });
        await rm(result, { force: true });
        if (record(finished) && finished.status === 'done')
            return finished;
    }
    const result = join(options.directory, `project-setup-${randomUUID()}.result.json`);
    const run = {
        requestId: options.requestId,
        root: options.root,
        result: basename(result),
        startedAt: Date.now(),
    };
    await writeFileAtomic(runFile, JSON.stringify(run));
    const child = spawn(process.execPath, ['-e', SUPERVISOR, result, options.bin, 'project', 'ensure', '--agent', '--json'], {
        cwd: options.root,
        shell: false,
        detached: true,
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'ignore'],
        // Runtime injection variables and repository/PATH executables are not inherited.
        env: Object.fromEntries([
            'HOME',
            'USERPROFILE',
            'LOCALAPPDATA',
            'XDG_STATE_HOME',
            'MNEMONIK_STATE_DIR',
            'MNEMONIK_SERVER',
            'MNEMONIK_API_RESOURCE',
            'MNEMONIK_OAUTH_ISSUER',
            'SYSTEMROOT',
            'TEMP',
            'TMP',
            'TMPDIR',
        ].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]]))),
    });
    const spawnFailed = new Promise((_, reject) => child.once('error', () => reject(new Error('helper_failed'))));
    child.stdin?.on('error', () => { });
    child.stdin?.end(JSON.stringify({ requestId: options.requestId }));
    child.unref();
    const outcome = await Promise.race([waitForResult(result, options.waitMs), spawnFailed]);
    if (outcome !== RUNNING) {
        await rm(runFile, { force: true });
        await rm(result, { force: true });
    }
    return outcome;
}
async function writeFileAtomic(path, data) {
    const temp = `${path}.${randomUUID()}`;
    try {
        const file = await open(temp, 'wx', 0o600);
        try {
            await file.writeFile(data);
        }
        finally {
            await file.close();
        }
        await rename(temp, path);
    }
    finally {
        await rm(temp, { force: true });
    }
}
export async function handoffProjectSetup(input) {
    const response = setupResponse(input.response);
    if (!response)
        return;
    let root;
    let action = PROJECT_SETUP_MANUAL;
    let outcome = 'failed';
    let reason = 'manual_setup_required';
    const requestId = typeof response.requestId === 'string' && response.requestId.length <= 4096
        ? response.requestId
        : undefined;
    try {
        if (!input.cwd)
            throw new Error('safe_cwd_unavailable');
        // The binding receipt is private local state. No path from the response is read.
        const cache = JSON.parse(await readPrivate(join(dirname(input.stateFile), 'bound-context.json')));
        const [, family, body] = JSON.parse(cache.key);
        if (!input.familyId ||
            family !== input.familyId ||
            body.host !== input.host ||
            body.hostSessionId !== input.hostSessionId ||
            cache.expiresAt <= Date.now() ||
            !cache.canonicalRoot)
            throw new Error('bound_context_unavailable');
        root = await realpath(cache.canonicalRoot);
        const { findProjectIdentityDetailed } = await import('./hookRuntime.js');
        const identity = await findProjectIdentityDetailed(await realpath(input.cwd));
        if (identity.kind === 'git_unavailable' || root !== (await realpath(identity.root)))
            throw new Error('bound_root_changed');
        if (!requestId)
            throw new Error('manual_setup_required');
        const runtime = await new RuntimeReader(input.stateDir).verifyRuntime('cli').catch(() => {
            throw new Error('verified_cli_runtime_unavailable');
        });
        const bin = join(dirname(runtime.entry), 'bin.js');
        if (!runtime.manifest.files[relative(runtime.directory, bin).replaceAll('\\', '/')])
            throw new Error('verified_cli_bin_missing');
        const result = await runEnsure({
            bin,
            root,
            requestId,
            directory: dirname(input.stateFile),
            waitMs: input.waitMs ?? Math.max(0, hookDeadlineMs(input.host) - performance.now()),
        });
        if (result === RUNNING) {
            // Still running detached (runEnsure); the next session_bootstrap's hook
            // waits for it or collects its result, and never starts a second one.
            return PROJECT_SETUP_RUNNING;
        }
        // The helper may have written this folder's identity.
        (await import('./hookRuntime.js')).clearProjectIdentityCache();
        if (!record(result))
            throw new Error('helper_invalid_json');
        if (result.status === 'done') {
            outcome = 'done';
            reason = 'complete';
            action = 'Mnemonik project setup is complete; call session_bootstrap again.';
        }
        else if (['ACTION_REQUIRED', 'action_required', 'project_setup_required'].includes(String(result.status))) {
            outcome = 'ACTION_REQUIRED';
            reason = 'choice_required';
            action =
                result.action === 'mnemonik auth renew' ||
                    (Array.isArray(result.allowedActions) &&
                        result.allowedActions.includes('mnemonik auth renew'))
                    ? 'mnemonik auth renew'
                    : result.allowedActions
                        ? `Mnemonik project setup needs attention; allowed actions: ${projectSetupActions(result.allowedActions)}.`
                        : PROJECT_SETUP_MANUAL;
        }
        else
            throw new Error('helper_invalid_json');
    }
    catch (error) {
        const code = error instanceof Error ? error.message : '';
        reason = /^[a-z_]+$/.test(code) ? code : 'helper_unavailable';
        process.stderr.write(`mnemonik-hook: project setup ${reason}; manual action required\n`);
    }
    try {
        await writeDiagnostic(input.stateFile, {
            requestId,
            outcome,
            time: new Date().toISOString(),
            rootHash: root ? hash(root) : input.cwd ? hash(await realpath(input.cwd)) : null,
            action,
            reason,
        });
    }
    catch {
        process.stderr.write('mnemonik-hook: project setup diagnostic unavailable\n');
    }
    return action;
}
/** Both doctor and status consume private per-session outcomes, scoped by root hash. */
export async function pendingProjectSetup(root) {
    const rootHash = hash(await realpath(root));
    const results = [];
    const uid = process.getuid?.() ?? 'user';
    for (const host of ['credit', 'cursor', 'grok']) {
        const directory = join(tmpdir(), `mnemonik-${host}-${uid}`);
        try {
            const stat = await lstat(directory);
            if (stat.isSymbolicLink() || !stat.isDirectory())
                continue;
            for (const name of await readdir(directory)) {
                if (!/^[a-f0-9]{64}$/.test(name))
                    continue;
                try {
                    if ((await lstat(join(directory, name))).isSymbolicLink())
                        continue;
                    const diagnostic = JSON.parse(await readPrivate(join(directory, name, 'project-setup.json')));
                    if ((diagnostic.rootHash === rootHash || diagnostic.rootHash === null) &&
                        ['done', 'ACTION_REQUIRED', 'failed'].includes(diagnostic.outcome) &&
                        typeof diagnostic.action === 'string' &&
                        diagnostic.action.length < 2000 &&
                        Date.now() - Date.parse(diagnostic.time) < 24 * 60 * 60 * 1000)
                        results.push(diagnostic);
                }
                catch {
                    /* An incomplete or removed session is not a pending action. */
                }
            }
        }
        catch {
            /* Host has no local sessions. */
        }
    }
    // A later completion supersedes stale actions from another session in this root.
    results.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
    return results[0]?.outcome === 'done' ? [] : results.slice(0, 1);
}
//# sourceMappingURL=projectSetupHandoff.js.map