export type Signer = {
    platform: 'darwin';
    identity: string;
} | {
    platform: 'win32';
    identity: string;
} | {
    platform: 'linux';
    identity: string;
    signature: string;
};
export type Execute = (file: string, args: string[], input?: string) => Promise<unknown>;
export declare const execute: Execute;
/** Pinned release identity; a downloaded manifest can never replace its own trust anchor. */
export declare const RELEASE_MINISIGN_PUBLIC_KEY = "RWSBYwgbjz0qKB4/ToA3dywBiAlQeBjoQpib4OHdjP2nDbpQnOVqpPm0";
export declare function verifyMinisign(message: Buffer, signatureText: string, identity?: string): void;
/** Release tooling supplies the real identity and artifacts. These checks do not sign anything. */
export declare function verifySigner(path: string, signer: Signer, run?: Execute): Promise<void>;
/** Windows stat mode/uid are not ACL evidence. */
export declare function verifyWindowsPermission(path: string, run?: Execute, state?: string): Promise<void>;
type HookIdentity = {
    name: string;
    sid: string;
    /**
     * The SID the SDDL alias `LA` stands for on this machine: its own account
     * domain's RID 500. Resolved only for a RID-500 token (no other account can
     * be LA); `null` when that token is not a local account, so LA is someone else.
     */
    localAdministratorSid?: string | null;
};
export declare function windowsCurrentAccountSync(): HookIdentity;
/** Frequent config polling checks fresh ACEs; stat changes trigger a full owner audit. */
export declare function verifyWindowsAcl(path: string, run?: Execute, state?: string): Promise<void>;
/** icacls /save writes alternating relative paths and SDDL in UTF-16LE. */
export declare function aclRecords(output: string, root: string, paths: string[], onLookup?: () => void): Map<string, string[]>;
export declare function prepareWindowsAclDirectory(state: string, run?: Execute): Promise<void>;
export declare function protectWindowsDirectory(path: string, created: boolean, run?: Execute, session?: string): Promise<void>;
/** File ACEs may inherit from their already-private parent. */
export declare function verifyWindowsPermissionSync(path: string): void;
export declare function ensureWindowsPrivateDirectorySync(path: string, session?: string): void;
export type WindowsPermission = 'ok' | 'owner' | 'ace' | 'acl_unavailable';
/** Recursive native listings are attributed by absolute path; missing entries fall back. */
export declare function auditWindowsPermissions(state: string, paths: string[], run?: Execute, recursive?: boolean, tempState?: string): Promise<Map<string, WindowsPermission>>;
export {};
//# sourceMappingURL=runtimeSigners.d.ts.map