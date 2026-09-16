import { protectWindowsDirectory } from './runtimeSigners.js';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RuntimeReader, hash } from './runtimeReader.js';

export const PROJECT_SETUP_MANUAL =
  'Mnemonik project setup needs attention; ask the person to run `mnemonik project init` in this folder.';
const words = (value: unknown): string =>
  typeof value === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(value)
    ? value.replaceAll('_', ' ')
    : 'needs attention';
export function projectSetupActions(value: unknown): string {
  return Array.isArray(value) ? value.slice(0, 20).map(words).join(', ') : 'retry, cancel';
}
export interface ProjectSetupDiagnostic {
  requestId?: string;
  outcome: 'done' | 'ACTION_REQUIRED' | 'failed';
  time: string;
  rootHash: string | null;
  action: string;
  reason?: string;
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
/** Parse the native tool response, never tool arguments or agent-authored command fields. */
export function setupResponse(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    if (value.length > 64 * 1024) return;
    try {
      value = JSON.parse(value);
    } catch {
      return;
    }
  }
  if (!record(value)) return;
  if (record(value.structuredContent)) value = value.structuredContent;
  else {
    // Claude supplies the server's tool_response directly, not model-authored text.
    // Accept only the server envelope; no command/path extensions cross this boundary.
    const keys = ['status', 'state', 'allowedActions', 'requestId', 'expiresAt'];
    const envelope = value;
    if (
      !keys.every((key) => Object.hasOwn(envelope, key)) ||
      Object.keys(value).some((key) => ![...keys, 'manualAction'].includes(key)) ||
      typeof value.state !== 'string' ||
      !Array.isArray(value.allowedActions) ||
      !value.allowedActions.every((action) => typeof action === 'string') ||
      typeof value.requestId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value.requestId
      ) ||
      typeof value.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(value.expiresAt)) ||
      (Object.hasOwn(value, 'manualAction') && typeof value.manualAction !== 'string')
    )
      return;
  }
  if (record(value) && value.status === 'project_setup_required') return value;
  return;
}
async function privateDirectory(path: string, session: string): Promise<void> {
  const created = await mkdir(path, { recursive: true, mode: 0o700 });
  const st = await lstat(path);
  if (
    !st.isDirectory() ||
    st.isSymbolicLink() ||
    (process.getuid && (st.uid !== process.getuid() || st.mode & 0o077))
  )
    throw new Error('diagnostic_unavailable');
  if (process.platform === 'win32') {
    await protectWindowsDirectory(path, created !== undefined, undefined, session);
  }
}
async function readPrivate(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await file.stat();
    if (
      !st.isFile() ||
      st.size > 64 * 1024 ||
      (process.getuid && (st.uid !== process.getuid() || st.mode & 0o077))
    )
      throw new Error('diagnostic_unavailable');
    return await file.readFile('utf8');
  } finally {
    await file.close();
  }
}
async function writeDiagnostic(path: string, value: ProjectSetupDiagnostic): Promise<void> {
  await privateDirectory(dirname(dirname(path)), dirname(path));
  await privateDirectory(dirname(path), dirname(path));
  const temp = `${path}.${randomUUID()}`;
  try {
    const file = await open(temp, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(value) + '\n');
    } finally {
      await file.close();
    }
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

export async function handoffProjectSetup(input: {
  response: unknown;
  cwd: string | undefined;
  host: 'claude_code' | 'cursor' | 'grok';
  hostSessionId: string;
  stateFile: string;
  stateDir: string;
  familyId: string | undefined;
}): Promise<string | undefined> {
  const response = setupResponse(input.response);
  if (!response) return;
  let root: string | undefined;
  let action = PROJECT_SETUP_MANUAL;
  let outcome: ProjectSetupDiagnostic['outcome'] = 'failed';
  let reason = 'manual_setup_required';
  const requestId =
    typeof response.requestId === 'string' && response.requestId.length <= 4096
      ? response.requestId
      : undefined;
  try {
    if (!input.cwd) throw new Error('safe_cwd_unavailable');
    // The binding receipt is private local state. No path from the response is read.
    const cache = JSON.parse(
      await readPrivate(join(dirname(input.stateFile), 'bound-context.json'))
    );
    const [, family, body] = JSON.parse(cache.key);
    if (
      !input.familyId ||
      family !== input.familyId ||
      body.host !== input.host ||
      body.hostSessionId !== input.hostSessionId ||
      cache.expiresAt <= Date.now() ||
      !cache.canonicalRoot
    )
      throw new Error('bound_context_unavailable');
    root = await realpath(cache.canonicalRoot);
    const { findProjectIdentityDetailed } = await import('./hookRuntime.js');
    const identity = await findProjectIdentityDetailed(await realpath(input.cwd));
    if (identity.kind === 'git_unavailable' || root !== (await realpath(identity.root)))
      throw new Error('bound_root_changed');
    if (!requestId) throw new Error('manual_setup_required');
    const runtime = await new RuntimeReader(input.stateDir).verifyRuntime('cli').catch(() => {
      throw new Error('verified_cli_runtime_unavailable');
    });
    const bin = join(dirname(runtime.entry), 'bin.js');
    if (!runtime.manifest.files[relative(runtime.directory, bin).replaceAll('\\', '/')])
      throw new Error('verified_cli_bin_missing');
    const result = await new Promise<unknown>((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [bin, 'project', 'ensure', '--agent', '--json'],
        {
          cwd: root,
          shell: false,
          timeout: 30_000,
          killSignal: 'SIGKILL',
          maxBuffer: 64 * 1024,
          // Runtime injection variables and repository/PATH executables are not inherited.
          env: Object.fromEntries(
            [
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
            ].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]]))
          ),
        },
        (error, stdout) => {
          if (error && (error.killed || error.code !== 3))
            return reject(new Error('helper_failed'));
          try {
            resolve(JSON.parse(stdout));
          } catch {
            reject(new Error('helper_invalid_json'));
          }
        }
      );
      child.stdin?.on('error', () => {});
      child.stdin?.end(JSON.stringify({ requestId }));
    });
    if (!record(result)) throw new Error('helper_invalid_json');
    if (result.status === 'done') {
      outcome = 'done';
      reason = 'complete';
      action = 'Mnemonik project setup is complete; call session_bootstrap again.';
    } else if (
      ['ACTION_REQUIRED', 'action_required', 'project_setup_required'].includes(
        String(result.status)
      )
    ) {
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
    } else throw new Error('helper_invalid_json');
  } catch (error) {
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
  } catch {
    process.stderr.write('mnemonik-hook: project setup diagnostic unavailable\n');
  }
  return action;
}

