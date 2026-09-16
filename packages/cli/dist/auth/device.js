import { URL, URLSearchParams } from 'node:url';
import { OAuthProtocolError } from './pkce.js';
/** Shown with every device code, byte for byte, as required by the OAuth contract. */
export const DEVICE_WARNING = "Approve only a request you just started on a device you control. Compare this code with the one in that device's terminal. If you received this code or link from someone else, deny it.";
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
function validVerificationUris(issuer, userCode, verificationUri, completeUri) {
    try {
        const expected = new URL('/oauth/device', `${issuer}/`);
        const verification = new URL(verificationUri);
        const complete = new URL(completeUri);
        const parameters = [...complete.searchParams];
        return (verification.href === expected.href &&
            complete.origin === expected.origin &&
            complete.pathname === expected.pathname &&
            !complete.username &&
            !complete.password &&
            !complete.hash &&
            parameters.length === 1 &&
            parameters[0]?.[0] === 'user_code' &&
            parameters[0]?.[1] === userCode);
    }
    catch {
        return false;
    }
}
export async function runDeviceFlow(options) {
    const issuer = options.issuer.replace(/\/$/u, '');
    const fetchImpl = options.fetch ?? fetch;
    const sleep = options.sleep ?? wait;
    const now = options.now ?? Date.now;
    const started = now();
    const response = await fetchImpl(`${issuer}/oauth/device_authorization`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: options.clientId,
            scope: options.scopes.join(' '),
            resource: options.resource,
            ...(options.scannerRoots ? { scanner_roots: options.scannerRoots } : {}),
            ...(options.deviceInstallationIds?.length
                ? { device_installation_ids: JSON.stringify(options.deviceInstallationIds) }
                : {}),
            ...(options.deviceInstallationId
                ? { device_installation_id: options.deviceInstallationId }
                : {}),
            device_name: options.deviceName,
        }),
    });
    const issued = (await response.json().catch(() => ({})));
    if (!response.ok)
        throw new OAuthProtocolError(typeof issued.error === 'string' ? issued.error : 'device_authorization_failed');
    if (typeof issued.device_code !== 'string' ||
        typeof issued.user_code !== 'string' ||
        !/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/u.test(issued.user_code) ||
        typeof issued.verification_uri !== 'string' ||
        typeof issued.verification_uri_complete !== 'string' ||
        typeof issued.expires_in !== 'number' ||
        !Number.isSafeInteger(issued.expires_in) ||
        issued.expires_in <= 0 ||
        issued.expires_in > 600 ||
        typeof issued.interval !== 'number' ||
        !Number.isSafeInteger(issued.interval) ||
        issued.interval < 5 ||
        !validVerificationUris(issuer, issued.user_code, issued.verification_uri, issued.verification_uri_complete))
        throw new OAuthProtocolError('invalid_device_response');
    options.print(`Code: ${issued.user_code}`);
    options.print(`Verification URI: ${issued.verification_uri}`);
    options.print(`Complete URI: ${issued.verification_uri_complete}`);
    options.print(DEVICE_WARNING);
    let interval = issued.interval;
    let transportBackoff = 0;
    const deadline = started + issued.expires_in * 1000;
    while (now() < deadline) {
        await sleep((transportBackoff || interval) * 1000);
        if (now() >= deadline)
            break;
        let poll;
        try {
            poll = await fetchImpl(`${issuer}/oauth/token`, {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
                    client_id: options.clientId,
                    device_code: issued.device_code,
                    resource: options.resource,
                }),
            });
        }
        catch {
            transportBackoff = Math.min(Math.max(interval, transportBackoff || interval) * 2, 60);
            continue;
        }
        transportBackoff = 0;
        const body = (await poll.json().catch(() => ({})));
        if (poll.ok) {
            if (typeof body.access_token !== 'string' ||
                typeof body.refresh_token !== 'string' ||
                typeof body.expires_in !== 'number' ||
                typeof body.scope !== 'string')
                throw new OAuthProtocolError('invalid_token_response');
            return {
                clientId: options.clientId,
                tokens: {
                    access_token: body.access_token,
                    refresh_token: body.refresh_token,
                    token_type: 'Bearer',
                    expires_in: body.expires_in,
                    scope: body.scope,
                },
            };
        }
        const error = typeof body.error === 'string' ? body.error : 'device_poll_failed';
        if (error === 'authorization_pending')
            continue;
        if (error === 'slow_down') {
            interval += 5;
            continue;
        }
        if (error === 'access_denied')
            throw new OAuthProtocolError(error, 'denied on the other device');
        if (error === 'expired_token')
            throw new OAuthProtocolError(error, 'expired');
        throw new OAuthProtocolError(error);
    }
    throw new OAuthProtocolError('expired_token', 'expired');
}
//# sourceMappingURL=device.js.map