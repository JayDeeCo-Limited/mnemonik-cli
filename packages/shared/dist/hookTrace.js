/**
 * Hook flight recorder: a bounded, local, append-only record of every hook
 * invocation on this machine, so an agent or support can see what a real
 * editor sent to the hooks and what they answered.
 *
 * One JSON Lines file per host under the Mnemonik state folder
 * (`<state>/hook-trace/<host>.jsonl`, directory 0700, file 0600), rotated to a
 * single `.1` file past {@link HOOK_TRACE_MAX_BYTES}. Each invocation writes
 * up to three lines sharing one run `id`: `start` as soon as the recorder
 * starts (before stdin is read, so a run the editor kills while it is still
 * sending the event leaves a trace), `input` once the event is known, and
 * `end` when the process exits. A run with no `end` is one the editor killed
 * (a signal ends the process without Node's `exit` event); one with only
 * `start` was killed before its event arrived.
 *
 * The record holds identifiers, field names and sizes only. It never holds
 * prompt text, tool input or output bodies, file contents, transcript
 * contents, credentials or the environment: payload values are reduced to
 * their byte size, and the one free-text field (an error message) passes
 * through `scrubSecrets`.
 *
 * Every write is synchronous and short (one line), and every failure is
 * swallowed: the recorder can never throw into a hook or change its output.
 * Being synchronous, a write to a hung network home directory would block the
 * hook. `MNEMONIK_HOOK_TRACE=off` disables it.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeSync, } from 'node:fs';
import { dirname, join } from 'node:path';
import { open as openAsync, stat as statAsync } from 'node:fs/promises';
import { mnemonikStateDirectory } from './protectedPaths.js';
import { ensureWindowsPrivateDirectorySync } from './runtimeSigners.js';
import { scrubSecrets } from './secretPatterns.js';
/** Past this size the file is renamed to `<host>.jsonl.1` (replacing any older one). */
export const HOOK_TRACE_MAX_BYTES = 2 * 1024 * 1024;
export const HOOK_TRACE_ENV = 'MNEMONIK_HOOK_TRACE';
const MAX_FIELDS = 64;
const MAX_CALLS = 64;
const MAX_ERROR_CHARS = 80;
const SAFE_ID = /^[A-Za-z0-9@._+:-]{1,128}$/;
const SAFE_NAME = /^[A-Za-z0-9@._+:/-]{1,120}$/;
const SAFE_ENUM = /^[A-Za-z_]{1,24}$/;
export function hookTraceEnabled(env = process.env) {
    const value = env[HOOK_TRACE_ENV]?.trim().toLowerCase();
    return !value || !['off', '0', 'false', 'no', 'disabled'].includes(value);
}
export function hookTraceDirectory(stateDir = mnemonikStateDirectory()) {
    return join(stateDir, 'hook-trace');
}
export function hookTraceFile(host, stateDir) {
    return join(hookTraceDirectory(stateDir), `${host}.jsonl`);
}
const preparedDirectories = new Set();
function ensurePrivateDirectory(directory) {
    if (preparedDirectories.has(directory))
        return;
    if (process.platform === 'win32')
        ensureWindowsPrivateDirectorySync(directory);
    else {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const stat = lstatSync(directory);
        if (!stat.isDirectory() ||
            stat.isSymbolicLink() ||
            (process.getuid && stat.uid !== process.getuid()) ||
            stat.mode & 0o077)
            throw new Error('hook trace directory is not private');
    }
    preparedDirectories.add(directory);
}
function openTrace(file) {
    return openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
}
/** Whether `file` still names the file `fd` has open: no other writer rotated it away. */
function sameFile(file, fd) {
    try {
        const opened = fstatSync(fd, { bigint: true });
        const named = statSync(file, { bigint: true });
        return opened.ino === named.ino && opened.dev === named.dev;
    }
    catch {
        return false;
    }
}
/** A rotation lock older than this was left by a killed writer. */
const STALE_LOCK_MS = 10_000;
function takeLock(lock) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            closeSync(openSync(lock, 'wx', 0o600));
            return true;
        }
        catch {
            try {
                if (attempt > 0 || Date.now() - lstatSync(lock).mtimeMs < STALE_LOCK_MS)
                    return false;
                unlinkSync(lock);
            }
            catch {
                /* Gone already: try once more. */
            }
        }
    }
    return false;
}
/**
 * Rotate the full file `fd` has open to `.1`. Hooks run concurrently, so
 * rotation is serialised by an exclusive lock file and, while holding it,
 * happens only when the path still names the file `fd` has open: a writer
 * that finds another already rotated (or rotating) appends to the fresh file
 * instead of rotating again and replacing the full file in `.1`.
 */
