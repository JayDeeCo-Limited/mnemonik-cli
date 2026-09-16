import { createCliCredentials } from '../auth/credentials.js';
import { URLSearchParams } from 'node:url';
import { createCliAuth } from '../auth/index.js';
const DEFAULT_API = 'https://api.mnemonik.dev/';
const action = (state, allowedActions = ['retry', 'cancel']) => ({
    status: 'ACTION_REQUIRED',
    state,
    allowedActions,
});
const isAction = (value) => !!value &&
    typeof value === 'object' &&
    value.status === 'ACTION_REQUIRED';
export class ServerActionRequiredError extends Error {
    result;
    constructor(result) {
        super(result.state);
        this.result = result;
        this.name = 'ServerActionRequiredError';
    }
}
export function createServerTransport(options) {
    const resource = options.resource ?? process.env.MNEMONIK_API_RESOURCE ?? DEFAULT_API;
    const apiBase = (options.apiBase ?? resource).replace(/\/$/u, '');
    const fetchImpl = options.fetch ?? fetch;
    const credentials = options.credentials ?? createCliCredentials();
    const getCliBearer = options.getCliBearer ?? createCliAuth({ resource, fetch: fetchImpl, credentials }).getCliBearer;
    const rotation = {
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
            });
            return {
                status: response.status,
                body: (await response.json().catch(() => ({}))),
                ...(response.headers.has('retry-after')
                    ? { retryAfterMs: Number(response.headers.get('retry-after')) * 1_000 }
                    : {}),
            };
        },
    };
    const request = async (method, path, payload, suppliedBearer) => {
        const firstBearer = suppliedBearer ?? (await getCliBearer());
        if (typeof firstBearer !== 'string')
            return action(firstBearer.reason, ['mnemonik auth renew']);
        const send = async (bearer) => {
            try {
                const response = await fetchImpl(`${apiBase}${path}`, {
                    method,
                    headers: {
                        authorization: `Bearer ${bearer}`,
                        ...(payload ? { 'content-type': 'application/json' } : {}),
                    },
                    ...(payload ? { body: JSON.stringify(payload) } : {}),
                });
                return {
                    status: response.status,
                    body: (await response.json().catch(() => ({}))),
                };
            }
            catch {
                return { status: 503, body: action('server_unavailable') };
            }
        };
        const first = await send(firstBearer);
        if (first.status !== 401)
            return first;
        const refreshed = await credentials.rotateCli(rotation);
        if (!('accessToken' in refreshed))
            return action(refreshed.reason, ['mnemonik auth renew']);
        const second = await send(refreshed.accessToken);
        return second.status === 401 ? action('protected_unauthorized') : second;
    };
    const bodyOrAction = (response) => {
        if (isAction(response))
            return response;
        if (isAction(response.body))
            return response.body;
        if (response.status >= 200 && response.status < 300)
            return response.body;
        return action(typeof response.body.state === 'string'
            ? response.body.state
            : response.status >= 500
                ? 'server_unavailable'
                : 'request_refused');
    };
    const setup = {
        async issueSetupRequest(input) {
            const context = await options.issueContext(input);
            const result = bodyOrAction(await request('POST', '/api/v1/project-setup/issue', {
                ...context,
                ...(options.requestId ? { requestId: options.requestId } : {}),
            }));
            return result;
        },
        async consumeSetupRequest(input) {
            return bodyOrAction(await request('POST', '/api/v1/project-setup/consume', input));
        },
    };
    const accountContext = async (bearer) => {
        const result = bodyOrAction(await request('GET', '/api/v1/project-setup/default-owner', undefined, bearer));
        if (isAction(result))
            throw new ServerActionRequiredError(result);
        if (typeof result.userId !== 'string' ||
            typeof result.deviceInstallationId !== 'string' ||
            !(result.owner === 'personal' ||
                (!!result.owner &&
                    typeof result.owner === 'object' &&
                    typeof result.owner.teamId === 'string')))
            throw new ServerActionRequiredError(action('invalid_server_result'));
        return result;
    };
    return {
        ...setup,
        getCliBearer,
        credentials,
        accountContext,
        async getDefaultOwner(bearer) {
            return (await accountContext(bearer)).owner;
        },
        async readProjectState(projectId, bearer, localFingerprint) {
            const result = bodyOrAction(await request('GET', `/api/v1/project-setup/project-state?projectId=${encodeURIComponent(projectId)}`, undefined, bearer));
            if (isAction(result))
                throw new ServerActionRequiredError(result);
            if (typeof result.state !== 'string' ||
                !['access', 'archived', 'deleted', 'suspended', 'not_found'].includes(result.state))
                throw new ServerActionRequiredError(action('invalid_server_result'));
            const serverFingerprint = result.repositoryFingerprint;
            const mismatch = !!serverFingerprint &&
                !!localFingerprint &&
                (serverFingerprint.algorithmVersion !== localFingerprint.algorithmVersion ||
                    serverFingerprint.hash !== localFingerprint.hash);
            return { state: mismatch ? 'mismatch' : result.state };
        },
    };
}
//# sourceMappingURL=server.js.map