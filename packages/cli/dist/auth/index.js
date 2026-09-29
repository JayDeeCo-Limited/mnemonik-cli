import { stateDirectory } from '@mnemonik/local-setup';
import { readInstallations, saveInstallation } from '../installation.js';
import { createCliCredentials } from './credentials.js';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { URLSearchParams } from 'node:url';
import { isCredentialSessionUnavailableError, } from '@mnemonik/credentials';
import { runDeviceFlow } from './device.js';
import { machineName } from './machineName.js';
import { open, OAuthProtocolError } from './pkce.js';
export const CLI_SCOPES = [
    'account:read',
    'install:manage',
    'components:manage',
    'projects:manage',
    'offline_access',
];
const CLI_VERSION = createRequire(import.meta.url)('../../package.json')
    .version;
/**
 * Sign-out holds the CLI credential lease across its /oauth/revoke call, so the call is
 * bounded: a hung issuer must not keep the lease (and a sign-in waiting for it) indefinitely.
 */
export const CLI_REVOKE_TIMEOUT_MS = 10_000;
/**
 * Bound on one token refresh. The credential adapter retries a lost response
 * once, so a refresh the server never answers ends as rotation_response_lost
 * (retry) after about twice this.
 */
export const CLI_REFRESH_TIMEOUT_MS = 5_000;
export function noBrowserAvailable(platform = process.platform, env = process.env) {
    return (!!env.SSH_CONNECTION ||
        !!env.SSH_TTY ||
        (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY));
}
const clientMetadata = (redirectUris) => ({
    client_name: 'Mnemonik CLI',
    application_type: 'native',
    redirect_uris: redirectUris,
    token_endpoint_auth_method: 'none',
    grant_types: [
        'authorization_code',
        'refresh_token',
        'urn:ietf:params:oauth:grant-type:device_code',
    ],
    response_types: ['code'],
    scope: CLI_SCOPES.join(' '),
    software_id: 'mnemonik-cli',
    software_version: CLI_VERSION,
});
export function createCliAuth(options = {}) {
    const issuer = (options.issuer ??
        process.env.MNEMONIK_OAUTH_ISSUER ??
        'https://auth.mnemonik.ai').replace(/\/$/u, '');
    const resource = options.resource ?? process.env.MNEMONIK_API_RESOURCE ?? 'https://api.mnemonik.dev/';
    const fetchImpl = options.fetch ?? fetch;
    const print = options.print ?? ((line) => process.stdout.write(`${line}\n`));
    const now = options.now ?? Date.now;
    const stateDir = options.stateDir ?? options.credentialOptions?.stateDir ?? stateDirectory();
    const credentials = options.credentials ?? createCliCredentials({ ...options.credentialOptions, stateDir });
    let deviceInstallationId = options.deviceInstallationId;
    let deviceInstallationIds = [];
    const cimdClientId = `${issuer}/oauth/clients/mnemonik-cli.json`;
    async function register(redirectUris) {
        const response = await fetchImpl(`${issuer}/oauth/register`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(clientMetadata(redirectUris)),
        });
        const body = (await response.json().catch(() => ({})));
        if (!response.ok || typeof body.client_id !== 'string')
            throw new OAuthProtocolError(typeof body.error === 'string' ? body.error : 'client_registration_failed');
        return body.client_id;
    }
    async function device(clientId, openBrowser) {
        return runDeviceFlow({
            issuer,
            resource,
            scopes: CLI_SCOPES,
            scannerRoots: options.scannerRoots,
            deviceInstallationId,
            deviceInstallationIds,
            clientId,
            deviceName: options.deviceName ??
                (await machineName(options.platform ?? process.platform, options.computerName)),
            print,
            ...(options.onApprovalLink ? { onLink: options.onApprovalLink } : {}),
            openBrowser,
            fetch: fetchImpl,
            sleep: options.sleep,
            now,
        });
    }
    async function deviceWithRegistration(clientId, openBrowser) {
        try {
            return await device(clientId, openBrowser);
        }
        catch (error) {
            if (!(error instanceof OAuthProtocolError) || error.code !== 'invalid_client')
                throw error;
            return device(await register(['http://127.0.0.1/callback', 'http://[::1]/callback']), openBrowser);
        }
    }
    async function signIn() {
        deviceInstallationIds = [
            ...new Set([options.deviceInstallationId, ...(await readInstallations(stateDir))].filter((id) => !!id)),
        ];
        deviceInstallationId = deviceInstallationIds[0];
        // Before any device grant exists: a sign-out or rotation holding the CLI lease finishes
        // first, and a lease that cannot be had fails here rather than after approval, when the
        // grant would be live with nowhere to store it.
        await credentials.waitForCliLease();
        const saved = await credentials.readCliOAuth().catch((error) => {
            // An unreadable session store, or a record an older crash left without its secret:
            // sign in afresh (putCliOAuth replaces the record).
            if (isCredentialSessionUnavailableError(error))
                return null;
            if (error instanceof Error && error.message === 'credential_secret_missing')
                return null;
            throw error;
        });
        const clientId = saved?.clientId ?? cimdClientId;
        const browserUnavailable = options.noBrowser || noBrowserAvailable(options.platform, options.env);
        const result = await deviceWithRegistration(clientId, browserUnavailable
            ? undefined
            : (options.openBrowser ?? ((url) => open(url, options.platform ?? process.platform))));
        const rotatedAt = now();
        // localFamilyKey: the server does not expose its family id to the CLI yet;
        // this stable digest is only the local serialization/lease identity.
        const localFamilyKey = createHash('sha256')
            .update(`${issuer}\0${result.clientId}`)
            .digest('hex');
        await credentials.putCliOAuth({
            issuer,
            clientId: result.clientId,
            scopes: result.tokens.scope.split(' ').filter(Boolean),
            familyId: localFamilyKey,
            lastRotationTime: new Date(rotatedAt).toISOString(),
        }, {
            accessToken: result.tokens.access_token,
            refreshToken: result.tokens.refresh_token,
            accessExpiresAt: new Date(rotatedAt + result.tokens.expires_in * 1000).toISOString(),
        });
        await accountEmail(result.tokens.access_token);
        const stored = await credentials.readCliOAuth();
        if (!stored)
            throw new Error('credential_persistence_failed');
        return stored;
    }
    const transport = {
        async rotateCli(current) {
            const response = await fetchImpl(`${current.issuer.replace(/\/$/u, '')}/oauth/token`, {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    grant_type: 'refresh_token',
                    client_id: current.clientId,
                    refresh_token: current.refreshToken,
                    resource,
                }),
                // A refresh that never answers is a lost response to the credential
                // adapter (retried once, then rotation_response_lost), not a hang.
                signal: AbortSignal.timeout(options.refreshTimeoutMs ?? CLI_REFRESH_TIMEOUT_MS),
            });
            return {
                status: response.status,
                body: (await response.json().catch(() => ({}))),
                ...(response.headers.has('retry-after')
                    ? { retryAfterMs: Number(response.headers.get('retry-after')) * 1000 }
                    : {}),
            };
        },
    };
    async function getCliBearer() {
        const current = await credentials.readCliOAuth();
        if (!current)
            return { status: 'ACTION_REQUIRED', reason: 'family_missing' };
        if (current.accessToken && Date.parse(current.accessExpiresAt) > now())
            return current.accessToken;
        const rotated = await credentials.rotateCli(transport);
        return 'accessToken' in rotated
            ? rotated.accessToken
            : { status: rotated.status, reason: rotated.reason };
    }
    async function accountEmail(bearer) {
        const response = await fetchImpl(new URL('/api/v1/auth/grants', resource), {
            headers: { authorization: `Bearer ${bearer}` },
        });
        const body = (await response.json().catch(() => ({})));
        if (!response.ok || typeof body.email !== 'string')
            throw new OAuthProtocolError('account_identity_failed');
        if (typeof body.deviceInstallationId === 'string')
            await saveInstallation(stateDir, body.deviceInstallationId, typeof body.account === 'string' ? { account: body.account, email: body.email } : undefined);
        return body.email;
    }
    /** Revokes and removes under the credential package's CLI lease (revokeCli). */
    async function logout() {
        const result = await credentials.revokeCli({
            async revokeCli(current) {
                let response;
                try {
                    response = await fetchImpl(`${current.issuer.replace(/\/$/u, '')}/oauth/revoke`, {
                        method: 'POST',
                        headers: { 'content-type': 'application/x-www-form-urlencoded' },
                        body: new URLSearchParams({
                            client_id: current.clientId,
                            token: current.refreshToken,
                            token_type_hint: 'refresh_token',
                        }),
                        signal: AbortSignal.timeout(options.revokeTimeoutMs ?? CLI_REVOKE_TIMEOUT_MS),
                    });
                }
                catch {
                    // Timed out or unreachable: keep the credential for a retry, as for a 5xx.
                    return { status: 503, body: { error: 'revoke_failed' } };
                }
                return response.ok
                    ? { status: 200, body: {} }
                    : { status: response.status, body: { error: 'revoke_failed' } };
            },
        });
        // credential_secret_missing: an unusable record was removed; nothing is left to sign out.
        if (result.status === 'revoked' ||
            result.reason === 'family_missing' ||
            result.reason === 'credential_secret_missing')
            return;
        throw new OAuthProtocolError('revoke_failed');
    }
    return { signIn, getCliBearer, accountEmail, logout };
}
export * from './device.js';
export * from './pkce.js';
//# sourceMappingURL=index.js.map