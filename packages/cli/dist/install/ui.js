import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { stateDirectory } from '@mnemonik/local-setup';
import { cancelScreen, finalReviewScreen, hostApprovalScreen, interruptedScreen, renderScreen, } from '../screens.js';
import { hostOrder, SimulatedHostAdapter } from './adapters.js';
export function terminalInstallUI(input, output, roots) {
    const readline = createInterface({
        input,
        terminal: Boolean(input.isTTY),
    });
    const answers = readline[Symbol.asyncIterator]();
    const controller = new AbortController();
    readline.on('SIGINT', () => controller.abort());
    const ask = async (screen) => {
        renderScreen(screen, output);
        const answer = await new Promise((resolve) => {
            const interrupt = () => resolve('\u0003');
            readline.once('SIGINT', interrupt);
            void answers.next().then((result) => {
                readline.off('SIGINT', interrupt);
                resolve(result.done ? 'Cancel' : result.value);
            });
        });
        if (answer.includes('\u0003') || answer === 'Cancel')
            return -1;
        const index = answer.trim() ? Number(answer) - 1 : screen.default;
        return Number.isInteger(index) && index >= 0 && index < screen.choices.length ? index : -1;
    };
    const ui = {
        batch: async (hosts) => (await ask(hostApprovalScreen(hostOrder.filter((h) => hosts.includes(h))))) === 0
            ? 'connect'
            : 'cancel',
        waiting: (host) => output.line(host.startsWith('scanner ')
            ? `Waiting for ${host}, up to ${host === 'scanner heartbeat' ? '1 minute' : '2 minutes'}.`
            : `Waiting for ${host} to accept the connection, up to 2 minutes.`),
        timeout: async (host) => {
            const answer = await ask({
                id: 'host_approvals',
                title: `${host} did not connect`,
                lines: [
                    host.startsWith('scanner ')
                        ? `Retry waits again for ${host}. Skip keeps scanner coverage LIMITED.`
                        : 'Retry starts a new two-minute timer for this editor.',
                ],
                choices: ['Retry', 'Skip', 'Cancel'],
                default: 0,
            });
            return answer === 0 ? 'retry' : answer === 1 ? 'skip' : 'cancel';
        },
        roots,
        consent: async (fields) => (await ask({
            id: 'scanner',
            title: 'Scanner disclosure',
            lines: [
                `Account: ${fields.account}`,
                `Disclosure: ${fields.disclosureVersion}`,
                `Roots: ${fields.roots.join(', ')}`,
                `Exclusions: ${fields.exclusions.join(', ')}`,
                'The scanner reads and uploads approved source files after Apply.',
            ],
            choices: ['Accept disclosure', 'Cancel'],
            default: 1,
        })) === 0,
        review: async (journal) => {
            const d = journal.data;
            const choice = await ask(finalReviewScreen([
                `Components: ${d.components.join(', ')}`,
                ...d.hosts.map((h) => `${h}: ${d.scopes[h]?.requested} -> ${d.scopes[h]?.effective}`),
                ...d.targets.filter((t) => t.status !== 'restored').map((t) => `${t.kind}: ${t.path}`),
                ...d.projects.map((p) => `Project: ${p.root} ${p.uuid ?? 'setup required'}`),
                `Roots: ${d.roots.join(', ')}`,
                'First upload: waiting for Apply',
                ...d.credentials.map((c) => `Credential reference: ${c.reference}`),
                ...d.reports,
            ], d.components.includes('scanner')));
            return choice === 0 ? 'apply' : choice === 1 ? 'back' : 'cancel';
        },
        cancel: async () => ((await ask(cancelScreen)) === 1 ? 'keep-cli' : 'revoke'),
        recovery: async (reports) => (await ask({ ...interruptedScreen, lines: reports })) === 0 ? 'resume' : 'rollback',
    };
    return { ui, signal: controller.signal, close: () => readline.close() };
}
/** Explicit simulation: all declarations stay under state/install-simulation. */
export function simulatedInstall(state = stateDirectory()) {
    const account = 'simulated-account';
    const adapters = hostOrder.map((name) => {
        const adapter = new SimulatedHostAdapter(name, {
            path: join(state, 'install-simulation', `${name}.json`),
            content: Buffer.from('{"mnemonik":"https://api.mnemonik.dev/mcp"}\n'),
            staging: 'inactive',
            requestedScope: 'user',
            effectiveScope: 'user',
            version: 'simulated',
            artifactDigest: 'simulated',
        });
        adapter.grant = { id: `simulated-${name}`, account, scopes: ['mcp'] };
        return adapter;
    });
    return {
        stateDir: state,
        adapters,
        input: {
            account,
            components: ['mcp'],
            hosts: [...hostOrder],
            roots: [],
            scopes: {},
            credentials: [],
        },
        roots: async () => ({
            account,
            disclosureVersion: 'simulation-no-scanner',
            picked: { roots: [], exclusions: [], repositories: [] },
        }),
        executor: {
            stage: async () => {
                throw new Error('Simulation has no projects');
            },
            apply: async () => {
                throw new Error('Simulation has no projects');
            },
            rollback: async () => {
                throw new Error('Simulation has no projects');
            },
        },
        revokeCli: async () => { },
        revokeComponent: async () => true,
    };
}
export async function chooseHostProfile(input, output, profiles) {
    output.line('Choose the host profile to change:');
    profiles.forEach((profile, index) => output.line(`${index + 1}. ${profile}`));
    const reader = createInterface({ input });
    try {
        const answer = await reader[Symbol.asyncIterator]().next();
        if (answer.done)
            return undefined;
        return profiles[Number(answer.value.trim()) - 1];
    }
    finally {
        reader.close();
    }
}
//# sourceMappingURL=ui.js.map