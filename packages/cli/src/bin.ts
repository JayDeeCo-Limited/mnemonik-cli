#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { helpScreen } from './help.js';
import { bootstrapFailureMessage, humanReason, humanReport } from './humanReason.js';
import { bootstrap } from './runtime/bootstrap.js';

const args = process.argv.slice(2);
const helpIndex = args.findIndex(
  (argument) => argument === '--help' || argument.startsWith('--help=')
);

if (helpIndex !== -1) {
  const positionals = args.slice(0, helpIndex).filter((argument) => !argument.startsWith('--'));
  const screen = helpScreen(positionals);
  process.stdout.write(screen ?? helpScreen(positionals.slice(0, 1)) ?? helpScreen([]) ?? '');
  process.exitCode = screen ? 0 : 2;
} else {
  try {
    process.exitCode = await bootstrap(args, fileURLToPath(import.meta.url));
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
    if (process.argv.includes('--json')) {
      if (reason === 'lock_held')
        process.stdout.write(`${JSON.stringify({ status: 'FAILED', reason })}\n`);
      else process.stderr.write(`${reason}\n`);
    } else
      process.stderr.write(
        `${reason === 'lock_held' ? humanReason(reason) : process.argv.includes('install') ? bootstrapFailureMessage : humanReport(reason)}\n`
      );
    process.exitCode ??= 1;
  }
}