function rotate(file, fd) {
    const lock = `${file}.lock`;
    if (!takeLock(lock))
        return;
    try {
        if (sameFile(file, fd))
            renameSync(file, `${file}.1`);
    }
    finally {
        try {
            unlinkSync(lock);
        }
        catch {
            /* Already removed as stale: nothing to release. */
        }
    }
}
/** Append one line, rotating first when the file is full. Throws; callers swallow. */
export function appendHookTraceLine(file, record) {
    ensurePrivateDirectory(dirname(file));
    const line = `${JSON.stringify(record)}\n`;
    let fd = openTrace(file);
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid()))
            throw new Error('hook trace file is not ours');
        if (stat.size > 0 && stat.size + Buffer.byteLength(line) > HOOK_TRACE_MAX_BYTES) {
            try {
                rotate(file, fd);
            }
            finally {
                closeSync(fd);
                fd = -1;
            }
            fd = openTrace(file);
        }
        writeSync(fd, line);
    }
    finally {
        if (fd >= 0)
            closeSync(fd);
    }
}
function byteSize(value) {
    if (typeof value === 'string')
        return Buffer.byteLength(value);
    try {
        return Buffer.byteLength(JSON.stringify(value) ?? '');
    }
    catch {
        return 0;
    }
}
function safe(value, pattern) {
    return typeof value === 'string' && pattern.test(value) ? value : undefined;
}
function sizesOf(object, prefix = '') {
    const sizes = {};
    for (const key of Object.keys(object).slice(0, MAX_FIELDS))
        if (SAFE_NAME.test(key))
            sizes[prefix + key] = byteSize(object[key]);
    return sizes;
}
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
/** Field names and sizes, the decision fields' short enum values, never text. */
export function summarizeHookOutput(text) {
    const output = { bytes: Buffer.byteLength(text), sizes: {} };
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        return output;
    }
    if (!isObject(value))
        return output;
    const nested = isObject(value.hookSpecificOutput) ? value.hookSpecificOutput : undefined;
    const { hookSpecificOutput: _nested, ...top } = value;
    output.sizes = { ...sizesOf(top), ...(nested ? sizesOf(nested, 'hookSpecificOutput.') : {}) };
    const permission = safe(value.permission ?? nested?.permissionDecision, SAFE_ENUM);
    const decision = safe(value.decision, SAFE_ENUM);
    if (permission)
        output.permission = permission;
    if (decision)
        output.decision = decision;
    if (typeof value.continue === 'boolean')
        output.continue = value.continue;
    return output;
}
function routeOf(input) {
    try {
        const href = typeof input === 'string'
            ? input
            : input instanceof URL
                ? input.href
                : input.url;
        return new URL(String(href)).pathname
            .split('/')
            .map((segment) => (segment.length >= 16 && /\d/.test(segment)) || /[%@]/.test(segment) ? ':id' : segment)
            .join('/')
            .slice(0, 200);
    }
    catch {
        return 'unknown';
    }
}
export function errorKind(error) {
    const failure = error;
    if (failure?.name === 'TimeoutError')
        return 'timeout';
    if (failure?.name === 'AbortError')
        return 'aborted';
    const code = failure?.cause?.code ?? failure?.code;
    if (typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code))
        return code;
    return safe(failure?.name, /^\w{1,40}$/) ?? 'error';
}
/** The message, whitespace folded, secrets scrubbed, cut to 80 characters. */
export function scrubHookTraceMessage(error) {
    const text = error instanceof Error ? error.message : String(error);
    return scrubSecrets(text.replace(/\s+/g, ' ').trim()).slice(0, MAX_ERROR_CHARS);
}
export class HookTrace {
    host;
    file;
    hookVersion;
    id = randomBytes(8).toString('hex');
    startedAt = performance.now();
    opened = false;
    started = false;
    ended = false;
    event = null;
    outputSummary = null;
    error;
    errorKind;
    projectId;
    calls = [];
    inFlight = new Set();
    constructor(host, file, hookVersion) {
        this.host = host;
        this.file = file;
        this.hookVersion = hookVersion;
    }
    get enabled() {
        return this.file !== undefined;
    }
    write(record) {
        if (!this.file)
            return;
        try {
            appendHookTraceLine(this.file, record);
        }
        catch {
            /* A diagnostic record never costs the hook anything. */
        }
    }
    /**
     * Write the `start` line: pid, run id and time since process start, nothing
     * from the editor. Runs before stdin is read, so a run killed while the
     * editor is still sending its event leaves this line.
     */
    open() {
        if (!this.file || this.opened)
            return;
        this.opened = true;
        this.write({
            v: 1,
            phase: 'start',
            ts: new Date().toISOString(),
            host: this.host,
            ...(this.hookVersion ? { hookVersion: this.hookVersion } : {}),
            pid: process.pid,
            id: this.id,
            processMs: Math.round(process.uptime() * 1000),
        });
    }
    /** Write the `input` line. `input` is the parsed payload, or null when none parsed. */
    begin(input, event) {
        if (!this.file || this.started)
            return;
        this.open();
        this.started = true;
        try {
            const payload = isObject(input) ? input : {};
            this.event =
                safe(event, SAFE_NAME) ??
                    safe(payload.hook_event_name, SAFE_NAME) ??
                    safe(payload.hookEventName, SAFE_NAME) ??
                    null;
            const roots = Array.isArray(payload.workspace_roots) ? payload.workspace_roots : [];
            const cwd = typeof payload.cwd === 'string' && payload.cwd
                ? payload.cwd
                : typeof roots[0] === 'string'
                    ? roots[0]
                    : process.cwd();
            const record = {
                v: 1,
                phase: 'input',
                ts: new Date().toISOString(),
                host: this.host,
                pid: process.pid,
                id: this.id,
                event: this.event,
                inputBytes: isObject(input) ? byteSize(input) : 0,
                fields: sizesOf(payload),
                readMs: Math.round(performance.now() - this.startedAt),
            };
            const hostVersion = safe(payload.cursor_version ?? payload.version, /^[\w.+-]{1,40}$/);
            if (hostVersion)
                record.hostVersion = hostVersion;
            const ids = [
                ['sessionId', 'session_id'],
                ['conversationId', 'conversation_id'],
                ['generationId', 'generation_id'],
                ['agentId', 'agent_id'],
                ['agentId', 'subagent_id'],
                ['turnId', 'turn_id'],
            ];
            for (const [name, key] of ids) {
                const id = safe(payload[key], SAFE_ID);
                if (id && record[name] === undefined)
                    record[name] = id;
            }
            const tool = safe(payload.tool_name, SAFE_NAME);
            if (tool)
                record.tool = tool;
            if (cwd.length <= 1024)
                record.cwd = cwd;
            this.write(record);
        }
        catch {
            /* Never into the hook. */
        }
    }
    /** The exact text the hook wrote to stdout (or nothing). */
    output(text) {
        if (!this.file || text === null || text === undefined)
            return;
        try {
            this.outputSummary = summarizeHookOutput(text);
        }
        catch {
            /* Never into the hook. */
        }
    }
    /** The error the hook failed open on. */
    fail(error) {
        if (!this.file)
            return;
        try {
            this.errorKind = errorKind(error);
            this.error = scrubHookTraceMessage(error);
        }
        catch {
            this.errorKind = 'error';
        }
    }
    project(projectId) {
        if (projectId && !this.projectId && SAFE_ID.test(projectId))
            this.projectId = projectId;
    }
    /** A call has gone out; {@link settle} records it, {@link finish} records it as pending. */
    callStarted(input) {
        const token = { input, startedAt: performance.now() };
        if (this.file)
            this.inFlight.add(token);
        return token;
    }
    settle(token, status, error) {
        this.inFlight.delete(token);
        this.call(token.input, token.startedAt, status, error);
    }
    call(input, startedAt, status, error) {
        if (!this.file || this.calls.length >= MAX_CALLS)
            return;
        try {
            this.calls.push({
                path: routeOf(input),
                ...(status !== undefined ? { status } : { error: errorKind(error) }),
                ms: Math.round(performance.now() - startedAt),
            });
        }
        catch {
            /* Never into the hook. */
        }
    }
    /** Write the `end` line once. Runs from the process `exit` event. */
    finish(exitCode = 0) {
        if (!this.file || this.ended)
            return;
        this.open();
        this.ended = true;
        for (const { input, startedAt } of this.inFlight) {
            if (this.calls.length >= MAX_CALLS)
                break;
            try {
                this.calls.push({
                    path: routeOf(input),
                    pending: true,
                    ms: Math.round(performance.now() - startedAt),
                });
            }
            catch {
                /* Never into the hook. */
            }
        }
        this.inFlight.clear();
        this.write({
            v: 1,
            phase: 'end',
            ts: new Date().toISOString(),
            host: this.host,
            pid: process.pid,
            id: this.id,
            event: this.event,
            ...(this.projectId ? { projectId: this.projectId } : {}),
            output: this.outputSummary,
            calls: this.calls,
            durationMs: Math.round(performance.now() - this.startedAt),
            processMs: Math.round(process.uptime() * 1000),
            exitCode,
            ...(this.errorKind ? { errorKind: this.errorKind } : {}),
            ...(this.error ? { error: this.error } : {}),
        });
    }
}
let active;
/** Resolved project ids reach the trace from the shared identity cache. */
export function noteHookTraceProject(projectId) {
    active?.project(projectId);
}
/**
 * Start this process's recorder: one per hook process. Writes the `start`
 * line at once (so call it before reading stdin), times every `fetch` the
 * process makes (path, status or error kind, duration; `pending` when still
 * waiting at exit) and writes the `end` line from the process `exit` event,
 * so every exit path is covered.
 */
