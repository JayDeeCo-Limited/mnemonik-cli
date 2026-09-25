import { WINDOWS_SERVICE_BUDGET_MS } from '@mnemonik/shared';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicWrite, withLock } from '@mnemonik/local-setup';
import { scannerService, type ScannerServiceOptions } from './service.js';

export interface ScannerReceipt {
  recordedAt: number;
  snapshot: {
    devReleaseSource?: boolean;
    version: string | null;
    lifecycle: {
      state: string;
      reason: string;
      pid: number | null;
      controlId?: string;
      pauseIntervals: Array<{ start: number; end: number | null }>;
      readiness?: string;
      action?: string;
    };
    heartbeat: { lastSuccess: number | null };
    startupTimings?: { localReadyAt?: number | null };
    transfers?: {
      sinceStart: { files: number; bytes: number };
      sinceInstall: { files: number; bytes: number };
    };
    roots: string[];
    exclusions: string[];
    /** One entry per batch the server refused (scanner daemon `getRefusedBatches`). */
    refusedBatches?: Array<{ project: string; files: number; issue: string }>;
    /** The scanner's last failure until it recovers; `cause` is the line it logged. */
    failure?: {
      kind: string;
      at: string;
      cause: string;
      /** push_rejected: the server's stated reason. */
      reason?: string;
      /** watcher_error: the project's name. */
      project?: string;
    } | null;
  };
}
/** The scanner paused itself because its saved consent does not cover it. */
export function pausedForConsent(receipt: ScannerReceipt | null | undefined): boolean {
  return (
    receipt?.snapshot.lifecycle.state === 'paused' &&
    receipt.snapshot.lifecycle.reason === 'consent_required'
  );
}
export async function scannerReceipt(stateDir: string): Promise<ScannerReceipt | null> {
  return JSON.parse(
    await readFile(join(stateDir, 'scanner/status.json'), 'utf8').catch(() => 'null')
  ) as ScannerReceipt | null;
}
/** The install run that paused the scanner, so a later command can tell when it is gone. */
export interface PauseOwner {
  /** The install journal's run id. */
  session: string;
  pid: number;
  at: number;
}
export const ABANDONED_PAUSE_RESUMED =
  'Background indexing was paused by an installation that did not finish. Mnemonik resumed it.';
const INSTALL_LEASE_STALE_MS = 30_000;

export async function controlScanner(
  action: 'pause' | 'resume' | 'stop',
  options: ScannerServiceOptions,
  owner?: PauseOwner
) {
  const { running, pid } = await scannerService(options).status();
  if (!running || !pid) throw new Error('scanner_not_running');
  return withLock(join(options.stateDir, 'scanner/control'), 5000, () =>
    sendControl(action, options, pid, owner)
  );
}

async function sendControl(
  action: 'pause' | 'resume' | 'stop',
  options: ScannerServiceOptions,
  pid: number,
  owner?: PauseOwner
) {
  const id = randomUUID();
  await atomicWrite(
    join(options.stateDir, 'scanner/control.json'),
    Buffer.from(JSON.stringify({ id, action, ...(owner ? { owner } : {}) }))
  );
  const now = options.now ?? Date.now;
  const deadline = now() + (process.platform === 'win32' ? WINDOWS_SERVICE_BUDGET_MS / 4 : 10000);
  do {
    const receipt = await scannerReceipt(options.stateDir);
    if (receipt?.snapshot.lifecycle.pid === pid && receipt.snapshot.lifecycle.controlId === id)
      return receipt;
    await (options.sleep ?? delay)(100);
  } while (now() < deadline);
  throw new Error('scanner_control_timeout');
}

type ControlRequest = { id?: string; action?: string; owner?: Partial<PauseOwner> };
const readControl = async (stateDir: string) =>
  JSON.parse(
    await readFile(join(stateDir, 'scanner/control.json'), 'utf8').catch(() => 'null')
  ) as ControlRequest | null;

/** An install holds its lease while it runs; the lease and its process both have to be alive. */
async function installerAlive(stateDir: string, owner: Partial<PauseOwner>): Promise<boolean> {
  if (typeof owner.pid !== 'number' || typeof owner.session !== 'string') return false;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  const lease = await stat(join(stateDir, 'install-owner.json.lock')).catch(() => null);
  if (!lease || Date.now() - lease.mtimeMs > INSTALL_LEASE_STALE_MS) return false;
  const current = JSON.parse(
    await readFile(join(stateDir, 'install-owner.json'), 'utf8').catch(() => '{}')
  ) as { runId?: unknown };
  return current.runId === owner.session;
}

/**
 * An install pauses a running scanner while it works and resumes it when it
 * stops. One that died on the way leaves the pause behind, and nothing else
 * would undo it. A pause a person chose carries no owner and is left alone.
 */
export async function resumeAbandonedPause(options: ScannerServiceOptions): Promise<boolean> {
  const request = await readControl(options.stateDir);
  if (request?.action !== 'pause' || !request.owner) return false;
  if (await installerAlive(options.stateDir, request.owner)) return false;
  const supervisor = await scannerService(options)
    .status()
    .catch(() => undefined);
  const pid = supervisor?.running ? supervisor.pid : null;
  if (!pid) return false;
  // A finished install leaves its request behind with the scanner running. The
  // pause must be this request, applied by this process or restored at its start.
  const lifecycle = (await scannerReceipt(options.stateDir))?.snapshot.lifecycle;
  if (
    lifecycle?.pid !== pid ||
    lifecycle.state !== 'paused' ||
    (lifecycle.controlId !== request.id &&
      (lifecycle.controlId !== undefined || lifecycle.reason !== 'pause_restored'))
  )
    return false;
  return withLock(join(options.stateDir, 'scanner/control'), 5000, async () => {
    // Another command may have written a newer request since the first read.
    if ((await readControl(options.stateDir))?.id !== request.id) return false;
    // No acknowledgement leaves the pause for status to report as before.
    return sendControl('resume', options, pid).then(
      () => true,
      () => false
    );
  });
}
