import { protectWindowsDirectory } from './runtimeSigners.js';
import { stderr, stdin } from 'node:process';
import { HOOK_STDIN_TIMEOUT_MS } from './hookTimeouts.js';
import { resolveProjectIdentity } from './repositoryRoot.js';
/**
 * One resolution per directory per process. A hook process serves one event,
 * and its handlers resolve the same cwd several times in sequence (each
 * request builder, each gate report); every resolution runs `git rev-parse`
 * with a 2 s timeout, so on a slow or hung git the repeats alone could pass
 * the host's 5 s hook timeout. Only hook runtimes call this (short-lived
 * processes); project setup clears it after it writes an identity.
 */
const identityCache = new Map();
/** Forget cached resolutions (after project setup wrote a `.mnemonik.json`). */
export function clearProjectIdentityCache() {
    identityCache.clear();
}
export async function findProjectIdentity(startCwd, options = {}) {
    if (!startCwd)
        return null;
    const key = JSON.stringify([
        startCwd,
        options.allowNestedInherit ?? null,
        options.maxDepth ?? null,
    ]);
    let pending = identityCache.get(key);
    if (!pending) {
        pending = findProjectIdentityDetailed(startCwd, options).then((result) => result.kind === 'ok'
            ? {
                projectId: result.identity.projectId,
                projectName: result.identity.projectName,
                projectRoot: result.root,
            }
            : null);
        identityCache.set(key, pending);
        // A failure is not an answer: the next caller resolves afresh.
        pending.catch(() => identityCache.delete(key));
    }
    return pending;
}
export async function findProjectIdentityDetailed(startCwd, options = {}) {
    return resolveProjectIdentity(startCwd, options);
}
/** Largest hook payload read from stdin; a bigger one fails open. */
export const HOOK_STDIN_MAX_BYTES = 1_048_576;
/**
 * Read a hook's stdin payload, bounded in size and in time. Resolves the text
 * (a leading BOM removed) when the host closes stdin, or when `timeoutMs`
 * passes first: then with whatever arrived, which the caller parses like any
 * other payload (a partial one fails to parse and the hook fails open).
 * Resolves null past `maxBytes` or on a stream error. After the timeout or
 * the cap the stream is destroyed, so an unclosed pipe no longer holds the
 * process open (Grok's hook returns without calling exit).
 */
