import { createInterface } from 'node:readline';
/** Browser-owned account, CLI and scanner choices are announced, never duplicated here. */
export function renderJourney(screen, output, v = {}) {
    const hosts = v.hosts ?? [];
    const lines = {
        recommended: [
            'Mnemonik',
            '',
            `  Found      ${hosts.join(', ') || 'No supported editors'}`,
            `  Project    ${v.project}`,
            `  Node ${v.node}, ${v.os}`,
            '',
            '  Recommended setup',
            `    Memory tools and hooks in ${hosts.length === 3 ? 'all three editors' : 'your selected editors'}`,
            '    Background scanner watching this project',
            '',
            '  > Recommended',
            '    Customize',
            '',
        ],
        account: [
            '  Opening your browser to sign in.',
            '  Waiting for you to sign in and approve, up to 10 minutes.',
            '',
        ],
        cli_approval: [
            '  Approve this CLI in the browser.',
            '  Compare the code and confirm the account and computer shown there.',
            '',
        ],
        host_approvals: [
            '  Connect your editors',
            '',
            ...hosts.map((host) => `  - Approve Mnemonik in ${host}, your default profile`),
            '',
            '  > Connect them',
            '    Cancel',
            '',
        ],
        scanner: [
            '  Review scanner disclosure and roots in your browser.',
            '  Waiting for you to approve the selected roots before Apply.',
            '',
        ],
        apply: [
            '  Ready to install',
            '',
            ...(v.files ?? []).map((file) => `  ${file}`),
            '',
            '  Existing files are backed up and restored if anything fails.',
            v.connected === false
                ? '  Skipped editors can be connected later.'
                : '  Your selected editors are connected.',
            '',
            '  > Install and upload',
            '    Back',
            '    Cancel',
            '',
        ],
        done: [
            '  Done. Your editors will use Mnemonik on their next session.',
            ...(v.total != null && v.completed != null
                ? [`  Indexing ${v.total} files, ${v.completed} done. You can close this terminal.`]
                : ['  Indexing in progress.']),
            '',
        ],
        skipped: [
            !v.remaining
                ? '  Done.'
                : v.remaining === 1
                    ? '  Done, with one thing left.'
                    : `  Done, with ${v.remaining} things left.`,
            `  ${v.skipped ?? ''}`,
            '',
        ],
        windows: [
            '  Your editors are connected. The scanner could not be installed.',
            `  Windows could not create the logon task: ${v.reason}`,
            '  Run mnemonik scanner enable to try again.',
            '',
        ],
    };
    for (const line of lines[screen] ?? [])
        output.line(line);
}
export function journeyAnswers(input) {
    const reader = createInterface({
        input,
        terminal: Boolean(input.isTTY),
    });
    const answers = reader[Symbol.asyncIterator]();
    let cancelled = false;
    reader.on('SIGINT', () => {
        cancelled = true;
        reader.close();
    });
    return {
        async choose(choices, fallback = 0) {
            const answer = await answers.next();
            if (answer.done || cancelled)
                return 'Cancel';
            const value = answer.value.trim();
            if (!value)
                return choices[fallback] ?? 'Cancel';
            return (choices[Number(value) - 1] ??
                choices.find((c) => c.toLowerCase() === value.toLowerCase()) ??
                'Cancel');
        },
        async text() {
            const answer = await answers.next();
            return answer.done ? undefined : answer.value.trim();
        },
        close() {
            reader.close();
        },
    };
}
//# sourceMappingURL=journey.js.map