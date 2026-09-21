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
    openBrowser?: (url: string) => Promise<void>;
    fetch?: typeof fetch;
    sleep?: (milliseconds: number) => Promise<void>;
    now?: () => number;
}
/** Shown with every device code, byte for byte, as required by the OAuth contract. */
export declare const DEVICE_WARNING = "Approve only a request on a device you control.";
export declare const DEVICE_APPROVAL_INSTRUCTION = "Please approve the device by opening the link below.";
export declare const REPOSITORY_APPROVAL_INSTRUCTION = "Please choose your repositories by opening the link below.";
export interface DeviceResult {
    clientId: string;
    tokens: CliTokenResponse;
}
export declare function runDeviceFlow(options: DeviceOptions): Promise<DeviceResult>;
//# sourceMappingURL=device.d.ts.map