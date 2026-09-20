import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { expect, it } from 'vitest';
import { DEVICE_WARNING, runDeviceFlow } from '../../src/auth/device.js';
import { browserFallbackLines } from '../../src/auth/pkce.js';
import { Output } from '../../src/output.js';
import { nodeVersionHelp } from '../../src/preflight.js';
import { connectedProjectsMessage, projectLimitMessage } from '../../src/project.js';
import { bootstrapProgress } from '../../src/runtime/bootstrap.js';
import { SCANNER_APPROVAL_WAIT } from '../../src/scanner/enable.js';
import { runScannerBoundaryPicker, scannerBoundaryPrompt } from '../../src/scanner/picker.js';
import {
  runCli,
  connectedFolderLine,
  connectFolderPrompt,
  removedFolderLine,
  removeFolderPrompt,
} from '../../src/router.js';
import { renderStatusSummaries } from '../../src/status.js';
import { serializeReadiness } from '@mnemonik/shared';
import {
  ADD_ANOTHER_FOLDER,
  completedLine,
  completedStep,
  INSTALLATION_STOPPED,
  journeyAnswers,
  renderCustomize,
  renderInterrupted,
  renderJourney,
  renderRollbackResult,
  stepProgress,
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
  await writeFile(`${previewDirectory}/w3-install.txt`, preview);
});

