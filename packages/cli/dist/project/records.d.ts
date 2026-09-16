import { type Owner } from '@mnemonik/local-setup';
export interface ProjectCommandRecord {
    resolvedRoot: string;
    decisionReason: string;
    chosenOwner: 'personal' | `team:${string}`;
    projectId: string | null;
    beforeHash: `sha256:${string}` | null;
    afterHash: `sha256:${string}` | null;
}
export declare function identityHash(root: string): Promise<ProjectCommandRecord['beforeHash']>;
export declare const ownerLabel: (owner: Owner | undefined) => ProjectCommandRecord['chosenOwner'];
export declare function saveCommandRecord(record: ProjectCommandRecord, stateDir?: string): Promise<void>;
export declare function readExecutorState(root: string, stateDir?: string): Promise<string | undefined>;
//# sourceMappingURL=records.d.ts.map