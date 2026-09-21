import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { bytesAt } from './journal.js';
export const launchHosts = ['claude-code', 'codex', 'cursor'];
export const hostOrder = launchHosts;
export const launchHostLabels = {
    'claude-code': 'Claude Code',
    codex: 'Codex',
    cursor: 'Cursor',
};
// The caller supplies a freshly verified store result, never an npm cache path.
const loadAdapter = (runtime) => import(pathToFileURL(join(dirname(runtime.entry), 'adapter.js')).href);
export const hostPackageImports = {
    'claude-code': loadAdapter,
    codex: loadAdapter,
    cursor: loadAdapter,
};
export class SimulatedHostAdapter {
    name;
    declaration;
    supportsRevoke;
    grant;
    authenticatedTools = true;
    launches = 0;
    revoked = [];
    revokeAction;
    constructor(name, declaration, supportsRevoke = true) {
        this.name = name;
        this.declaration = declaration;
        this.supportsRevoke = supportsRevoke;
        this.revokeAction = `Open ${name} connection settings and revoke the Mnemonik connection.`;
    }
    async detect() {
        return { supported: true, version: 'simulated' };
    }
    capabilities() {
        return {
            scopes: ['user', 'project'],
            components: ['hooks', 'mcp'],
            nativeConnect: true,
            revoke: this.supportsRevoke,
        };
    }
    async inspect() {
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
    async install(writer) {
        for (const change of (await this.plan()).changes)
            await writer.stage(change);
    }
    async update(writer) {
        await this.install(writer);
    }
    async repair(writer) {
        await this.install(writer);
    }
    async launch() {
        this.launches++;
        return '';
    }
    async verify() {
        return this.inspect();
    }
    async uninstall(writer) {
        await writer.stage({ path: this.declaration.path, content: Buffer.from('{}\n') });
    }
    async revoke(grant) {
        if (!this.supportsRevoke)
            return false;
        this.revoked.push(grant.id);
        this.grant = undefined;
        return true;
    }
}
//# sourceMappingURL=adapters.js.map