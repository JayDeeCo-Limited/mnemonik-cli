export type OsStoreKind = 'keychain' | 'credential-manager' | 'secret-service';
export type CredentialStoreKind = 'os' | 'file' | OsStoreKind;
export class CredentialSessionUnavailableError extends Error {
  readonly reason = 'credential_session_unavailable';
  constructor(public readonly store: OsStoreKind | 'os') {
    super(
      `Not signed in in this session. The sign-in is in ${store === 'keychain' ? 'the login keychain' : 'the OS credential store'}; run mnemonik auth login here or use Terminal.`
    );
    this.name = 'CredentialSessionUnavailableError';
  }
}
/** Public CLI entrypoints can bundle separate copies of this class. */
export function isCredentialSessionUnavailableError(
  error: unknown
): error is CredentialSessionUnavailableError {
  return (
    !!error &&
    typeof error === 'object' &&
    'reason' in error &&
    error.reason === 'credential_session_unavailable' &&
    'name' in error &&
    error.name === 'CredentialSessionUnavailableError' &&
    'store' in error &&
    ['keychain', 'credential-manager', 'secret-service', 'os'].includes(String(error.store)) &&
    'message' in error &&
    typeof error.message === 'string'
  );
}
export type ComponentKind = 'hook' | 'scanner';

export interface CliOAuthMetadata {
  issuer: string;
  clientId: string;
  scopes: string[];
  familyId: string;
  lastRotationTime: string;
}

export interface CliOAuthTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
}

export interface ComponentCredentialResponse {
  id: string;
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_expires_in: number;
  scope: string;
  display_prefix: string;
}

export interface FamilyCredential {
  store: CredentialStoreKind;
  familyId: string;
  componentKind: ComponentKind;
  scopes: string[];
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
  lastRotationTime: string;
}

export interface CliOAuthCredential extends CliOAuthMetadata, CliOAuthTokens {
  store: CredentialStoreKind;
}

export interface CliTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
}

export type ErrorBody = { error: string };
export type TransportResponse<T> =
  | { status: 200; body: T; retryAfterMs?: number }
  | { status: number; body: ErrorBody; retryAfterMs?: number };

export interface CredentialTransport {
  rotateFamily(
    familyId: string,
    refreshToken: string
  ): Promise<TransportResponse<ComponentCredentialResponse>>;
  revokeFamily(familyId: string, refreshToken: string): Promise<TransportResponse<object>>;
}

export interface CliCredentialTransport {
  rotateCli(credential: CliOAuthCredential): Promise<TransportResponse<CliTokenResponse>>;
}

export type ActionRequired = {
  status: 'ACTION_REQUIRED';
  reason: string;
  familyId: string;
};
export type RetryLater = {
  status: 'RETRY_LATER';
  reason: 'rate_limited' | 'server_error';
  familyId: string;
};
export type RotationResult = FamilyCredential | ActionRequired | RetryLater;

export type WorkResponse<T> = { status: number; body: T };

export interface SecretStore {
  readonly kind?: OsStoreKind;
  isAvailable(): Promise<boolean>;
  get(reference: string): Promise<string | null | undefined>;
  set(reference: string, secret: string): Promise<void>;
  delete(reference: string): Promise<void>;
}

export class SimulatedSecretStore implements SecretStore {
  readonly values = new Map<string, string>();

  constructor(private readonly available = true) {}

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  async get(reference: string): Promise<string | null> {
    return this.values.get(reference) ?? null;
  }

  async set(reference: string, secret: string): Promise<void> {
    this.values.set(reference, secret);
  }

  async delete(reference: string): Promise<void> {
    this.values.delete(reference);
  }
}
