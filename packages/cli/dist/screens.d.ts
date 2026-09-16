import type { Output } from './output.js';
export interface ChoiceScreen {
    id: 'recommended' | 'account' | 'cli_approval' | 'host_approvals' | 'scanner' | 'apply' | 'cancel' | 'resume';
    title: string;
    lines: string[];
    choices: string[];
    default: number;
    owner?: 'account setup' | 'scanner setup' | 'installation' | 'host setup';
}
export declare const cancelScreen: ChoiceScreen;
export declare const interruptedScreen: ChoiceScreen;
export declare const hostApprovalScreen: (hosts: string[]) => ChoiceScreen;
export declare const finalReviewScreen: (lines: string[], scanner: boolean) => ChoiceScreen;
export declare function renderScreen(screen: ChoiceScreen, output: Output, width?: number): void;
export * from './scanner/discover.js';
export * from './scanner/picker.js';
export { renderJourney } from './screens/journey.js';
//# sourceMappingURL=screens.d.ts.map