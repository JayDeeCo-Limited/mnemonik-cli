/** How the CLI looks for editors on this machine: a config file under the home
 * directory, or a binary on PATH. Every default lives here so the test setup can
 * replace both in one place; a fixture must never see the editors installed on
 * the machine that runs it. */
export interface HostDiscovery {
    pathExists(path: string): Promise<boolean>;
    binaryExists(file: string): Promise<boolean>;
}
export declare const hostDiscovery: HostDiscovery;
//# sourceMappingURL=hostDiscovery.d.ts.map