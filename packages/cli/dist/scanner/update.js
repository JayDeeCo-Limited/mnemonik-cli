import { atomicWrite, withLock } from '@mnemonik/local-setup';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RuntimeStore, updateRuntime } from '../runtime/store.js';
import { releaseSource } from '../runtime/releaseSource.js';
import { scannerService } from './service.js';
import { controlScanner } from './control.js';
import { scannerStateBytes } from './enable.js';
export async function updateScanner(options, source = () => releaseSource('scanner')) {
    const store = options.store ??
        new RuntimeStore(options.stateDir, undefined, {
            allowUnsigned: !!process.env.MNEMONIK_DEV_RELEASE_DIR,
        });
    const service = scannerService({ ...options, store });
    const checkedSource = async () => {
        return withLock(join(options.stateDir, 'scanner/enable'), 5000, async () => {
            const candidate = await source();
            const state = JSON.parse(await readFile(join(options.stateDir, 'scanner/state.json'), 'utf8'));
            if (candidate.manifest.disclosureVersion &&
                candidate.manifest.disclosureVersion !== state.consent?.disclosureVersion) {
                if ((await service.status()).running)
                    await controlScanner('pause', { ...options, store });
                else {
                    state.paused = true;
                    await atomicWrite(join(options.stateDir, 'scanner/state.json'), scannerStateBytes(state));
                }
                throw new Error('release_consent_required: mnemonik scanner enable');
            }
            return candidate;
        });
    };
    return updateRuntime({
        store,
        source: checkedSource,
        restartManagedServices: async () => {
            await service.restart();
        },
    });
}
//# sourceMappingURL=update.js.map