#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { bootstrapFailureMessage, humanReason, humanReport } from './humanReason.js';
import { bootstrap } from './runtime/bootstrap.js';
try {
    process.exitCode = await bootstrap(process.argv.slice(2), fileURLToPath(import.meta.url));
}
catch (error) {
    const reason = error &&
        typeof error === 'object' &&
        'name' in error &&
        error.name === 'RuntimeError' &&
        'reason' in error &&
        typeof error.reason === 'string'
        ? error.reason
        : error instanceof Error && error.message
            ? error.message
            : 'runtime_failed';
    if (process.argv.includes('--json')) {
        if (reason === 'lock_held')
            process.stdout.write(`${JSON.stringify({ status: 'FAILED', reason })}\n`);
        else
            process.stderr.write(`${reason}\n`);
    }
    else
        process.stderr.write(`${reason === 'lock_held' ? humanReason(reason) : process.argv.includes('install') ? bootstrapFailureMessage : humanReport(reason)}\n`);
    process.exitCode ??= 1;
}
//# sourceMappingURL=bin.js.map