it('renders the L-60 to L-64 wording from production code', async () => {
  const interrupted = capture();
  renderInterrupted(interrupted.output);
  const rollback = capture();
  renderRollbackResult(true, rollback.output);
  const rollbackNeedsAction = capture();
  renderRollbackResult(false, rollbackNeedsAction.output);

  const home = await mkdtemp(join(tmpdir(), 'mnemonik-day-words-preview-'));
  const missing = join(home, 'missing');
  const closed = join(home, 'closed');
  const empty = join(home, 'empty');
  const privateFolder = join(home, 'private');
  const projects = join(home, 'Projects');
  await mkdir(empty);
  await mkdir(privateFolder);
  await mkdir(projects);
  const repositories = Array.from({ length: 200 }, (_, index) => ({
    path: join(projects, `project-${index + 1}`),
    state: 'not_set_up' as const,
  }));
  const renderFolderChoice = async (
    first: string,
    issue: 'empty' | 'missing' | 'closed' | 'protected' | 'unusable',
    omitted = 0
  ) => {
    const screen = capture();
    await runScannerBoundaryPicker({
      input: Readable.from(`${first}\n${projects}\n`),
      output: new Output({ write: (chunk) => screen.output.write(chunk) }, undefined, { home }),
      currentProject: home,
      currentFolder: home,
      home,
      protectedPaths: issue === 'protected' ? [privateFolder] : [],
      canonicalizePath: async (path) => {
        if (path === first && issue === 'missing')
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        if (path === first && issue === 'closed')
          throw Object.assign(new Error('closed'), { code: 'EACCES' });
        return path;
      },
      discover: async (path) => ({
        status: 'complete',
        displayRoot: path,
        root: path,
        directoriesVisited: path === empty ? 1 : 300,
        repositories: path === empty ? [] : repositories,
        truncated: omitted > 0,
        omitted,
      }),
    });
    return screen.text().trimEnd();
  };
  const folderHome = await renderFolderChoice(home, 'unusable');
  const folderRoot = await renderFolderChoice('/', 'unusable');
  const folderClosed = await renderFolderChoice(closed, 'closed');
  const folderUnusable = await renderFolderChoice(tmpdir(), 'unusable');
  const folderProtected = await renderFolderChoice(privateFolder, 'protected');
  const folderMissing = await renderFolderChoice(missing, 'missing');
  const folderEmpty = await renderFolderChoice(empty, 'empty');
  const folderOmittedOne = capture();
  const folderOmittedMany = capture();
  try {
    for (const [screen, omitted] of [
      [folderOmittedOne, 1],
      [folderOmittedMany, 100],
    ] as const)
      await runScannerBoundaryPicker({
        input: Readable.from(`${projects}\n`),
        output: new Output({ write: (chunk) => screen.output.write(chunk) }, undefined, { home }),
        currentProject: home,
        currentFolder: home,
        home,
        protectedPaths: [],
        canonicalizePath: async (path) => path,
        discover: async (path) => ({
          status: 'complete',
          displayRoot: path,
          root: path,
          directoriesVisited: 300,
          repositories,
          truncated: true,
          omitted,
        }),
      });
  } finally {
    await rm(home, { recursive: true, force: true });
  }

  const noTerminalScreens = await Promise.all(
    [[], ['--without-scanner'], ['--accept-indexing'], ['--accept-indexing', '--apply']].map(
      async (flags) => {
        const screen = capture();
        await runCli(['install', ...flags], {
          input: Readable.from([]),
          stdout: { write: (chunk) => screen.output.write(chunk) },
          stderr: { write: (chunk) => screen.output.write(chunk) },
        });
        return screen.text().trimEnd();
      }
    )
  );

  const indexingSkipped = capture();
  renderJourney('indexing_skipped', indexingSkipped.output);
  const indexingOnly = capture();
  renderJourney('indexing', indexingOnly.output);
  const indexingDone = capture();
  renderJourney('indexing_done', indexingDone.output);
  const indexingProgress = capture();
  const checkingAccount = stepProgress(indexingProgress.output, false, 'Checking your account');
  checkingAccount.complete(completedLine('Account checked'));
  const gettingReady = stepProgress(indexingProgress.output, false, 'Getting ready');
  gettingReady.complete(completedLine('Ready'));
  const anotherFolder = capture();
  anotherFolder.output.line(completedLine('Repositories connected'));
  anotherFolder.output.line(`  ${ADD_ANOTHER_FOLDER}`);

  const preview = [
    '=== When a previous installation was interrupted ===',
    interrupted.text().trimEnd(),
    '',
    '=== After Rollback succeeds ===',
    rollback.text().trimEnd(),
    '',
    '=== When Rollback needs to be finished ===',
    rollbackNeedsAction.text().trimEnd(),
    '',
    '=== When the home folder is entered as the projects folder ===',
    folderHome,
    '',
    '=== When the whole computer is entered as the projects folder ===',
    folderRoot,
    '',
    '=== When the projects folder cannot be opened ===',
    folderClosed,
    '',
    '=== When the projects folder cannot be used ===',
    folderUnusable,
    '',
    '=== When the projects folder cannot be read ===',
    folderProtected,
    '',
    '=== When the projects folder does not exist ===',
    folderMissing,
    '',
    '=== When the projects folder has no repositories ===',
    folderEmpty,
    '',
    '=== When one repository is left out of the projects list ===',
    folderOmittedOne.text().trimEnd(),
    '',
    '=== When 100 repositories are left out of the projects list ===',
    folderOmittedMany.text().trimEnd(),
    '',
    '=== When install has no terminal and --accept-indexing is missing ===',
    noTerminalScreens[0],
    '',
    '=== When install has no terminal and --accept-limited is missing ===',
    noTerminalScreens[1],
    '',
    '=== When install has no terminal and --apply is missing ===',
    noTerminalScreens[2],
    '',
    '=== When install has no terminal and --scan-roots is missing ===',
    noTerminalScreens[3],
    '',
    '=== When installation finishes after indexing was unticked ===',
    indexingSkipped.text().trimEnd(),
    '',
    '=== When install is run again after indexing was skipped ===',
    indexingOnly.text().trimEnd(),
    '',
    '=== During the indexing-only run ===',
    indexingProgress.text().trimEnd(),
    '',
    '=== When the indexing-only run finishes ===',
    indexingDone.text().trimEnd(),
    '',
    '=== After repositories are connected ===',
    anotherFolder.text().trimEnd(),
    '',
  ].join('\n');

  expect(preview).not.toContain(home);
  await mkdir(previewDirectory, { recursive: true });
  await writeFile(`${previewDirectory}/day-cli-words.txt`, preview);
});

