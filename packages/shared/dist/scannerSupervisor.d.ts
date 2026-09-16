export declare const WINDOWS_SERVICE_BUDGET_MS = 120000;
export interface ServiceDefinition {
    /** Test isolation; production always uses mnemonik-scanner.service. */
    unitName?: string;
    binaryPath: string;
    arguments: readonly ['start'];
    workingDirectory: string;
    environment: Readonly<Record<string, string>>;
    credentialFamilyId?: string;
    runAtLogin: true;
    restart: {
        policy: 'on-failure';
        delayMs: number;
    };
    logDestination: string;
}
export interface SupervisorStatus {
    kind: string;
    installed: boolean;
    running: boolean;
    pid: number | null;
    binaryPath?: string;
    reason?: string;
}
export type ServiceOperation = 'install' | 'uninstall' | 'start' | 'stop' | 'status';
export type ServiceResult = {
    status: 'ok';
    supervisor: SupervisorStatus;
} | {
    status: 'LIMITED';
    reason: string;
    detail: string;
    action: string;
};
//# sourceMappingURL=scannerSupervisor.d.ts.map