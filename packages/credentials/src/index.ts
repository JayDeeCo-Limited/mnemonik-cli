import { createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { windowsCurrentUserAcl, withLock } from '@mnemonik/local-setup';
import {
  type ActionRequired,
  type CliOAuthCredential,
  type CliOAuthMetadata,
  type CliOAuthTokens,
  type CliCredentialTransport,
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

export function createCredentialAdapter(options: CredentialAdapterOptions = {}) {
  const files = new SecureFiles({ ...options, stateDir: options.stateDir ?? stateDirectory() });
  const paths = credentialPaths(files.stateDir);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? wait;
  const retryLimit = options.retryLimit ?? 2;
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
  const reference = (name: string) => `mnemonik.credentials.v1:${name}`;
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
      ? { store: 'os', secretRef: reference(name) }
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

  async function putCliOAuth(metadata: CliOAuthMetadata, tokens: CliOAuthTokens | string) {
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

  async function putFamily(componentKind: ComponentKind, response: ComponentCredentialResponse) {
    const familyPaths = credentialPaths(files.stateDir, response.id);
    const current = await readRecord<FamilyRecord>(familyPaths.record, 'component');
    return persistFamily(componentKind, response, current ?? undefined);
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

  async function requestRotation<T>(
    familyId: string,
    request: () => Promise<TransportResponse<T>>
  ): Promise<TransportResponse<T> | ActionRequired | RetryLater> {
    const started = now();
    let lostResponseRetried = false;
    let retryableAttempt = 0;
    while (true) {
      let response: TransportResponse<T>;
      try {
        response = await request();
      } catch {
        if (lostResponseRetried) return action(familyId, 'rotation_response_lost');
        lostResponseRetried = true;
        await sleep(250);
        if (now() > started + 60_000) return action(familyId, 'rotation_response_lost');
        continue;
      }
      if (response.status === 400 && response.body.error === 'invalid_grant')
        return action(familyId, 'invalid_grant');
      if (response.status === 429 || response.status >= 500) {
        if (lostResponseRetried) return action(familyId, 'rotation_response_lost');
        if (retryableAttempt >= retryLimit)
          return retryLater(familyId, response.status === 429 ? 'rate_limited' : 'server_error');
        const delay = response.retryAfterMs ?? 250 * 2 ** retryableAttempt;
        retryableAttempt += 1;
        await sleep(delay);
        continue;
      }
      return response;
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
    return withLock(lockPath, options.lockWaitMs ?? 60_000, async () => {
      const current = await read();
      if (!current) return action(predecessor.familyId, 'family_missing');
      if (current.refreshToken !== predecessor.refreshToken) return current;
      const response = await requestRotation(current.familyId, () => request(current));
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
    });
  }

  function rotateLocked(familyId: string, transport: CredentialTransport) {
    const familyPaths = credentialPaths(files.stateDir, familyId);
    return rotateStored(
      familyPaths.record,
      familyId,
      () => readFamily(familyId),
      (current) => transport.rotateFamily(familyId, current.refreshToken),
      (body) => ('access_token' in body ? body : null),
      (current, body) =>
        persistFamily(current.componentKind, body, {
          schemaVersion: 1,
          kind: 'component',
          familyId: current.familyId,
          componentKind: current.componentKind,
          scopes: current.scopes,
          accessExpiresAt: current.accessExpiresAt,
          refreshExpiresAt: current.refreshExpiresAt,
          lastRotationTime: current.lastRotationTime,
          ...(current.store === 'os'
            ? { store: 'os', secretRef: reference(`component:${familyId}`) }
            : { store: 'file', secretFile: relativeSecret(familyPaths.secret) }),
        })
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
        await putCliOAuth(
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
    const record = await readRecord<CliRecord>(paths.cliRecord, 'cli-oauth');
    if (!record) return;
    await deleteSecret(record, paths.cliSecret);
    await files.remove(paths.cliRecord);
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

  async function removeFamily(familyId: string): Promise<void> {
    const familyPaths = credentialPaths(files.stateDir, familyId);
    const record = await readRecord<FamilyRecord>(familyPaths.record, 'component');
    if (!record) return;
    await deleteSecret(record, familyPaths.secret);
    await files.remove(familyPaths.record);
  }

  async function revokeFamily(familyId: string, transport: CredentialTransport) {
    const current = await readFamily(familyId);
    if (!current) return action(familyId, 'family_missing');
    const response = await transport.revokeFamily(familyId, current.refreshToken);
    if (response.status === 429) return retryLater(familyId, 'rate_limited');
    if (response.status >= 500) return retryLater(familyId, 'server_error');
    if (response.status !== 200)
      return action(familyId, 'error' in response.body ? response.body.error : 'revoke_refused');
    await removeFamily(familyId);
    return { status: 'revoked' as const, familyId };
  }

  async function rootKey(): Promise<Buffer> {
    return withLock(paths.rootRecord, options.lockWaitMs ?? 60_000, async () => {
      const record = await readRecord<RootRecord>(paths.rootRecord, 'root-binding');
      if (record) {
        const key = await readSecret(record, paths.rootSecret);
        if (!key || key.length !== 32) throw new Error('root_binding_key_invalid');
        return key;
      }
      const location = await locator('root-binding', paths.rootSecret);
      const key = randomBytes(32);
      await writeSecret(location, paths.rootSecret, key);
      await files.write(
        paths.rootRecord,
        json({ schemaVersion: 1, kind: 'root-binding', ...location } satisfies RootRecord),
        'record'
      );
      return key;
    });
  }

  async function hmacRootBinding(version: 1, input: string) {
    if (version !== 1) throw new Error('unsupported_root_binding_version');
    const key = await rootKey();
    return { version, hmac: createHmac('sha256', key).update(input).digest('base64url') };
  }

  async function forget() {
    const cli = await readRecord<CliRecord>(paths.cliRecord, 'cli-oauth');
    const componentFamilyIds: string[] = [];
    for (const name of await files.list(paths.familyRecords)) {
      const recordPath = join(paths.familyRecords, name);
      const record = await readRecord<FamilyRecord>(recordPath, 'component');
      if (!record) continue;
      componentFamilyIds.push(record.familyId);
      await removeFamily(record.familyId);
    }
    if (cli) {
      await deleteSecret(cli, paths.cliSecret);
      await files.remove(paths.cliRecord);
    }
    const root = await readRecord<RootRecord>(paths.rootRecord, 'root-binding');
    if (root) {
      await deleteSecret(root, paths.rootSecret);
      await files.remove(paths.rootRecord);
    }
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

/** Preserve each caller's wire body and budget; share rotation and failure state with bound context. */
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
  const unavailable = () => new Response('{"ok":false}', { status: 403 });
  if (!credential || credential.unavailable) return unavailable();
  try {
    const result = await credential.credentials.withCredential(
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
    );
    if (typeof result.status === 'number' && 'body' in result) return result.body;
    credential.unavailable ||= result.reason === 'invalid_grant';
  } catch (error) {
    // Only explicit revocation/expiry disables the family; a rejected route is call-local.
    credential.unavailable ||= (error as { code?: string } | null)?.code === 'invalid_grant';
  }
  if (!credential.diagnosed)
    process.stderr.write('mnemonik-hook: credentials unavailable - fail-open.\n');
  credential.diagnosed = true;
  return unavailable();
}
