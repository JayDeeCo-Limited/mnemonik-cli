import { createInterface, emitKeypressEvents } from 'node:readline';
import { DEVICE_APPROVAL_INSTRUCTION } from '../auth/device.js';
export const completedStep = (step, text) => `Step ${step} of 5: ${text}`;
export const completedLine = (text) => `  ✓ ${text}`;
export const INSTALLATION_STOPPED = 'Installation stopped.';
export const SCANNER_FAILURE_MESSAGE = 'Background indexing could not be started.';
export const SCANNER_RETRY_MESSAGE = 'Run mnemonik install to try again.';
export const ADD_ANOTHER_FOLDER = 'To connect a folder somewhere else, run mnemonik add <folder>.';
/** Step 4's spinner while the browser approval of the project folders is pending. */
export const APPROVAL_WAITING = 'Waiting for approval';
const STEP_NAMES = [
    'Choose what to set up',
    'Sign in',
    'Configure coding tools',
    'Connect project folders',
    'Finish',
];
export const stepProgress = (output, interactive, text) => output.progressLine(interactive ? text : `  ${text}`, interactive);
function setupLines(items, cursor = 0) {
    return [
        'Step 1 of 5: Choose what to set up',
        '  These coding tools were found on this computer. Untick any you do not want.',
        '  Use the Up/Down arrow keys to move, Space to select, Enter to continue.',
        '',
        ...items.map((item, index) => `  ${index === cursor ? '>' : ' '} [${item.checked ? 'x' : ' '}] ${item.label}`),
        '',
        '  Learn more about indexing:',
        '  https://mnemonik.ai/indexing',
    ];
}
export function renderSetup(items, output, cursor = 0) {
    return setupLines(items, cursor).reduce((count, line) => count + output.line(line), 0);
}
export function renderNoSupportedEditors(output) {
    output.line('No supported coding tools found.');
    output.line();
    output.line('Learn more about supported coding tools:');
    output.line('https://mnemonik.ai/install#support');
}
export function editorAuthorizationRows(hosts = []) {
    const selected = new Set(hosts);
    return [
        ...(selected.has('claude-code')
            ? ['Claude Code      type /mcp, choose mnemonik, then Authenticate']
            : []),
        ...(selected.has('codex')
            ? [
                'Codex CLI        run codex mcp login mnemonik',
                'Codex Desktop    open Settings, Plugins, MCPs, then Authenticate',
            ]
            : []),
        ...(selected.has('cursor')
            ? ['Cursor Desktop   open Cursor Settings, Customize, MCPs, then Authenticate']
            : []),
    ];
}
function editorAuthorizationLines(hosts = []) {
    const rows = editorAuthorizationRows(hosts);
    if (!rows.length)
        return [];
    return [
        '  One step is left in each coding tool: Authorize the Mnemonik MCP connection.',
        '  You may need to restart your coding tool after authorizing.',
        '',
        ...rows.map((row) => `  ${row}`),
        '',
    ];
}
/** Browser-owned account, CLI and scanner choices are announced, never duplicated here. */
export function renderJourney(screen, output, v = {}) {
    const authorization = editorAuthorizationLines(v.hosts);
    const lines = {
        indexing: [
            'Indexing was skipped.',
            '  Use the Up/Down arrow keys and Enter.',
            '',
            '  > Set up indexing',
            '    Cancel',
            '',
        ],
        account: ['Step 2 of 5: Sign in', `  ${DEVICE_APPROVAL_INSTRUCTION}`],
        scanner: ['Step 4 of 5: Connect project folders'],
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
            // A bare reason code is never shown to a person: main's rule, kept here.
            `  ${SCANNER_FAILURE_MESSAGE}`,
            `  ${SCANNER_RETRY_MESSAGE}`,
            '',
        ],
        scanner_failed: [
            `  ${v.scannerFailureMessage ?? SCANNER_FAILURE_MESSAGE}`,
            // Some failures leave nothing for the person to do, and say so on one line.
            ...(v.action === '' ? [] : [`  ${v.action ?? SCANNER_RETRY_MESSAGE}`]),
            ...(authorization.length ? ['', ...authorization] : ['']),
        ],
        authorization,
    };
    const rendered = lines[screen] ?? [];
    return rendered.reduce((count, line) => count + output.line(line), 0);
}
/** The step an unfinished joined install had reached, read from its journal. */
export function interruptedStep(data) {
    const done = (data.hostRuns ?? []).filter((run) => run.status === 'complete' || run.status === 'verified').length;
    // The journal starts at step 3, so steps 1 and 2 were already behind it.
    if (done < (data.hostRequest?.selections.length ?? 0))
        return 3;
    return data.phase === 'applying' || !data.components.includes('scanner') ? 5 : 4;
}
export function renderInterrupted(output, data) {
    output.installSection();
    output.heading('Previous installation was interrupted');
    if (data) {
        const step = interruptedStep(data);
        output.line(`  It stopped at step ${step} of 5: ${STEP_NAMES[step - 1]}.`);
    }
    output.line('  Resume keeps your choices and continues the installation.');
    output.line('  Rollback removes changes from the unfinished installation.');
    output.line('  Use the Up/Down arrow keys and Enter.');
    output.line();
    output.line('  > Resume');
    output.line('    Rollback');
    output.line();
}
export function renderRollbackResult(removed, output) {
    output.line(removed
        ? '  The unfinished installation was removed.'
        : '  Run mnemonik install again to finish removing the unfinished installation.');
}
export function journeyAnswers(input, output, options = {}) {
    const terminalInput = input;
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
        return 'Cancel';
    };
    const keys = [];
    let questionActive = false;
    let inputEnded = false;
    let resolveKey;
    const enqueue = (value) => {
        if (resolveKey) {
            const resolve = resolveKey;
            resolveKey = undefined;
            resolve(value);
        }
        else
            keys.push(value);
    };
    const pressed = (_sequence, value) => {
        if (value.ctrl && value.name === 'c' && options.interrupt) {
            if (signals === process)
                process.kill(process.pid, 'SIGINT');
            else
                signals.emit?.('SIGINT');
        }
        else if (questionActive)
            enqueue(value);
    };
    const ended = () => {
        inputEnded = true;
        if (questionActive)
            enqueue({ name: 'end' });
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
                ? Promise.resolve({ name: 'end' })
                : new Promise((resolve) => {
                    resolveKey = resolve;
                });
    };
    const nextAnswer = () => answers?.next() ?? Promise.resolve({ done: true, value: undefined });
    const rewriteChoices = (choices, selected) => {
        if (!output)
            return;
        output.write(`\u001b[${choices.length + 1}A`);
        for (const [index, choice] of choices.entries())
            output.write(`\r\u001b[2K  ${index === selected ? '>' : ' '} ${choice}\n`);
        output.write('\r\u001b[2K\n');
    };
    return {
        async choose(choices, fallback = 0) {
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
                        }
                        else if (answer.name === 'return' || answer.name === 'enter') {
                            const selectedChoice = choices[selected] ?? 'Cancel';
                            return selectedChoice === 'Cancel' ? cancel() : selectedChoice;
                        }
                        else if (answer.name === 'escape' ||
                            answer.name === 'end' ||
                            (answer.ctrl && answer.name === 'c'))
                            return cancel();
                    }
                }
                finally {
                    questionActive = false;
                    keys.length = 0;
                    resolveKey = undefined;
                }
            }
            const answer = await nextAnswer();
            if (answer.done || cancelled)
                return cancel();
            const value = answer.value.trim();
            const selectedChoice = !value
                ? (choices[fallback] ?? 'Cancel')
                : (choices[Number(value) - 1] ??
                    choices.find((c) => c.toLowerCase() === value.toLowerCase()) ??
                    'Cancel');
            return selectedChoice === 'Cancel' ? cancel() : selectedChoice;
        },
        async checklist(items) {
            if (!interactive) {
                const answer = await nextAnswer();
                if (answer.done || cancelled)
                    return cancel();
                if (/^(?:esc|back|cancel)$/iu.test(answer.value.trim()))
                    return 'Back';
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
                    if (!output)
                        return;
                    const lines = setupLines(selected, cursor);
                    output.write(`\u001b[${lines.length}A`);
                    for (const line of lines)
                        output.write(`\r\u001b[2K${line}\n`);
                };
                for (;;) {
                    const answer = await key();
                    if (answer.name === 'up' || answer.name === 'down') {
                        const count = selected.length;
                        cursor = (cursor + (answer.name === 'up' ? count - 1 : 1)) % count;
                        redraw();
                    }
                    else if (answer.name === 'space') {
                        const item = selected[cursor];
                        if (item)
                            item.checked = !item.checked;
                        redraw();
                    }
                    else if (answer.name === 'return' || answer.name === 'enter') {
                        return { selected: selected.filter((item) => item.checked).map((item) => item.value) };
                    }
                    else if (answer.name === 'escape')
                        continue;
                    else if (answer.name === 'end' || (answer.ctrl && answer.name === 'c'))
                        return cancel();
                }
            }
            finally {
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
                        if (answer.name === 'end' || (answer.ctrl && answer.name === 'c'))
                            return undefined;
                        const sequence = answer.sequence ?? '';
                        if (!answer.ctrl &&
                            !answer.meta &&
                            sequence &&
                            [...sequence].every((character) => character >= ' ' && character !== '\u007f')) {
                            value += sequence;
                            output?.write(sequence);
                        }
                    }
                }
                finally {
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
//# sourceMappingURL=journey.js.map