export function startHookTrace(options) {
    if (active)
        return active;
    let file;
    try {
        if (hookTraceEnabled(options.env))
            file = hookTraceFile(options.host, options.stateDir ?? mnemonikStateDirectory(process.platform, options.env ?? process.env));
    }
    catch {
        file = undefined;
    }
    const trace = new HookTrace(options.host, file, options.hookVersion);
    active = trace;
    if (!file)
        return trace;
    const original = globalThis.fetch;
    if (typeof original === 'function') {
        globalThis.fetch = async (input, init) => {
            const token = trace.callStarted(input);
            try {
                const response = await original.call(globalThis, input, init);
                trace.settle(token, response.status);
                return response;
            }
            catch (error) {
                trace.settle(token, undefined, error);
                throw error;
            }
        };
    }
    process.once('exit', (code) => trace.finish(typeof code === 'number' ? code : 0));
    trace.open();
    return trace;
}
/** The trace window a hook reports its recent misses over. */
export const HOOK_MISS_WINDOW_MS = 30 * 60 * 1000;
/**
 * How much of the trace file's end is read for that summary, asynchronously
 * and once per hook process (it used to read 256 KB synchronously on every
 * call). About a hundred hook runs: the recent ones are what the count is for.
 */
const HOOK_MISS_TAIL_BYTES = 64 * 1024;
/** Sent on the main hook call: `<missed>/<total>` server calls over the window. */
export const HOOK_MISSES_HEADER = 'x-mnemonik-hook-misses';
/**
 * How many of this host's recent calls to the server did not get an answer
 * in time: a timeout, a connection error, a gateway or server error, a call
 * still pending at exit, or a whole run the editor killed at its own hook
 * timeout. Each of these is silent where it happens (the hook fails open, by
 * design), so the main hook call carries the count to the server, and
 * machine health tells the agent when a machine is losing memory this way
 * (limits audit #2-#3: the hook budget chain fails silently).
 *
 * Reads only the end of the trace file, and never throws.
 */
