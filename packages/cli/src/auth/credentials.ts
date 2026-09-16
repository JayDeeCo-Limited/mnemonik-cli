import {
  createLocalCredentialAdapter,
  isCredentialSessionUnavailableError,
  type CredentialAdapterOptions,
  type CredentialStoreKind,
} from '@mnemonik/credentials';

const diagnostics = new Set<string>();
/** Every CLI OAuth consumer uses the same process-scoped OS store. */
export function createCliCredentials(options: CredentialAdapterOptions = {}) {
  return createLocalCredentialAdapter({
    ...options,
    onDiagnostic(code) {
      diagnostics.add(code);
      options.onDiagnostic?.(code);
    },
  });
}

export async function cliCredentialStatus(options: CredentialAdapterOptions = {}): Promise<{
  store: CredentialStoreKind | null;
  present: boolean;
  diagnostics: string[];
  reason?: string;
  detail?: string;
}> {
  try {
    const credential = await createCliCredentials(options).readCliOAuth();
    return {
      store: credential?.store ?? 'file',
      present: Boolean(credential),
      diagnostics: [...diagnostics],
    };
  } catch (error) {
    if (isCredentialSessionUnavailableError(error))
      return {
        store: error.store,
        present: false,
        diagnostics: [...diagnostics],
        reason: error.reason,
        detail: error.message,
      };
    return { store: null, present: false, diagnostics: [...diagnostics, 'credential_unreadable'] };
  }
}
