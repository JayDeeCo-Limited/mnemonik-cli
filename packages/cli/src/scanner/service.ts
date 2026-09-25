import {
  pidIsScanner,
  removeMacScanner,
  macScannerLauncher,
  scannerAttemptHealthy,
  uninstallSystemdUnit,
  SCANNER_HANDOFF_BUDGET_MS,
  SCANNER_MAC_COMMAND_BUDGET_MS,
  SCANNER_RECEIPT_STALE_MS,
  SCANNER_REMOVAL_BUDGET_MS,
  SCANNER_STARTUP_BUDGET_MS,
  SCANNER_STOP_BUDGET_MS,
  WINDOWS_SERVICE_BUDGET_MS,
} from '@mnemonik/shared';
import { withLock } from '@mnemonik/local-setup';
import { execFile } from 'node:child_process';
import { readFile, rm, lstat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  ServiceDefinition,
  ServiceOperation,
  ServiceResult,
  SupervisorStatus,
} from '@mnemonik/shared';
import { RuntimeStore, type Verified } from '../runtime/store.js';
import { scannerReceipt } from './control.js';

export const SCANNER_RESTART_MESSAGE =
  'Background indexing stopped responding. Mnemonik restarted it.';
// Printed by mnemonik status itself, so it must not send the person back to it.
export const SCANNER_RESTART_ACTION = 'Wait a minute, then check again.';

