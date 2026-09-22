export interface Digest {
  algorithmVersion: 1;
  hash: string;
}
export type Owner = 'personal' | { teamId: string };
/** Wire types mirror src/agent/projectSetup.ts, without importing server runtime. */
export interface SetupRequired {
  status: 'project_setup_required';
  state: string;
  allowedActions: string[];
  candidates?: Array<{ projectId: string; displayName: string }>;
  requestId?: string;
  expiresAt?: string;
  manualAction?: 'project_init' | 'project_setup';
}
export interface ActionRequired {
  status: 'ACTION_REQUIRED';
  state: string;
  allowedActions: string[];
  [key: string]: unknown;
}
export interface Evidence {
  deviceRootContext: Digest;
  repositoryFingerprint: Digest | null;
}
export interface ConsumeInput extends Evidence {
  requestId: string;
  action: 'create' | 'link' | 'restore';
  projectId?: string;
  operationId?: string;
  displayName?: string;
  owner?: Owner;
  confirmCandidate?: string;
}
export type Complete = { status: 'complete'; projectId: string; displayName: string };
export interface SetupTransport {
  /** POST /api/v1/project-setup/issue; caller supplies OAuth, never this package. */
  issueSetupRequest(
    input: Evidence & { projectId?: string }
  ): Promise<SetupRequired | ActionRequired | Complete>;
  /** POST /api/v1/project-setup/consume; caller supplies OAuth, never this package. */
  consumeSetupRequest(input: ConsumeInput): Promise<Complete | ActionRequired>;
}
export interface EnsureOptions {
  cwd: string;
  owner?: Owner;
  allowCreate: boolean;
  allowNestedInherit: boolean;
  intent?: { action: 'link'; projectId: string; replace?: true };
  ignore?: true;
  clearIgnore?: true;
}
export type SetupResult =
  | ActionRequired
  | SetupRequired
  | {
      status: 'done' | 'staged' | 'rolled_back' | 'ignored';
      operationId: string;
      root: string;
      projectId?: string;
      retainedRemoteUUID?: string;
      permissionStatus: 'private' | 'acl_pending';
    };
export const actionRequired = (state: string): ActionRequired => ({
  status: 'ACTION_REQUIRED',
  state,
  allowedActions: ['retry', 'cancel'],
});
