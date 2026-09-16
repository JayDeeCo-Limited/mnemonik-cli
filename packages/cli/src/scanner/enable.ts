import { revokeInstallComponent } from '../install/transaction.js';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Readable } from 'node:stream';
import { atomicWrite, withLock } from '@mnemonik/local-setup';
import { type ComponentCredentialResponse } from '@mnemonik/credentials';
import {
  apiOrigin,
  serializeReadiness,
  type SupervisorStatus,
  type ServiceDefinition,
} from '@mnemonik/shared';
import { createCliAuth } from '../auth/index.js';
import { createCliCredentials } from '../auth/credentials.js';
import { type InstallSession } from '../auth/installSession.js';
import { readInstallVersions } from '../install/ownership.js';
import { grantTransport } from '../auth/status.js';
import { readInstallation, saveInstallation } from '../installation.js';
import { RuntimeStore, hash, type RuntimeSource } from '../runtime/store.js';
import { releaseSource, devReadiness } from '../runtime/releaseSource.js';
import { Output } from '../output.js';
import { evaluateRoot } from '../project/eligibility.js';
import { runScannerPicker } from './picker.js';
import { scannerService, type ScannerServiceOptions } from './service.js';
import { controlScanner, scannerReceipt } from './control.js';
import { bytesAt, digest, type Journal } from '../install/journal.js';

export interface Consent {
  userId: string;
  roots: string[];
  exclusions: string[];
  disclosureVersion: string;
}
export interface SavedState {
  schemaVersion: 1;
  config: {
    roots: string[];
    exclusions: string[];
    serverUrl: string;
    credentialFamilyId?: string;
    deviceInstallationId?: string;
  };
  consent?: Consent;
  paused: boolean;
  pauseIntervals: Array<{ start: number; end: number | null; reason: string }>;
  devReleaseSource?: boolean;
}
export const scannerStateBytes = (state: SavedState): Buffer =>
  Buffer.from(`${JSON.stringify(state, null, 2)}\n`);
