import { type RuntimeSource } from '../runtime/store.js';
import { type ScannerServiceOptions } from './service.js';
/**
 * The release names a newer disclosure than the saved consent. Nothing was
 * installed and the running scanner was left as it was; a person has to
 * approve the updated notice (the same browser approval install uses).
 */
export declare class ScannerConsentRequired extends Error {
    constructor();
}
export declare function updateScanner(options: ScannerServiceOptions, source?: () => Promise<RuntimeSource>): Promise<import("../runtime/store.js").Verified>;
//# sourceMappingURL=update.d.ts.map