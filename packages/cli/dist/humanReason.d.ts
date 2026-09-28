type ReadinessMessage = {
    sentence: string;
    nextStep: string;
};
export declare const CODEX_TRUST_MESSAGE: {
    sentence: string;
    nextStep: string;
};
/**
 * What an agent runs with `--json` or no terminal to redo the scanner setup
 * over the folders already approved. Machine surfaces only: a person is
 * never shown flags.
 */
export declare const SCANNER_ENABLE_ACTION = "mnemonik scanner enable --accept-indexing --apply";
/**
 * An updated notice waits for the person's approval (only the approval
 * is theirs). The agent runs this for them: it starts the browser approval over
 * the folders already approved, and completes the update once approved.
 */
export declare const SCANNER_APPROVAL_ACTION = "mnemonik update";
/** What an agent needs to know to run SCANNER_APPROVAL_ACTION for the person. */
export declare const SCANNER_APPROVAL_NOTE: string;
/** The same step as the agent running the command reads it (no terminal). */
export declare const AGENT_APPROVAL_STEP = "Run mnemonik update and give the person the approval link it prints; it finishes when they approve.";
export declare const SCANNER_CONSENT_MESSAGE: {
    sentence: string;
    nextStep: string;
};
export declare const SCANNER_UPDATE_CONSENT_MESSAGE: {
    sentence: string;
    nextStep: string;
};
/** The consent reasons whose step is an approval the agent brings to the person. */
export declare const APPROVAL_REASONS: RegExp;
/** A consent message as its reader needs it: a person, or the agent running the command. */
export declare function approvalMessage(message: ReadinessMessage, agent: boolean): ReadinessMessage;
export declare const INTERRUPTED_INSTALL: RegExp;
export declare const INTERRUPTED_INSTALL_MESSAGE: {
    sentence: string;
    nextStep: string;
};
/** The table's words for a reason, or undefined when the table has none. */
export declare function knownReason(reason: string): ReadinessMessage | undefined;
/**
 * The words for one condition. A reason with no table entry keeps its own
 * sentence and its own step, so nothing reaches a person as a reason code.
 */
export declare function messageFor(reason: string, actions?: readonly string[], action?: string): ReadinessMessage;
/** Keep internal diagnostics in JSON and logs; human errors use the approved status copy. */
export declare function humanReason(reason: string): string;
export declare const bootstrapFailureMessage = "Installation stopped.\nRun npx -y @mnemonik/cli@latest install to try again.";
/** Older journals mix sentences and reason codes. Preserve their sentences and actionable paths. */
export declare function humanReport(report: string): string;
export declare function humanProjectAction(action: string): string;
/** The sentence for an action, or nothing when Mnemonik has no plain words for it. */
export declare function projectActionSentence(action: string): string | undefined;
export declare function humanIdentityState(state: string): string;
export {};
//# sourceMappingURL=humanReason.d.ts.map