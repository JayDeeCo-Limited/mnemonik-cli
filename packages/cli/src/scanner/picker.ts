import { createInterface } from 'node:readline';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { Readable } from 'node:stream';
import type { EnsureOptions, SetupResult } from '@mnemonik/local-setup';
import {
  isProtectedLocalPath,
  protectedLocalPaths,
  protectedPathsWithinRoot,
} from '@mnemonik/shared';
import type { Output } from '../output.js';
import { evaluateRoot } from '../project/eligibility.js';
import {
  classifyRepository,
  discoverRepositories,
  repositoryName,
  repositoryStateLabel,
  type DiscoveredRepository,
  type RepositoryState,
} from './discover.js';

export interface PickerRepository {
  path: string;
  state: RepositoryState;
  selected: boolean;
  nonGitSelected?: true;
}

export interface ScannerPickerResult {
  roots: string[];
  exclusions: string[];
  repositories: PickerRepository[];
}

export type ScannerPickerRunResult =
  | ScannerPickerResult
  | {
      status: 'cancelled';
      reason:
        | 'non_git_not_confirmed'
        | 'selection_limit_back'
        | 'protected_path'
        | 'protected_exclusion_limit'
        | 'filesystem_root'
        | 'home_directory'
        | 'temporary_directory'
        | 'mnemonik_state_directory'
        | 'user_data_directory'
        | 'host_config_directory'
        | 'broad_workspace_parent';
    };

type ScannerPickerCancellation = Extract<ScannerPickerRunResult, { status: 'cancelled' }>;

export interface ScannerConsentDraft {
  roots: string[];
  exclusions: string[];
}

export const SCANNER_SELECTION_LIMIT = 32;
export const SCANNER_SELECTION_LIMIT_MESSAGE =
  'You can leave out up to 32 repositories here. Choose a narrower folder, or watch only this project.';

interface PickerOptions {
  input: Readable;
  output: Output;
  currentProject: string;
  currentFolder: string;
  canonicalizePath?: (path: string) => Promise<string>;
  discover?: typeof discoverRepositories;
  classify?: typeof classifyRepository;
  protectedPaths?: readonly string[];
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
}

function writeChoices(output: Output, currentFolder: string): void {
  output.line('  What should Mnemonik watch?');
  output.line();
  output.line('    1. This project');
  output.line(`  > 2. This folder and everything under it     ${currentFolder}`);
  output.line('    3. Another path');
  output.line();
}

function writeSummary(
  output: Output,
  displayRoot: string,
  canonicalRoot: string,
  rows: PickerRepository[],
  truncated: boolean
): void {
  output.line(`  ${rows.length} repositories under ${displayRoot} will be indexed`);
  for (const row of rows.slice(0, 2)) {
    output.line(
      `    ${repositoryName(canonicalRoot, row.path).padEnd(15)}${repositoryStateLabel(row.state)}`
    );
  }
  if (rows.length > 2) {
    const more = rows.length - 2;
    output.line(`    ...            ${more} more ${more === 1 ? 'repository' : 'repositories'}`);
  }
  output.line();
  output.line('  Repositories up to 3 folders deep are included.');
  if (truncated) output.line('  32 shown; choose a narrower folder to see the rest');
  output.line('  Review the list and choose the ones you want.');
  output.line();
  output.line('  Repositories (all selected)');
  rows.forEach((row, index) =>
    output.line(
      `    ${index + 1}. [x] ${repositoryName(canonicalRoot, row.path)} - ${repositoryStateLabel(row.state)}`
    )
  );
  output.line('  Enter repository numbers to exclude, separated by commas.');
}

const pickRows = (repositories: DiscoveredRepository[]): PickerRepository[] =>
  repositories.map(({ path, state, nonGitSelected }) => ({
    path,
    state,
    selected: true,
    ...(nonGitSelected ? { nonGitSelected } : {}),
  }));

function exclude(answer: string, rows: PickerRepository[]): void {
  const indexes = new Set(
    answer
      .split(',')
      .map((value) => Number(value.trim()) - 1)
      .filter((value) => Number.isInteger(value) && value >= 0 && value < rows.length)
  );
  rows.forEach((row, index) => (row.selected = !indexes.has(index)));
}

