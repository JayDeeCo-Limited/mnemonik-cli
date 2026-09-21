import type { RepositoryFingerprint } from './repositoryFingerprint.js';
export declare const isCanonicalUuid: (value: unknown) => value is string;
export interface ProjectIdentityFile {
    schemaVersion: 1;
    projectId: string;
    projectName?: string;
    repositoryFingerprint?: RepositoryFingerprint;
}
export type IdentityFileResult = {
    kind: 'ok';
    identity: ProjectIdentityFile;
} | {
    kind: 'unknown_version';
    version: unknown;
} | {
    kind: 'malformed';
    detail: string;
} | {
    kind: 'absent';
};
export declare function parseIdentityFile(text: string): Exclude<IdentityFileResult, {
    kind: 'absent';
}>;
export declare function readIdentityFile(dir: string, options?: {
    selectedRoot?: boolean;
}): Promise<IdentityFileResult>;
//# sourceMappingURL=projectIdentityFile.d.ts.map