export function readHookStdin(options = {}) {
    const stream = options.stream ?? stdin;
    const maxBytes = options.maxBytes ?? HOOK_STDIN_MAX_BYTES;
    return new Promise((resolve) => {
        const chunks = [];
        let bytes = 0;
        let settled = false;
        const text = () => Buffer.concat(chunks)
            .toString('utf8')
            .replace(/^\uFEFF/, '');
        const finish = (value, release) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            stream.removeListener('data', onData);
            stream.removeListener('end', onEnd);
            if (release) {
                stream.pause();
                stream.destroy?.();
            }
            resolve(value);
        };
        const onData = (chunk) => {
            const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
            bytes += buffer.length;
            if (bytes > maxBytes)
                return finish(null, true);
            chunks.push(buffer);
        };
        const onEnd = () => finish(text(), false);
        const timer = setTimeout(() => finish(text(), true), options.timeoutMs ?? HOOK_STDIN_TIMEOUT_MS);
        stream.on('data', onData);
        stream.on('end', onEnd);
        stream.on('error', () => finish(null, false));
    });
}
let mismatchEmitted = false;
export async function parseHookResponse(response) {
    const body = (await response.json());
    const result = body;
    if (!mismatchEmitted && result?.ok === false && result.reason === 'identity_mismatch') {
        stderr.write('mnemonik-hook: project identity mismatch - .mnemonik.json points to one project, ' +
            'but this directory is registered to a different one on the server. ' +
            'Fix .mnemonik.json (delete it and let session_bootstrap rewrite it) or cd to the correct project root.\n');
        mismatchEmitted = true;
    }
    return body;
}
/** Native host correlation only; never accept checkpoint/model fields here. */
export function validHookSessionId(value) {
    return (typeof value === 'string' &&
        /^[a-zA-Z0-9@._+:-]{1,255}$/.test(value) &&
        !['cursor-unknown-session', 'codex-unknown-session'].includes(value));
}
/** Bounded JSON transport; never log credentials, request/response bodies or URLs. */
export async function postHookBoundJson(server, path, token, body) {
    const response = await fetch(`${server.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(2_000),
    });
    return { status: response.status, body: (await response.json()) };
}
/** Shared context/cache logic. Credentials remain owned by each host package's
 * adapter callback so shared acquires no runtime credential dependency. */
export async function bindHookContext(input, familyId, hmac, post, options = {}) {
    const { execFile } = await import('node:child_process');
    const { constants } = await import('node:fs');
    const { lstat, mkdir, open, realpath } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    // Lazy: legacy durable runtimes may not carry the fingerprint module.
    const { selectRemote } = await import('./repositoryFingerprint.js');
    const identity = await findProjectIdentityDetailed(await realpath(input.cwd));
    if (identity.kind === 'git_unavailable')
        throw new Error('context unavailable');
    const root = await realpath(identity.root);
    const binding = await hmac(root);
    const gitEnv = { LC_ALL: 'C' };
    for (const key of ['PATH', 'HOME', 'LANG', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE'])
        if (process.env[key] !== undefined)
            gitEnv[key] = process.env[key];
    const git = (args) => new Promise((resolve) => {
        execFile('git', args, { cwd: root, env: gitEnv, timeout: 2_000, encoding: 'utf8' }, (error, stdout) => resolve(error ? [] : stdout.trim().split(/\r?\n/).filter(Boolean)));
    });
    const remotes = identity.repository.kind === 'git' ? await git(['remote']) : [];
    const selection = selectRemote(await Promise.all(remotes.map(async (name) => ({
        name,
        fetchUrls: await git(['remote', 'get-url', '--all', name]),
        pushUrls: await git(['remote', 'get-url', '--push', '--all', name]),
    }))));
    const body = {
        host: input.host,
        hostSessionId: input.hostSessionId,
        deviceRootContext: {
            algorithmVersion: binding.version,
            hash: Buffer.from(binding.hmac, 'base64url').toString('hex'),
        },
        repositoryFingerprint: selection.status === 'fingerprint'
            ? {
                algorithmVersion: selection.fingerprint.algorithmVersion,
                hash: selection.fingerprint.hash,
            }
            : null,
        // A plain folder with a valid .mnemonik.json is a project; Git plays no part.
        rootKind: identity.repository.kind === 'git'
            ? 'git'
            : identity.kind === 'ok'
                ? 'selected_non_git'
                : 'ineligible',
        identityState: identity.kind === 'ok' ? 'valid' : identity.kind === 'absent' ? 'absent' : 'invalid',
        ...(identity.kind === 'ok' ? { projectId: identity.identity.projectId } : {}),
    };
    const key = JSON.stringify([input.server, familyId, body]);
    const directory = dirname(input.stateFile);
    for (const path of [dirname(directory), directory]) {
        const created = await mkdir(path, { recursive: true, mode: 0o700 });
        const stat = await lstat(path);
        if (!stat.isDirectory() ||
            stat.isSymbolicLink() ||
            ((options.platform ?? process.platform) !== 'win32' &&
                ((process.getuid && stat.uid !== process.getuid()) || stat.mode & 0o077)))
            throw new Error('cache unavailable');
        if ((options.platform ?? process.platform) === 'win32') {
            await protectWindowsDirectory(path, created !== undefined, options.run, directory);
        }
    }
    const file = await open(input.stateFile, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try {
        let cache;
        try {
            cache = JSON.parse(await file.readFile('utf8'));
        }
        catch {
            /* First event. */
        }
        const now = Date.now();
        if (cache && cache.expiresAt > now && (cache.key === key || cache.retryKey === key))
            return;
        const status = await post(body);
        if (status === 200)
            cache = { key, expiresAt: Date.now() + 120_000, canonicalRoot: root };
        else {
            stderr.write(`mnemonik-hook: bound-context post failed (${status})\n`);
            if (status !== 409)
                return;
            // A changed root/identity cannot replace a live server binding. Retry at
            // its original expiry; without a local receipt, wait one conservative TTL.
            cache = {
                key: cache?.key ?? '',
                expiresAt: cache && cache.expiresAt > now ? cache.expiresAt : now + 120_000,
                retryKey: key,
            };
        }
        await file.truncate(0);
        await file.write(JSON.stringify(cache), 0, 'utf8');
    }
    finally {
        await file.close();
    }
}
export * from './runtimeReader.js';
export * from './runtimeSigners.js';
export * from './projectSetupHandoff.js';
export * from './hookConversation.js';
//# sourceMappingURL=hookRuntime.js.map