import { createCliCredentials } from '../auth/credentials.js';
import { URLSearchParams } from 'node:url';
import {
  type createCredentialAdapter,
  type CliCredentialTransport,
  type CliOAuthCredential,
} from '@mnemonik/credentials';
import type {
  ActionRequired,
  ConsumeInput,
  Evidence,
  Owner,
  SetupRequired,
  SetupTransport,
} from '@mnemonik/local-setup';
import type { RepositoryFingerprint } from '@mnemonik/shared';
import { createCliAuth } from '../auth/index.js';

const DEFAULT_API = 'https://api.mnemonik.dev/';

export interface CliIssueContext extends Evidence {
  rootKind: 'git' | 'selected_non_git' | 'ineligible';
  identityState: 'absent' | 'valid' | 'invalid';
  projectId?: string;
  requestedProjectId?: string;
  requestId?: string;
}

export interface ServerTransportOptions {
  apiBase?: string;
  resource?: string;
  fetch?: typeof fetch;
  credentials?: ReturnType<typeof createCredentialAdapter>;
  getCliBearer?: () => Promise<string | { status: string; reason: string }>;
  requestId?: string;
  issueContext(input: Evidence & { projectId?: string }): Promise<CliIssueContext>;
}

type Json = Record<string, unknown>;
type HttpResult = { status: number; body: Json } | ActionRequired;
type AccountContext = {
  owner: Owner;
  userId: string;
  deviceInstallationId: string;
};
type ProjectState = 'access' | 'archived' | 'deleted' | 'suspended' | 'not_found';

const action = (state: string, allowedActions = ['retry', 'cancel']): ActionRequired => ({
  status: 'ACTION_REQUIRED',
  state,
  allowedActions,
});
const isAction = (value: unknown): value is ActionRequired =>
  !!value &&
  typeof value === 'object' &&
  (value as { status?: unknown }).status === 'ACTION_REQUIRED';

/**
 * What to do next when the account cannot be reached, by the reason's name.
 * The hook that runs `mnemonik project ensure` relays `mnemonik auth renew`.
 */
export const accountActions: Record<string, string> = {
  not_signed_in: 'mnemonik install',
  renew: 'mnemonik auth renew',
  unreachable: 'retry',
  server_error: 'retry',
  invalid_request: 'retry',
};

/**
 * A sign-in that produced no bearer, named for what fixes it: there is none,
 * the server could not be reached or failed while renewing it, or the server
 * no longer accepts it.
 */
export function signInFailureState(failure: { status?: string; reason: string }): string {
  if (failure.reason === 'family_missing') return 'not_signed_in';
  if (failure.reason === 'rotation_response_lost') return 'unreachable';
  return failure.status === 'RETRY_LATER' ? 'server_error' : 'renew';
}

const signInAction = (failure: { status?: string; reason: string }): ActionRequired => {
  const state = signInFailureState(failure);
  return action(state, [accountActions[state] ?? 'retry']);
};

export class ServerActionRequiredError extends Error {
  constructor(readonly result: ActionRequired) {
    super(result.state);
    this.name = 'ServerActionRequiredError';
  }
}

