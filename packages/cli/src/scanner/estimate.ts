import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * What the person sees before the first scan: how many files will be
 * indexed, how much they hold, and roughly how long indexing will take
 * (assessment item 8; owner decision of 25 October 2026). The count is the
 * scanner's own file selection (the shared FileSelector, with every ignore
 * rule it applies), and the time comes from the server's measured throughput
 * and current queue (`GET /api/v1/scan/ingest/estimate`). Neither blocks
 * anything: a count that takes too long, or an estimate the server cannot
 * give, is simply not shown.
 */

export interface FolderCount {
  files: number;
  bytes: number;
  /** The walk stopped at its time bound; the numbers are a lower bound. */
  partial: boolean;
}

export interface ServerEstimate {
  files: number;
  lowSeconds: number;
  highSeconds: number;
  basis: 'measured' | 'typical';
  accountsAhead: number;
}

/** A count longer than this is shown as "at least". */
export const COUNT_TIME_BOUND_MS = 30_000;

type Lister = (root: string) => Promise<{ paths: string[] }>;

async function defaultLister(): Promise<Lister> {
  // The scanner's own selection (CodeScanner extends FileSelector), from the
  // subpath that loads no chunker, redaction or compiler: importing the
  // package root put the Svelte and Vue compilers in the public CLI's bundle
  // (26 Oct 2026).
  const { FileSelector } = await import('@mnemonik/shared/file-selection');
  const selector = new FileSelector();
  return (root) => selector.listFilesWithStatus(root);
}

/** The files the scanner would index under these folders, and their total size. */
export async function countIndexableFiles(
  roots: readonly string[],
  options: { list?: Lister; timeBoundMs?: number; now?: () => number } = {}
): Promise<FolderCount> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeBoundMs ?? COUNT_TIME_BOUND_MS);
  const list = options.list ?? (await defaultLister());
  let files = 0;
  let bytes = 0;
  for (const root of roots) {
    const remaining = deadline - now();
    if (remaining <= 0) return { files, bytes, partial: true };
    const listed = await Promise.race([
      list(root),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining).unref()),
    ]);
    if (!listed) return { files, bytes, partial: true };
    for (let i = 0; i < listed.paths.length; i += 64) {
      if (now() > deadline) return { files, bytes, partial: true };
      const sizes = await Promise.all(
        listed.paths.slice(i, i + 64).map((path) =>
          lstat(join(root, path)).then(
            (stat) => stat.size,
            () => null
          )
        )
      );
      for (const size of sizes) {
        if (size === null) continue;
        files++;
        bytes += size;
      }
    }
  }
  return { files, bytes, partial: false };
}

const number = (value: number) => value.toLocaleString('en-US');

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${number(Math.round(bytes / (1024 * 1024)))} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function unit(seconds: number): { value: number; name: string } {
  if (seconds < 90 * 60) return { value: Math.max(1, Math.round(seconds / 60)), name: 'minute' };
  if (seconds < 48 * 3600) return { value: Math.round(seconds / 3600), name: 'hour' };
  return { value: Math.round(seconds / 86_400), name: 'day' };
}

/** "about 5 minutes", "about 10 to 20 minutes", "about 2 to 4 hours". */
export function formatDurationRange(lowSeconds: number, highSeconds: number): string {
  if (highSeconds < 60) return 'under a minute';
  const low = unit(lowSeconds);
  const high = unit(highSeconds);
  const plural = (n: number, name: string) => `${n} ${name}${n === 1 ? '' : 's'}`;
  if (low.name !== high.name)
    return `about ${plural(low.value, low.name)} to ${plural(high.value, high.name)}`;
  if (low.value === high.value) return `about ${plural(high.value, high.name)}`;
  return `about ${low.value} to ${plural(high.value, high.name)}`;
}

/** The lines shown before the first scan. */
export function onboardingEstimateLines(
  count: FolderCount,
  estimate: ServerEstimate | null
): string[] {
  if (count.files === 0) return [];
  const files = `${count.partial ? 'at least ' : ''}${number(count.files)} file${count.files === 1 ? '' : 's'}`;
  const lines = [`Mnemonik will index ${files} (${formatBytes(count.bytes)}).`];
  if (estimate) {
    const busy = estimate.accountsAhead > 0 ? ' at the current load' : '';
    lines.push(
      `Indexing will take ${formatDurationRange(estimate.lowSeconds, estimate.highSeconds)}${busy}. You can keep working while it runs; files become searchable as they are indexed.`
    );
  }
  return lines;
}
