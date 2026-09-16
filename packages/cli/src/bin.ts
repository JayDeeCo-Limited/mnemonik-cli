#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { bootstrap } from './runtime/bootstrap.js';

try {
  process.exitCode = await bootstrap(process.argv.slice(2), fileURLToPath(import.meta.url));
} catch (error) {
  const reason =
    error &&
    typeof error === 'object' &&
    'name' in error &&
    error.name === 'RuntimeError' &&
    'reason' in error &&
    typeof error.reason === 'string'
      ? error.reason
      : error instanceof Error && error.message
        ? error.message
        : 'runtime_failed';
  if (reason === 'lock_held') {
    if (process.argv.includes('--json'))
      process.stdout.write(`${JSON.stringify({ status: 'FAILED', reason })}\n`);
    else
      process.stderr.write('Another mnemonik command holds the state lock; retry in a moment.\n');
  } else process.stderr.write(`${reason}\n`);
  process.exitCode ??= 1;
}
