import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, readFile, rm, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { SCANNER_STOP_BUDGET_MS } from './scannerSupervisor.js';

type Run = (file: string, args: string[]) => Promise<string>;

/** Print one registration, or null when the domain holds none and says so plainly. */
export async function printLaunchdRegistration(
  domain: string,
  label: string,
  run: Run
): Promise<string | null> {
  try {
    return await run('launchctl', ['print', `${domain}/${label}`]);
  } catch (error) {
    // An unavailable GUI login is normal over SSH. Other errors prove nothing.
    const failure = error as Error & { code?: number; killed?: boolean; signal?: string | null };
    if (/Could not find (?:service|domain)\b/i.test(failure.message)) return null;
    const unsupportedDomain =
      /Could not print domain:\s*125:\s*Domain does not support specified action\s*$/.test(
        failure.message
      );
    if (
      domain.startsWith('gui/') &&
      unsupportedDomain &&
      ((failure.code === 125 && !failure.killed && !failure.signal) ||
        /^supervisor_command_failed killed=false code=125 signal=null:/.test(failure.message))
    )
      return null;
    throw error;
  }
}

/** Are any of these processes still alive? ps exits 1 when none of them exist. */
export async function processesAlive(pids: Iterable<number>, run: Run): Promise<boolean> {
  const list = [...pids];
  if (!list.length) return false;
  try {
    return (await run('ps', ['-p', list.join(','), '-o', 'pid='])).trim() !== '';
  } catch (error) {
    const failure = error as Error & { code?: number; killed?: boolean; signal?: string | null };
    if (
      (failure.code === 1 && !failure.killed && !failure.signal) ||
      /^supervisor_command_failed killed=false code=1 signal=null:/.test(failure.message)
    )
      return false;
    throw error;
  }
}

export const macScannerLauncher = '/Library/Application Support/Mnemonik/scanner-launcher';
export const macScannerPlist = '/Library/LaunchDaemons/ai.mnemonik.scanner.plist';
export async function authorizeMacService(run: Run, env = process.env) {
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
  };
  process.on('SIGINT', interrupt);
  try {
    // sudo reads /dev/tty itself, including when the service protocol uses stdin.
    await run('sudo', [...(env.SUDO_ASKPASS ? ['-A'] : []), '-v']);
  } catch (error) {
    throw new Error(
      !interrupted &&
        /terminal is required|a password is required|no tty present|no askpass program/iu.test(
          (error as Error).message
        )
        ? 'mac_authorization_required'
        : 'mac_authorization_failed'
    );
  } finally {
    process.removeListener('SIGINT', interrupt);
  }
}

/** Native removal also works when the selected scanner executable is missing or old. */
export async function removeMacScanner(
  state: string,
  home: string,
  uid: number,
  run: Run,
  options: {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    plist?: string;
    launcher?: string;
    remove?: boolean;
    environment?: NodeJS.ProcessEnv;
  } = {}
) {
  const exists = (path: string) =>
    lstat(path).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    );
  const receipt = await readFile(join(state, 'scanner/status.json'), 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  );
  const recordedPid = receipt ? JSON.parse(receipt).snapshot?.lifecycle?.pid : undefined;
  const system = (await printLaunchdRegistration('system', 'ai.mnemonik.scanner', run)) !== null;
  const plist = options.plist ?? macScannerPlist;
  const present = await exists(plist);
  const launcher = options.launcher ?? macScannerLauncher;
  const launcherPresent = await exists(launcher);
  if (system || present || launcherPresent) await authorizeMacService(run, options.environment);
  const privileged: Run = (file, args) =>
    file === 'launchctl' && args[0] === 'bootout'
      ? run('sudo', ['-n', '/bin/launchctl', ...args])
      : run(file, args);
  await stopLaunchdRegistrations(['system'], 'ai.mnemonik.scanner', privileged, {
    ...options,
  });
  const legacy = [`user/${uid}`, `gui/${uid}`];
  await stopLaunchdRegistrations(legacy, 'ai.mnemonik.scanner.replacement', run, options);
  await stopLaunchdRegistrations(legacy, 'ai.mnemonik.scanner', run, { ...options, recordedPid });
  // Nothing is being replaced any more, so the last attempt must not outlive the
  // job it describes: its dead pid would read as an interrupted replacement.
  await rm(join(state, 'scanner/service-replacement'), { recursive: true, force: true });
  if (options.remove === false) {
    await mkdir(join(state, 'scanner/service-replacement'), { recursive: true });
    await writeFile(
      join(state, 'scanner/service-replacement/result.json'),
      JSON.stringify({ stopped: true })
    );
    return;
  }
  if (present || launcherPresent) await run('sudo', ['-n', '/bin/rm', '-f', plist, launcher]);
  for (const label of ['ai.mnemonik.scanner', 'ai.mnemonik.scanner.replacement'])
    await rm(join(home, 'Library/LaunchAgents', `${label}.plist`), { force: true });
  await rm(join(state, 'scanner/assets'), { recursive: true, force: true });
  await rm(join(state, 'scanner/service-supervisor.json'), { force: true });
  await rm(join(state, 'scanner/service-migrated'), { force: true });
  await rm(join(state, 'scanner/system-service.plist'), { force: true });
}

/** Stop every registration and verify its processes exited before callers remove software. */
export async function stopLaunchdRegistrations(
  domains: string[],
  label: string,
  run: Run,
  options: {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    recordedPid?: number | null;
  } = {}
): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? delay;
  const inspect = (domain: string) => printLaunchdRegistration(domain, label, run);
  const pids = new Set<number>();
  const recordedPid = options.recordedPid;
  if (typeof recordedPid === 'number' && Number.isInteger(recordedPid) && recordedPid > 0)
    pids.add(recordedPid);
  const registrations = [];
  // Inspect every domain before stopping any service: an unknown domain error
  // must not turn a harmless preflight failure into a partially stopped scanner.
  for (const domain of domains) {
    const output = await inspect(domain);
    if (output === null) continue;
    const pid = Number(/\bpid = (\d+)/.exec(output)?.[1]);
    if (pid) pids.add(pid);
    registrations.push(domain);
  }
  for (const domain of registrations) await run('launchctl', ['bootout', `${domain}/${label}`]);
  const deadline = now() + SCANNER_STOP_BUDGET_MS;
  do {
    let registered = false;
    for (const domain of domains) {
      const output = await inspect(domain);
      if (output !== null) {
        registered = true;
        const pid = Number(/\bpid = (\d+)/.exec(output)?.[1]);
        if (pid) pids.add(pid);
      }
    }
    if (!registered && !(await processesAlive(pids, run))) return;
    await sleep(100);
  } while (now() <= deadline);
  throw new Error('scanner_stop_failed');
}
