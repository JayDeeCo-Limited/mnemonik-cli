/**
 * Source redaction in its own processes, without a clock deciding a file's
 * fate. Used by the server (Swift, and every file of a megabyte or more) and
 * by the scanner (every file of a megabyte or more), each supplying how to
 * start its child (`spawn`).
 *
 * Why a separate process at all: Swift's tree-sitter grammar, compiled by
 * TurboFan, allocates 0.5 to 0.7 GB and can take Node down with it, so Swift
 * is parsed in Liftoff-only children (measured 18 October 2026). What this
 * replaces forked one child per upload batch, capped its heap at 128 MB and
 * killed it after 5 seconds (`source_redaction_timeout`). A large Swift file,
 * or any Swift file on a busy task, then failed redaction and its whole
 * upload batch failed with it, every retry, with no line saying why: the same
 * shape as MNEMONIK-CV, where a wall clock and a fixed heap decided a file's
 * fate (stream F2 fixed that one in its parse pool, whose design this
 * mirrors: src/agent/codeConnections/parsePool.ts on fix/scale-f2-code).
 *
 *  - A persistent child keeps the grammar loaded between files; uploads queue
 *    for it in arrival order.
 *  - Its heap is sized from the input: a file of LARGE_FILE_BYTES or more gets
 *    its own child with 128 MB plus 16 MB per MB of source (110 MB per MB for
 *    Vue and Svelte components, whose compilers build JavaScript syntax trees),
 *    and a file that still runs out of memory is tried once more with twice
 *    that.
 *  - Memory admission: up to MAX_LARGE_CHILDREN large children run at once,
 *    each only when the memory it needs fits what the probe reports (the ECS
 *    task's limit less the container's memory.current on the server; the
 *    cgroup working set, or the scanner's own total budget less its resident
 *    memory, on a machine), less a reserve, less what running children may
 *    still grow into and what admitted-but-waiting work holds. A child that
 *    would not fit even alone is never started, since running the container
 *    out of memory ends every request it is serving; the file fails counted
 *    (`source_redaction_exceeds_memory`).
 *  - No deadline, but a ceiling on work: a file that has used
 *    CPU_CEILING_SECONDS of the child's CPU (about ten times the slowest file
 *    measured) fails (`source_redaction_cpu_ceiling`) and its child is
 *    replaced, so no file holds a child indefinitely. A child that holds a file
 *    and has used no CPU for STALL_POLLS polls in a row is presumed hung.
 *    CPU time comes from /proc on Linux and `ps` elsewhere; where neither
 *    exists (Windows), only an exit ends a file.
 *  - Interactive files (an agent's file_push) are served before background
 *    ingest, in both queues.
 *  - A failure is counted (`source_redaction.failed`), logged with the path's
 *    extension and size, and thrown for that file alone: callers store the
 *    other files and report the failed one as not uploaded, with its reason.
 *    Redacted text is never replaced by unredacted text.
 */
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { parentPort } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { scrubSourceSecretsInProcess } from './sourceRedaction.js';
const MB = 1024 * 1024;
/** At and above this length a file gets a child of its own, sized from it. */
export const LARGE_FILE_BYTES = 1 * MB;
/** The shared child's heap: comfortably above any file under LARGE_FILE_BYTES. */
export const SHARED_HEAP_MB = 256;
/** A shared child is replaced once its resident memory passes this (WebAssembly memory never shrinks). */
const SHARED_RECYCLE_RSS_MB = 512;
export const STALL_POLL_MS = 5_000;
/** One minute without any CPU while holding a file. */
export const STALL_POLLS = 12;
/**
 * CPU a single file may use. Generous: the slowest files measured (26 October
 * 2026, loaded host) were a 3.1 MB Svelte component at 23 s and a 9.9 MB Vue
 * component at 17 s.
 */
export const CPU_CEILING_SECONDS = 300;
/**
 * CPU a single file may use in the shared small-file child before it is sent
 * to a child of its own: one tenant's crafted file must not stall small-file
 * redaction for everyone on the task.
 */
