export declare const PROJECT_SETUP_MANUAL = "Mnemonik project setup needs attention; ask the person to run `mnemonik project init` in this folder.";
export declare function projectSetupActions(value: unknown): string;
export interface ProjectSetupDiagnostic {
    requestId?: string;
    outcome: 'done' | 'ACTION_REQUIRED' | 'failed';
    time: string;
    rootHash: string | null;
    action: string;
    reason?: string;
}
/** Parse the native tool response, never tool arguments or agent-authored command fields. */
export declare function setupResponse(value: unknown): Record<string, unknown> | undefined;
/** What the agent is told while `project ensure` is still running detached. */
export declare const PROJECT_SETUP_RUNNING = "Mnemonik project setup is still running; call session_bootstrap again in a few seconds.";
/** The CLI helper's own bound, enforced by the detached supervisor below. */
export declare const PROJECT_ENSURE_TIMEOUT_MS = 30000;
export declare function handoffProjectSetup(input: {
    response: unknown;
    cwd: string | undefined;
    host: 'claude_code' | 'cursor' | 'grok';
    hostSessionId: string;
    stateFile: string;
    stateDir: string;
    familyId: string | undefined;
    /**
     * How long this hook may wait for `project ensure`; defaults to what the
     * host's hook timeout leaves (hookDeadlineMs less the time since start).
     */
    waitMs?: number;
}): Promise<string | undefined>;
/** Both doctor and status consume private per-session outcomes, scoped by root hash. */
export declare function pendingProjectSetup(root: string): Promise<ProjectSetupDiagnostic[]>;
//# sourceMappingURL=projectSetupHandoff.d.ts.map