import { execFile as nodeExecFile } from 'node:child_process';
import type { SecretStore } from './contracts.js';
type Options = {
    platform?: NodeJS.Platform;
    execFile?: typeof nodeExecFile;
};
/** CLI wiring opts in. Production availability/failure is shared for this process. */
export declare function osSecretStore(options?: Options): SecretStore | undefined;
export {};
//# sourceMappingURL=osSecretStore.d.ts.map