export const SHARED_CPU_CEILING_SECONDS = 30;
/**
 * Failures that say something about the file itself, which a scanner counts
 * as strikes against that revision: it ran to the CPU ceiling, ran out of
 * memory at twice its heap, or could not be redacted. Not counted: a child
 * that would not fit in memory now, or one that stalled; those are retried.
 */
export const STRIKE_REASONS = new Set([
    'source_redaction_cpu_ceiling',
    'source_redaction_out_of_memory',
    'source_redaction_invalid_result',
]);
/** Large children a pool runs at once, memory permitting. */
export const MAX_LARGE_CHILDREN = 2;
/**
 * A scanner's total memory, itself and its redaction children: the systemd
 * unit's MemoryMax, and the budget used where no control group limits it.
 */
export const SCANNER_TOTAL_MEMORY_MB = 1536;
/**
 * The heap a file's child may use: 128 MB plus 16 MB per MB of source (as F2's
 * parse pool), or 110 MB per MB for Vue and Svelte components. Measured 26
 * October 2026 (Liftoff-only): a 9.9 MB Vue component of about 100,000
 * template nodes ran out of memory at 900 MB and completed at 1,228 MB (peak
 * resident 1.13 GB); a 3.1 MB Svelte component completed at 500 MB.
 */
export function redactionHeapMb(bytes, filePath = '') {
    const perMb = COMPONENT_SOURCE.test(filePath) ? 110 : 16;
    return Math.ceil(128 + perMb * (bytes / MB));
}
const COMPONENT_SOURCE = /\.(?:vue|svelte)$/i;
/** Resident memory a child uses beyond its heap (code, grammars, buffers). */
export const CHILD_OVERHEAD_MB = 128;
/** Memory left free for everything else when a large child is admitted. */
export const ADMISSION_RESERVE_MB = 256;
const readText = (path) => readFileSync(path, 'utf8');
function numberIn(read, path) {
    try {
        const text = read(path).trim();
        if (text === 'max')
            return null;
        const value = Number(text);
        return Number.isFinite(value) ? value : null;
    }
    catch {
        return null;
    }
}
function statField(read, path, names) {
    try {
        const lines = read(path).split('\n');
        for (const name of names) {
            const line = lines.find((entry) => entry.startsWith(`${name} `));
            if (line)
                return Number(line.slice(name.length + 1)) || 0;
        }
    }
    catch {
        // No stat file: nothing reclaimable is subtracted.
    }
    return 0;
}
/** This process's control group memory (v2, else v1), or null where there is none. */
export function cgroupMemory(read = readText) {
    try {
        const line = read('/proc/self/cgroup')
            .split('\n')
            .find((entry) => entry.startsWith('0::'));
        if (line) {
            const path = line.slice(3).trim();
            const dir = `/sys/fs/cgroup${path === '/' ? '' : path}`;
            const current = numberIn(read, `${dir}/memory.current`);
            if (current !== null) {
                const limit = numberIn(read, `${dir}/memory.max`);
                const inactive = statField(read, `${dir}/memory.stat`, ['inactive_file']);
                return {
                    limitMb: limit === null ? null : limit / MB,
                    currentMb: current / MB,
                    workingSetMb: Math.max(0, current - inactive) / MB,
                };
            }
        }
    }
    catch {
        // Not Linux, or no v2 hierarchy: try v1.
    }
    const usage = numberIn(read, '/sys/fs/cgroup/memory/memory.usage_in_bytes');
    if (usage === null)
        return null;
    const limit = numberIn(read, '/sys/fs/cgroup/memory/memory.limit_in_bytes');
    const inactive = statField(read, '/sys/fs/cgroup/memory/memory.stat', [
        'total_inactive_file',
        'inactive_file',
    ]);
    return {
        limitMb: limit === null || limit >= 2 ** 60 ? null : limit / MB,
        currentMb: usage / MB,
        workingSetMb: Math.max(0, usage - inactive) / MB,
    };
}
/**
 * The API server's probe: the task's memory limit (ECS task metadata, else the
 * cgroup, else the host: the caller supplies it) less the container's working
 * set (memory.current less inactive file cache, which the kernel reclaims
 * first). Without a control group, this process's resident memory.
 */
