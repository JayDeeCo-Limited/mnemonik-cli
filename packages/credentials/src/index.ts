import { createHash, createHmac, randomBytes } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { windowsCurrentUserAcl, withLock } from '@mnemonik/local-setup';
import {
  type ActionRequired,
  type CliOAuthCredential,
  type CliOAuthMetadata,
  type CliOAuthTokens,
  type CliCredentialTransport,
  type CliRevocationTransport,
  type CliTokenResponse,
  type ComponentCredentialResponse,
  type ComponentKind,
  type CredentialStoreKind,
  type CredentialTransport,
  type FamilyCredential,
  type RetryLater,
  type RotationResult,
  type SecretStore,
  SimulatedSecretStore,
  CredentialSessionUnavailableError,
  type TransportResponse,
  type WorkResponse,
} from './contracts.js';
import {
  CredentialError,
  SecureFiles,
  credentialPaths,
  stateDirectory,
  type SecureFileOptions,
} from './storage.js';

export * from './contracts.js';
import { osSecretStore } from './osSecretStore.js';
export { osSecretStore };
export {
  CredentialError,
  SimulatedSecretStore,
  credentialPaths,
  stateDirectory,
  windowsCurrentUserAcl,
};

type SecretLocator = { store: 'os'; secretRef: string } | { store: 'file'; secretFile: string };
type CliRecord = CliOAuthMetadata & SecretLocator & { schemaVersion: 1; kind: 'cli-oauth' };
type FamilyRecord = Omit<FamilyCredential, 'store' | 'accessToken' | 'refreshToken'> &
  SecretLocator & { schemaVersion: 1; kind: 'component' };
type RootRecord = SecretLocator & { schemaVersion: 1; kind: 'root-binding' };
type FamilySecret = { accessToken: string; refreshToken: string };
interface CredentialBackend {
  readonly store: CredentialStoreKind;
  isAvailable(): Promise<boolean>;
  read(reference: string, file: string): Promise<Buffer | null>;
  write(reference: string, file: string, secret: Buffer): Promise<void>;
  delete(reference: string, file: string): Promise<void>;
}

export interface CredentialAdapterOptions extends SecureFileOptions {
  secretStore?: SecretStore;
  onDiagnostic?: (code: 'os_store_unavailable') => void;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  retryLimit?: number;
  lockWaitMs?: number;
}

const json = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const parse = <T>(bytes: Buffer, expectedKind: string): T => {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString());
  } catch {
    throw new Error('credential_record_invalid');
  }
  if (
    !value ||
    typeof value !== 'object' ||
    (value as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    (value as { kind?: unknown }).kind !== expectedKind
  )
    throw new Error('credential_record_invalid');
  return value as T;
};
const wait = (milliseconds: number) =>
  new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));
const action = (familyId: string, reason: string): ActionRequired => ({
  status: 'ACTION_REQUIRED',
  reason,
  familyId,
});
/** Retry counters of one rotation, kept across the lease entries its back-offs separate. */
type RotationAttempts = { started: number; lostResponseRetried: boolean; retryableAttempt: number };
/** A 429/5xx back-off, waited out by rotateStored with the lease released. */
type Backoff = { backoffMs: number };
/** readSecret's answer for a record whose secret is gone (not an unavailable OS store). */
const isSecretMissing = (error: unknown) =>
  error instanceof Error && error.message === 'credential_secret_missing';
const retryLater = (familyId: string, reason: RetryLater['reason']): RetryLater => ({
  status: 'RETRY_LATER',
  reason,
  familyId,
});
const isFailure = (result: object): result is ActionRequired | RetryLater =>
  'status' in result &&
  ((result as { status?: string }).status === 'ACTION_REQUIRED' ||
    (result as { status?: string }).status === 'RETRY_LATER');

const diagnosedStores = new WeakSet<SecretStore>();
/**
 * A family's record or secret, named by the SHA-256 of its family id (credentialPaths), or an
 * atomic-write temporary of either (atomicWrite).
 */
const familyFileName = /^([0-9a-f]{64})\.json(?:\.[0-9a-f-]{36}\.tmp)?$/;
/** atomicWrite's temporary for `base`: `<base>.<uuid>.tmp`. */
const temporaryOf = (base: string, name: string) =>
  name.startsWith(`${base}.`) && /^\.[0-9a-f-]{36}\.tmp$/.test(name.slice(base.length));

