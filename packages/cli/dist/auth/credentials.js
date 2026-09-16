import { createLocalCredentialAdapter, isCredentialSessionUnavailableError, } from '@mnemonik/credentials';
const diagnostics = new Set();
/** Every CLI OAuth consumer uses the same process-scoped OS store. */
export function createCliCredentials(options = {}) {
    return createLocalCredentialAdapter({
        ...options,
        onDiagnostic(code) {
            diagnostics.add(code);
            options.onDiagnostic?.(code);
        },
    });
}
export async function cliCredentialStatus(options = {}) {
    try {
        const credential = await createCliCredentials(options).readCliOAuth();
        return {
            store: credential?.store ?? 'file',
            present: Boolean(credential),
            diagnostics: [...diagnostics],
        };
    }
    catch (error) {
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
//# sourceMappingURL=credentials.js.map