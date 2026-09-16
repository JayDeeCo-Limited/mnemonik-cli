import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from '@mnemonik/local-setup';
import { RuntimeError, RuntimeStore } from './store.js';
import { npmReleaseSource, releaseBytes } from './releaseSource.js';
import { newerVersion } from './bootstrap.js';

const registry = 'https://registry.npmjs.org/%40mnemonik%2Fcli/';
const validVersion = (value: unknown): value is string =>
  typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(value);
async function metadata(version = 'latest', fetcher: typeof fetch = fetch) {
  const value = JSON.parse((await releaseBytes(registry + version, fetcher)).toString()) as {
    name: string;
    version: string;
    dist: { integrity: string; tarball: string };
  };
  if (
    value.name !== '@mnemonik/cli' ||
    !validVersion(value.version) ||
    (version !== 'latest' && value.version !== version) ||
    !/^(sha512|sha256)-[A-Za-z0-9+/=]+$/.test(value.dist?.integrity) ||
    typeof value.dist?.tarball !== 'string'
  )
    throw new RuntimeError('unsigned');
  return value;
}
export async function updateCli(store: RuntimeStore): Promise<{
  status: 'NOT_INSTALLED' | 'UP_TO_DATE' | 'UPDATED' | 'FAILED';
  oldVersion?: string;
  newVersion?: string;
  reason?: string;
  devReleaseSource?: boolean;
}> {
  let oldVersion: string | undefined;
  let newVersion: string | undefined;
  const dev = process.env.MNEMONIK_DEV_RELEASE_DIR ? { devReleaseSource: true } : {};
  try {
    // Source checkouts do not have a managed CLI; the public entry always installs one first.
    if (
      !(await readFile(store.pointerPath('cli')).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return false;
          throw error;
        }
      ))
    )
      return { status: 'NOT_INSTALLED', ...dev };
    oldVersion = (await store.verifyRuntime('cli')).reference.version;
    const latest = await metadata();
    newVersion = latest.version;
    if (oldVersion === newVersion) return { status: 'UP_TO_DATE', oldVersion, newVersion, ...dev };
    const exact = await metadata(newVersion);
    if (exact.dist.integrity !== latest.dist.integrity) throw new RuntimeError('digest_mismatch');
    const source = await npmReleaseSource(fetch, async () => ({
      version: exact.version,
      'dist.integrity': exact.dist.integrity,
      'dist.tarball': exact.dist.tarball,
    }));
    await store.installRuntime('cli', newVersion, source);
    return { status: 'UPDATED', oldVersion, newVersion, ...dev };
  } catch (error) {
    return { status: 'FAILED', oldVersion, newVersion, reason: (error as Error).message, ...dev };
  }
}
export function cliUpdateLine(result: Awaited<ReturnType<typeof updateCli>>): string {
  if (result.status === 'UPDATED')
    return `CLI updated: ${result.oldVersion} -> ${result.newVersion}. Next invocation uses ${result.newVersion}.`;
  if (result.status === 'UP_TO_DATE') return `CLI up to date: ${result.oldVersion}.`;
  if (result.status === 'NOT_INSTALLED') return 'CLI runtime is not installed.';
  return `CLI update FAILED: ${result.reason}. CLI remains ${result.oldVersion ?? 'unavailable'}.`;
}

/** Status alone caches successes and failures; update always reads the release afresh. */
export async function cliUpdateHint(
  store: RuntimeStore,
  current: string
): Promise<string | undefined> {
  const path = join(store.state, 'cli-update-check.json');
  const devReleaseSource = process.env.MNEMONIK_DEV_RELEASE_DIR ?? '';
  let cached: { checkedAt: number; version?: string; devReleaseSource: string } | undefined;
  try {
    await store.inspect(path);
    cached = JSON.parse(await readFile(path, 'utf8')) as typeof cached;
  } catch {
    /* An absent or unreadable hint must not affect status. */
  }
  if (
    !cached ||
    cached.devReleaseSource !== devReleaseSource ||
    !(Date.now() - cached.checkedAt >= 0 && Date.now() - cached.checkedAt < 3_600_000)
  ) {
    cached = { checkedAt: Date.now(), devReleaseSource };
    try {
      const signal = AbortSignal.timeout(2500);
      cached.version = (
        await metadata('latest', (url, options) => fetch(url, { ...options, signal }))
      ).version;
    } catch {
      /* Offline status stays quiet. */
    }
    try {
      await store.inspect(store.state, true);
      await atomicWrite(path, Buffer.from(JSON.stringify(cached)));
    } catch {
      /* Cache persistence is best effort. */
    }
  }
  if (!validVersion(cached.version) || cached.version === current) return undefined;
  if (!newerVersion(cached.version, current)) return undefined;
  return `CLI ${cached.version} is available; run mnemonik update.`;
}
