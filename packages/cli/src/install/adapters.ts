import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import type { Verified } from '../runtime/store.js';
import type {
  AdapterDependencies,
  AdapterWriter,
  Grant,
  HostAdapter,
  HostName,
  HostPlan,
  Inspection,
} from '@mnemonik/shared';
export type {
  AdapterDependencies,
  AdapterWriter,
  FileChange,
  Grant,
  HostAdapter,
  HostName,
  HostPlan,
  Inspection,
  Target,
} from '@mnemonik/shared';
import { bytesAt } from './journal.js';

export const hostOrder = ['claude-code', 'codex', 'grok', 'cursor'] as const;
export const hostPackages = {
  'claude-code': '@mnemonik/claude-code-hooks',
  codex: '@mnemonik/codex-hooks',
  grok: '@mnemonik/grok-hooks',
  cursor: '@mnemonik/cursor-hooks',
} as const;
export type HostPackageImports = {
  [H in (typeof hostOrder)[number]]: (runtime: Verified) => Promise<{
    createHostAdapter(deps?: AdapterDependencies): HostAdapter;
  }>;
};
// The caller supplies a freshly verified store result, never an npm cache path.
const loadAdapter = (runtime: Verified) =>
  import(pathToFileURL(join(dirname(runtime.entry), 'adapter.js')).href) as ReturnType<
    HostPackageImports['codex']
  >;
export const hostPackageImports: HostPackageImports = {
  'claude-code': loadAdapter,
  codex: loadAdapter,
  cursor: loadAdapter,
  grok: loadAdapter,
};

export class SimulatedHostAdapter implements HostAdapter {
  grant?: Grant;
  authenticatedTools = true;
  launches = 0;
  revoked: string[] = [];
  revokeAction: string;
  constructor(
    readonly name: HostName,
    readonly declaration: Omit<HostPlan, 'changes'> & { path: string; content: Buffer },
    readonly supportsRevoke = true
  ) {
    this.revokeAction = `Open ${name} connection settings and revoke the Mnemonik connection.`;
  }
  async detect() {
    return { supported: true, version: 'simulated' };
  }
  capabilities() {
    return {
      scopes: ['user', 'project'],
      components: ['hooks', 'mcp'] as ('hooks' | 'mcp')[],
      nativeConnect: true,
      revoke: this.supportsRevoke,
    };
  }
  async inspect(): Promise<Inspection> {
    return {
      authenticatedTools: this.authenticatedTools,
      grant: this.grant,
      declarationPresent: (await bytesAt(this.declaration.path)) !== null,
    };
  }
  async plan() {
    return {
      ...this.declaration,
      changes: [{ path: this.declaration.path, content: this.declaration.content }],
    };
  }
  async install(writer: AdapterWriter) {
    for (const change of (await this.plan()).changes) await writer.stage(change);
  }
  async update(writer: AdapterWriter) {
    await this.install(writer);
  }
  async repair(writer: AdapterWriter) {
    await this.install(writer);
  }
  async launch() {
    this.launches++;
    return '';
  }
  async verify() {
    return this.inspect();
  }
  async uninstall(writer: AdapterWriter) {
    await writer.stage({ path: this.declaration.path, content: Buffer.from('{}\n') });
  }
  async revoke(grant: Grant) {
    if (!this.supportsRevoke) return false;
    this.revoked.push(grant.id);
    this.grant = undefined;
    return true;
  }
}
