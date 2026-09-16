type Platform = NodeJS.Platform;
/** Local state and credential locations that Mnemonik must never scan. */
export declare function protectedLocalPaths(platform?: Platform, env?: NodeJS.ProcessEnv, home?: string): string[];
/** True when candidate is the protected path itself or lies below it. */
export declare function isProtectedLocalPath(candidate: string, protectedPaths?: readonly string[], platform?: Platform): boolean;
/** Protected paths equal to or below root, for consent auto-exclusions. */
export declare function protectedPathsWithinRoot(root: string, protectedPaths?: readonly string[], platform?: Platform): string[];
export {};
//# sourceMappingURL=protectedPaths.d.ts.map