export function containerMemoryProbe(limitMb, read = readText) {
    return async () => {
        const group = cgroupMemory(read);
        return {
            limitMb: await limitMb(),
            usedMb: group ? group.workingSetMb : process.memoryUsage().rss / MB,
            includesChildren: group !== null,
            source: group ? 'container_working_set' : 'process_resident',
        };
    };
}
/**
 * A scanner's probe. Under a control group limit (Linux, the systemd unit):
 * the limit less the working set, since the scanner's file reads leave page
 * cache the kernel reclaims before it would kill anything. Elsewhere (macOS,
 * Windows, an unlimited group): the scanner's own total budget less its own
 * resident memory, never the machine's free memory, which on macOS counts
 * compressed and cached pages as used and would refuse almost everything.
 */
export function scannerMemoryProbe(totalBudgetMb = SCANNER_TOTAL_MEMORY_MB, read = readText, 
/** Children are worker threads, so this process's own resident memory includes them. */
childrenInProcess = false) {
    return () => {
        const group = cgroupMemory(read);
        if (group && group.limitMb !== null)
            return {
                limitMb: group.limitMb,
                usedMb: group.workingSetMb,
                includesChildren: true,
                source: 'cgroup_working_set',
            };
        return {
            limitMb: totalBudgetMb,
            usedMb: process.memoryUsage().rss / MB,
            includesChildren: childrenInProcess,
            source: 'own_budget',
        };
    };
}
const CLOCK_TICKS_PER_SECOND = 100;
function parsePsTime(text) {
    // [[DD-]HH:]MM:SS[.ss]
    const trimmed = text.trim();
    if (!trimmed)
        return null;
    const [dayPart, rest] = trimmed.includes('-') ? trimmed.split('-', 2) : ['0', trimmed];
    const parts = (rest ?? '').split(':').map(Number);
    if (parts.some((part) => !Number.isFinite(part)))
        return null;
    let seconds = 0;
    for (const part of parts)
        seconds = seconds * 60 + part;
    return seconds + Number(dayPart) * 86_400;
}
/** CPU seconds (user + system) a process has used: /proc on Linux, `ps` elsewhere, null on Windows. */
export async function processCpuSeconds(pid) {
    if (!pid)
        return null;
    if (process.platform === 'linux') {
        try {
            const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.split(' ') ?? [];
            const ticks = Number(fields[11]) + Number(fields[12]);
            return Number.isFinite(ticks) ? ticks / CLOCK_TICKS_PER_SECOND : null;
        }
        catch {
            return null;
        }
    }
    if (process.platform === 'win32')
        return null;
    return new Promise((resolve) => {
        execFile('ps', ['-o', 'time=', '-p', String(pid)], { timeout: 4_000 }, (error, stdout) => resolve(error ? null : parsePsTime(String(stdout))));
    });
}
export { parsePsTime as parsePsTimeForTest };
function residentMb(pid) {
    if (!pid || process.platform !== 'linux')
        return null;
    try {
        const match = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
        return match ? Number(match[1]) / 1024 : null;
    }
    catch {
        return null;
    }
}
/**
 * A worker thread as a redaction child. Its heap is the Worker's
 * resourceLimits (sized per file by the caller), and running out of it ends
 * the worker, not the process, reported as out of memory so the pool retries
 * with twice the heap. Its CPU time comes from the Worker itself, on every
 * platform, even while its own thread is busy (review of 26 Oct 2026: on
 * Windows there was no CPU ceiling or stall detection).
 */