export async function summarizeRecentHookCalls(host, options = {}) {
    // With the recorder off there is no file, which reads as nothing to report.
    const empty = { missed: 0, total: 0 };
    const now = options.now ?? Date.now();
    const since = now - (options.windowMs ?? HOOK_MISS_WINDOW_MS);
    let text;
    try {
        const file = hookTraceFile(host, options.stateDir);
        const size = (await statAsync(file)).size;
        const handle = await openAsync(file, 'r');
        try {
            const length = Math.min(size, HOOK_MISS_TAIL_BYTES);
            const buffer = Buffer.alloc(length);
            await handle.read(buffer, 0, length, size - length);
            text = buffer.toString('utf8');
        }
        finally {
            await handle.close();
        }
    }
    catch {
        return empty;
    }
    const started = new Map();
    const ended = new Set();
    let missed = 0;
    let total = 0;
    for (const line of text.split('\n')) {
        let record;
        try {
            record = JSON.parse(line);
        }
        catch {
            continue; // the first line of the tail is usually cut
        }
        const at = Date.parse(record.ts);
        if (!(at >= since))
            continue;
        if (record.phase === 'start')
            started.set(record.id, at);
        else if (record.phase === 'end') {
            ended.add(record.id);
            // One logical call per path in a run: a hedged request's aborted
            // loser, or a first attempt whose retry was answered, is not a miss.
            // Only a call none of whose requests got an answer is.
            const answeredByPath = new Map();
            for (const call of record.calls ?? []) {
                const status = call.status ?? 0;
                const answered = call.error === undefined &&
                    call.pending !== true &&
                    status > 0 &&
                    status < 500 &&
                    status !== 408 &&
                    status !== 429;
                answeredByPath.set(call.path, (answeredByPath.get(call.path) ?? false) || answered);
            }
            for (const answered of answeredByPath.values()) {
                total++;
                if (!answered)
                    missed++;
            }
        }
    }
    // A run with a start and no end was ended by the editor at its timeout.
    for (const [id, at] of started) {
        if (ended.has(id) || now - at < 60_000)
            continue;
        total++;
        missed++;
    }
    return { missed, total };
}
const summaries = new Map();
function summaryFor(host, options) {
    const key = `${host}\0${options.stateDir ?? ''}\0${options.now ?? ''}`;
    const cached = summaries.get(key);
    if (cached)
        return cached;
    const entry = {
        read: Promise.resolve({}),
    };
    entry.read = summarizeRecentHookCalls(host, options).then(({ missed, total }) => {
        const value = total > 0 ? { [HOOK_MISSES_HEADER]: `${missed}/${total}` } : {};
        entry.value = value;
        return value;
    });
    summaries.set(key, entry);
    return entry;
}
/**
 * The header the main hook call carries, or none when nothing was called
 * recently. Read once per hook process, without blocking it.
 */
export function hookMissesHeaders(host, options = {}) {
    return summaryFor(host, options).read;
}
/**
 * The header if the read has finished, else none, and never a wait: the
 * count only feeds machine health, so it must never delay a hook request
 * (the hook starts the read when it loads, so it is normally ready).
 */
export function hookMissesHeadersIfReady(host, options = {}) {
    return summaryFor(host, options).value ?? {};
}
//# sourceMappingURL=hookTrace.js.map