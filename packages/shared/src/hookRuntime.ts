import { protectWindowsDirectory, type Execute } from './runtimeSigners.js';
import { stderr } from 'node:process';
import { resolveProjectIdentity, type ProjectIdentityResolution } from './repositoryRoot.js';

export interface ProjectIdentity {
  projectId: string;
  projectName?: string;
  projectRoot: string;
}

export async function findProjectIdentity(
  startCwd: string,
  options: { allowNestedInherit?: boolean; maxDepth?: number } = {}
): Promise<ProjectIdentity | null> {
  if (!startCwd) return null;
  const result = await findProjectIdentityDetailed(startCwd, options);
  if (result.kind !== 'ok') return null;
  return {
    projectId: result.identity.projectId,
    projectName: result.identity.projectName,
    projectRoot: result.root,
  };
}

export async function findProjectIdentityDetailed(
  startCwd: string,
  options: { allowNestedInherit?: boolean; maxDepth?: number } = {}
): Promise<ProjectIdentityResolution> {
  return resolveProjectIdentity(startCwd, options);
}

let mismatchEmitted = false;

export async function parseHookResponse<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T;
  const result = body as { ok?: boolean; reason?: string };
  if (!mismatchEmitted && result?.ok === false && result.reason === 'identity_mismatch') {
    stderr.write(
      'mnemonik-hook: project identity mismatch - .mnemonik.json points to one project, ' +
        'but this directory is registered to a different one on the server. ' +
        'Fix .mnemonik.json (delete it and let session_bootstrap rewrite it) or cd to the correct project root.\n'
    );
    mismatchEmitted = true;
  }
  return body;
}

/** Native host correlation only; never accept checkpoint/model fields here. */
export function validHookSessionId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[a-zA-Z0-9@._+:-]{1,255}$/.test(value) &&
    !['cursor-unknown-session', 'codex-unknown-session'].includes(value)
  );
}

export interface HookBindingInput {
  host: 'claude_code' | 'cursor' | 'grok';
  hostSessionId: string;
  cwd: string;
  server: string;
  stateFile: string;
}

/** Bounded JSON transport; never log credentials, request/response bodies or URLs. */
export async function postHookBoundJson(server: string, path: string, token: string, body: object) {
  const response = await fetch(`${server.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(2_000),
  });
  return { status: response.status, body: (await response.json()) as unknown };
}

/** Shared context/cache logic. Credentials remain owned by each host package's
 * adapter callback so shared acquires no runtime credential dependency. */
export async function bindHookContext(
  input: HookBindingInput,
  familyId: string,
  hmac: (root: string) => Promise<{ version: 1; hmac: string }>,
  post: (body: object) => Promise<number | string>,
  options: { platform?: NodeJS.Platform; run?: Execute } = {}
): Promise<void> {
  const { execFile } = await import('node:child_process');
  const { constants } = await import('node:fs');
  const { lstat, mkdir, open, realpath } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  // Lazy: legacy durable runtimes may not carry the fingerprint module.
  const { selectRemote } = await import('./repositoryFingerprint.js');
  const identity = await findProjectIdentityDetailed(await realpath(input.cwd));
  if (identity.kind === 'git_unavailable') throw new Error('context unavailable');
  const root = await realpath(identity.root);
  const binding = await hmac(root);
  const gitEnv: NodeJS.ProcessEnv = { LC_ALL: 'C' };
  for (const key of ['PATH', 'HOME', 'LANG', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE'])
    if (process.env[key] !== undefined) gitEnv[key] = process.env[key];
  const git = (args: string[]): Promise<string[]> =>
    new Promise((resolve) => {
      execFile(
        'git',
        args,
        { cwd: root, env: gitEnv, timeout: 2_000, encoding: 'utf8' },
        (error, stdout) => resolve(error ? [] : stdout.trim().split(/\r?\n/).filter(Boolean))
      );
    });
  const remotes = identity.repository.kind === 'git' ? await git(['remote']) : [];
  const selection = selectRemote(
    await Promise.all(
      remotes.map(async (name) => ({
        name,
        fetchUrls: await git(['remote', 'get-url', '--all', name]),
        pushUrls: await git(['remote', 'get-url', '--push', '--all', name]),
      }))
    )
  );
  const body = {
    host: input.host,
    hostSessionId: input.hostSessionId,
    deviceRootContext: {
      algorithmVersion: binding.version,
      hash: Buffer.from(binding.hmac, 'base64url').toString('hex'),
    },
    repositoryFingerprint:
      selection.status === 'fingerprint'
        ? {
            algorithmVersion: selection.fingerprint.algorithmVersion,
            hash: selection.fingerprint.hash,
          }
        : null,
    // A plain folder with a valid .mnemonik.json is a project; Git plays no part.
    rootKind:
      identity.repository.kind === 'git'
        ? 'git'
        : identity.kind === 'ok'
          ? 'selected_non_git'
          : 'ineligible',
    identityState:
      identity.kind === 'ok' ? 'valid' : identity.kind === 'absent' ? 'absent' : 'invalid',
    ...(identity.kind === 'ok' ? { projectId: identity.identity.projectId } : {}),
  };
  const key = JSON.stringify([input.server, familyId, body]);
  const directory = dirname(input.stateFile);
  for (const path of [dirname(directory), directory]) {
    const created = await mkdir(path, { recursive: true, mode: 0o700 });
    const stat = await lstat(path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      ((options.platform ?? process.platform) !== 'win32' &&
        ((process.getuid && stat.uid !== process.getuid()) || stat.mode & 0o077))
    )
      throw new Error('cache unavailable');
    if ((options.platform ?? process.platform) === 'win32') {
      await protectWindowsDirectory(path, created !== undefined, options.run, directory);
    }
  }
  const file = await open(
    input.stateFile,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600
  );
  try {
    let cache:
      { key: string; expiresAt: number; retryKey?: string; canonicalRoot?: string } | undefined;
    try {
      cache = JSON.parse(await file.readFile('utf8'));
    } catch {
      /* First event. */
    }
    const now = Date.now();
    if (cache && cache.expiresAt > now && (cache.key === key || cache.retryKey === key)) return;
    const status = await post(body);
    if (status === 200) cache = { key, expiresAt: Date.now() + 120_000, canonicalRoot: root };
    else {
      stderr.write(`mnemonik-hook: bound-context post failed (${status})\n`);
      if (status !== 409) return;
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
  } finally {
    await file.close();
  }
}

export * from './runtimeReader.js';
export * from './runtimeSigners.js';
export * from './projectSetupHandoff.js';