export interface ScannerServiceOptions {
  stateDir: string;
  pidIdentity?: typeof pidIsScanner;
  signal?: typeof process.kill;
  onScannerRestartRequested?: () => void;
  /** Called once a pause left by an installation that did not finish is undone. */
  onAbandonedPauseResumed?: () => void;
  platform?: NodeJS.Platform;
  home?: string;
  uid?: number;
  systemPlist?: string;
  supervisorRun?: (file: string, args: string[]) => Promise<string>;
  captureDefinition?: boolean;
  /** Keep the new supervisor's platform fixes available while restoring an older runtime. */
  supervisorRuntime?: Verified;
  store?: RuntimeStore;
  describe?: () => Promise<ServiceDefinition>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  command?: (operation: ServiceOperation, definition?: ServiceDefinition) => Promise<ServiceResult>;
  timeout?: (phase: 'service' | 'heartbeat') => Promise<'retry' | 'skip'>;
  waiting?: (phase: 'service' | 'heartbeat', ms: number) => void;
}
export const SCANNER_LIMITED_SENTENCE = 'Background indexing could not be started.';
export const SCANNER_LIMITED_ACTION = 'Run mnemonik install to try again.';
// One sentence and one next step for every scanner reason a person can meet. An
// empty next step means there is nothing useful to do. Anything missing here
// falls back to the approved pair, so no reason code ever reaches a person bare.
const SCANNER_SENTENCES: Record<string, [string, string]> = {
  systemd_linger_required: [
    'Background indexing needs permission to keep running after you log out.',
    'Run sudo loginctl enable-linger $USER, then run mnemonik install.',
  ],
  systemd_session_unavailable: [
    'This server cannot keep background indexing running.',
    'Ask the server administrator to enable systemd user services, then run mnemonik install.',
  ],
  mac_authorization_required: [
    'Mnemonik needs your Mac password to set up background indexing.',
    'Run mnemonik install in a terminal and enter your Mac password.',
  ],
  mac_authorization_failed: [
    'Background indexing was not set up because the password was not accepted.',
    SCANNER_LIMITED_ACTION,
  ],
  scanner_replacement_rolled_back: [
    'Background indexing went back to the previous version.',
    SCANNER_LIMITED_ACTION,
  ],
  scanner_stop_failed: [
    'Background indexing could not be stopped.',
    'Restart this computer, then run mnemonik uninstall again.',
  ],
  scanner_other_account: [
    'Background indexing is already set up for another account on this Mac.',
    '',
  ],
  scanner_stopped: [
    'Background indexing is stopped on this computer.',
    'Run mnemonik scanner start and enter your Mac password to start it again.',
  ],
  scanner_replacement_failed: [
    'Background indexing could not be started. Mnemonik tried the new version and the last working one.',
    SCANNER_LIMITED_ACTION,
  ],
  scanner_replacement_pending: [
    'Background indexing is restarting with a new version.',
    'Wait a minute, then check again.',
  ],
  heartbeat_timeout: [
    'Background indexing started but has not reported yet.',
    'Wait a minute, then check again.',
  ],
};
export class ScannerServiceLimited extends Error {
  readonly status = 'LIMITED';
  get summary(): string {
    return SCANNER_SENTENCES[this.reason]?.[0] ?? SCANNER_LIMITED_SENTENCE;
  }
  get action(): string {
    if (
      this.reason.startsWith('scanner_replacement_') &&
      /ENOSPC|no space left/iu.test(this.message)
    )
      return 'Free disk space on this computer, then run mnemonik install.';
    return SCANNER_SENTENCES[this.reason]?.[1] ?? SCANNER_LIMITED_ACTION;
  }
  constructor(
    readonly reason: string,
    message = reason
  ) {
    super(message);
  }
}
export function scannerService(options: ScannerServiceOptions) {
  let store = options.store ?? new RuntimeStore(options.stateDir);
  const configureStore = async () => {
    if (!options.store) {
      const saved = JSON.parse(
        await new RuntimeStore(options.stateDir)
          .bytes(join(options.stateDir, 'scanner/state.json'))
          .then((bytes) => bytes.toString())
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return 'null';
            throw error;
          })
      ) as { devReleaseSource?: boolean } | null;
      store = new RuntimeStore(options.stateDir, undefined, {
        allowUnsigned: saved?.devReleaseSource === true,
      });
    }
  };
  const verify = async () => {
    await configureStore();
    return store.verifyRuntime('scanner');
  };
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? delay;
  let verified = false;
  let replacementRuntime: Verified | undefined;
  const command =
    options.command ??
    (async (operation, definition) => {
      const retained = replacementRuntime ?? options.supervisorRuntime;
      const fixed =
        !replacementRuntime && (options.platform ?? process.platform) === 'darwin'
          ? await lstat(macScannerLauncher).catch((error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT') return null;
              throw error;
            })
          : null;
      if (fixed && (!fixed.isFile() || fixed.uid !== 0 || fixed.mode & 0o022))
        throw new Error('service_runtime_permission');
      const entry = fixed
        ? macScannerLauncher
        : (retained
            ? await store.verifyRetainedRuntime('scanner', retained.reference)
            : await verify()
          ).entry;
      return new Promise<ServiceResult>((resolve, reject) => {
        const child = execFile(
          entry,
          ['service', operation, '--json'],
          {
            timeout:
              (options.platform ?? process.platform) === 'darwin'
                ? SCANNER_MAC_COMMAND_BUDGET_MS
                : process.platform === 'win32'
                  ? WINDOWS_SERVICE_BUDGET_MS
                  : 30000,
            encoding: 'utf8',
            env: {
              ...process.env,
              MNEMONIK_STATE_DIR: options.stateDir,
              NODE_OPTIONS: '',
              NODE_EXTRA_CA_CERTS: '',
            },
          },
          (error, stdout) => {
            if (error) {
              reject(
                new Error(
                  `scanner_service_command_failed killed=${error.killed ?? false} code=${error.code ?? null} signal=${error.signal ?? null}: ${error.message}`
                )
              );
              return;
            }
            try {
              resolve(JSON.parse(stdout) as ServiceResult);
            } catch (error) {
              reject(error);
            }
          }
        );
        child.stdin?.end(definition ? JSON.stringify(definition) : '');
      });
    });
  const invoke = async (operation: ServiceOperation, definition?: ServiceDefinition) => {
    let result: ServiceResult;
    const interrupt = () => {};
    const terminalAuthentication =
      (options.platform ?? process.platform) === 'darwin' && operation === 'install';
    if (terminalAuthentication) process.on('SIGINT', interrupt);
    try {
      result = await command(operation, definition);
    } catch (error) {
      throw new ScannerServiceLimited('scanner_service_unavailable', (error as Error).message);
    } finally {
      if (terminalAuthentication) process.removeListener('SIGINT', interrupt);
    }
    if (result.status === 'LIMITED') throw new ScannerServiceLimited(result.reason, result.detail);
    return result.supervisor;
  };
  const waitFor = async (
    phase: 'service' | 'heartbeat',
    ms: number,
    check: () => Promise<boolean>
  ) => {
    for (;;) {
      options.waiting?.(phase, ms);
      const deadline = now() + ms;
      do {
        if (await check()) return;
        if (now() >= deadline) break;
        await sleep(Math.min(1000, deadline - now()));
      } while (now() <= deadline);
      if ((await options.timeout?.(phase)) !== 'retry')
        throw new ScannerServiceLimited(
          `${phase}_timeout`,
          `${phase} timed out; retry or skip with scanner coverage LIMITED.`
        );
      if (phase === 'service') await invoke('start');
    }
  };
  // The only question the network answers: has this process reached the server?
  const heartbeat = async (since: number, pid: number | null) => {
    const snapshot = (await scannerReceipt(options.stateDir).catch(() => null))?.snapshot;
    return (
      pid !== null &&
      snapshot?.lifecycle.pid === pid &&
      (snapshot.heartbeat.lastSuccess ?? 0) > since
    );
  };
  const locallyReady = async (since: number, pid: number, paused = false) =>
    scannerAttemptHealthy(
      await scannerReceipt(options.stateDir).catch(() => null),
      { pid, startedAt: since },
      paused
    );
  const describe = async (): Promise<ServiceDefinition> => {
    const runtime = await verify();
    return options.describe
      ? await options.describe()
      : (JSON.parse(
          (
            await promisify(execFile)(runtime.entry, ['service', 'describe', '--json'], {
              env: {
                ...process.env,
                MNEMONIK_STATE_DIR: options.stateDir,
                NODE_OPTIONS: '',
                NODE_EXTRA_CA_CERTS: '',
              },
            })
          ).stdout
        ) as ServiceDefinition);
  };
  return {
    status: () => invoke('status'),
    async recover(): Promise<boolean> {
      if ((options.platform ?? process.platform) !== 'darwin') return false;
      return withLock(
        join(options.stateDir, 'scanner/launchd-replacement-control'),
        5000,
        async () => {
          const receipt = await scannerReceipt(options.stateDir);
          const snapshot = receipt?.snapshot;
          const attempt = await readFile(
            join(options.stateDir, 'scanner/service-replacement/result.json'),
            'utf8'
          )
            .then((text) => JSON.parse(text) as { pid?: number; startedAt?: number })
            .catch(() => null);
          const age = now() - Number(attempt?.startedAt);
          if (attempt?.pid && age <= SCANNER_HANDOFF_BUDGET_MS) return false;
          const stalledStart =
            attempt?.pid && Number.isFinite(age) && age > SCANNER_HANDOFF_BUDGET_MS;
          const staleReceipt =
            snapshot &&
            receipt &&
            snapshot.heartbeat.lastSuccess &&
            ['running', 'starting'].includes(snapshot.lifecycle.state) &&
            now() - snapshot.heartbeat.lastSuccess > SCANNER_RECEIPT_STALE_MS &&
            now() - receipt.recordedAt > SCANNER_RECEIPT_STALE_MS;
          const pid = stalledStart ? attempt.pid : snapshot?.lifecycle.pid;
          if (!pid || (!stalledStart && !staleReceipt)) return false;
          // A fresh local receipt proves progress even when the server is offline.
          if (
            receipt &&
            snapshot?.lifecycle.pid === pid &&
            (snapshot.lifecycle.state === 'paused' ||
              now() - receipt.recordedAt <= SCANNER_RECEIPT_STALE_MS)
          )
            return false;
          const state = JSON.parse(
            await readFile(join(options.stateDir, 'scanner/state.json'), 'utf8')
          );
          if (state.paused) return false;
          let runtime = await verify();
          const service = await invoke('status');
          if (service.binaryPath !== runtime.entry) {
            const pointer = JSON.parse(
              (await store.bytes(store.pointerPath('scanner'))).toString()
            ) as {
              previous?: typeof runtime.reference;
            };
            if (!pointer.previous) return false;
            runtime = await store.verifyRetainedRuntime('scanner', pointer.previous);
          }
          if (
            service.kind !== 'launchd' ||
            !service.installed ||
            !service.running ||
            service.pid !== pid ||
            service.binaryPath !== runtime.entry ||
            !process.getuid
          )
            return false;
          if (
            !(options.pidIdentity ?? pidIsScanner)(pid, 'darwin', undefined, {
              binaryPath: runtime.entry,
              uid: process.getuid(),
            })
          )
            return false;
          // A frozen event loop cannot handle SIGTERM. KeepAlive owns the restart.
          (options.signal ?? process.kill)(pid, 'SIGKILL');
          options.onScannerRestartRequested?.();
          return true;
        }
      );
    },
    get verified() {
      return verified;
    },
    async inspect() {
      try {
        const status = await invoke('status');
        return [
          {
            id: 'scanner',
            before: JSON.stringify({
              ...status,
              ...(status.installed && options.captureDefinition
                ? { definition: await describe() }
                : {}),
            }),
          },
        ];
      } catch (error) {
        if (!(error instanceof ScannerServiceLimited)) throw error;
        return [{ id: 'scanner', before: 'unknown' }];
      }
    },
    async start(
      _id = 'scanner',
      heartbeatAfter?: number
    ): Promise<
      { started: true; alreadyRunning: false } | { started: false; alreadyRunning: true }
    > {
      verified = false;
      let state = await invoke('status');
      const alreadyRunning = state.running;
      const startedAt = now();
      if (!state.installed) {
        await invoke('install', await describe());
      }
      state = await invoke('status');
      if (!state.running) await invoke('start');
      await waitFor('service', WINDOWS_SERVICE_BUDGET_MS, async () => {
        state = await invoke('status');
        return state.running;
      });
      // Existing healthy services need no restart; accept a receipt within the heartbeat cadence.
      await waitFor('heartbeat', SCANNER_STARTUP_BUDGET_MS, () =>
        heartbeat(heartbeatAfter ?? (alreadyRunning ? startedAt - 300000 : startedAt), state.pid)
      );
      verified = true;
      return alreadyRunning
        ? { started: false, alreadyRunning: true }
        : { started: true, alreadyRunning: false };
    },
    async exportPreview(out: string) {
      const runtime = await verify();
      return promisify(execFile)(runtime.entry, ['export-preview', '--out', out], {
        env: {
          ...process.env,
          MNEMONIK_STATE_DIR: options.stateDir,
          NODE_OPTIONS: '',
          NODE_EXTRA_CA_CERTS: '',
        },
      });
    },
    async replace(runtime: Verified, replacement: NonNullable<ServiceDefinition['replacement']>) {
      replacementRuntime = runtime;
      verified = false;
      const saved = JSON.parse(
        replacement.state?.after ??
          (await readFile(join(options.stateDir, 'scanner/state.json'), 'utf8'))
      ) as { paused?: boolean; config?: { credentialFamilyId?: string } };
      const startedAt = now();
      // Authorization precedes publication. Launchd owns recovery if this caller dies.
      await invoke('install', {
        binaryPath: runtime.entry,
        arguments: ['start'],
        workingDirectory: runtime.directory,
        environment: { MNEMONIK_STATE_DIR: options.stateDir },
        credentialFamilyId: saved.config?.credentialFamilyId,
        runAtLogin: true,
        restart: { policy: 'on-failure', delayMs: 3000 },
        logDestination: join(options.stateDir, 'scanner/scanner.log'),
        replacement,
      });
      const deadline = now() + SCANNER_HANDOFF_BUDGET_MS;
      while (now() < deadline) {
        const attempt = (await readFile(
          join(options.stateDir, 'scanner/service-replacement/result.json'),
          'utf8'
        )
          .then(JSON.parse)
          .catch(() => null)) as {
          pid: number;
          startedAt: number;
          fallback?: boolean;
          candidateError?: string;
          fallbackError?: string;
        } | null;
        if (attempt && attempt.startedAt >= startedAt) {
          if (attempt.candidateError === 'scanner_configuration_changed')
            throw new ScannerServiceLimited('scanner_replacement_interrupted');
          if (attempt.fallbackError)
            throw new ScannerServiceLimited(
              attempt.fallbackError === 'scanner_fallback_missing'
                ? 'scanner_replacement_candidate_failed'
                : 'scanner_replacement_failed',
              [attempt.candidateError, attempt.fallbackError].filter(Boolean).join('; ')
            );
          const active = await invoke('status');
          if (
            active.running &&
            active.pid === attempt.pid &&
            (await locallyReady(attempt.startedAt, active.pid, saved.paused))
          ) {
            if (attempt.fallback)
              throw new ScannerServiceLimited(
                'scanner_replacement_rolled_back',
                attempt.candidateError
              );
            verified = true;
            return;
          }
        }
        await sleep(1000);
      }
      throw new ScannerServiceLimited('scanner_replacement_interrupted');
    },
    async restart() {
      // Let the adapter validate and replace its registration before stopping a
      // working service. Uninstall first discards the definition rollback needs.
      const definition = await describe();
      const startedAt = now();
      // On systemd the adapter submits one manager-owned restart. A CLI stop
      // then start would strand the scanner if this process disappeared between them.
      await invoke('install', definition);
      return this.start('scanner', startedAt);
    },
    async stop() {
      await invoke('stop');
    },
    async uninstall() {
      const native = (timeout: number) =>
        options.supervisorRun ??
        (async (file: string, args: string[]) =>
          (await promisify(execFile)(file, args, { encoding: 'utf8', timeout })).stdout);
      try {
        if ((options.platform ?? process.platform) === 'darwin') {
          // Removal must also work offline with a legacy, missing or damaged runtime.
          // Ask launchd directly rather than trusting the executable being removed.
          return await withLock(
            join(options.stateDir, 'scanner/launchd-replacement-control'),
            SCANNER_REMOVAL_BUDGET_MS,
            async () => {
              await removeMacScanner(
                options.stateDir,
                options.home ?? homedir(),
                options.uid ?? process.getuid?.() ?? -1,
                native(SCANNER_REMOVAL_BUDGET_MS),
                { now, sleep, plist: options.systemPlist }
              );
              await rm(dirname(store.pointerPath('scanner')), { recursive: true, force: true });
            }
          );
        }
        if ((options.platform ?? process.platform) === 'linux') {
          const recordedPid = await readFile(join(options.stateDir, 'scanner/status.json'), 'utf8')
            .then(
              (text) =>
                (JSON.parse(text) as { snapshot?: { lifecycle?: { pid?: number } } }).snapshot
                  ?.lifecycle?.pid
            )
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT') return undefined;
              throw error;
            });
          await uninstallSystemdUnit(
            join(
              process.env.XDG_CONFIG_HOME ?? join(options.home ?? homedir(), '.config'),
              'systemd/user/mnemonik-scanner.service'
            ),
            native(SCANNER_STOP_BUDGET_MS),
            { now, sleep, recordedPid }
          );
        } else {
          await invoke('stop');
          await invoke('uninstall');
        }
        await rm(dirname(store.pointerPath('scanner')), { recursive: true, force: true });
      } catch (error) {
        // Native removal reports one code; keep the reason it actually failed for.
        const cause = (error as Error).cause;
        throw new ScannerServiceLimited(
          'scanner_stop_failed',
          [(error as Error).message, cause instanceof Error ? cause.message : undefined]
            .filter(Boolean)
            .join(': ')
        );
      }
    },
    async restore(_id: string, before: string) {
      if (before === 'unknown') return;
      const restoredAt = now();
      const previous = JSON.parse(before) as SupervisorStatus & { definition?: ServiceDefinition };
      if (previous.installed && previous.definition) {
        await invoke('install', previous.definition);
        if (previous.running) await this.start('scanner', restoredAt);
        else await invoke('stop');
        return;
      }
      if (!previous.installed) await invoke('uninstall');
      else if (previous.running) await this.start('scanner', restoredAt);
      else await invoke('stop');
    },
  };
}