it('renders the night interaction screens from production code', async () => {
  const bootstrap = capture();
  bootstrapProgress({ write: (chunk) => bootstrap.output.write(chunk) }, false).stop();
  const progress = capture();
  const signingIn = stepProgress(progress.output, false, 'Signing in');
  signingIn.complete(completedLine('Signed in'));
  const configuring = stepProgress(progress.output, false, 'Configuring your editors');
  configuring.complete(completedLine('2 editors configured'));

  const localSignIn = capture();
  const opened: string[] = [];
  await runDeviceFlow({
    issuer: 'https://auth.mnemonik.ai',
    resource: 'https://api.mnemonik.dev/',
    scopes: ['openid'],
    clientId: 'preview-client',
    deviceName: 'Preview computer',
    print: (line) => localSignIn.output.line(line),
    openBrowser: async (url) => void opened.push(url),
    fetch: async (url) =>
      String(url).endsWith('/oauth/device_authorization')
        ? Response.json({
            device_code: 'local-device-code',
            user_code: 'BCDF-GHJK',
            expires_in: 600,
            interval: 5,
            verification_uri: 'https://auth.mnemonik.ai/oauth/device',
            verification_uri_complete: 'https://auth.mnemonik.ai/oauth/device?user_code=BCDF-GHJK',
          })
        : Response.json({
            access_token: 'preview-access',
            refresh_token: 'preview-refresh',
            expires_in: 3600,
            scope: 'openid',
          }),
    sleep: async () => undefined,
  });
  expect(opened).toEqual(['https://auth.mnemonik.ai/oauth/device?user_code=BCDF-GHJK']);

  const remoteSignIn = capture();
  let now = 0;
  const first = {
    device_code: 'first-device-code',
    user_code: 'BCDF-GHJK',
    expires_in: 600,
    interval: 5,
    verification_uri: 'https://auth.mnemonik.ai/oauth/device',
    verification_uri_complete: 'https://auth.mnemonik.ai/oauth/device?user_code=BCDF-GHJK',
  };
  const second = {
    ...first,
    device_code: 'second-device-code',
    user_code: 'JKLM-NPQR',
    verification_uri_complete: 'https://auth.mnemonik.ai/oauth/device?user_code=JKLM-NPQR',
  };
  const responses = [
    Response.json(first),
    Response.json({ error: 'expired_token' }, { status: 400 }),
    Response.json(second),
    Response.json({
      access_token: 'preview-access',
      refresh_token: 'preview-refresh',
      expires_in: 3600,
      scope: 'openid',
    }),
  ];
  await runDeviceFlow({
    issuer: 'https://auth.mnemonik.ai',
    resource: 'https://api.mnemonik.dev/',
    scopes: ['openid'],
    clientId: 'preview-client',
    deviceName: 'Preview computer',
    print: (line) => remoteSignIn.output.line(line),
    fetch: async () => responses.shift()!,
    now: () => now,
    sleep: async (milliseconds) => void (now += milliseconds),
  });
  expect(localSignIn.text()).toContain(DEVICE_WARNING);
  expect(remoteSignIn.text()).toContain(DEVICE_WARNING);

  const home = await mkdtemp(join(tmpdir(), 'mnemonik-night-preview-'));
  const boundary = join(home, 'Projects');
  await mkdir(join(boundary, 'app', '.git'), { recursive: true });
  const folder = capture();
  try {
    await runScannerBoundaryPicker({
      input: Readable.from(`${home}\n${boundary}\n`),
      output: new Output({ write: (chunk) => folder.output.write(chunk) }, undefined, { home }),
      currentProject: home,
      currentFolder: home,
      home,
      protectedPaths: [],
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }

  const preview = [
    '=== Cold start in a non-interactive terminal ===',
    bootstrap.text().trimEnd(),
    '',
    '=== Long steps in a non-interactive terminal ===',
    progress.text().trimEnd(),
    '',
    '=== Local sign-in (browser opens automatically) ===',
    localSignIn.text().trimEnd(),
    '',
    '=== Remote sign-in (open the printed link; expired request restarts once) ===',
    remoteSignIn.text().trimEnd(),
    '',
    '=== Project folder guess and retry ===',
    folder.text().trimEnd(),
    '',
    '=== Interrupted installation ===',
    INSTALLATION_STOPPED,
    '',
  ].join('\n');
  expect(preview).not.toContain(home);
  await mkdir(previewDirectory, { recursive: true });
  await writeFile(`${previewDirectory}/night-interaction.txt`, preview);
});
