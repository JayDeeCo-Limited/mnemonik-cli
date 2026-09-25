import type { Output } from './output.js';
/**
 * A missing consent flag is a decision that belongs to the person. Without a
 * terminal the reader is usually an agent, so each one says the question to put
 * to the person and how to pass their answer back.
 */
export interface ConsentDecision {
    /** The question for the person, to relay as written. */
    question: string;
    /** How to pass the answer, in words. */
    then: string;
    /** The same, for a reader of JSON: flags to add or remove for each answer. */
    answers: Array<{
        answer: string;
        add: string[];
        remove?: string[];
    }>;
}
/** Editors found on this machine, to name in the editors question. */
export interface FoundEditor {
    value: string;
    label: string;
}
export declare function consentDecision(flag: string, command?: 'install' | 'other', found?: FoundEditor[]): ConsentDecision | undefined;
/** The lines a person or agent reads when a consent flag is missing. */
export declare function consentLines(flag: string, command?: 'install' | 'other', found?: FoundEditor[]): string[];
/** Stops for a missing consent flag, in JSON or in words. Always exit 3. */
export declare function missingConsent(output: Output, json: boolean, flag: string, command?: 'install' | 'other', found?: FoundEditor[]): 3;
//# sourceMappingURL=consent.d.ts.map