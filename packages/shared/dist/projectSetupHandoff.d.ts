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
export declare function handoffProjectSetup(input: {
    response: unknown;
    cwd: string | undefined;
    host: 'claude_code' | 'cursor' | 'grok';
    hostSessionId: string;
    stateFile: string;
    stateDir: string;
    familyId: string | undefined;
}): Promise<string | undefined>;
/** Both doctor and status consume private per-session outcomes, scoped by root hash. */
export declare function pendingProjectSetup(root: string): Promise<ProjectSetupDiagnostic[]>;
//# sourceMappingURL=projectSetupHandoff.d.ts.map