/**
 * `mnemonik hooks log` and doctor's "hooks last ran" lines: readers of the
 * hook flight recorder the hook packages write (`@mnemonik/shared`
 * hookTrace.ts; docs/reference/HOOKS_REFERENCE.md, "Hook trace").
 */
import { open, readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { hookTraceFile, } from '@mnemonik/shared/hook-runtime';
import { relativeTime } from './auth/status.js';
import { launchHostLabels } from './install/adapters.js';
/**
 * Every host whose hooks write a trace. VS Code Copilot runs the Claude Code
 * dispatcher and traces as `copilot`; it is not a launch host, so this list is
 * the reader's own.
 */
export const tracedHosts = ['claude-code', 'codex', 'cursor', 'copilot'];
export const tracedHostLabels = {
    ...launchHostLabels,
    copilot: 'VS Code Copilot',
};
/** A run with no `end` this long after it started is not running, whatever its pid says. */
export const UNFINISHED_AFTER_MS = 60_000;
export function processAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code === 'EPERM';
    }
}
async function readText(path, tailBytes) {
    if (tailBytes === undefined)
        return readFile(path, 'utf8').catch(() => '');
    const file = await open(path, 'r').catch(() => undefined);
    if (!file)
        return '';
    try {
        const { size } = await file.stat();
        const length = Math.min(size, tailBytes);
        const buffer = Buffer.alloc(length);
        await file.read(buffer, 0, length, size - length);
        const text = buffer.toString('utf8');
        // A cut first line is not a record.
        return length < size ? text.slice(text.indexOf('\n') + 1) : text;
    }
    finally {
        await file.close();
    }
}
function records(text) {
    const found = [];
    for (const line of text.split('\n')) {
        if (!line.trim())
            continue;
        try {
            const record = JSON.parse(line);
            if (record &&
                record.v === 1 &&
                (record.phase === 'start' || record.phase === 'input' || record.phase === 'end') &&
                typeof record.id === 'string' &&
                typeof record.ts === 'string')
                found.push(record);
        }
        catch {
            /* A torn or foreign line is skipped. */
        }
    }
    return found;
}
/** Every recorded invocation of the given hosts, its lines merged by run id, oldest first. */
export async function readHookInvocations(options) {
    const alive = options.alive ?? processAlive;
    const now = (options.now ?? Date.now)();
    const invocations = new Map();
    for (const host of options.hosts ?? tracedHosts) {
        const file = hookTraceFile(host, options.stateDir);
        const text = options.tailBytes === undefined
            ? (await readText(`${file}.1`)) + (await readText(file))
            : await readText(file, options.tailBytes);
        for (const record of records(text)) {
            const key = `${host}:${record.id}`;
            const invocation = invocations.get(key) ?? {
                host,
                id: record.id,
                pid: record.pid,
                event: null,
                ts: record.ts,
                state: 'finished',
            };
            if (record.phase === 'start') {
                invocation.start = record;
                invocation.ts = record.ts;
            }
            else if (record.phase === 'input') {
                invocation.input = record;
                if (!invocation.start)
                    invocation.ts = record.ts;
                invocation.event = record.event ?? invocation.event;
            }
            else {
                invocation.end = record;
                invocation.event ??= record.event;
            }
            invocations.set(key, invocation);
        }
    }
    const list = [...invocations.values()];
    for (const invocation of list) {
        const started = Date.parse(invocation.ts);
        const recent = Number.isFinite(started) && now - started < UNFINISHED_AFTER_MS;
        invocation.state = invocation.end
            ? 'finished'
            : recent && alive(invocation.pid)
                ? 'running'
                : 'unfinished';
    }
    return list.sort((a, b) => a.ts.localeCompare(b.ts));
}
function size(bytes) {
    return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}
