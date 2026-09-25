type ReadinessMessage = {
    sentence: string;
    nextStep: string;
};
export declare const CODEX_TRUST_MESSAGE: {
    sentence: string;
    nextStep: string;
};
export declare const SCANNER_CONSENT_MESSAGE: {
    sentence: string;
    nextStep: string;
};
export declare const SCANNER_UPDATE_CONSENT_MESSAGE: {
    sentence: string;
    nextStep: string;
};
export declare const INTERRUPTED_INSTALL: RegExp;
export declare const INTERRUPTED_INSTALL_MESSAGE: {
    sentence: string;
    nextStep: string;
};
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