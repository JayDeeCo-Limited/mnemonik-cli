import { devReadiness } from './runtime/releaseSource.js';
import { apiOrigin, reduceReadiness, serializeReadiness as baseReadiness, } from '@mnemonik/shared';
import { renderStatusSummaries } from './status.js';
export const serializeInstallReadiness = (input) => serializeReadiness(input);
export function createHttpInstallSessionTransport(accessToken, fetcher = globalThis.fetch, apiUrl = 'https://api.mnemonik.dev') {
    const request = async (path, method, body) => {
        const response = await fetcher(new URL(path, apiUrl), {
            method,
            headers: {
                Authorization: `Bearer ${accessToken}`,
                ...(body ? { 'Content-Type': 'application/json' } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
        if (!response.ok)
            throw new Error(`Install-session ${method} failed: HTTP ${response.status}`);
        return response;
    };
    return {
        getCurrent: async () => (await (await request('/api/v1/install-sessions/current', 'GET')).json()),
        complete: async (id, readiness) => {
            await request(`/api/v1/install-sessions/${encodeURIComponent(id)}/complete`, 'POST', {
                readiness,
            });
        },
    };
}
export async function postCurrentReadiness(accessToken, readiness, fetcher = globalThis.fetch, apiUrl = apiOrigin()) {
    const response = await fetcher(new URL('/api/v1/installations/current/readiness', apiUrl), {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ readiness }),
    });
    if (!response.ok)
        throw new Error(`Install-session POST failed: HTTP ${response.status}`);
}
export async function reportInstall(input, output, transport, json = false) {
    const { steps, ...readinessInput } = input;
    const generatedAt = readinessInput.generatedAt ?? new Date().toISOString();
    const initial = serializeInstallReadiness({ ...readinessInput, generatedAt });
    let installSession = transport
        ? { status: 'report_failed', reason: 'Install session was not read' }
        : { status: 'not_signed_in' };
    let document = serializeReadiness({
        ...readinessInput,
        generatedAt,
        installSession: {
            id: null,
            status: 'not_signed_in',
            kind: null,
            startedAt: null,
            completedAt: null,
        },
    });
    if (transport) {
        try {
            const current = await transport.getCurrent();
            installSession =
                initial.installation.state === 'READY'
                    ? { status: 'completed', id: current.id }
                    : { status: 'not_ready', id: current.id };
            document = serializeReadiness({
                ...readinessInput,
                generatedAt,
                installSession: {
                    id: current.id,
                    status: installSession.status,
                    kind: null,
                    startedAt: null,
                    completedAt: null,
                },
            });
            if (installSession.status === 'completed')
                await transport.complete(current.id, document);
        }
        catch (error) {
            installSession = {
                status: 'report_failed',
                reason: error instanceof Error ? error.message : String(error),
            };
            const uploadFailure = reduceReadiness([
                {
                    kind: 'post_commit_upload_failed',
                    reason: 'The final installation status could not be uploaded.',
                    action: 'Run mnemonik doctor and retry the report.',
                },
            ]);
            document = serializeReadiness({
                ...readinessInput,
                installation: {
                    state: uploadFailure.state,
                    reasons: [...initial.installation.reasons, ...uploadFailure.reasons],
                    actions: [...initial.installation.actions, ...uploadFailure.actions],
                },
                generatedAt,
                installSession: {
                    id: null,
                    status: 'report_failed',
                    kind: null,
                    startedAt: null,
                    completedAt: null,
                },
            });
        }
    }
    if (json)
        output.json(document);
    else {
        renderStatusSummaries(document, output);
        for (const step of steps) {
            const owner = step.owner ? ` (${step.owner})` : '';
            output.line(`  ${step.name}: ${step.status}${owner}${step.action ? ` - ${step.action}` : ''}`);
        }
        output.line(`  Install session: ${installSession.status}`);
        output.line();
        output.line('  Status and devices: https://app.mnemonik.ai/install');
        output.line('  On this machine: mnemonik status');
    }
    return installSession;
}
const serializeReadiness = (input) => devReadiness(baseReadiness(input));
//# sourceMappingURL=installSession.js.map