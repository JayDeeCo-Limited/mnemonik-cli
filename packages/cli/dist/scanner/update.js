import { withLock } from '@mnemonik/local-setup';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RuntimeStore, updateRuntime } from '../runtime/store.js';
import { releaseSource } from '../runtime/releaseSource.js';
import { scannerService } from './service.js';
import { resumeAbandonedPause } from './control.js';
/**
 * The release names a newer disclosure than the saved consent. Nothing was
 * installed and the running scanner was left as it was; a person has to
 * approve the updated notice (the same browser approval install uses).
 */
export class ScannerConsentRequired extends Error {
    constructor() {
        super('release_consent_required');
        this.name = 'ScannerConsentRequired';
    }
}
export async function updateScanner(options, source = () => releaseSource('scanner')) {
    const store = options.store ??
        new RuntimeStore(options.stateDir, undefined, {
            allowUnsigned: !!process.env.MNEMONIK_DEV_RELEASE_DIR,
        });
    let service = scannerService({ ...options, store });
    let retainedSupervisor = false;
    const before = await store.verifyRuntime('scanner');
    await service.recover();
    // An update restarts the scanner from its saved state, which a dead install's pause marks paused.
    if (await resumeAbandonedPause({ ...options, store }))
        options.onAbandonedPauseResumed?.();
    let replacement = false;
    const checkedSource = async () => {
        return withLock(join(options.stateDir, 'scanner/enable'), 5000, async () => {
            const candidate = await source();
            const state = JSON.parse(await readFile(join(options.stateDir, 'scanner/state.json'), 'utf8'));
            if (candidate.manifest.disclosureVersion &&
                candidate.manifest.disclosureVersion !== state.consent?.disclosureVersion) {
                // The running release still has valid consent. Reject the new release without
                // suspending indexing that the person already approved.
                throw new ScannerConsentRequired();
            }
            replacement = candidate.manifest.version !== before.reference.version;
            return candidate;
        });
    };
    if ((options.platform ?? process.platform) === 'darwin') {
        return withLock(join(options.stateDir, 'scanner/replace'), 5000, async () => {
            const candidate = await checkedSource();
            // Stage the complete, verified release without changing what the old scanner reads.
            const runtime = await store.stageRuntime('scanner', candidate.manifest.version, candidate);
            if (!replacement) {
                const candidateService = scannerService({ ...options, store, supervisorRuntime: runtime });
                const active = await candidateService.status();
                if (active.running && active.binaryPath === runtime.entry) {
                    await candidateService.start();
                    return runtime;
                }
            }
            const pointer = await readFile(store.pointerPath('scanner'), 'utf8');
            const current = JSON.parse(pointer);
            await service.replace(runtime, {
                pointer: {
                    after: current.current.version === runtime.reference.version &&
                        current.current.manifestSha256 === runtime.reference.manifestSha256
                        ? pointer
                        : JSON.stringify({ current: runtime.reference, previous: current.current }),
                },
            });
            return runtime;
        });
    }
    return updateRuntime({
        store,
        source: checkedSource,
        restartManagedServices: async () => {
            if (replacement && !retainedSupervisor) {
                service = scannerService({
                    ...options,
                    store,
                    supervisorRuntime: await store.verifyRuntime('scanner'),
                });
                retainedSupervisor = true;
            }
            if (replacement)
                await service.restart();
            else
                await service.start();
        },
    });
}
//# sourceMappingURL=update.js.map