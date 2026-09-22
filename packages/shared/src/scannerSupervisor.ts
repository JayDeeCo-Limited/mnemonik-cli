export const WINDOWS_SERVICE_BUDGET_MS = 120_000;
/** Every scanner supervision timing, named once. Budgets come from measured cold starts. */
export const SCANNER_STARTUP_BUDGET_MS = 60_000,
  SCANNER_RAPID_FAILURE_LIMIT = 3,
  SCANNER_HANDOFF_BUDGET_MS = 150_000,
  SCANNER_RECEIPT_STALE_MS = 360_000,
  SCANNER_MAC_COMMAND_BUDGET_MS = 360_000,
  SCANNER_STOP_BUDGET_MS = 10_000,
  SCANNER_REMOVAL_BUDGET_MS = 180_000;

/**
 * One rule for every caller: did this attempt reach its local running state? It
 * judges only what the machine can prove, never the network. A clean exit keeps
 * the progress it made, and a pause counts only where a pause was expected.
 */
export function scannerAttemptHealthy(
  receipt: {
    recordedAt?: number;
    snapshot?: {
      version?: string | null;
      lifecycle?: { pid?: number | null; state?: string };
      startupTimings?: { localReadyAt?: number | null };
    };
  } | null,
  attempt: { pid?: number | null; startedAt: number; version?: string } | null,
  paused = false
): boolean {
  const life = receipt?.snapshot?.lifecycle;
  const readyAt = receipt?.snapshot?.startupTimings?.localReadyAt;
  const state = life?.state;
  return (
    !!receipt &&
    !!attempt &&
    (receipt.recordedAt ?? 0) > attempt.startedAt &&
    (attempt.version === undefined || receipt.snapshot?.version === attempt.version) &&
    (life?.pid === attempt.pid || state === 'stopped') &&
    ((paused && state === 'paused') ||
      ((readyAt ?? 0) > attempt.startedAt &&
        (state === 'running' || state === 'starting' || state === 'stopped')) ||
      (readyAt === undefined && state === 'running'))
  );
}

export interface ServiceDefinition {
  /** Test isolation; production always uses mnemonik-scanner.service. */
  unitName?: string;
  /** Publish the selected release after authorizing the system service. */
  replacement?: {
    pointer: { after: string };
    state?: { before: string | null; after: string };
  };
  binaryPath: string;
  arguments: readonly ['start'];
  workingDirectory: string;
  environment: Readonly<Record<string, string>>;
  credentialFamilyId?: string;
  runAtLogin: true;
  restart: { policy: 'on-failure'; delayMs: number };
  logDestination: string;
}
export interface SupervisorStatus {
  kind: string;
  installed: boolean;
  running: boolean;
  pid: number | null;
  binaryPath?: string;
  reason?: string;
}
export type ServiceOperation = 'install' | 'uninstall' | 'start' | 'stop' | 'status';
export type ServiceResult =
  | { status: 'ok'; supervisor: SupervisorStatus }
  | { status: 'LIMITED'; reason: string; detail: string; action: string };
