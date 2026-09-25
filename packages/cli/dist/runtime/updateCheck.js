import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from '@mnemonik/local-setup';
/**
 * The last full `mnemonik update` on this machine, automatic or by hand. The
 * readiness report carries it, so the console can say when an automatic update
 * did not finish instead of leaving a machine quietly behind.
 */
const updateCheckPath = (stateDir) => join(stateDir, 'update-check.json');
export async function recordUpdateCheck(stateDir, result, now = Date.now) {
    const check = { checkedAt: new Date(now()).toISOString(), result };
    try {
        await atomicWrite(updateCheckPath(stateDir), Buffer.from(`${JSON.stringify(check)}\n`));
    }
    catch {
        // The record describes the update; failing to write it must not fail the update.
    }
}
export async function readUpdateCheck(stateDir) {
    try {
        const value = JSON.parse(await readFile(updateCheckPath(stateDir), 'utf8'));
        const { checkedAt, result } = (value ?? {});
        if (typeof checkedAt !== 'string' ||
            !Number.isFinite(Date.parse(checkedAt)) ||
            !['updated', 'current', 'failed'].includes(String(result)))
            return undefined;
        return { checkedAt, result: result };
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=updateCheck.js.map