export interface EnableOptions extends ScannerServiceOptions {
  cwd: string;
  input: Readable;
  output: Output;
  nonInteractive?: boolean;
  pendingHosts?: boolean;
  journal?: Journal;
  roots?: string[];
  exclusions?: string[];
  noBrowser?: boolean;
  fetch?: typeof fetch;
  source?: () => Promise<RuntimeSource>;
  store?: RuntimeStore;
  credentials?: ReturnType<typeof createCliCredentials>;
  authorize?: (
    selection?: { roots: string[]; exclusions: string[] },
    installation?: string
  ) => Promise<string>;
}
export interface PreparedScanner {
  roots: string[];
  exclusions: string[];
  files: string[];
  session: InstallSession;
  apply(journal?: Journal): Promise<ReturnType<typeof serializeReadiness>>;
  rollback(journal: Journal): Promise<void>;
  complete(document: ReturnType<typeof serializeReadiness>): Promise<void>;
}
export async function enableScanner(options: EnableOptions) {
  return prepareScanner(options, async (prepared) => {
    const document = await prepared.apply();
    if (document.installation.state === 'READY') await prepared.complete(document);
    return document;
  });
}
/** The scanner lease spans browser review, Apply and compensation. */
export async function prepareScanner<T>(
  options: EnableOptions,
  work: (prepared: PreparedScanner) => Promise<T>
): Promise<T> {
  await mkdir(join(options.stateDir, 'scanner'), { recursive: true, mode: 0o700 });
  return withLock(join(options.stateDir, 'scanner/enable'), 5000, async () => {
    const path = join(options.stateDir, 'scanner/state.json');
    const saved = JSON.parse(await readFile(path, 'utf8').catch(() => 'null')) as SavedState | null;

    const credentials = options.credentials ?? createCliCredentials({ stateDir: options.stateDir });
    const authorize =
      options.authorize ??
      (async (selection, installation) => {
        const auth = createCliAuth({
          credentials: options.credentials ?? createCliCredentials({ stateDir: options.stateDir }),
          noBrowser: options.noBrowser,
          scannerRoots: selection ? JSON.stringify(selection) : undefined,
          credentialOptions: { stateDir: options.stateDir },
          deviceInstallationId: installation,
          print: (line) =>
            options.nonInteractive ? options.output.error(line) : options.output.line(line),
          fetch: options.fetch,
        });
        if (selection) await auth.signIn();
        let token = await auth.getCliBearer();
        if (typeof token !== 'string') {
          await auth.signIn();
          token = await auth.getCliBearer();
        }
        if (typeof token !== 'string') throw new Error(token.reason);
        return token;
      });
    let bearer = await authorize();
    const request = async (method: string, route: string, body?: unknown, missing = false) => {
      const response = await (options.fetch ?? fetch)(`${apiOrigin()}${route}`, {
        method,
        headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (missing && response.status === 404) return null;
      if (!response.ok) throw new Error(`scanner_request_${response.status}`);
      return response.json();
    };
    let session = (await request(
      'GET',
      '/api/v1/install-sessions/current',
      undefined,
      true
    )) as InstallSession | null;
    const store =
      options.store ??
      new RuntimeStore(options.stateDir, undefined, {
        allowUnsigned: !!process.env.MNEMONIK_DEV_RELEASE_DIR,
      });
    options = { ...options, store };
    const service = scannerService({ ...options, captureDefinition: true });
    const before =
      saved && (await bytesAt(store.pointerPath('scanner')))
        ? (await service.inspect())[0]?.before
        : undefined;
    if (before === 'unknown') throw new Error('scanner_service_unavailable');
    const previous = before
      ? (JSON.parse(before) as SupervisorStatus & { definition?: ServiceDefinition })
      : null;
    let restore = previous?.running && !saved?.paused;
    if (restore && options.journal && before) {
      const journal = options.journal;
      if (!journal.data.services.some((s) => s.id === 'scanner'))
        journal.data.services.push({ id: 'scanner', before, started: true });
      await journal.plan(path, await bytesAt(path), {
        kind: 'runtime',
        group: `scanner:${journal.data.targets.length}`,
      });
      await journal.event('service_start_intent', 'scanner');
    }
    if (restore) await controlScanner('pause', options);
    try {
      const picked = options.roots
        ? { roots: options.roots, exclusions: options.exclusions ?? [] }
        : options.nonInteractive
          ? (() => {
              throw new Error('scan_roots_required');
            })()
          : await runScannerPicker({
              input: options.input,
              output: options.output,
              currentProject: options.cwd,
              currentFolder: options.cwd,
            });
      if ('status' in picked) throw new Error('consent_declined');
      if (!picked.roots.length) throw new Error('scan_roots_required');
      picked.roots = await Promise.all(picked.roots.map((root) => realpath(root)));
      picked.exclusions = await Promise.all(picked.exclusions.map((root) => realpath(root)));
      for (const root of picked.roots) {
        const decision = await evaluateRoot(
          { kind: 'absent', root, repository: { kind: 'plain', root }, nested: [] },
          { cwd: root, nonGitSelected: true }
        );
        if (!decision.allowed) throw new Error(decision.reason);
      }
      let remote = (await request('GET', '/api/v1/scanner-consent/current')) as {
        consent: Consent | null;
        disclosure: { version: string; statements: Array<{ text: string }> };
      };
      if (!options.nonInteractive)
        for (const statement of remote.disclosure.statements) options.output.line(statement.text);
      const matches = () =>
        remote.consent?.disclosureVersion === remote.disclosure.version &&
        JSON.stringify(remote.consent?.roots) === JSON.stringify(picked.roots) &&
        JSON.stringify(remote.consent?.exclusions) === JSON.stringify(picked.exclusions);
      if (!matches() || !session) {
        const listing = await grantTransport(async () => bearer, options.fetch).list();
        const installation =
          session?.device_installation_id ??
          listing.deviceInstallationId ??
          (await readInstallation(options.stateDir, listing.account));
        if (!installation) throw new Error('scanner_installation_missing');
        // Browser approval reuses this installation's active session. Never cancel the hosts' session.
        bearer = await authorize(picked, installation);
        session = (await request('GET', '/api/v1/install-sessions/current')) as InstallSession;
        remote = (await request('GET', '/api/v1/scanner-consent/current')) as typeof remote;
      }
      if (!matches() || !remote.consent || !session) throw new Error('browser_consent_required');
      const listing = await grantTransport(async () => bearer, options.fetch).list();
      await saveInstallation(options.stateDir, session.device_installation_id, {
        account: listing.account,
      });
      const approvedSession = session;
      const approvedConsent = remote.consent;
      const pointer = store.pointerPath('scanner');
      return await work({
        roots: picked.roots,
        exclusions: picked.exclusions,
        files: [path, pointer],
        session,
        complete: async (document) => {
          await request('POST', `/api/v1/install-sessions/${approvedSession.id}/complete`, {
            readiness: document,
            platform: process.platform,
          });
        },
        rollback: async (journal) => {
          await restoreScannerInstall(journal, options);
        },
        apply: async (journal) => {
          const put = async (targetPath: string, content: Buffer) => {
            if (!journal) return atomicWrite(targetPath, content);
            const target = await journal.plan(targetPath, content, {
              kind: 'runtime',
              group: `scanner:${journal.data.targets.length}`,
            });
            return journal.commit(target);
          };
          if (journal) {
            if (!journal.data.services.some((s) => s.id === 'scanner'))
              journal.data.services.push({
                id: 'scanner',
                before: JSON.stringify(previous ?? { installed: false, running: false }),
                started: true,
              });
            const serviceRecord = journal.data.services.find((s) => s.id === 'scanner');
            if (serviceRecord) serviceRecord.started = true;
            await journal.event('service_start_intent', 'scanner');
          }
          // Stop the old writer before replacing state; refusal above leaves its consent untouched.
          if (previous?.running) await service.stop();
          if (journal) await observeScannerState(journal, path);
          restore = false;
          const state: SavedState = {
            schemaVersion: 1,
            config: {
              roots: picked.roots,
              exclusions: picked.exclusions,
              serverUrl: apiOrigin(),
              deviceInstallationId: approvedSession.device_installation_id,
            },
            consent: approvedConsent,
            paused: false,
            pauseIntervals: saved?.pauseIntervals ?? [],
            ...(process.env.MNEMONIK_DEV_RELEASE_DIR ? { devReleaseSource: true } : {}),
          };
          for (const interval of state.pauseIntervals)
            if (interval.end === null) interval.end = Date.now();
          await put(path, scannerStateBytes(state));
          const source = await (options.source ?? (() => releaseSource('scanner')))();
          if (
            source.manifest.disclosureVersion &&
            source.manifest.disclosureVersion !== state.consent?.disclosureVersion
          )
            throw new Error('release_consent_required');
          if (process.env.MNEMONIK_DEV_RELEASE_DIR)
            options.output.error(
              'WARNING: development scanner release; readiness remains LIMITED dev_release_source.'
            );
          const prior = await bytesAt(pointer);
          const pointerTarget = journal
            ? await journal.plan(
                pointer,
                Buffer.from(
                  JSON.stringify({
                    current: {
                      version: source.manifest.version,
                      manifestSha256: hash(JSON.stringify(source.manifest)),
                    },
                    previous: prior
                      ? (JSON.parse(prior.toString()) as { current: unknown }).current
                      : undefined,
                  })
                ),
                { kind: 'runtime', group: `scanner:${journal.data.targets.length}` }
              )
            : undefined;
          await store.installRuntime('scanner', source.manifest.version, source);
          if (pointerTarget) await journal?.commit(pointerTarget);
          const issued = (await request('POST', '/api/v1/component-credentials', {
            component_kind: 'scanner',
          })) as ComponentCredentialResponse;
          if (journal) {
            journal.data.credentials.push({
              reference: issued.id,
              kind: 'component',
              component: 'scanner',
            });
            await journal.save();
          }
          await credentials.putFamily('scanner', issued);
          state.config.credentialFamilyId = issued.id;
          await put(path, scannerStateBytes(state));
          await journal?.event('upload_intent', 'scanner');
          if (previous?.installed) await service.restart();
          else await service.start();
          const receipt = await scannerReceipt(options.stateDir);
          const heartbeat = receipt?.snapshot.heartbeat.lastSuccess;
          if (typeof heartbeat !== 'number') throw new Error('scanner_receipt_missing');
          const document = devReadiness(
            serializeReadiness({
              platform: process.platform,
              versions: await readInstallVersions(options.stateDir, source.manifest.version),
              installation: {
                conditions: options.pendingHosts
                  ? [{ kind: 'hook_not_verified', reason: 'Host setup still needs verification.' }]
                  : [],
              },
              scanner: {
                roots: state.config.roots,
                heartbeatAt: new Date(heartbeat).toISOString(),
                version: source.manifest.version,
                readiness: null,
                acceptedDisclosureVersion: approvedConsent.disclosureVersion,
              },
            })
          );
          return document;
        },
      });
    } catch (error) {
      if (restore) await controlScanner('resume', options);
      throw error;
    }
  });
}

/** Stop/unregister with the installed runtime, restore bytes, then restore the old definition. */
export async function restoreScannerInstall(
  journal: Journal,
  options: ScannerServiceOptions & { fetch?: typeof fetch }
) {
  const record = journal.data.services.find((s) => s.id === 'scanner');
  const service = scannerService(options);
  const before = record ? (JSON.parse(record.before) as SupervisorStatus) : undefined;
  const hasRuntime = await bytesAt(new RuntimeStore(options.stateDir).pointerPath('scanner'));
  if (record?.started && hasRuntime) {
    await service.stop();
    if (!before?.installed) await service.restore('scanner', record.before);
  }
  if (record?.started)
    await observeScannerState(journal, join(options.stateDir, 'scanner/state.json'));
  for (const target of [...journal.data.targets]
    .reverse()
    .filter((t) => t.group?.startsWith('scanner:')))
    await journal.restore(target);
  if (record?.started && before?.installed) await service.restore('scanner', record.before);
  if (record) record.started = false;
  for (const credential of journal.data.credentials.filter(
    (c) => c.component === 'scanner' && !c.revoked
  )) {
    credential.revoked = await revokeInstallComponent(
      options.stateDir,
      credential.reference,
      options.fetch
    ).catch(() => false);
    if (!credential.revoked)
      journal.data.reports.push(
        `Credential ${credential.reference} retained; revoke it in Devices and grants.`
      );
  }
  await journal.save();
}

// Once its writer is stopped, adopt only lifecycle changes to the scanner-owned state.
// Config or consent edits still fail the ordinary journal conflict check.
async function observeScannerState(journal: Journal, path: string) {
  const target = [...journal.data.targets]
    .reverse()
    .find((t) => t.path === path && t.group?.startsWith('scanner:') && t.status !== 'restored');
  if (!target) return;
  const current = await bytesAt(path);
  if (!current || digest(current) === target.proposedHash || digest(current) === target.beforeHash)
    return;
  const proposed = await bytesAt(target.proposed);
  if (!proposed) return;
  const actual = JSON.parse(current.toString()) as SavedState;
  const expected = JSON.parse(proposed.toString()) as SavedState;
  if (
    !isDeepStrictEqual(actual.config, expected.config) ||
    !isDeepStrictEqual(actual.consent, expected.consent) ||
    actual.schemaVersion !== expected.schemaVersion
  )
    throw new Error(`File changed outside install: ${path}`);
  await atomicWrite(target.proposed, current);
  target.proposedHash = digest(current);
  await journal.save();
}
