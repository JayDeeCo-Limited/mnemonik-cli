import { apiOrigin } from '@mnemonik/shared';
import { createCliAuth } from './index.js';
export async function currentInstallSession(bearer, fetcher = fetch) {
    const response = await fetcher(`${apiOrigin()}/api/v1/install-sessions/current`, {
        headers: { authorization: `Bearer ${bearer}` },
    });
    if (response.status === 404)
        return null;
    if (!response.ok)
        throw new Error(`install_session_status_${response.status}`);
    return (await response.json());
}
/** Reauthorize the existing installation only when its install session has expired. */
export async function ensureInstallSession(options) {
    const current = options.currentSession === undefined
        ? await currentInstallSession(options.bearer, options.fetch)
        : options.currentSession;
    if (current)
        return options.bearer;
    if (options.authorize)
        return options.authorize(options.deviceInstallationId);
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
    if (typeof bearer !== 'string')
        throw new Error(bearer.reason);
    return bearer;
}
//# sourceMappingURL=installSession.js.map