export function createServerTransport(options: ServerTransportOptions) {
  const resource = options.resource ?? process.env.MNEMONIK_API_RESOURCE ?? DEFAULT_API;
  const apiBase = (options.apiBase ?? resource).replace(/\/$/u, '');
  const fetchImpl = options.fetch ?? fetch;
  const credentials = options.credentials ?? createCliCredentials();
  const getCliBearer =
    options.getCliBearer ?? createCliAuth({ resource, fetch: fetchImpl, credentials }).getCliBearer;
  const rotation: CliCredentialTransport = {
    async rotateCli(current: CliOAuthCredential) {
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
        body: (await response.json().catch(() => ({}))) as never,
        ...(response.headers.has('retry-after')
          ? { retryAfterMs: Number(response.headers.get('retry-after')) * 1_000 }
          : {}),
      };
    },
  };

  const request = async (
    method: 'GET' | 'POST',
    path: string,
    payload?: object,
    suppliedBearer?: string
  ): Promise<HttpResult> => {
    const firstBearer = suppliedBearer ?? (await getCliBearer());
    if (typeof firstBearer !== 'string') return signInAction(firstBearer);
    const send = async (bearer: string) => {
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
          body: (await response.json().catch(() => ({}))) as Json,
        };
      } catch {
        return { status: 503, body: action('unreachable') as unknown as Json };
      }
    };
    const first = await send(firstBearer);
    if (first.status !== 401) return first;
    const refreshed = await credentials.rotateCli(rotation);
    if (!('accessToken' in refreshed)) return signInAction(refreshed);
    const second = await send(refreshed.accessToken);
    return second.status === 401 ? signInAction({ reason: 'protected_unauthorized' }) : second;
  };

  const bodyOrAction = (response: HttpResult): Json | ActionRequired => {
    if (isAction(response)) return response;
    if (isAction(response.body)) return response.body;
    if (response.status >= 200 && response.status < 300) return response.body;
    return action(
      typeof response.body.state === 'string'
        ? response.body.state
        : response.status >= 500
          ? 'server_error'
          : 'request_refused'
    );
  };

  const setup: SetupTransport = {
    async issueSetupRequest(input) {
      const context = await options.issueContext(input);
      const result = bodyOrAction(
        await request('POST', '/api/v1/project-setup/issue', {
          ...context,
          ...(options.requestId ? { requestId: options.requestId } : {}),
        })
      );
      return result as
        | SetupRequired
        | ActionRequired
        | {
            status: 'complete';
            projectId: string;
            displayName: string;
          };
    },
    async consumeSetupRequest(input: ConsumeInput) {
      return bodyOrAction(await request('POST', '/api/v1/project-setup/consume', input)) as Awaited<
        ReturnType<SetupTransport['consumeSetupRequest']>
      >;
    },
  };

  const accountContext = async (bearer?: string): Promise<AccountContext> => {
    const result = bodyOrAction(
      await request('GET', '/api/v1/project-setup/default-owner', undefined, bearer)
    );
    if (isAction(result)) throw new ServerActionRequiredError(result);
    if (
      typeof result.userId !== 'string' ||
      typeof result.deviceInstallationId !== 'string' ||
      !(
        result.owner === 'personal' ||
        (!!result.owner &&
          typeof result.owner === 'object' &&
          typeof (result.owner as { teamId?: unknown }).teamId === 'string')
      )
    )
      throw new ServerActionRequiredError(action('invalid_server_result'));
    return result as AccountContext;
  };

  return {
    ...setup,
    getCliBearer,
    credentials,
    accountContext,
    async getDefaultOwner(bearer: string): Promise<Owner | undefined> {
      return (await accountContext(bearer)).owner;
    },
    async readProjectState(
      projectId: string,
      bearer: string,
      localFingerprint?: RepositoryFingerprint | null
    ) {
      const result = bodyOrAction(
        await request(
          'GET',
          `/api/v1/project-setup/project-state?projectId=${encodeURIComponent(projectId)}`,
          undefined,
          bearer
        )
      );
      if (isAction(result)) throw new ServerActionRequiredError(result);
      if (
        typeof result.state !== 'string' ||
        !['access', 'archived', 'deleted', 'suspended', 'not_found'].includes(result.state)
      )
        throw new ServerActionRequiredError(action('invalid_server_result'));
      const serverFingerprint = result.repositoryFingerprint as RepositoryFingerprint | null;
      const mismatch =
        !!serverFingerprint &&
        !!localFingerprint &&
        (serverFingerprint.algorithmVersion !== localFingerprint.algorithmVersion ||
          serverFingerprint.hash !== localFingerprint.hash);
      return { state: mismatch ? ('mismatch' as const) : (result.state as ProjectState) };
    },
  };
}
