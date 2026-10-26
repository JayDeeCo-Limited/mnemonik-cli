/**
 * Never use bytes from the packaged scanner's extracted runtime unchecked
 * (review of 26 Oct 2026). JavaScript is checked as it loads
 * (packages/scanner/src/verifiedLoader.cts); this covers what is read with fs
 * and then run or parsed as code: the grammar WebAssembly, web-tree-sitter's
 * own runtime WebAssembly and the tag queries. The caller passes the buffer it
 * is about to use, so the bytes checked are the bytes used.
 *
 * The packaged executable's entry point publishes the embedded assets' hashes
 * on globalThis (and runtimeWorker.ts in each worker). Anywhere else, in
 * development, tests and on the server, there is nothing to check against and
 * this does nothing.
 */
import { createHash } from 'node:crypto';
import { relative, sep } from 'node:path';
const RUNTIME = Symbol.for('mnemonik.sea.verifiedLoader');
/** Bytes that are not the embedded asset they must be. */
export class RuntimeAssetError extends Error {
}
function runtime() {
    return globalThis[RUNTIME];
}
/** Whether this process runs from the packaged executable's verified runtime. */
export function inVerifiedRuntime() {
    return runtime() !== undefined;
}
/**
 * Check bytes read from `path` against the embedded asset they must equal.
 * Throws `mnemonik_asset_integrity` when they differ and
 * `mnemonik_unverified_asset` for a path that is not an embedded asset.
 */
export function verifyRuntimeAsset(path, bytes) {
    const verified = runtime();
    if (!verified)
        return;
    const key = relative(verified.root, path).split(sep).join('/');
    const expected = key.startsWith('../') || key === '..' ? undefined : verified.hashes.get(key);
    if (!expected)
        throw new RuntimeAssetError(`mnemonik_unverified_asset: ${path}`);
    if (createHash('sha256').update(bytes).digest('hex') !== expected)
        throw new RuntimeAssetError(`mnemonik_asset_integrity: ${key}`);
}
//# sourceMappingURL=runtimeAssets.js.map