export function createCredentialAdapter(options: CredentialAdapterOptions = {}) {
  const files = new SecureFiles({ ...options, stateDir: options.stateDir ?? stateDirectory() });
  const paths = credentialPaths(files.stateDir);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? wait;
  const retryLimit = options.retryLimit ?? 2;
  const lockWaitMs = options.lockWaitMs ?? 60_000;
  const store = options.secretStore;
  const rotations = new Map<string, Promise<RotationResult | CliOAuthCredential>>();
  let osAvailable: Promise<boolean> | undefined;

  const disable = () => {
    osAvailable = Promise.resolve(false);
    if (store && !diagnosedStores.has(store)) {
      diagnosedStores.add(store);
      options.onDiagnostic?.('os_store_unavailable');
    }
  };
  const available = () =>
    (osAvailable ??= store
      ? store
          .isAvailable()
          .catch(() => false)
          .then((ok) => {
            if (!ok) disable();
            return ok;
          })
      : Promise.resolve(false));
  /**
   * A new OS-store entry's name carries its state directory: the entry lives outside it, and
   * without the directory two state directories' CLI credentials would share one entry. The
   * directory is canonicalized by the native realpath (case and short names on Windows, and
   * a link above the state root; SecureFiles refuses links inside it) and hashed to 32 hex
   * characters, keeping names short and within [\w.:-]. Records keep the reference they were written with.
   */
  const reference = async (name: string) => {
    const directory = createHash('sha256').update(await realpath(files.stateDir));
    return `mnemonik.credentials.v1:${name}:${directory.digest('hex').slice(0, 32)}`;
  };
  const relativeSecret = (path: string) => path.slice(files.stateDir.length + 1);
  const fileBackend: CredentialBackend = {
    store: 'file',
    isAvailable: async () => true,
    read: async (_reference, file) => files.read(file),
    write: async (_reference, file, secret) => files.write(file, secret, 'secret'),
    delete: async (_reference, file) => files.remove(file),
  };
  const osBackend: CredentialBackend = {
    store: 'os',
    isAvailable: available,
    read: async (reference) => {
      if (!(await available()) || !store) throw new Error('os_store_unavailable');
      const value = await store.get(reference);
      return value == null ? null : Buffer.from(value, 'base64');
    },
    write: async (reference, _file, secret) => {
      if (!(await available()) || !store) throw new Error('os_store_unavailable');
      await store.set(reference, secret.toString('base64'));
    },
    delete: async (reference) => {
      if (!(await available()) || !store) throw new Error('os_store_unavailable');
      await store.delete(reference);
    },
  };

  async function locator(
    name: string,
    file: string,
    existing?: SecretLocator
  ): Promise<SecretLocator> {
    if (existing?.store === 'os') return existing;
    return name === 'cli-oauth' && (await osBackend.isAvailable())
      ? { store: 'os', secretRef: await reference(name) }
      : { store: 'file', secretFile: relativeSecret(file) };
  }

  const useFile = (location: SecretLocator, file: string) => {
    Object.assign(location, { store: 'file', secretFile: relativeSecret(file) });
    delete (location as { secretRef?: string }).secretRef;
  };
  async function writeSecret(location: SecretLocator, file: string, value: Buffer): Promise<void> {
    if (location.store === 'os') {
      try {
        await osBackend.write(referenceFor(location), file, value);
        return;
      } catch {
        disable();
      }
      useFile(location, file);
    }
    await fileBackend.write('', file, value);
  }

  async function readSecret(location: SecretLocator, file: string): Promise<Buffer> {
    let sessionUnavailable = false;
    if (location.store === 'os') {
      try {
        const value = await osBackend.read(referenceFor(location), file);
        if (value) return value;
      } catch {
        disable();
        sessionUnavailable = true;
      }
    }
    const value = await fileBackend.read('', file);
    if (!value && sessionUnavailable)
      throw new CredentialSessionUnavailableError(store?.kind ?? 'os');
    if (!value) throw new Error('credential_secret_missing');
    useFile(location, file);
    return value;
  }

  async function deleteSecret(location: SecretLocator, file: string): Promise<void> {
    if (location.store === 'os') {
      try {
        await osBackend.delete(referenceFor(location), file);
      } catch {
        disable();
      }
    }
    await fileBackend.delete('', file);
  }

  const referenceFor = (location: SecretLocator) =>
    location.store === 'os' ? location.secretRef : '';

  async function readRecord<T>(path: string, kind: string): Promise<T | null> {
    const bytes = await files.read(path);
    return bytes ? parse<T>(bytes, kind) : null;
  }

  /**
   * Every sign-in takes the CLI rotation lease, so a rotation of a previous grant cannot
   * persist over it, and forget can tell a crash's leftovers from a write in progress. The
   * private directories exist before the lease would create them without their ACLs.
   */
  async function putCliOAuth(
    metadata: CliOAuthMetadata,
    tokens: CliOAuthTokens | string
  ): ReturnType<typeof writeCliOAuth> {
    await files.ensureParent(paths.cliRecord);
    return leased(
      paths.cliRecord,
      () => writeCliOAuth(metadata, tokens),
      () => putCliOAuth(metadata, tokens)
    );
  }

  /**
   * Waits until no other holder has the CLI rotation lease (a sign-out or rotation in
   * progress), then returns without keeping it. Sign-in calls this before a device grant is
   * issued: every holder's hold is bounded, so the later putCliOAuth then gets the lease within
   * lockWaitMs, and a lease that cannot be had fails the sign-in before any grant exists
   * instead of after the person approved one (which would leave it live and unstored).
   */
  async function waitForCliLease(): Promise<void> {
    await files.ensureParent(paths.cliRecord);
    await leased(
      paths.cliRecord,
      async () => undefined,
      () => undefined
    );
  }

  async function writeCliOAuth(metadata: CliOAuthMetadata, tokens: CliOAuthTokens | string) {
    const current = await readRecord<CliRecord>(paths.cliRecord, 'cli-oauth');
    const location = await locator('cli-oauth', paths.cliSecret, current ?? undefined);
    const secret: CliOAuthTokens =
      typeof tokens === 'string'
        ? { accessToken: '', refreshToken: tokens, accessExpiresAt: new Date(0).toISOString() }
        : tokens;
    await writeSecret(location, paths.cliSecret, Buffer.from(JSON.stringify(secret)));
    const record: CliRecord = { schemaVersion: 1, kind: 'cli-oauth', ...metadata, ...location };
    await files.write(paths.cliRecord, json(record), 'record');
    if (location.store === 'os') await files.remove(paths.cliSecret);
    return { store: location.store === 'os' ? (store?.kind ?? 'os') : 'file' };
  }

  async function readCliOAuth(): Promise<CliOAuthCredential | null> {
    const record = await readRecord<CliRecord>(paths.cliRecord, 'cli-oauth');
    if (!record) return null;
    const stored = (await readSecret(record, paths.cliSecret)).toString();
    const tokens: CliOAuthTokens = stored.startsWith('{')
      ? (JSON.parse(stored) as CliOAuthTokens)
      : { accessToken: '', refreshToken: stored, accessExpiresAt: new Date(0).toISOString() };
    if (
      typeof tokens.accessToken !== 'string' ||
      typeof tokens.refreshToken !== 'string' ||
      typeof tokens.accessExpiresAt !== 'string'
    )
      throw new Error('credential_record_invalid');
    const { schemaVersion: _schema, kind: _kind, ...metadata } = record;
    void _schema;
    void _kind;
    const {
      secretRef: _ref,
      secretFile: _file,
      ...publicMetadata
    } = metadata as CliOAuthMetadata & {
      store: CredentialStoreKind;
      secretRef?: string;
      secretFile?: string;
    };
    void _ref;
    void _file;
    return {
      ...publicMetadata,
      ...tokens,
      store: record.store === 'os' ? (store?.kind ?? 'os') : 'file',
    };
  }

  async function persistFamily(
    componentKind: ComponentKind,
    response: ComponentCredentialResponse,
    existing?: FamilyRecord
  ): Promise<FamilyCredential> {
    if (existing && existing.familyId !== response.id) throw new Error('family_id_changed');
    const familyPaths = credentialPaths(files.stateDir, response.id);
    const location = await locator(`component:${response.id}`, familyPaths.secret, existing);
    const rotationTime = now();
    const secret: FamilySecret = {
      accessToken: response.access_token,
      refreshToken: response.refresh_token,
    };
    await writeSecret(location, familyPaths.secret, Buffer.from(JSON.stringify(secret)));
    const record: FamilyRecord = {
      schemaVersion: 1,
      kind: 'component',
      familyId: response.id,
      componentKind,
      scopes: response.scope.split(' ').filter(Boolean),
      accessExpiresAt: new Date(rotationTime + response.expires_in * 1000).toISOString(),
      refreshExpiresAt: new Date(rotationTime + response.refresh_expires_in * 1000).toISOString(),
      lastRotationTime: new Date(rotationTime).toISOString(),
      ...location,
    };
    await files.write(familyPaths.record, json(record), 'record');
    return {
      store: location.store,
      familyId: record.familyId,
      componentKind: record.componentKind,
      scopes: record.scopes,
      accessExpiresAt: record.accessExpiresAt,
      refreshExpiresAt: record.refreshExpiresAt,
      lastRotationTime: record.lastRotationTime,
      ...secret,
    };
  }

  /**
   * Provisioning holds the family lease from the secret write to the record write, so forget
   * never mistakes a secret whose record is still being written for a crash's orphan.
   */
  async function putFamily(
    componentKind: ComponentKind,
    response: ComponentCredentialResponse
  ): Promise<FamilyCredential> {
    const familyPaths = credentialPaths(files.stateDir, response.id);
    // The private directories exist before the lease would create them without their ACLs.
    await files.ensureParent(familyPaths.record);
    return leased(
      familyPaths.record,
      async () => {
        const current = await readRecord<FamilyRecord>(familyPaths.record, 'component');
        return persistFamily(componentKind, response, current ?? undefined);
      },
      () => putFamily(componentKind, response)
    );
  }

  async function readFamily(familyId: string): Promise<FamilyCredential | null> {
    const familyPaths = credentialPaths(files.stateDir, familyId);
    const record = await readRecord<FamilyRecord>(familyPaths.record, 'component');
    if (!record) return null;
    if (record.familyId !== familyId) throw new Error('credential_record_invalid');
    const secret = JSON.parse(
      (await readSecret(record, familyPaths.secret)).toString()
    ) as FamilySecret;
    if (typeof secret.accessToken !== 'string' || typeof secret.refreshToken !== 'string')
      throw new Error('credential_record_invalid');
    const { schemaVersion: _schema, kind: _kind, ...metadata } = record;
    void _schema;
    void _kind;
    const {
      secretRef: _ref,
      secretFile: _file,
      ...publicMetadata
    } = metadata as Omit<FamilyCredential, 'accessToken' | 'refreshToken'> & {
      secretRef?: string;
      secretFile?: string;
    };
    void _ref;
    void _file;
    return { ...publicMetadata, ...secret };
  }

  /**
   * One rotation request, with its retry rules. A lost response is retried once, inside the
   * caller's lease and with the same predecessor, because the issuer may already have rotated
   * (rotation_response_lost otherwise). A 429/5xx is an answer - nothing rotated - so its
   * back-off is not slept here: it is returned as `{ backoffMs }` for rotateStored to wait out
   * with the lease released. `state` carries the attempt counters across those lease entries.
   */
  async function requestRotation<T>(
    familyId: string,
    request: () => Promise<TransportResponse<T>>,
    state: RotationAttempts
  ): Promise<TransportResponse<T> | ActionRequired | RetryLater | Backoff> {
    while (true) {
      let response: TransportResponse<T>;
      try {
        response = await request();
      } catch {
        if (state.lostResponseRetried) return action(familyId, 'rotation_response_lost');
        state.lostResponseRetried = true;
        await sleep(250);
        if (now() > state.started + 60_000) return action(familyId, 'rotation_response_lost');
        continue;
      }
      if (response.status === 400 && response.body.error === 'invalid_grant')
        return action(familyId, 'invalid_grant');
      if (response.status === 429 || response.status >= 500) {
        if (state.lostResponseRetried) return action(familyId, 'rotation_response_lost');
        if (state.retryableAttempt >= retryLimit)
          return retryLater(familyId, response.status === 429 ? 'rate_limited' : 'server_error');
        const delay = response.retryAfterMs ?? 250 * 2 ** state.retryableAttempt;
        state.retryableAttempt += 1;
        return { backoffMs: delay };
      }
      return response;
    }
  }

  /**
   * withLock on a record's lease. forget removes emptied credential directories, so a waiter
   * can find its lease directory's parent gone; the record went with it, and `vanished`
   * answers as a reread that found nothing would.
   */
  async function leased<T>(
    recordPath: string,
    work: () => Promise<T>,
    vanished: () => T | Promise<T>
  ): Promise<T> {
    let entered = false;
    try {
      return await withLock(recordPath, lockWaitMs, () => {
        entered = true;
        return work();
      });
    } catch (error) {
      if (entered || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return vanished();
    }
  }

  async function rotateStored<
    Current extends { familyId: string; refreshToken: string },
    Body extends object,
  >(
    lockPath: string,
    missingId: string,
    read: () => Promise<Current | null>,
    request: (current: Current) => Promise<TransportResponse<Body>>,
    decode: (body: Body | { error: string }) => Body | null,
    persist: (current: Current, body: Body) => Promise<Current>
  ): Promise<Current | ActionRequired | RetryLater> {
    const predecessor = await read();
    if (!predecessor) return action(missingId, 'family_missing');
    const attempts: RotationAttempts = {
      started: now(),
      lostResponseRetried: false,
      retryableAttempt: 0,
    };
    // A 429/5xx back-off (possibly a long Retry-After) is waited out with the lease released,
    // so a sign-in, sign-out or forget is not blocked behind it; the lease is then retaken and
    // the credential reread, so a change made meanwhile is returned rather than rotated over.
    for (;;) {
      const outcome = await rotateStoredOnce(
        lockPath,
        predecessor,
        read,
        request,
        decode,
        persist,
        attempts
      );
      if (!('backoffMs' in outcome)) return outcome;
      await sleep(outcome.backoffMs);
    }
  }

  async function rotateStoredOnce<
    Current extends { familyId: string; refreshToken: string },
    Body extends object,
  >(
    lockPath: string,
    predecessor: Current,
    read: () => Promise<Current | null>,
    request: (current: Current) => Promise<TransportResponse<Body>>,
    decode: (body: Body | { error: string }) => Body | null,
    persist: (current: Current, body: Body) => Promise<Current>,
    attempts: RotationAttempts
  ): Promise<Current | ActionRequired | RetryLater | Backoff> {
    return leased<Current | ActionRequired | RetryLater | Backoff>(
      lockPath,
      async () => {
        const current = await read();
        if (!current) return action(predecessor.familyId, 'family_missing');
        // Detects another holder's refresh only where the issuer rotates refresh tokens (component
        // families); CLI grants keep theirs (rotateRefreshToken: false), so concurrent CLI
        // processes may each refresh once, which only mints an extra access token.
        if (current.refreshToken !== predecessor.refreshToken) return current;
        const response = await requestRotation(current.familyId, () => request(current), attempts);
        if ('backoffMs' in response) return response;
        if (
          'status' in response &&
          (response.status === 'ACTION_REQUIRED' || response.status === 'RETRY_LATER')
        )
          return response;
        if (response.status !== 200)
          return action(
            current.familyId,
            'error' in response.body ? response.body.error : 'rotation_refused'
          );
        const body = decode(response.body);
        if (!body) return action(current.familyId, 'rotation_refused');
        try {
          return await persist(current, body);
        } catch {
          return action(current.familyId, 'persistence_failed');
        }
      },
      () => action(predecessor.familyId, 'family_missing')
    );
  }

  function rotateLocked(familyId: string, transport: CredentialTransport) {
    const familyPaths = credentialPaths(files.stateDir, familyId);
    return rotateStored(
      familyPaths.record,
      familyId,
      () => readFamily(familyId),
      (current) => transport.rotateFamily(familyId, current.refreshToken),
      (body) => ('access_token' in body ? body : null),
      // The stored record's own locator: a reference rebuilt from the name could differ.
      async (current, body) =>
        persistFamily(
          current.componentKind,
          body,
          (await readRecord<FamilyRecord>(familyPaths.record, 'component')) ?? undefined
        )
    );
  }

  function rotateFamily(familyId: string, transport: CredentialTransport): Promise<RotationResult> {
    const active = rotations.get(familyId);
    if (active) return active as Promise<RotationResult>;
    const rotation = rotateLocked(familyId, transport);
    rotations.set(familyId, rotation);
    const clear = () => {
      if (rotations.get(familyId) === rotation) rotations.delete(familyId);
    };
    void rotation.then(clear, clear);
    return rotation;
  }

  function rotateCliLocked(transport: CliCredentialTransport) {
    return rotateStored(
      paths.cliRecord,
      'cli',
      readCliOAuth,
      (current) => transport.rotateCli(current),
      (body) =>
        'access_token' in body &&
        typeof body.access_token === 'string' &&
        'refresh_token' in body &&
        typeof body.refresh_token === 'string' &&
        'expires_in' in body &&
        typeof body.expires_in === 'number' &&
        'scope' in body &&
        typeof body.scope === 'string'
          ? body
          : null,
      async (current, body: CliTokenResponse) => {
        const rotatedAt = now();
        await writeCliOAuth(
          {
            issuer: current.issuer,
            clientId: current.clientId,
            familyId: current.familyId,
            scopes: body.scope.split(' ').filter(Boolean),
            lastRotationTime: new Date(rotatedAt).toISOString(),
          },
          {
            accessToken: body.access_token,
            refreshToken: body.refresh_token,
            accessExpiresAt: new Date(rotatedAt + body.expires_in * 1000).toISOString(),
          }
        );
        const stored = await readCliOAuth();
        if (!stored) throw new Error('credential_persistence_failed');
        return stored;
      }
    );
  }

  function rotateCli(
    transport: CliCredentialTransport
  ): Promise<ActionRequired | RetryLater | CliOAuthCredential> {
    const key = 'cli';
    const active = rotations.get(key);
    if (active) return active as Promise<ActionRequired | RetryLater | CliOAuthCredential>;
    const rotation = rotateCliLocked(transport);
    rotations.set(key, rotation);
    const clear = () => {
      if (rotations.get(key) === rotation) rotations.delete(key);
    };
    void rotation.then(clear, clear);
    return rotation;
  }

  async function withCliCredential<T>(
    transport: CliCredentialTransport,
    work: (accessToken: string) => Promise<WorkResponse<T>>
  ): Promise<WorkResponse<T> | ActionRequired | RetryLater> {
    let current = await readCliOAuth();
    if (!current) return action('cli', 'family_missing');
    if (!current.accessToken || Date.parse(current.accessExpiresAt) <= now()) {
      const rotated = await rotateCli(transport);
      if (isFailure(rotated)) return rotated;
      current = rotated;
    }
    const first = await work(current.accessToken);
    if (first.status !== 401) return first;
    const rotated = await rotateCli(transport);
    if (isFailure(rotated)) return rotated;
    const second = await work(rotated.accessToken);
    return second.status === 401 ? action(rotated.familyId, 'protected_unauthorized') : second;
  }

  async function removeCliOAuth(): Promise<void> {
    await removeLeased<CliRecord>(paths.cliRecord, 'cli-oauth', paths.cliSecret);
  }

  /**
   * Sign-out, with revokeFamily's guarantees: the CLI rotation lease is held from the reread
   * through the issuer's revocation to local removal, so the issuer is shown the current
   * refresh token and a rotation waiting behind it finds nothing to persist. 429/5xx keep the
   * credential for a retry.
   */
  async function revokeCli(transport: CliRevocationTransport) {
    if (!(await readRecord<CliRecord>(paths.cliRecord, 'cli-oauth')))
      return action('cli', 'family_missing');
    return leased(
      paths.cliRecord,
      async () => {
        let current: CliOAuthCredential | null;
        try {
          current = await readCliOAuth();
        } catch (error) {
          if (!isSecretMissing(error)) throw error;
          // The record outlived its secret (a crash in the removal order used before
          // removeStored deleted records first). Nothing here can revoke the grant, and the
          // record would block every sign-in and sign-out: remove it and say so.
          await removeStored<CliRecord>(paths.cliRecord, 'cli-oauth', paths.cliSecret);
          return action('cli', 'credential_secret_missing');
        }
        if (!current) return action('cli', 'family_missing');
        const response = await transport.revokeCli(current);
        if (response.status === 429) return retryLater(current.familyId, 'rate_limited');
        if (response.status >= 500) return retryLater(current.familyId, 'server_error');
        if (response.status !== 200)
          return action(
            current.familyId,
            'error' in response.body ? response.body.error : 'revoke_refused'
          );
        await removeStored<CliRecord>(paths.cliRecord, 'cli-oauth', paths.cliSecret);
        return { status: 'revoked' as const, familyId: current.familyId };
      },
      () => action('cli', 'family_missing')
    );
  }

  async function withCredential<T>(
    familyId: string,
    transport: CredentialTransport,
    work: (accessToken: string) => Promise<WorkResponse<T>>
  ): Promise<WorkResponse<T> | ActionRequired | RetryLater> {
    let current = await readFamily(familyId);
    if (!current) return action(familyId, 'family_missing');
    if (!current.accessToken || Date.parse(current.accessExpiresAt) <= now()) {
      const rotated = await rotateFamily(familyId, transport);
      if (isFailure(rotated)) return rotated;
      current = rotated;
    }
    const first = await work(current.accessToken);
    if (first.status !== 401) return first;
    const rotated = await rotateFamily(familyId, transport);
    if (isFailure(rotated)) return rotated;
    const second = await work(rotated.accessToken);
    return second.status === 401 ? action(familyId, 'protected_unauthorized') : second;
  }

  /**
   * Removes a record and its secret; the caller already holds the record's lease. The record
   * goes first: a crash between the two deletes then leaves only a record-less secret, which
   * every reader treats as absent, sign-in overwrites, revokeFamily can still revoke with, and
   * forget erases. Deleting the secret first left a record without its secret, on which every
   * read - and so every sign-in, sign-out and rollback - failed.
   */
  async function removeStored<T extends SecretLocator>(
    recordPath: string,
    kind: string,
    secretPath: string
  ): Promise<T | null> {
    const record = await readRecord<T>(recordPath, kind);
    if (!record) return null;
    await files.remove(recordPath);
    await deleteSecret(record, secretPath);
    return record;
  }

  /** removeStored under the lease the record's writers hold; no lease for an absent record. */
  async function removeLeased<T extends SecretLocator>(
    recordPath: string,
    kind: string,
    secretPath: string
  ): Promise<T | null> {
    if (!(await readRecord<T>(recordPath, kind))) return null;
    return leased(
      recordPath,
      () => removeStored<T>(recordPath, kind, secretPath),
      () => null
    );
  }

  async function orphanRefreshToken(secretPath: string): Promise<string | null> {
    const bytes = await files.read(secretPath);
    if (!bytes) return null;
    const secret = JSON.parse(bytes.toString()) as Partial<FamilySecret>;
    if (typeof secret.refreshToken !== 'string') throw new Error('credential_record_invalid');
    return secret.refreshToken;
  }

  async function removeFamily(familyId: string): Promise<void> {
    const familyPaths = credentialPaths(files.stateDir, familyId);
    await removeStored<FamilyRecord>(familyPaths.record, 'component', familyPaths.secret);
  }

  /**
   * The server accepts only the family's current refresh token, so revocation holds the
   * rotation lease from the reread through remote revocation and local removal: a rotation
   * either persists its successor first (and that successor is revoked) or rereads after the
   * removal and finds no family.
   */
  async function revokeFamily(familyId: string, transport: CredentialTransport) {
    const familyPaths = credentialPaths(files.stateDir, familyId);
    // No lease directory is created for a family this machine does not hold.
    if (
      !(await readRecord<FamilyRecord>(familyPaths.record, 'component')) &&
      !(await files.read(familyPaths.secret))
    )
      return action(familyId, 'family_missing');
    await files.ensureParent(familyPaths.record);
    return leased(
      familyPaths.record,
      async () => {
        let current: FamilyCredential | null;
        try {
          current = await readFamily(familyId);
        } catch (error) {
          if (!isSecretMissing(error)) throw error;
          // A record without its secret (see removeStored): no token can revoke the grant
          // from here. Remove the record so it stops failing every call, and say so.
          await removeFamily(familyId);
          return action(familyId, 'credential_secret_missing');
        }
        // Every family writer holds this lease, so a secret without its record is a crash's
        // orphan: its grant is live server-side, and it holds the token that can revoke it.
        const refreshToken =
          current?.refreshToken ?? (await orphanRefreshToken(familyPaths.secret));
        if (!refreshToken) return action(familyId, 'family_missing');
        const response = await transport.revokeFamily(familyId, refreshToken);
        if (response.status === 429) return retryLater(familyId, 'rate_limited');
        if (response.status >= 500) return retryLater(familyId, 'server_error');
        const refusal =
          response.status === 200
            ? null
            : 'error' in response.body
              ? response.body.error
              : 'revoke_refused';
        // Any refusal keeps the credential, an orphan's included. The issuer answers 200 to
        // any refresh token of an already revoked grant (a removal that crashed after the
        // issuer revoked, see removeStored), so invalid_grant means the token names no
        // revoked grant: it is unknown there (another server, a purged payload) or a live
        // grant's expired token. That grant may still be live and this secret is the only
        // local trace of it, so it stays for the person to resolve.
        if (refusal) return action(familyId, refusal);
        if (current) await removeFamily(familyId);
        else await files.remove(familyPaths.secret);
        return { status: 'revoked' as const, familyId };
      },
      () => action(familyId, 'family_missing')
    );
  }

  /** The stored root key, or null when its record or secret is not (or no longer) on disk. */
  async function storedRootKey(): Promise<Buffer | null> {
    const record = await readRecord<RootRecord>(paths.rootRecord, 'root-binding');
    if (!record) return null;
    const key = await readSecret(record, paths.rootSecret).catch((error: unknown) => {
      if (isSecretMissing(error)) return null;
      throw error;
    });
    if (key && key.length !== 32) throw new Error('root_binding_key_invalid');
    return key;
  }

  /**
   * The root-binding key. Hooks call this on every run, so an existing key is read without the
   * lease or ensureParent (which on Windows runs icacls for each directory): the binding is
   * written once, secret then record, under the lease, so a record whose secret reads back is
   * a complete key. Only a key that must be created takes the slow path - the private
   * directories first, then the lease (never the reverse, or the lease would create them
   * without their ACLs), a reread, and the write. A record whose secret is gone is replaced.
   */
  async function rootKey(): Promise<Buffer> {
    const existing = await storedRootKey();
    if (existing) return existing;
    await files.ensureParent(paths.rootRecord);
    return leased(
      paths.rootRecord,
      async () => {
        const stored = await storedRootKey();
        if (stored) return stored;
        const location = await locator('root-binding', paths.rootSecret);
        const key = randomBytes(32);
        await writeSecret(location, paths.rootSecret, key);
        await files.write(
          paths.rootRecord,
          json({ schemaVersion: 1, kind: 'root-binding', ...location } satisfies RootRecord),
          'record'
        );
        return key;
      },
      // forget erased the binding and its directory while this call waited: create afresh.
      rootKey
    );
  }

  async function hmacRootBinding(version: 1, input: string) {
    if (version !== 1) throw new Error('unsupported_root_binding_version');
    const key = await rootKey();
    return { version, hmac: createHmac('sha256', key).update(input).digest('base64url') };
  }

  /**
   * Erases an entry's record, secret and atomic-write temporaries; the caller holds its lease.
   * Every writer of a family, the CLI credential and the root binding holds that entry's
   * lease, so a secret without a record, or a temporary, here is a crash's leftover.
   */
  async function eraseEntry<T extends SecretLocator>(
    recordPath: string,
    kind: string,
    secretPath: string
  ): Promise<T | null> {
    const record = await removeStored<T>(recordPath, kind, secretPath);
    if (!record) await files.remove(secretPath);
    for (const path of [recordPath, secretPath])
      for (const entry of await files.list(dirname(path)))
        if (temporaryOf(basename(path), entry)) await files.remove(join(dirname(path), entry));
    return record;
  }

  /**
   * Removes this directory's namespaced OS entry for the CLI credential (the only kind the
   * OS store holds) when no record owns it: every CLI writer holds the CLI lease and writes the
   * entry before the record, so an unowned entry found under the lease is a crash's leftover.
   * Un-namespaced legacy entries cannot be attributed to this directory and are never probed.
   */
  async function forgetCliOsOrphan(): Promise<void> {
    if (!store) return;
    const recordPath = paths.cliRecord;
    const ref = await reference('cli-oauth').catch(() => null);
    if (!ref || !(await available())) return;
    if (!(await osBackend.read(ref, '').catch(() => null))) return;
    await files.ensureParent(recordPath);
    await leased(
      recordPath,
      async () => {
        const record = await readRecord<CliRecord>(recordPath, 'cli-oauth');
        if (record?.store === 'os' && record.secretRef === ref) return;
        await osBackend.delete(ref, '');
      },
      () => undefined
    );
  }

  /** eraseEntry under the entry's lease, taken only when anything of the entry is on disk. */
  async function forgetEntry<T extends SecretLocator>(
    recordPath: string,
    kind: string,
    secretPath: string
  ): Promise<T | null> {
    let present = false;
    for (const path of [recordPath, secretPath])
      for (const entry of await files.list(dirname(path)))
        present ||= entry === basename(path) || temporaryOf(basename(path), entry);
    if (!present) return null;
    await files.ensureParent(recordPath);
    return leased(
      recordPath,
      () => eraseEntry<T>(recordPath, kind, secretPath),
      () => null
    );
  }

  /**
   * Erases this machine's credentials entry by entry, each under the lease its writers hold:
   * a family's rotation/revocation lease, the CLI rotation lease, the root-binding lease. The
   * boundary is per entry, not a store-wide snapshot. A rotation in flight either persists
   * first and its successor is erased, or rereads after the erase and persists nothing; a
   * family being provisioned is erased whole once its record is written. A family first
   * provisioned after forget listed the store, or a root binding first requested after its
   * erase, is new state outside this forget.
   */
  async function forget() {
    const componentFamilyIds: string[] = [];
    // Families are named by their records, their secrets (a crash can leave a secret whose
    // record was never written) and atomic-write temporaries; lease directories are skipped.
    const digests = new Set<string>();
    for (const directory of [paths.familyRecords, paths.familySecrets])
      for (const name of await files.list(directory)) {
        const digest = familyFileName.exec(name)?.[1];
        if (digest) digests.add(digest);
      }
    for (const digest of [...digests].sort()) {
      const record = await forgetEntry<FamilyRecord>(
        join(paths.familyRecords, `${digest}.json`),
        'component',
        join(paths.familySecrets, `${digest}.json`)
      );
      if (record) componentFamilyIds.push(record.familyId);
    }
    const cli = await forgetEntry<CliRecord>(paths.cliRecord, 'cli-oauth', paths.cliSecret);
    await forgetCliOsOrphan();
    await forgetEntry<RootRecord>(paths.rootRecord, 'root-binding', paths.rootSecret);
    await files.removeEmptyDirectories([
      paths.familySecrets,
      paths.familyRecords,
      paths.secrets,
      paths.records,
      paths.root,
    ]);
    return {
      status: 'forgotten' as const,
      retainedServerSide: {
        ...(cli ? { cliFamilyId: cli.familyId } : {}),
        componentFamilyIds: componentFamilyIds.sort(),
      },
    };
  }

  return {
    putCliOAuth,
    readCliOAuth,
    rotateCli,
    withCliCredential,
    removeCliOAuth,
    revokeCli,
    waitForCliLease,
    putFamily,
    readFamily,
    rotateFamily,
    withCredential,
    revokeFamily,
    forget,
    hmacRootBinding,
  };
}

/** Shared CLI/hook backend selection; component records keep their recorded backend. */
export function createLocalCredentialAdapter(options: CredentialAdapterOptions = {}) {
  return createCredentialAdapter({
    ...options,
    secretStore: options.secretStore ?? osSecretStore(),
  });
}

type HookFamily = {
  familyId: string;
  server: string;
  credentials: ReturnType<typeof createCredentialAdapter>;
  unavailable: boolean;
  diagnosed?: boolean;
};
export type HookCredential = string | HookFamily;
const hookFamilies = new Map<string, HookFamily>();

/** Family handles contain no tokens. Legacy keys are considered only without a family. */
export function resolveHookCredential(
  legacyKey: string | null,
  server: string,
  env: NodeJS.ProcessEnv = process.env,
  argv = process.argv.slice(2)
): HookCredential | null {
  const index = argv.indexOf('--credential-family');
  const familyId = (index >= 0 ? argv[index + 1]?.trim() : '') || env.MNEMONIK_HOOK_FAMILY?.trim();
  if (!familyId) return legacyKey;
  const key = JSON.stringify([server, familyId]);
  let family = hookFamilies.get(key);
  if (!family) {
    family = {
      familyId,
      server,
      unavailable: false,
      credentials: createLocalCredentialAdapter({ lockWaitMs: 2_000, retryLimit: 0 }),
    };
    hookFamilies.set(key, family);
  }
  return family;
}

/**
 * Rotation outcomes that say nothing lasting about the family: the issuer was busy (429/5xx),
 * its answer was lost, or the successor could not be written here. A later call can succeed.
 */
const TRANSIENT_ACTION_REASONS = new Set(['rotation_response_lost', 'persistence_failed']);

/**
 * `work()`, settled early when `signal` aborts. withCredential's lease wait, the lost-response
 * sleep and the OS store call take no signal; without this a hook request's timeout covered only
 * the network part of a credentialed call, and a held lease added up to its whole wait on top.
 * The abandoned work finishes (or not) in the background; hook processes exit after answering.
 */
function untilAborted<T>(signal: AbortSignal | null | undefined, work: () => Promise<T>) {
  if (!signal) return work();
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolvePromise, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work().then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolvePromise(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

/** Header on a synthetic answer that no server sent: the credential was not usable. */
export const HOOK_CREDENTIAL_HEADER = 'x-mnemonik-credential';

/**
 * Preserve each caller's wire body and budget; share rotation and failure state with bound context.
 *
 * When no request could be sent, the answer is synthetic and says whether that is lasting, so a
 * caller that retries (edit reports) can tell the two apart without knowing about credentials:
 * - lasting (no credential, revoked or expired grant, family gone, refused rotation):
 *   403 `{"ok":false}`, as before;
 * - transient (rotation answered 429/5xx, its response lost, the successor not persisted, the
 *   lease or store unavailable): 503 `{"ok":false,"retryable":true,"reason":"credential_unavailable"}`.
 * Both carry `x-mnemonik-credential: unavailable`.
 */
export async function fetchWithHookCredential(
  credential: HookCredential | null,
  url: string,
  init: NonNullable<Parameters<typeof fetch>[1]> & { headers?: Record<string, string> }
): Promise<Response> {
  const send = (token: string) =>
    fetch(url, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${token}` },
    });
  if (typeof credential === 'string') return send(credential);
  const unavailable = (transient = false) =>
    new Response(
      transient
        ? '{"ok":false,"retryable":true,"reason":"credential_unavailable"}'
        : '{"ok":false}',
      {
        status: transient ? 503 : 403,
        headers: { 'content-type': 'application/json', [HOOK_CREDENTIAL_HEADER]: 'unavailable' },
      }
    );
  if (!credential || credential.unavailable) return unavailable();
  let transient = false;
  try {
    const result = await untilAborted(init.signal, () =>
      credential.credentials.withCredential(
        credential.familyId,
        {
          rotateFamily: async (id, token) => {
            const response = await fetch(
              `${credential.server}/api/v1/component-credentials/${encodeURIComponent(id)}/rotate`,
              {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
                body: '{}',
                signal: init.signal
                  ? AbortSignal.any([init.signal, AbortSignal.timeout(2_000)])
                  : AbortSignal.timeout(2_000),
              }
            );
            return {
              status: response.status,
              body: await response.json(),
            } as TransportResponse<ComponentCredentialResponse>;
          },
          revokeFamily: async () => {
            throw new Error('unused');
          },
        },
        async (token) => {
          const response = await send(token);
          return { status: response.status, body: response };
        }
      )
    );
    if (typeof result.status === 'number' && 'body' in result) return result.body;
    credential.unavailable ||= result.reason === 'invalid_grant';
    transient =
      result.status === 'RETRY_LATER' ||
      (result.status === 'ACTION_REQUIRED' && TRANSIENT_ACTION_REASONS.has(result.reason));
  } catch (error) {
    // The caller's own timeout or cancellation: answer as fetch would.
    if (init.signal?.aborted) throw error;
    // Only explicit revocation/expiry disables the family; a rejected route is call-local.
    const invalidGrant = (error as { code?: string } | null)?.code === 'invalid_grant';
    credential.unavailable ||= invalidGrant;
    // A lease wait, OS store or file error: nothing is known to be wrong with the grant.
    transient = !invalidGrant;
  }
  if (!credential.diagnosed)
    process.stderr.write('mnemonik-hook: credentials unavailable - fail-open.\n');
  credential.diagnosed = true;
  return unavailable(transient);
}
