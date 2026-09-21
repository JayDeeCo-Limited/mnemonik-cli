import type { Readable } from 'node:stream';
import type { EnsureOptions, SetupResult } from '@mnemonik/local-setup';
import type { Output } from '../output.js';
import { classifyRepository, discoverRepositories, type ScannerCandidate, type RepositoryState } from './discover.js';
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
    boundary?: string;
    candidates?: ScannerCandidate[];
}
export type ScannerPickerRunResult = ScannerPickerResult | {
    status: 'cancelled';
    reason: 'non_git_not_confirmed' | 'selection_limit_back' | 'protected_path' | 'protected_exclusion_limit' | 'filesystem_root' | 'home_directory' | 'temporary_directory' | 'mnemonik_state_directory' | 'user_data_directory' | 'host_config_directory' | 'broad_workspace_parent';
};
export interface ScannerConsentDraft {
    roots: string[];
    exclusions: string[];
    candidates?: ScannerCandidate[];
    boundary?: string;
}
export declare const SCANNER_SELECTION_LIMIT = 32;
export declare const SCANNER_SELECTION_LIMIT_MESSAGE = "You can leave out up to 32 repositories here. Choose a narrower folder, or watch only this project.";
export declare const scannerBoundaryPrompt: (shown: string) => string;
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
    readAnswer?: () => Promise<string | undefined>;
}
export declare function runScannerBoundaryPicker(options: PickerOptions): Promise<ScannerPickerResult>;
export declare function runScannerPicker(options: PickerOptions): Promise<ScannerPickerRunResult>;
export declare function consentDraft(picked: ScannerPickerResult): ScannerConsentDraft;
export declare const scannerRootsParameter: (picked: ScannerPickerResult) => string;
type StageExecutor = {
    stage(options: EnsureOptions): Promise<SetupResult>;
};
export interface ScannerReviewHandoff {
    staged: Array<{
        path: string;
        result: SetupResult;
    }>;
    actionRequired: Array<{
        path: string;
        result: SetupResult;
    }>;
}
export declare function reviewScannerProjects(picked: ScannerPickerResult, executor: StageExecutor, output?: Output): Promise<ScannerReviewHandoff>;
export declare function renderScannerStatus(status: ScannerPickerResult, output: Output): void;
export {};
//# sourceMappingURL=picker.d.ts.map