function route(path) {
    return path.replace(/^\/api\/v1\/hooks\//, '').replace(/^\/api\/v1\//, '');
}
function callText(call) {
    const result = call.pending ? 'no answer by exit' : (call.status ?? call.error ?? '?');
    return `${route(call.path)} ${result} ${call.ms} ms`;
}
/** What the hook answered, in a few words. */
export function outcome(end) {
    if (end.errorKind || end.error)
        return `failed open (${[end.errorKind, end.error].filter(Boolean).join(': ')})`;
    const output = end.output;
    if (!output)
        return 'allowed, no output';
    const parts = [];
    if (output.permission === 'deny' || output.permission === 'ask')
        parts.push(output.permission);
    else if (output.decision)
        parts.push(output.decision);
    else if (output.continue === false)
        parts.push('stop');
    else
        parts.push('allow');
    const context = output.sizes.additional_context ??
        output.sizes.additionalContext ??
        output.sizes['hookSpecificOutput.additionalContext'];
    if (context)
        parts.push(`context ${size(context)}`);
    if (output.sizes.followup_message)
        parts.push(`follow-up ${size(output.sizes.followup_message)}`);
    if (output.sizes.updated_input || output.sizes['hookSpecificOutput.updatedInput'])
        parts.push('updated input');
    return parts.join(', ');
}
function clock(ts) {
    const date = new Date(ts);
    if (Number.isNaN(date.getTime()))
        return ts;
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
/** One plain line per invocation. */
export function invocationLine(invocation) {
    const tool = invocation.input?.tool ? ` (${invocation.input.tool})` : '';
    const head = `${clock(invocation.ts)}  ${tracedHostLabels[invocation.host]}  ${invocation.event ?? 'unknown event'}${tool}`;
    if (!invocation.end)
        return invocation.state === 'running'
            ? `${head}  still running`
            : invocation.input
                ? `${head}  UNFINISHED: started but never finished (the coding tool may have stopped it)`
                : `${head}  UNFINISHED: stopped before the coding tool finished sending the event`;
    const calls = invocation.end.calls.length
        ? `server: ${invocation.end.calls.map(callText).join(', ')}`
        : 'no server calls';
    return `${head}  ${outcome(invocation.end)}  ${invocation.end.durationMs} ms  ${calls}`;
}
/**
 * Print the last `last` invocations, then, with `follow`, each invocation as it
 * finishes (or is found unfinished) until the signal aborts.
 */
export async function hooksLog(options) {
    const shown = new Set();
    const all = await readHookInvocations(options);
    const recent = all.slice(-options.last);
    for (const invocation of all)
        if (invocation.state !== 'running')
            shown.add(`${invocation.host}:${invocation.id}`);
    for (const invocation of recent)
        options.print(invocation);
    const follow = options.follow;
    if (!follow)
        return recent;
    while (!follow.signal?.aborted) {
        try {
            await sleep(follow.pollMs ?? 500, undefined, { signal: follow.signal });
        }
        catch (error) {
            if (error.name === 'AbortError')
                break;
            throw error;
        }
        for (const invocation of await readHookInvocations(options)) {
            const key = `${invocation.host}:${invocation.id}`;
            if (invocation.state === 'running' || shown.has(key))
                continue;
            shown.add(key);
            options.print(invocation);
        }
    }
    return recent;
}
/**
 * Doctor: one plain line per coding tool that has a trace, saying when its
 * hooks last ran and, when that run was stopped, where to look. No event
 * names, ids or paths.
 */
export async function hookActivityLines(stateDir, now, alive = processAlive) {
    const lines = [];
    for (const host of tracedHosts) {
        const invocations = await readHookInvocations({
            hosts: [host],
            stateDir,
            alive,
            now: () => now,
            tailBytes: 64 * 1024,
        });
        const last = invocations.at(-1);
        if (!last)
            continue;
        const when = relativeTime(Date.parse(last.ts), now);
        const label = tracedHostLabels[host];
        lines.push(last.state === 'unfinished'
            ? `${label} hooks last ran ${when} but were stopped before they finished. Run mnemonik hooks log --host ${host} for detail.`
            : `${label} hooks last ran ${when}.`);
    }
    return lines;
}
//# sourceMappingURL=hooksLog.js.map