/** Both doctor and status consume private per-session outcomes, scoped by root hash. */
export async function pendingProjectSetup(root: string): Promise<ProjectSetupDiagnostic[]> {
  const rootHash = hash(await realpath(root));
  const results: ProjectSetupDiagnostic[] = [];
  const uid = process.getuid?.() ?? 'user';
  for (const host of ['credit', 'cursor', 'grok']) {
    const directory = join(tmpdir(), `mnemonik-${host}-${uid}`);
    try {
      const stat = await lstat(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      for (const name of await readdir(directory)) {
        if (!/^[a-f0-9]{64}$/.test(name)) continue;
        try {
          if ((await lstat(join(directory, name))).isSymbolicLink()) continue;
          const diagnostic = JSON.parse(
            await readPrivate(join(directory, name, 'project-setup.json'))
          );
          if (
            (diagnostic.rootHash === rootHash || diagnostic.rootHash === null) &&
            ['done', 'ACTION_REQUIRED', 'failed'].includes(diagnostic.outcome) &&
            typeof diagnostic.action === 'string' &&
            diagnostic.action.length < 2000 &&
            Date.now() - Date.parse(diagnostic.time) < 24 * 60 * 60 * 1000
          )
            results.push(diagnostic);
        } catch {
          /* An incomplete or removed session is not a pending action. */
        }
      }
    } catch {
      /* Host has no local sessions. */
    }
  }
  // A later completion supersedes stale actions from another session in this root.
  results.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
  return results[0]?.outcome === 'done' ? [] : results.slice(0, 1);
}
