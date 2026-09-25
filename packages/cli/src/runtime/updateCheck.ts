import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from '@mnemonik/local-setup';
import type { ReadinessUpdateCheck } from '@mnemonik/shared';

/**
 * The last full `mnemonik update` on this machine, automatic or by hand. The
 * readiness report carries it, so the console can say when an automatic update
 * did not finish instead of leaving a machine quietly behind.
 */
const updateCheckPath = (stateDir: string) => join(stateDir, 'update-check.json');

export async function recordUpdateCheck(
  stateDir: string,
  result: ReadinessUpdateCheck['result'],
  now: () => number = Date.now
): Promise<void> {
  const check: ReadinessUpdateCheck = { checkedAt: new Date(now()).toISOString(), result };
  try {
    await atomicWrite(updateCheckPath(stateDir), Buffer.from(`${JSON.stringify(check)}\n`));
  } catch {
    // The record describes the update; failing to write it must not fail the update.
  }
}

export async function readUpdateCheck(stateDir: string): Promise<ReadinessUpdateCheck | undefined> {
  try {
    const value = JSON.parse(await readFile(updateCheckPath(stateDir), 'utf8')) as unknown;
    const { checkedAt, result } = (value ?? {}) as Partial<ReadinessUpdateCheck>;
    if (
      typeof checkedAt !== 'string' ||
      !Number.isFinite(Date.parse(checkedAt)) ||
      !['updated', 'current', 'failed'].includes(String(result))
    )
      return undefined;
    return { checkedAt, result: result as ReadinessUpdateCheck['result'] };
  } catch {
    return undefined;
  }
}
