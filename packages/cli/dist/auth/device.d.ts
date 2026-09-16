import type { CliTokenResponse } from '@mnemonik/credentials';
export interface DeviceOptions {
    scannerRoots?: string;
    deviceInstallationId?: string;
    deviceInstallationIds?: string[];
    issuer: string;
    resource: string;
    scopes: readonly string[];
    clientId: string;
    deviceName: string;
    print: (line: string) => void;
    fetch?: typeof fetch;
    sleep?: (milliseconds: number) => Promise<void>;
    now?: () => number;
}
/** Shown with every device code, byte for byte, as required by the OAuth contract. */
export declare const DEVICE_WARNING = "Approve only a request you just started on a device you control. Compare this code with the one in that device's terminal. If you received this code or link from someone else, deny it.";
export interface DeviceResult {
    clientId: string;
    tokens: CliTokenResponse;
}
export declare function runDeviceFlow(options: DeviceOptions): Promise<DeviceResult>;
//# sourceMappingURL=device.d.ts.map