export async function runScannerPicker(options: PickerOptions): Promise<ScannerPickerRunResult> {
  const readline = createInterface({ input: options.input, terminal: false });
  const answers = readline[Symbol.asyncIterator]();
  const next = async () => String((await answers.next()).value ?? '').trim();
  const canonicalize = options.canonicalizePath ?? realpath;
  const discover = options.discover ?? discoverRepositories;
  const classify = options.classify ?? classifyRepository;
  const protectedPaths =
    options.protectedPaths ?? protectedLocalPaths(options.platform, options.env, options.home);
  const guardRoot = async (
    candidate: string
  ): Promise<{ root: string; exclusions: string[] } | ScannerPickerCancellation> => {
    if (options.platform !== 'win32' && posix.resolve(candidate) === '/tmp') {
      options.output.error(
        `Refusing ${candidate}: temporary_directory; choose a project folder instead.`
      );
      return { status: 'cancelled', reason: 'temporary_directory' };
    }
    const marker = await lstat(join(candidate, '.git')).catch(() => undefined);
    const repository =
      marker?.isDirectory() || marker?.isFile()
        ? {
            kind: 'git' as const,
            root: candidate,
            commonDir: join(candidate, '.git'),
            isLinkedWorktree: false,
            nested: [],
          }
        : { kind: 'plain' as const, root: candidate };
    const decision = await evaluateRoot(
      {
        kind: 'absent',
        root: candidate,
        repository,
        nested: [],
      },
      {
        cwd: candidate,
        home: options.home,
        platform: options.platform,
        env: options.env,
        nonGitSelected: true,
      }
    );
    if (!decision.allowed) {
      options.output.error(
        `Refusing ${candidate}: ${decision.reason}; choose a project folder instead.`
      );
      return {
        status: 'cancelled',
        reason: decision.reason as ScannerPickerCancellation['reason'],
      };
    }
    const root = decision.root;
    const enclosing = protectedPaths.find((path) =>
      isProtectedLocalPath(root, [path], options.platform)
    );
    if (enclosing) {
      options.output.error(`Refusing ${root}: it is inside protected path ${enclosing}.`);
      return { status: 'cancelled' as const, reason: 'protected_path' as const };
    }
    const exclusions = protectedPathsWithinRoot(root, protectedPaths, options.platform);
    if (exclusions.length > SCANNER_SELECTION_LIMIT) {
      options.output.error('Protected exclusions exceed 32; choose a narrower folder.');
      return { status: 'cancelled' as const, reason: 'protected_exclusion_limit' as const };
    }
    for (const path of exclusions) options.output.line(`  Mnemonik will never read ${path}`);
    return { root, exclusions };
  };
  const loadFolder = async (path: string) => {
    const protectedResult = await guardRoot(path);
    if ('status' in protectedResult) return protectedResult;
    const canonicalRoot = await canonicalize(path);
    const found = await discover(path, {
      canonicalizePath: canonicalize,
      readDirectory: async (directory) =>
        isProtectedLocalPath(directory, protectedPaths, options.platform)
          ? []
          : readdir(directory, { withFileTypes: true }),
    });
    return {
      root: canonicalRoot,
      rows: pickRows(found.repositories),
      autoExclusions: protectedResult.exclusions,
      truncated: found.truncated,
    };
  };
  const confirmNonGit = async (displayPath: string, canonicalRoot: string) => {
    const rootRow = await classify(canonicalRoot, { canonicalizePath: canonicalize });
    if (rootRow.nonGitSelected) {
      options.output.line(
        `  ${displayPath} is not a Git repository. Index this folder anyway? [yes/no]`
      );
      if ((await next()).toLowerCase() !== 'yes') return undefined;
    }
    return rootRow;
  };
  try {
    writeChoices(options.output, options.currentFolder);
    const choice = (await next()) || '2';
    let displayRoot: string;
    let rows: PickerRepository[];
    let root: string;
    let autoExclusions: string[];
    let truncated: boolean;

    if (choice === '1') {
      displayRoot = options.currentProject;
      const protectedResult = await guardRoot(options.currentProject);
      if ('status' in protectedResult) return protectedResult;
      root = await canonicalize(options.currentProject);
      autoExclusions = protectedResult.exclusions;
      truncated = false;
      const row = await classify(root, { canonicalizePath: canonicalize });
      root = row.path;
      rows = pickRows([row]);
    } else {
      displayRoot = choice === '3' ? await next() : options.currentFolder;
      const loaded = await loadFolder(displayRoot);
      if ('status' in loaded) return loaded;
      ({ root, rows, autoExclusions, truncated } = loaded);
      if (choice === '3') {
        const rootRow = await confirmNonGit(displayRoot, root);
        if (!rootRow) return { status: 'cancelled', reason: 'non_git_not_confirmed' };
        if (rows.length === 0) rows = pickRows([rootRow]);
      }
    }

    while (true) {
      writeSummary(options.output, displayRoot, root, rows, truncated);
      exclude(await next(), rows);
      const exclusions = [
        ...new Set([
          ...autoExclusions,
          ...rows.filter((row) => !row.selected).map((row) => row.path),
        ]),
      ];
      if (exclusions.length <= SCANNER_SELECTION_LIMIT) {
        return { roots: [root], exclusions, repositories: rows };
      }
      options.output.line(`  ${SCANNER_SELECTION_LIMIT_MESSAGE}`);
      options.output.line('    1. Choose a narrower folder');
      options.output.line('    2. Watch only this project');
      options.output.line('    3. Back');
      const limitChoice = await next();
      if (limitChoice === '2') {
        const protectedResult = await guardRoot(options.currentProject);
        if ('status' in protectedResult) return protectedResult;
        const currentRoot = await canonicalize(options.currentProject);
        const row = await classify(currentRoot, { canonicalizePath: canonicalize });
        return {
          roots: [row.path],
          exclusions: protectedResult.exclusions,
          repositories: pickRows([row]),
        };
      }
      if (limitChoice !== '1') {
        return { status: 'cancelled', reason: 'selection_limit_back' };
      }
      options.output.line('  Narrower folder:');
      displayRoot = await next();
      const loaded = await loadFolder(displayRoot);
      if ('status' in loaded) return loaded;
      ({ root, rows, autoExclusions, truncated } = loaded);
      const rootRow = await confirmNonGit(displayRoot, root);
      if (!rootRow) return { status: 'cancelled', reason: 'non_git_not_confirmed' };
      if (rows.length === 0) rows = pickRows([rootRow]);
    }
  } finally {
    readline.close();
  }
}

