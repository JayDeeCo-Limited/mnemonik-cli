import { createInterface, emitKeypressEvents, type Key } from 'node:readline';
import type { Readable } from 'node:stream';
import type { Output } from '../output.js';
import { DEVICE_APPROVAL_INSTRUCTION } from '../auth/device.js';

export interface JourneyValues {
  total?: number | null;
  completed?: number | null;
  skipped?: string;
  remaining?: number;
  reason?: string;
  hosts?: readonly ('claude-code' | 'codex' | 'cursor')[];
}

export interface SetupItem {
  value: string;
  label: string;
  checked: boolean;
}

export const completedStep = (step: number, text: string): string => `Step ${step} of 5: ${text}`;
export const completedLine = (text: string): string => `  ✓ ${text}`;
export const INSTALLATION_STOPPED = 'Installation stopped.';
export const ADD_ANOTHER_FOLDER = 'To connect a folder somewhere else, run mnemonik add <folder>.';

export const stepProgress = (output: Output, interactive: boolean, text: string) =>
  output.progressLine(interactive ? text : `  ${text}`, interactive);

function setupLines(items: SetupItem[], cursor = 0): string[] {
  return [
    'Step 1 of 5: Choose what to set up',
    '  These editors were found on this computer. Untick any you do not want.',
    '  Use the Up/Down arrow keys to move, Space to select, Enter to continue.',
    '',
    ...items.map(
      (item, index) =>
        `  ${index === cursor ? '>' : ' '} [${item.checked ? 'x' : ' '}] ${item.label}`
    ),
    '',
    '  Learn more about indexing:',
    '  https://mnemonik.ai/indexing',
  ];
}

export function renderSetup(items: SetupItem[], output: Output, cursor = 0): number {
  return setupLines(items, cursor).reduce((count, line) => count + output.line(line), 0);
}

export function renderNoSupportedEditors(output: Output): void {
  output.line('No supported editors found.');
  output.line();
  output.line('Learn more about supported editors:');
  output.line('https://mnemonik.ai/editor-support');
}

function editorAuthorizationLines(hosts: JourneyValues['hosts'] = []): string[] {
  const selected = new Set(hosts);
  const rows = [
    ...(selected.has('claude-code')
      ? [['Claude Code', 'type /mcp, choose mnemonik, then Authenticate'] as const]
      : []),
    ...(selected.has('codex')
      ? [
          ['Codex CLI', 'run codex mcp login mnemonik'] as const,
          ['Codex Desktop', 'open Settings, Plugins, MCPs, then Authenticate'] as const,
        ]
      : []),
    ...(selected.has('cursor')
      ? [['Cursor Desktop', 'open Cursor Settings, Customize, MCPs, then Authenticate'] as const]
      : []),
  ];
  if (!rows.length) return [];
  const width = Math.max(...rows.map(([editor]) => editor.length)) + 3;
  return [
    '  One step is left in each editor: Authorize the Mnemonik MCP connection.',
    '  You may need to restart your editor after authorizing.',
    '',
    ...rows.map(([editor, instruction]) => `  ${editor.padEnd(width)}${instruction}`),
    '',
  ];
}
/** Browser-owned account, CLI and scanner choices are announced, never duplicated here. */
export function renderJourney(screen: string, output: Output, v: JourneyValues = {}) {
  const authorization = editorAuthorizationLines(v.hosts);
  const lines: Record<string, string[]> = {
    indexing: [
      'Indexing was skipped.',
      '  Use the Up/Down arrow keys and Enter.',
      '',
      '  > Set up indexing',
      '    Cancel',
      '',
    ],
    account: ['Step 2 of 5: Sign in', `  ${DEVICE_APPROVAL_INSTRUCTION}`],
    scanner: ['Step 4 of 5: Connect repositories'],
    apply: [
      'Step 5 of 5: Finish',
      '  Use the Up/Down arrow keys and Enter.',
      '',
      '  > Install and upload',
      '    Back',
      '    Cancel',
      '',
    ],
    done: authorization,
    indexing_done: ['  ✓ Indexing set up.', ''],
    indexing_skipped: [
      '  ✓ Installed.',
      ...(authorization.length ? ['', ...authorization] : []),
      '  Indexing was skipped. Run mnemonik install to set it up later.',
      '',
    ],
    skipped: [
      ...authorization,
      !v.remaining
        ? '  Done.'
        : v.remaining === 1
          ? '  Done, with one thing left.'
          : `  Done, with ${v.remaining} things left.`,
      ...(v.skipped ?? '')
        .split('\n')
        .filter(Boolean)
        .map((action, index) => `  ${index + 1}. ${action}`),
      '',
    ],
    windows: [
      '  Background indexing could not be started.',
      `  Windows could not create the logon task: ${v.reason}`,
      '  Run mnemonik install to try again.',
      '',
    ],
    scanner_failed: [
      '  Background indexing could not be started.',
      '  Run mnemonik install to try again.',
      ...(authorization.length ? ['', ...authorization] : ['']),
    ],
    authorization,
  };
  const rendered = lines[screen] ?? [];
  return rendered.reduce((count, line) => count + output.line(line), 0);
}

