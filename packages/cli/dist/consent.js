const decisions = {
    'accept-indexing': {
        question: 'Do you want automatic project indexing?',
        then: 'Then run the command again with --accept-indexing for yes, or with --without-scanner --accept-limited for no.',
        answers: [
            { answer: 'yes', add: ['--accept-indexing'] },
            { answer: 'no', add: ['--without-scanner', '--accept-limited'] },
        ],
    },
    'accept-limited': {
        question: 'Set up Mnemonik without automatic project indexing?',
        then: 'Then run the command again with --accept-limited for yes, or without --without-scanner for no.',
        answers: [
            { answer: 'yes', add: ['--accept-limited'] },
            { answer: 'no', add: [], remove: ['--without-scanner'] },
        ],
    },
    hosts: {
        question: 'Which coding tools should Mnemonik connect: Claude Code, Codex or Cursor?',
        then: 'Then run the command again with --hosts and their answer, for example --hosts claude-code,codex.',
        answers: [
            { answer: 'the coding tools they name', add: ['--hosts <claude-code,codex,cursor>'] },
        ],
    },
    'scan-roots': {
        question: 'Which folder holds your projects? You will choose which of them to index at the approval link.',
        then: 'Then run the command again with --scan-roots and that folder, and hand the approval link to the person.',
        answers: [{ answer: 'the folder they name', add: ['--scan-roots <folder>'] }],
    },
    apply: {
        question: 'Go ahead and make these changes?',
        then: 'Then run the command again with --apply for yes.',
        answers: [{ answer: 'yes', add: ['--apply'] }],
    },
};
/** Outside install, declining indexing is simply not running the command. */
const enableIndexing = {
    question: 'Do you want Mnemonik to index these folders?',
    then: 'Then run the command again with --accept-indexing for yes.',
    answers: [{ answer: 'yes', add: ['--accept-indexing'] }],
};
const list = (words) => words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
export function consentDecision(flag, command = 'other', found = []) {
    const name = flag.replace(/^--/u, '');
    if (name === 'accept-indexing' && command !== 'install')
        return enableIndexing;
    if (name === 'hosts' && found.length)
        return {
            question: `Which coding tools should Mnemonik connect? Found on this machine: ${list(found.map((editor) => editor.label))}.`,
            then: `Then run the command again with --hosts and their answer, for example --hosts ${found.map((editor) => editor.value).join(',')}.`,
            answers: [
                {
                    answer: 'the coding tools they name',
                    add: [`--hosts ${found.map((editor) => editor.value).join(',')}`],
                },
            ],
        };
    return decisions[name];
}
/** The lines a person or agent reads when a consent flag is missing. */
export function consentLines(flag, command = 'other', found = []) {
    const name = flag.replace(/^--/u, '');
    const decision = consentDecision(name, command, found);
    return [
        `Missing required consent flag: --${name}`,
        ...(decision ? [`Ask the person: ${decision.question}`, decision.then] : []),
    ];
}
/** Stops for a missing consent flag, in JSON or in words. Always exit 3. */
export function missingConsent(output, json, flag, command = 'other', found = []) {
    const name = flag.replace(/^--/u, '');
    const decision = consentDecision(name, command, found);
    if (json)
        output.json({
            status: 'action_required',
            reason: 'consent_required',
            flag: `--${name}`,
            action: `Rerun with --${name}`,
            ...(decision
                ? { question: decision.question, then: decision.then, answers: decision.answers }
                : {}),
        });
    else
        for (const line of consentLines(name, command, found))
            output.error(line);
    return 3;
}
//# sourceMappingURL=consent.js.map