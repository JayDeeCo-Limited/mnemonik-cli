/**
 * The name the owner gave this machine, sent once at sign-in (L-44). On macOS
 * that is the Computer Name ("Mac Mini"), not the network host name a router
 * hands out ("home.localdomain"); on Windows and Linux the host name is the
 * name the owner set. A rename in the console outranks it on the server.
 */
export declare function machineName(platform?: NodeJS.Platform, computerName?: () => Promise<string>): Promise<string>;
//# sourceMappingURL=machineName.d.ts.map