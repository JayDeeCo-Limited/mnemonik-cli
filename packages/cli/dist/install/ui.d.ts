import type { Readable } from 'node:stream';
import type { Output } from '../output.js';
import type { InstallDependencies, InstallUI } from './transaction.js';
export declare function terminalInstallUI(input: Readable, output: Output, roots: InstallUI['roots']): {
    ui: InstallUI;
    signal: AbortSignal;
    close(): void;
};
/** Explicit simulation: all declarations stay under state/install-simulation. */
export declare function simulatedInstall(state?: string): Omit<InstallDependencies, 'ui'> & {
    roots: InstallUI['roots'];
};
export declare function chooseHostProfile(input: Readable, output: Output, profiles: string[]): Promise<string | undefined>;
//# sourceMappingURL=ui.d.ts.map