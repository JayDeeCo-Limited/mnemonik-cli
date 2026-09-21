import type { Output } from './output.js';

export interface ChoiceScreen {
  id: 'account' | 'scanner' | 'apply' | 'cancel' | 'resume';
  title: string;
  lines: string[];
  choices: string[];
  default: number;
  owner?: 'account setup' | 'scanner setup' | 'installation' | 'host setup';
}

export const cancelScreen: ChoiceScreen = {
  id: 'cancel',
  title: 'Cancel installation?',
  lines: ['Staged local changes are undone in either case.'],
  choices: ['Revoke everything from this run', 'Keep the CLI sign-in only'],
  default: 0,
  owner: 'installation',
};

export const interruptedScreen: ChoiceScreen = {
  id: 'resume',
  title: 'Previous installation was interrupted',
  lines: ['The identity record can be resumed or rolled back without changing host files.'],
  choices: ['Resume', 'Rollback'],
  default: 0,
  owner: 'installation',
};

export const finalReviewScreen = (lines: string[], scanner: boolean): ChoiceScreen => ({
  id: 'apply',
  title: 'Ready to install',
  lines: [
    ...lines,
    'Existing files are backed up and restored if local rollback succeeds.',
    'Remote projects may remain. Uploaded data requires separate deletion.',
  ],
  choices: [scanner ? 'Install and upload' : 'Install in Limited Mode', 'Back', 'Cancel'],
  default: 0,
});

function wrap(text: string, width: number): string[] {
  const limit = Math.max(20, width - 4);
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current && current.length + word.length + 1 > limit) {
      lines.push(current);
      current = word;
    } else current += `${current ? ' ' : ''}${word}`;
  }
  if (current) lines.push(current);
  return lines;
}

export function renderScreen(screen: ChoiceScreen, output: Output, width = 80): void {
  output.line(`  ${screen.title}`);
  output.line();
  for (const line of screen.lines) for (const part of wrap(line, width)) output.line(`    ${part}`);
  if (screen.lines.length) output.line();
  output.line('  Use the Up/Down arrow keys and Enter.');
  output.line();
  screen.choices.forEach((choice, index) => {
    const marker = index === screen.default ? '>' : ' ';
    output.line(`  ${marker} ${index + 1}. ${choice}`);
  });
  output.line();
}

export * from './scanner/discover.js';
export * from './scanner/picker.js';

export {
  INSTALLATION_STOPPED,
  journeyAnswers,
  renderSetup,
  renderJourney,
  stepProgress,
} from './screens/journey.js';
