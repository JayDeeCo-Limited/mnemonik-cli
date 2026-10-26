/** Bytes that are not the embedded asset they must be. */
export declare class RuntimeAssetError extends Error {
}
/** Whether this process runs from the packaged executable's verified runtime. */
export declare function inVerifiedRuntime(): boolean;
/**
 * Check bytes read from `path` against the embedded asset they must equal.
 * Throws `mnemonik_asset_integrity` when they differ and
 * `mnemonik_unverified_asset` for a path that is not an embedded asset.
 */
export declare function verifyRuntimeAsset(path: string, bytes: Uint8Array): void;
//# sourceMappingURL=runtimeAssets.d.ts.map