import type { ReadinessUpdateCheck } from '@mnemonik/shared';
export declare function recordUpdateCheck(stateDir: string, result: ReadinessUpdateCheck['result'], now?: () => number): Promise<void>;
export declare function readUpdateCheck(stateDir: string): Promise<ReadinessUpdateCheck | undefined>;
//# sourceMappingURL=updateCheck.d.ts.map