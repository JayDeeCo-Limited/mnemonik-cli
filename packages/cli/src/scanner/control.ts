import { WINDOWS_SERVICE_BUDGET_MS } from '@mnemonik/shared';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
  };
}
export async function scannerReceipt(stateDir: string): Promise<ScannerReceipt | null> {
  return JSON.parse(
    await readFile(join(stateDir, 'scanner/status.json'), 'utf8').catch(() => 'null')
  ) as ScannerReceipt | null;
}
export async function controlScanner(action: 'pause' | 'resume', options: ScannerServiceOptions) {
  const supervisor = await scannerService(options).status();
  if (!supervisor.running || !supervisor.pid) throw new Error('scanner_not_running');
  return withLock(join(options.stateDir, 'scanner/control'), 5000, async () => {
    const id = randomUUID();
    await atomicWrite(
      join(options.stateDir, 'scanner/control.json'),
      Buffer.from(JSON.stringify({ id, action }))
    );
    const now = options.now ?? Date.now;
    const deadline = now() + (process.platform === 'win32' ? WINDOWS_SERVICE_BUDGET_MS / 4 : 10000);
    do {
      const receipt = await scannerReceipt(options.stateDir);
      if (
        receipt?.snapshot.lifecycle.pid === supervisor.pid &&
        receipt.snapshot.lifecycle.controlId === id
      )
        return receipt;
      await (options.sleep ?? delay)(100);
    } while (now() < deadline);
    throw new Error('scanner_control_timeout');
  });
}
