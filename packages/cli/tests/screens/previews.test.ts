import { mkdir, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { expect, it } from 'vitest';
import { browserFallbackLines, signedInPage } from '../../src/auth/pkce.js';
import { Output } from '../../src/output.js';
import { nodeVersionHelp } from '../../src/preflight.js';
import { connectedProjectsMessage, projectLimitMessage } from '../../src/project.js';
import { SCANNER_APPROVAL_WAIT } from '../../src/scanner/enable.js';
import { scannerBoundaryPrompt } from '../../src/scanner/picker.js';
import {
  connectedFolderLine,
  connectFolderPrompt,
  removedFolderLine,
  removeFolderPrompt,
} from '../../src/router.js';
import { renderStatusSummaries } from '../../src/status.js';
import { serializeReadiness } from '@mnemonik/shared';
import {
  completedLine,
  completedStep,
  journeyAnswers,
  renderCustomize,
  renderJourney,
} from '../../src/screens/journey.js';

const previewDirectory = '/tmp/previews';

function capture() {
  let text = '';
  return {
    output: new Output({ write: (chunk) => void (text += chunk) }),
    text: () => text,
  };
}

it('renders the W3 owner previews from the production screen code', async () => {
  const normal = capture();
  normal.output.line(completedStep(1, 'Recommended setup selected'));
  renderJourney('account', normal.output);
  for (const line of browserFallbackLines('https://auth.mnemonik.ai/oauth/authorize?...'))
    normal.output.line(line);
  normal.output.line(completedLine('Signed in'));
  normal.output.line(completedStep(3, 'Configure editors'));
  normal.output.line(completedLine('2 editors configured'));
  renderJourney('scanner', normal.output);
  normal.output.line(scannerBoundaryPrompt('~/Projects'));
  for (const line of browserFallbackLines('https://auth.mnemonik.ai/approve?...'))
    normal.output.line(line);
  normal.output.line(completedStep(5, 'Finish'));
  normal.output.line(
    connectedProjectsMessage(['/Projects/app', '/Projects/shop', '/Projects/api'])
  );
  renderJourney('done', normal.output);
  expect(normal.text().split('\n').filter(Boolean)).toHaveLength(15);
  expect(normal.text().indexOf(scannerBoundaryPrompt('~/Projects'))).toBeLessThan(
    normal.text().indexOf('https://auth.mnemonik.ai/approve?...')
  );

  const choice = capture();
  renderJourney('recommended', choice.output, {
    hosts: ['Claude Code', 'Codex'],
    project: '~/Projects',
    node: '24.21.0',
    os: 'macOS',
  });

  const customize = capture();
  renderCustomize(
    [
      { value: 'claude-code', label: 'Claude Code', checked: true },
      { value: 'codex', label: 'Codex', checked: true },
      { value: 'scanner', label: 'Indexing of your projects', checked: true },
    ],
    customize.output
  );

  const cancelled = capture();
  const answers = journeyAnswers(Readable.from([]), cancelled.output);
  await answers.choose(['Recommended', 'Customize']);
  answers.close();

  const limit = projectLimitMessage(
    {
      status: 'ACTION_REQUIRED',
      state: 'project_limit_reached',
      allowedActions: ['upgrade', 'cancel'],
      used: 1,
      limit: 1,
      tier: 'free',
      existingProjectNames: ['app'],
    },
    ['/Projects/shop', '/Projects/docs', '/Projects/api']
  );

  const status = capture();
  renderStatusSummaries(
    serializeReadiness({
      installation: { conditions: [] },
      scanner: {
        roots: ['/Projects/app', '/Projects/site', '/Projects/api'],
        heartbeatAt: new Date(0).toISOString(),
        version: 'preview',
        readiness: null,
        acceptedDisclosureVersion: 'preview',
      },
    }),
    status.output
  );

  const statusAttention = capture();
  renderStatusSummaries(
    serializeReadiness({
      installation: {
        conditions: [{ kind: 'hook_not_verified', reason: 'hook_not_verified' }],
      },
    }),
    statusAttention.output
  );

  const preview = [
    '=== Normal install, finished transcript (15 lines) ===',
    normal.text().trimEnd(),
    '',
    '=== Choice screen ===',
    choice.text().trimEnd(),
    '',
    '=== Customize ===',
    customize.text().trimEnd(),
    '',
    '=== Cancel ===',
    cancelled.text().trimEnd(),
    '',
    '=== Node gate, macOS ===',
    ...nodeVersionHelp('22.20.0', 'darwin'),
    '',
    '=== Indexing approval waiting ===',
    SCANNER_APPROVAL_WAIT,
    '',
    '=== Free-plan limit, several skipped ===',
    connectedProjectsMessage(['/Projects/app']),
    ...(limit ?? []),
    '',
    '=== Add a folder ===',
    connectFolderPrompt('shop'),
    connectedFolderLine('shop'),
    '',
    '=== Remove a folder ===',
    removeFolderPrompt('shop'),
    removedFolderLine('shop'),
    '',
    '=== Status ===',
    status.text().trimEnd(),
    '',
    '=== Status when something needs attention ===',
    statusAttention.text().trimEnd(),
    '',
  ].join('\n');

  expect(preview).not.toMatch(/sha256|\/Users\/|\/home\//u);
  expect(statusAttention.text()).not.toContain('hook_not_verified');
  await mkdir(previewDirectory, { recursive: true });
  await Promise.all([
    writeFile(`${previewDirectory}/w3-install.txt`, preview),
    writeFile(`${previewDirectory}/w3-signed-in.html`, signedInPage),
  ]);
});
