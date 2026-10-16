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
/**
 * A `.mnemonik.json` that holds configuration but no identity: a JSON object
 * with no `projectId` that names schema 1 or no schema. Invalid identities,
 * and any file naming another schema (which may carry its identity under other
 * keys), are not.
 */
export declare function isConfigurationOnly(text: string): boolean;
/**
 * Read a folder's identity file. With `configurationOnlyAbsent` (and with
 * `selectedRoot`, folders ticked during install), a configuration-only file is
 * no identity: the folder is not a project of its own.
 */
export declare function readIdentityFile(dir: string, options?: {
    selectedRoot?: boolean;
    configurationOnlyAbsent?: boolean;
}): Promise<IdentityFileResult>;
//# sourceMappingURL=projectIdentityFile.d.ts.map