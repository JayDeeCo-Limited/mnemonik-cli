import { WINDOWS_SERVICE_BUDGET_MS } from '@mnemonik/shared';
import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  ServiceDefinition,
  ServiceOperation,
  ServiceResult,
  SupervisorStatus,
} from '@mnemonik/shared';
import { RuntimeStore } from '../runtime/store.js';

export interface ScannerServiceOptions {
  stateDir: string;
  captureDefinition?: boolean;
  store?: RuntimeStore;
  describe?: () => Promise<ServiceDefinition>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  command?: (operation: ServiceOperation, definition?: ServiceDefinition) => Promise<ServiceResult>;
  timeout?: (phase: 'service' | 'heartbeat') => Promise<'retry' | 'skip'>;
  waiting?: (phase: 'service' | 'heartbeat', ms: number) => void;
}
export class ScannerServiceLimited extends Error {
  readonly status = 'LIMITED';
  readonly action = 'mnemonik scanner enable';
  constructor(
    readonly reason: string,
    message = reason
  ) {
    super(message);
  }
}
export function scannerService(options: ScannerServiceOptions) {
  let store = options.store ?? new RuntimeStore(options.stateDir);
  const verify = async () => {
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
    return store.verifyRuntime('scanner');
  };
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? delay;
  let verified = false;
  const command =
    options.command ??
    (async (operation, definition) => {
      const runtime = await verify();
      return new Promise<ServiceResult>((resolve, reject) => {
        const child = execFile(
          runtime.entry,
          ['service', operation, '--json'],
          {
            timeout: process.platform === 'win32' ? WINDOWS_SERVICE_BUDGET_MS : 30000,
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
    try {
      result = await command(operation, definition);
    } catch (error) {
      throw new ScannerServiceLimited('scanner_service_unavailable', (error as Error).message);
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
  const heartbeat = async (since: number, pid: number | null) => {
    try {
      const receipt = JSON.parse(
        await readFile(join(options.stateDir, 'scanner/status.json'), 'utf8')
      ) as { snapshot: { lifecycle: { pid: number }; heartbeat: { lastSuccess: number | null } } };
      return (
        pid !== null &&
        receipt.snapshot.lifecycle.pid === pid &&
        typeof receipt.snapshot.heartbeat.lastSuccess === 'number' &&
        receipt.snapshot.heartbeat.lastSuccess > since
      );
    } catch {
      return false;
    }
  };
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
      _id = 'scanner'
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
      await waitFor('heartbeat', 60000, () =>
        heartbeat(alreadyRunning ? startedAt - 300000 : startedAt, state.pid)
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
    async restart() {
      await invoke('stop');
      await invoke('uninstall');
      return this.start();
    },
    async stop() {
      await invoke('stop');
    },
    async uninstall() {
      await invoke('stop');
      await invoke('uninstall');
      await rm(dirname(store.pointerPath('scanner')), { recursive: true, force: true });
    },
    async restore(_id: string, before: string) {
      if (before === 'unknown') return;
      const previous = JSON.parse(before) as SupervisorStatus & { definition?: ServiceDefinition };
      if (previous.installed && previous.definition) {
        await invoke('install', previous.definition);
        await invoke(previous.running ? 'start' : 'stop');
        return;
      }
      if (!previous.installed) await invoke('uninstall');
      else if (!previous.running) await invoke('stop');
    },
  };
}