export function redactionWorkerThread(worker) {
    const events = new EventEmitter();
    let outOfMemory = false;
    let online = false;
    worker.once('online', () => {
        online = true;
    });
    worker.on('message', (message) => events.emit('message', message));
    worker.on('error', (error) => {
        if (error.code === 'ERR_WORKER_OUT_OF_MEMORY')
            outOfMemory = true;
        else
            events.emit('error', error);
    });
    worker.once('exit', (code) => events.emit('exit', code, outOfMemory ? 'SIGABRT' : null));
    return {
        channel: null,
        send(message, callback) {
            try {
                worker.postMessage(message);
                callback?.(null);
            }
            catch (error) {
                callback?.(error);
            }
            return true;
        },
        on: (event, listener) => events.on(event, listener),
        once: (event, listener) => events.once(event, listener),
        kill() {
            void worker.terminate();
            return true;
        },
        ref: () => worker.ref(),
        unref: () => worker.unref(),
        async memoryMb() {
            if (!online)
                return null;
            try {
                // Worker#getHeapStatistics is not in this @types/node yet.
                const stats = await worker.getHeapStatistics();
                return (stats.total_heap_size + (stats.external_memory ?? 0)) / MB;
            }
            catch {
                return null;
            }
        },
        async cpuSeconds() {
            if (!online)
                return null;
            try {
                // Worker#cpuUsage (Node 24.6+) is not in this @types/node yet.
                const usage = await worker.cpuUsage();
                return (usage.user + usage.system) / 1e6;
            }
            catch {
                return null; // not running (yet or any more)
            }
        },
    };
}
class RedactionProcess {
    heapMb;
    timings;
    ceiling;
    budgetMb;
    onDeath;
    onUsage;
    child;
    nextId = 1;
    current = null;
    poll;
    polling = false;
    startCpu = null;
    lastCpu = null;
    stillPolls = 0;
    /** When the file in hand was sent (performance.now()). */
    sentAt = 0;
    rssMb = 0;
    /** Memory the child last reported using (MB), or null where it cannot say. */
    usedMb = null;
    dead = false;
    constructor(heapMb, spawn, timings, 
    /** CPU a file may use here; past it the file fails with ceilingReason. */
    ceiling, 
    /**
     * Memory this child may use in all (MB): its heap and the overhead around
     * it. A worker's WebAssembly and Buffer memory are outside its heap limit,
     * so the pool checks what it reports and ends it past this.
     */
    budgetMb, onDeath, 
    /** Called each time the child reports what it uses (admission reads it). */
    onUsage = () => undefined) {
        this.heapMb = heapMb;
        this.timings = timings;
        this.ceiling = ceiling;
        this.budgetMb = budgetMb;
        this.onDeath = onDeath;
        this.onUsage = onUsage;
        this.child = spawn(heapMb);
        this.child.on('message', (reply) => this.receive(reply));
        this.child.once('error', () => this.die('source_redaction_worker_failed'));
        this.child.once('exit', (code, signal) => this.die(signal === 'SIGABRT' || code === 134
            ? 'source_redaction_out_of_memory'
            : 'source_redaction_worker_exit'));
        this.child.unref?.();
        this.child.channel?.unref?.();
    }
    get busy() {
        return this.current !== null;
    }
    redact(input) {
        if (this.dead)
            return Promise.reject(new Error('source_redaction_worker_exit'));
        if (this.current)
            return Promise.reject(new Error('source_redaction_busy'));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.current = { id, resolve, reject };
            // Hold the process open while a file is in flight: an idle child is
            // unreferenced so it never keeps its parent alive, but a parent whose
            // only pending work is this reply (a one-shot export) would otherwise
            // exit mid-await with status 0 and nothing written.
            this.child.ref?.();
            this.child.channel?.ref?.();
            this.startCpu = null;
            this.lastCpu = null;
            this.stillPolls = 0;
            // No CPU reading now: the first poll takes it (sampleCpu). A server
            // sends every source file and every chunk here, thousands per upload,
            // and reading /proc as each one started was a third of what sending a
            // file cost the parent's event loop (0.10 of 0.38 ms; 27 Oct 2026).
            this.sentAt = performance.now();
            this.poll = setInterval(() => void this.sampleCpu(), this.timings.pollMs);
            this.poll.unref();
            try {
                this.child.send({ id, text: input.text, filePath: input.filePath }, (error) => {
                    if (error)
                        this.settle(new Error('source_redaction_send_failed'));
                });
            }
            catch {
                this.settle(new Error('source_redaction_send_failed'));
            }
        });
    }
    async sampleCpu() {
        if (this.polling || !this.current)
            return;
        this.polling = true;
        const holding = this.current;
        try {
            const used = (await this.child.memoryMb?.()) ?? null;
            if (used !== null && this.current === holding) {
                this.usedMb = used;
                if (used > this.budgetMb) {
                    // Past its budget in memory its heap limit does not see: out of
                    // memory, as if its heap had run out (retried once with twice the
                    // heap, then a strike), before the scanner itself has to restart.
                    this.settle(new Error('source_redaction_out_of_memory'));
                    this.kill();
                    return;
                }
                this.onUsage();
            }
            const cpu = this.child.cpuSeconds
                ? await this.child.cpuSeconds()
                : await this.timings.cpuSeconds(this.child.pid);
            if (cpu === null || this.current !== holding)
                return; // no CPU accounting: only an exit ends the file
            if (this.startCpu === null) {
                // The first reading comes a poll after the file was sent. Its CPU
                // before then is unknown, so the file is charged all the time it has
                // been in hand: a parse uses no more CPU than the time it runs, so
                // the ceiling ends a file no later than it did with a reading at
                // the start.
                this.startCpu = cpu - (performance.now() - this.sentAt) / 1000;
                this.lastCpu = cpu;
                return;
            }
            if (cpu - this.startCpu >= this.ceiling.seconds) {
                this.settle(new Error(this.ceiling.reason));
                this.kill();
                return;
            }
            this.stillPolls = cpu === this.lastCpu ? this.stillPolls + 1 : 0;
            this.lastCpu = cpu;
            if (this.stillPolls >= this.timings.stallPolls) {
                this.settle(new Error('source_redaction_stalled'));
                this.kill();
            }
        }
        finally {
            this.polling = false;
        }
    }
    receive(reply) {
        if (!this.current || reply.id !== this.current.id)
            return;
        if ('value' in reply && typeof reply.value === 'string')
            this.settle(null, reply.value);
        else
            this.settle(new Error('source_redaction_invalid_result'));
        if ('rssMb' in reply && typeof reply.rssMb === 'number')
            this.rssMb = reply.rssMb;
    }
    settle(error, value) {
        const current = this.current;
        this.current = null;
        if (this.poll)
            clearInterval(this.poll);
        this.poll = undefined;
        this.child.unref?.();
        this.child.channel?.unref?.();
        if (!current)
            return;
        if (error)
            current.reject(error);
        else
            current.resolve(value);
    }
    die(reason) {
        if (this.dead)
            return;
        this.dead = true;
        this.settle(new Error(reason));
        this.onDeath(this);
    }
    kill() {
        if (this.dead)
            return;
        this.child.kill('SIGKILL');
        this.dead = true;
        this.settle(new Error('source_redaction_worker_exit'));
        this.onDeath(this);
    }
}
/** Reasons a second, larger attempt cannot help. */
const SHARED_CEILING_REASON = 'source_redaction_shared_cpu_ceiling';
const FINAL_REASONS = new Set([
    'source_redaction_invalid_result',
    'source_redaction_exceeds_memory',
    'source_redaction_cpu_ceiling',
]);
export class SourceRedactionPool {
    options;
    shared = null;
    sharedQueue = [];
    largeQueue = [];
    running = new Set();
    seq = 0;
    admitting = false;
    admitAgain = false;
    /** Large children finished so far (admission re-reads memory when this moves during a read). */
    finished = 0;
    timings;
    constructor(options) {
        this.options = options;
        this.timings = {
            pollMs: options.pollMs ?? STALL_POLL_MS,
            stallPolls: options.stallPolls ?? STALL_POLLS,
            cpuCeilingSeconds: options.cpuCeilingSeconds ?? CPU_CEILING_SECONDS,
            cpuSeconds: options.cpuSeconds ?? processCpuSeconds,
        };
    }
    /** Large children running now (tests and diagnostics). */
    get largeRunning() {
        return this.running.size;
    }
    /** Interactive before background; arrival order within each. */
    enqueue(queue, job) {
        const goesBefore = (other) => job.interactive !== other.interactive ? job.interactive : job.seq < other.seq;
        const index = queue.findIndex(goesBefore);
        queue.splice(index < 0 ? queue.length : index, 0, job);
    }
    runShared() {
        if (this.shared?.busy)
            return;
        const job = this.sharedQueue.shift();
        if (!job)
            return;
        if (!this.shared || this.shared.dead || this.shared.rssMb > SHARED_RECYCLE_RSS_MB) {
            this.shared?.kill();
            const created = new RedactionProcess(SHARED_HEAP_MB, this.options.spawn, this.timings, {
                seconds: this.options.sharedCpuCeilingSeconds ?? SHARED_CPU_CEILING_SECONDS,
                reason: SHARED_CEILING_REASON,
            }, SHARED_HEAP_MB + CHILD_OVERHEAD_MB, (dead) => {
                if (this.shared === dead)
                    this.shared = null;
            });
            this.shared = created;
        }
        const process = this.shared;
        process.redact(job.input).then((value) => {
            job.resolve(value);
            this.runShared();
        }, (error) => {
            job.reject(error);
            this.runShared();
        });
    }
    /**
     * Memory the redaction children use now, in MB, each counted at most up to
     * its budget: what a scanner's own memory ceiling leaves out when its
     * children are worker threads in its process.
     */
    childrenUsedMb() {
        let total = 0;
        for (const run of this.running)
            total += Math.min(run.reservedMb, Math.max(0, run.process.usedMb ?? 0));
        if (this.shared && !this.shared.dead)
            total += Math.min(this.shared.budgetMb, Math.max(0, this.shared.usedMb ?? 0));
        return total;
    }
    async admitLarge() {
        // A child that finishes while the probe is read calls this again; it must
        // not be lost, or a waiting file stays queued until the next finish.
        if (this.admitting) {
            this.admitAgain = true;
            return;
        }
        this.admitting = true;
        this.admitAgain = false;
        try {
            const limit = this.options.maxLargeChildren ?? MAX_LARGE_CHILDREN;
            while (this.largeQueue.length > 0 && this.running.size < limit) {
                const job = this.largeQueue[0];
                const needMb = job.heapMb + CHILD_OVERHEAD_MB;
                const finishedBefore = this.finished;
                const reading = await (this.options.memory ?? scannerMemoryProbe())();
                // A child that finished while memory was read makes the reading stale
                // (it may still count that child): read again before deciding.
                if (this.finished !== finishedBefore)
                    continue;
                let outstanding = 0;
                for (const run of this.running) {
                    // What it may still grow into: its reservation less what it uses
                    // now, as it reports (a worker thread) or as /proc says (a process).
                    const actual = reading.includesChildren
                        ? (run.process.usedMb ?? residentMb(run.process.child.pid) ?? 0)
                        : 0;
                    outstanding += Math.max(0, run.reservedMb - actual);
                }
                const available = reading.limitMb -
                    reading.usedMb -
                    ADMISSION_RESERVE_MB -
                    outstanding -
                    (this.options.heldMb?.() ?? 0);
                if (needMb > available) {
                    // Running children free memory when they finish; with none running,
                    // nothing will, so the file can never fit here.
                    if (this.running.size > 0)
                        return;
                    this.largeQueue.shift();
                    job.reject(new Error('source_redaction_exceeds_memory'));
                    continue;
                }
                this.largeQueue.shift();
                const run = {
                    reservedMb: needMb,
                    process: new RedactionProcess(job.heapMb, this.options.spawn, this.timings, { seconds: this.timings.cpuCeilingSeconds, reason: 'source_redaction_cpu_ceiling' }, needMb, () => undefined, 
                    // A file waiting for room may fit once this child says what it
                    // uses: until then admission counts its whole reservation.
                    () => {
                        if (this.largeQueue.length > 0)
                            void this.admitLarge();
                    }),
                };
                this.running.add(run);
                run.process
                    .redact(job.input)
                    .then(job.resolve, job.reject)
                    .finally(() => {
                    run.process.kill();
                    this.running.delete(run);
                    this.finished++;
                    void this.admitLarge();
                });
            }
        }
        finally {
            this.admitting = false;
            if (this.admitAgain) {
                this.admitAgain = false;
                void this.admitLarge();
            }
        }
    }
    submit(input, bytes, heapMb, large, seq) {
        return new Promise((resolve, reject) => {
            const job = {
                input,
                bytes,
                heapMb,
                large,
                interactive: input.priority === 'interactive',
                seq,
                resolve,
                reject,
            };
            if (large) {
                this.enqueue(this.largeQueue, job);
                void this.admitLarge();
            }
            else {
                this.enqueue(this.sharedQueue, job);
                this.runShared();
            }
        });
    }
    /** Redact one source; throws a counted, logged error for this file when it cannot. */
    async redact(input) {
        const bytes = Buffer.byteLength(input.text);
        const heapMb = Math.max(SHARED_HEAP_MB, redactionHeapMb(bytes, input.filePath));
        const seq = this.seq++;
        try {
            return await this.submit(input, bytes, heapMb, bytes >= LARGE_FILE_BYTES, seq);
        }
        catch (first) {
            const reason = first instanceof Error ? first.message : String(first);
            if (FINAL_REASONS.has(reason))
                return this.fail(input, bytes, reason);
            if (reason === SHARED_CEILING_REASON) {
                // Too much CPU for the shared child: a child of its own, with the full
                // ceiling, so the small files behind it are not held up.
                try {
                    return await this.submit(input, bytes, heapMb, true, seq);
                }
                catch (own) {
                    return this.fail(input, bytes, own instanceof Error ? own.message : String(own));
                }
            }
            // Out of memory, an unexpected exit or a hung child: once more, in its
            // own child, with twice the heap, keeping its place in line.
            this.options.onRetry?.(reason, { bytes, extension: extensionOf(input.filePath) });
            try {
                return await this.submit(input, bytes, heapMb * 2, true, seq);
            }
            catch (second) {
                return this.fail(input, bytes, second instanceof Error ? second.message : String(second));
            }
        }
    }
    fail(input, bytes, reason) {
        this.options.onFailure(reason, { bytes, extension: extensionOf(input.filePath) });
        throw new Error(reason);
    }
    /** Tests and shutdown. */
    close() {
        this.shared?.kill();
        this.shared = null;
        for (const run of this.running)
            run.process.kill();
    }
}
function extensionOf(path) {
    return /\.([A-Za-z0-9]{1,8})$/.exec(path)?.[1]?.toLowerCase() ?? '';
}
/**
 * The child side: redact each file sent over IPC, in this process, and
 * answer with its id and this process's resident memory (so the parent can
 * recycle a child whose WebAssembly memory has grown).
 */
export function runSourceRedactionWorker() {
    // In a worker thread (the scanner) replies go to the parent thread, and
    // the memory reported is this thread's own heap and external memory (its
    // WebAssembly memory included); the process's resident memory is shared.
    const port = parentPort;
    const reply = port
        ? (message) => port.postMessage(message)
        : (message) => process.send?.(message);
    if (!port && !process.send)
        throw new Error('Source redaction worker requires IPC');
    const memoryMb = () => {
        const usage = process.memoryUsage();
        return Math.round((port ? usage.heapTotal + usage.external : usage.rss) / MB);
    };
    const handle = (input) => {
        void scrubSourceSecretsInProcess(input.text, input.filePath)
            .then((value) => {
            reply({ id: input.id, value, rssMb: memoryMb() });
        })
            .catch(() => {
            reply({ id: input.id, error: 'source_redaction_invalid_result' });
        });
    };
    if (port) {
        port.on('message', handle);
        return;
    }
    process.on('message', handle);
    process.once('disconnect', () => process.exit(0));
}
//# sourceMappingURL=sourceRedactionPool.js.map