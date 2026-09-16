export class CredentialSessionUnavailableError extends Error {
    store;
    reason = 'credential_session_unavailable';
    constructor(store) {
        super(`Not signed in in this session. The sign-in is in ${store === 'keychain' ? 'the login keychain' : 'the OS credential store'}; run mnemonik auth login here or use Terminal.`);
        this.store = store;
        this.name = 'CredentialSessionUnavailableError';
    }
}
/** Public CLI entrypoints can bundle separate copies of this class. */
export function isCredentialSessionUnavailableError(error) {
    return (!!error &&
        typeof error === 'object' &&
        'reason' in error &&
        error.reason === 'credential_session_unavailable' &&
        'name' in error &&
        error.name === 'CredentialSessionUnavailableError' &&
        'store' in error &&
        ['keychain', 'credential-manager', 'secret-service', 'os'].includes(String(error.store)) &&
        'message' in error &&
        typeof error.message === 'string');
}
export class SimulatedSecretStore {
    available;
    values = new Map();
    constructor(available = true) {
        this.available = available;
    }
    async isAvailable() {
        return this.available;
    }
    async get(reference) {
        return this.values.get(reference) ?? null;
    }
    async set(reference, secret) {
        this.values.set(reference, secret);
    }
    async delete(reference) {
        this.values.delete(reference);
    }
}
//# sourceMappingURL=contracts.js.map