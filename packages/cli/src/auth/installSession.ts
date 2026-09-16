import type { createCredentialAdapter } from '@mnemonik/credentials';
import { apiOrigin } from '@mnemonik/shared';
import { createCliAuth } from './index.js';

export interface InstallSession {
  id: string;
  device_installation_id: string;
  expires_at?: string;
}

export interface EnsureInstallSessionOptions {
  stateDir?: string;
  bearer: string;
  deviceInstallationId: string;
  currentSession?: InstallSession | null;
  credentials?: ReturnType<typeof createCredentialAdapter>;
  scannerRoots?: string;
  noBrowser?: boolean;
  print?: (line: string) => void;
  fetch?: typeof fetch;
  authorize?: (deviceInstallationId: string) => Promise<string>;
}

export async function currentInstallSession(
  bearer: string,
  fetcher: typeof fetch = fetch
): Promise<InstallSession | null> {
  const response = await fetcher(`${apiOrigin()}/api/v1/install-sessions/current`, {
    headers: { authorization: `Bearer ${bearer}` },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`install_session_status_${response.status}`);
  return (await response.json()) as InstallSession;
}

/** Reauthorize the existing installation only when its install session has expired. */
export async function ensureInstallSession(options: EnsureInstallSessionOptions): Promise<string> {
  const current =
    options.currentSession === undefined
      ? await currentInstallSession(options.bearer, options.fetch)
      : options.currentSession;
  if (current) return options.bearer;
  if (options.authorize) return options.authorize(options.deviceInstallationId);

  const auth = createCliAuth({
    stateDir: options.stateDir,
    credentials: options.credentials,
    deviceInstallationId: options.deviceInstallationId,
    scannerRoots: options.scannerRoots,
    noBrowser: options.noBrowser,
    print: options.print,
    fetch: options.fetch,
  });
  await auth.signIn();
  const bearer = await auth.getCliBearer();
  if (typeof bearer !== 'string') throw new Error(bearer.reason);
  return bearer;
}
