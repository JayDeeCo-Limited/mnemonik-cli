type ReadinessMessage = {
    sentence: string;
    nextStep: string;
};
export declare const CODEX_TRUST_MESSAGE: {
    sentence: string;
    nextStep: string;
};
export declare const genericReadinessMessage: ReadinessMessage;
export declare function messageFor(reason: string, actions?: readonly string[]): ReadinessMessage;
/** Keep internal diagnostics in JSON and logs; human errors use the approved status copy. */
export declare function humanReason(reason: string): string;
export declare const bootstrapFailureMessage = "Installation stopped.\nRun npx -y @mnemonik/cli@latest install to try again.";
/** Older journals mix sentences and reason codes. Preserve their sentences and actionable paths. */
export declare function humanReport(report: string): string;
export declare function humanProjectAction(action: string): string;
export declare function humanIdentityState(state: string): string;
export {};
//# sourceMappingURL=humanReason.d.ts.map