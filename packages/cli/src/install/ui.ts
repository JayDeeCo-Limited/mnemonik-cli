import type { Readable } from 'node:stream';
import { join } from 'node:path';
import { stateDirectory } from '@mnemonik/local-setup';
import type { Output } from '../output.js';
import {
  cancelScreen,
  finalReviewScreen,
  interruptedScreen,
  renderScreen,
  type ChoiceScreen,
} from '../screens.js';
import { journeyAnswers } from '../screens/journey.js';
import { hostOrder, SimulatedHostAdapter } from './adapters.js';
import type { InstallDependencies, InstallUI } from './transaction.js';

export function terminalInstallUI(
  input: Readable,
  output: Output,
  roots: InstallUI['roots']
): { ui: InstallUI; signal: AbortSignal; close(): void } {
  const answers = journeyAnswers(input, output);
  const controller = new AbortController();
  input.on('SIGINT', () => controller.abort());
  const ask = async (screen: ChoiceScreen) => {
    renderScreen(screen, output);
    const answer = await answers.choose(screen.choices, screen.default);
    return !answer || answer === 'Cancel' ? -1 : screen.choices.indexOf(answer);
  };
  const ui: InstallUI = {
    waiting: (host) =>
      output.line(
        `Waiting for ${host}, up to ${host === 'scanner heartbeat' ? '1 minute' : '2 minutes'}.`
      ),
    timeout: async (host) => {
      const answer = await ask({
        id: 'scanner',
        title: `${host} did not connect`,
        lines: [`Retry waits again for ${host}. Skip keeps scanner coverage LIMITED.`],
        choices: ['Retry', 'Skip', 'Cancel'],
        default: 0,
      });
      return answer === 0 ? 'retry' : answer === 1 ? 'skip' : 'cancel';
    },
    roots,
    consent: async (fields) =>
      (await ask({
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
      const choice = await ask(
        finalReviewScreen(
          [
            `Components: ${d.components.join(', ')}`,
            ...d.hosts.map((h) => `${h}: ${d.scopes[h]?.requested} -> ${d.scopes[h]?.effective}`),
            ...d.targets.filter((t) => t.status !== 'restored').map((t) => `${t.kind}: ${t.path}`),
            ...d.projects.map((p) => `Project: ${p.root} ${p.uuid ?? 'setup required'}`),
            `Roots: ${d.roots.join(', ')}`,
            'First upload: waiting for Apply',
            ...d.credentials.map((c) => `Credential reference: ${c.reference}`),
            ...d.reports,
          ],
          d.components.includes('scanner')
        )
      );
      return choice === 0 ? 'apply' : choice === 1 ? 'back' : 'cancel';
    },
    cancel: async () => ((await ask(cancelScreen)) === 1 ? 'keep-cli' : 'revoke'),
    recovery: async (reports) =>
      (await ask({ ...interruptedScreen, lines: reports })) === 0 ? 'resume' : 'rollback',
  };
  return { ui, signal: controller.signal, close: () => answers.close() };
}

/** Explicit simulation: all declarations stay under state/install-simulation. */
export function simulatedInstall(
  state = stateDirectory()
): Omit<InstallDependencies, 'ui'> & { roots: InstallUI['roots'] } {
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
    revokeCli: async () => {},
    revokeComponent: async () => true,
  };
}

export async function chooseHostProfile(
  input: Readable,
  output: Output,
  profiles: string[]
): Promise<string | undefined> {
  output.line('Choose the host profile to change:');
  output.line('Use the Up/Down arrow keys and Enter.');
  profiles.forEach((profile, index) => output.line(`${index === 0 ? '>' : ' '} ${profile}`));
  const answers = journeyAnswers(input, output);
  try {
    const answer = await answers.choose(profiles);
    return answer === 'Cancel' ? undefined : answer;
  } finally {
    answers.close();
  }
}