export function consentDraft(picked: ScannerPickerResult): ScannerConsentDraft {
  if (
    picked.roots.length > SCANNER_SELECTION_LIMIT ||
    picked.exclusions.length > SCANNER_SELECTION_LIMIT
  ) {
    throw new RangeError(SCANNER_SELECTION_LIMIT_MESSAGE);
  }
  return { roots: picked.roots, exclusions: picked.exclusions };
}

export const scannerRootsParameter = (picked: ScannerPickerResult): string =>
  JSON.stringify(consentDraft(picked));

type StageExecutor = { stage(options: EnsureOptions): Promise<SetupResult> };
export interface ScannerReviewHandoff {
  staged: Array<{ path: string; result: SetupResult }>;
  actionRequired: Array<{ path: string; result: SetupResult }>;
}

export async function reviewScannerProjects(
  picked: ScannerPickerResult,
  executor: StageExecutor,
  output?: Output
): Promise<ScannerReviewHandoff> {
  const handoff: ScannerReviewHandoff = { staged: [], actionRequired: [] };
  for (const repository of picked.repositories.filter((row) => row.selected)) {
    const result = await executor.stage({
      cwd: repository.path,
      allowCreate: true,
      allowNestedInherit: false,
      ...(repository.nonGitSelected ? { nonGitSelected: true } : {}),
    });
    if (result.status === 'staged') handoff.staged.push({ path: repository.path, result });
    else handoff.actionRequired.push({ path: repository.path, result });
    output?.line(`${repository.path}  ${result.status}`);
  }
  return handoff;
}

export function renderScannerStatus(status: ScannerPickerResult, output: Output): void {
  for (const repository of status.repositories) {
    const label = repositoryStateLabel(repository.state);
    output.line(
      repository.state === 'not_set_up'
        ? `${repository.path}  ${label} - mnemonik project init ${repository.path}`
        : `${repository.path}  ${label}`
    );
  }
}