export function renderInterrupted(output: Output): void {
  output.installSection();
  output.line('  Previous installation was interrupted.');
  output.line('  Resume keeps your choices and continues the installation.');
  output.line('  Rollback removes changes from the unfinished installation.');
  output.line('  Use the Up/Down arrow keys and Enter.');
  output.line();
  output.line('  > Resume');
  output.line('    Rollback');
  output.line();
}

export function renderRollbackResult(removed: boolean, output: Output): void {
  output.line(
    removed
      ? '  The unfinished installation was removed.'
      : '  Run mnemonik install again to finish removing the unfinished installation.'
  );
}

interface SignalSource {
  on(event: 'SIGINT' | 'SIGHUP', listener: () => void): unknown;
  off(event: 'SIGINT' | 'SIGHUP', listener: () => void): unknown;
  emit?(event: 'SIGINT' | 'SIGHUP'): boolean;
}

export function journeyAnswers(
  input: Readable,
  output?: Pick<Output, 'line' | 'write' | 'inputPrefix'>,
  options: { interrupt?: (signal: 'SIGINT' | 'SIGHUP') => void; signals?: SignalSource } = {}
) {
  const terminalInput = input as Readable & {
    isTTY?: boolean;
    setRawMode?(enabled: boolean): void;
  };
  const interactive = Boolean(terminalInput.isTTY && terminalInput.setRawMode);
  const reader = interactive ? undefined : createInterface({ input, terminal: false });
  const answers = reader?.[Symbol.asyncIterator]();
  const signals = options.signals ?? process;
  let cancelled = false;
  reader?.on('SIGINT', () => {
    cancelled = true;
    options.interrupt?.('SIGINT');
    reader?.close();
  });
  const interruptedBySigint = () => options.interrupt?.('SIGINT');
  const interruptedByHangup = () => options.interrupt?.('SIGHUP');
  if (options.interrupt) {
    signals.on('SIGINT', interruptedBySigint);
    signals.on('SIGHUP', interruptedByHangup);
  }
  if (interactive) {
    emitKeypressEvents(input);
    terminalInput.setRawMode?.(true);
    input.resume();
  }
  const cancel = () => {
    output?.line('  Installation cancelled.');
    return 'Cancel' as const;
  };
  const keys: Key[] = [];
  let questionActive = false;
  let inputEnded = false;
  let resolveKey: ((key: Key) => void) | undefined;
  const enqueue = (value: Key) => {
    if (resolveKey) {
      const resolve = resolveKey;
      resolveKey = undefined;
      resolve(value);
    } else keys.push(value);
  };
  const pressed = (_sequence: string, value: Key) => {
    if (value.ctrl && value.name === 'c' && options.interrupt) {
      if (signals === process) process.kill(process.pid, 'SIGINT');
      else signals.emit?.('SIGINT');
    } else if (questionActive) enqueue(value);
  };
  const ended = () => {
    inputEnded = true;
    if (questionActive) enqueue({ name: 'end' });
  };
  if (interactive) {
    input.on('keypress', pressed);
    input.once('end', ended);
  }
  const key = () => {
    const queued = keys.shift();
    return queued
      ? Promise.resolve(queued)
      : inputEnded
        ? Promise.resolve({ name: 'end' } as Key)
        : new Promise<Key>((resolve) => {
            resolveKey = resolve;
          });
  };
  const nextAnswer = () =>
    answers?.next() ?? Promise.resolve({ done: true, value: undefined } as IteratorResult<string>);
  const rewriteChoices = (choices: string[], selected: number) => {
    if (!output) return;
    output.write(`\u001b[${choices.length + 1}A`);
    for (const [index, choice] of choices.entries())
      output.write(`\r\u001b[2K  ${index === selected ? '>' : ' '} ${choice}\n`);
    output.write('\r\u001b[2K\n');
  };
  return {
    async choose(choices: string[], fallback = 0) {
      if (interactive) {
        questionActive = true;
        keys.length = 0;
        try {
          let selected = fallback;
          for (;;) {
            const answer = await key();
            if (answer.name === 'up' || answer.name === 'down') {
              selected =
                (selected + (answer.name === 'up' ? choices.length - 1 : 1)) % choices.length;
              rewriteChoices(choices, selected);
            } else if (answer.name === 'return' || answer.name === 'enter') {
              const selectedChoice = choices[selected] ?? 'Cancel';
              return selectedChoice === 'Cancel' ? cancel() : selectedChoice;
            } else if (
              answer.name === 'escape' ||
              answer.name === 'end' ||
              (answer.ctrl && answer.name === 'c')
            )
              return cancel();
          }
        } finally {
          questionActive = false;
          keys.length = 0;
          resolveKey = undefined;
        }
      }
      const answer = await nextAnswer();
      if (answer.done || cancelled) return cancel();
      const value = answer.value.trim();
      const selectedChoice = !value
        ? (choices[fallback] ?? 'Cancel')
        : (choices[Number(value) - 1] ??
          choices.find((c) => c.toLowerCase() === value.toLowerCase()) ??
          'Cancel');
      return selectedChoice === 'Cancel' ? cancel() : selectedChoice;
    },
    async checklist(items: SetupItem[]) {
      if (!interactive) {
        const answer = await nextAnswer();
        if (answer.done || cancelled) return cancel();
        if (/^(?:esc|back|cancel)$/iu.test(answer.value.trim())) return 'Back' as const;
        return {
          selected: items.filter((item) => item.checked).map((item) => item.value),
        };
      }
      questionActive = true;
      keys.length = 0;
      try {
        let cursor = 0;
        const selected = items.map((item) => ({ ...item }));
        const redraw = () => {
          if (!output) return;
          const lines = setupLines(selected, cursor);
          output.write(`\u001b[${lines.length}A`);
          for (const line of lines) output.write(`\r\u001b[2K${line}\n`);
        };
        for (;;) {
          const answer = await key();
          if (answer.name === 'up' || answer.name === 'down') {
            const count = selected.length;
            cursor = (cursor + (answer.name === 'up' ? count - 1 : 1)) % count;
            redraw();
          } else if (answer.name === 'space') {
            const item = selected[cursor];
            if (item) item.checked = !item.checked;
            redraw();
          } else if (answer.name === 'return' || answer.name === 'enter') {
            return { selected: selected.filter((item) => item.checked).map((item) => item.value) };
          } else if (answer.name === 'escape') continue;
          else if (answer.name === 'end' || (answer.ctrl && answer.name === 'c')) return cancel();
        }
      } finally {
        questionActive = false;
        keys.length = 0;
        resolveKey = undefined;
      }
    },
    async text() {
      if (interactive) {
        questionActive = true;
        keys.length = 0;
        let value = '';
        try {
          output?.inputPrefix();
          for (;;) {
            const answer = await key();
            if (answer.name === 'return' || answer.name === 'enter') {
              output?.write('\n');
              return value.trim();
            }
            if (answer.name === 'backspace') {
              if (value) {
                value = [...value].slice(0, -1).join('');
                output?.write('\b \b');
              }
              continue;
            }
            if (answer.name === 'end' || (answer.ctrl && answer.name === 'c')) return undefined;
            const sequence = answer.sequence ?? '';
            if (
              !answer.ctrl &&
              !answer.meta &&
              sequence &&
              [...sequence].every((character) => character >= ' ' && character !== '\u007f')
            ) {
              value += sequence;
              output?.write(sequence);
            }
          }
        } finally {
          questionActive = false;
          keys.length = 0;
          resolveKey = undefined;
        }
      }
      const answer = await nextAnswer();
      return answer.done ? undefined : answer.value.trim();
    },
    close() {
      if (interactive) {
        terminalInput.setRawMode?.(false);
        input.off('keypress', pressed);
        input.off('end', ended);
        input.pause();
      }
      if (options.interrupt) {
        signals.off('SIGINT', interruptedBySigint);
        signals.off('SIGHUP', interruptedByHangup);
      }
      reader?.close();
    },
  };
}
