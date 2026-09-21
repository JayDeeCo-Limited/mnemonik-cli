import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const source = readFileSync('package/dist/vendor/shared/runtimeSigners.js', 'utf8');
const variants = [
  ['fixed', source],
  ['get-acl-reverted', source.replace('[System.IO.File]::GetAccessControl($path)', '(Get-Acl -LiteralPath $path)')],
  ['remove-grants-reverted', source.replace("...(created ? ['/remove:g', '*S-1-5-32-544', '*S-1-5-18'] : [])", '')],
  ['local-alias-reverted', source.replace(' || ownAlias', '')],
];
let fixed;
for (const [label, code] of variants) {
  if (label !== 'fixed') assert.notEqual(code, source, 'mutation must change code');
  const file = resolve(`${label}.mjs`);
  writeFileSync(file, code);
  const api = await import(pathToFileURL(file));
  if (label === 'fixed') fixed = api;
  const directory = join(process.env.RUNNER_TEMP, label);
  mkdirSync(directory, { mode: 0o700 });
  try {
    await assert.doesNotReject(api.protectWindowsDirectory(directory, true));
    assert.equal(label, 'fixed', 'reverted fix unexpectedly passed');
    console.log(`BASELINE_GREEN=${label}`);
  } catch (error) {
    if (label === 'fixed' || error.message.includes('unexpectedly passed')) throw error;
    console.log(`MUTATION_RED=${label}: ${error.actual?.message?.match(/acl_(?:permissions|owner|unavailable)/)?.[0] ?? error.actual?.code ?? error.code}`);
  }
}
for (const principal of ['S-1-5-32-544', 'S-1-5-18', 'S-1-1-0']) {
  const directory = join(process.env.RUNNER_TEMP, `shared-${principal}`);
  mkdirSync(directory, { mode: 0o700 });
  await fixed.protectWindowsDirectory(directory, true);
  execFileSync('icacls.exe', [directory, '/grant', `*${principal}:(OI)(CI)R`]);
  // A new module has no per-session receipt for this existing directory.
  const file = resolve(`shared-${principal}.mjs`);
  writeFileSync(file, source);
  const fresh = await import(pathToFileURL(file));
  // Remove the receipt created for this fixture so this verifies the ACL itself.
  const { unlinkSync } = await import('node:fs');
  unlinkSync(join(directory, '.windows-acl.json'));
  await assert.rejects(fresh.protectWindowsDirectory(directory, false), /acl_permissions/);
  console.log(`SHARED_REFUSED=${principal}`);
}
const directory = join(process.env.RUNNER_TEMP, 'foreign-owner');
mkdirSync(directory, { mode: 0o700 });
await fixed.protectWindowsDirectory(directory, true);
execFileSync('icacls.exe', [directory, '/setowner', '*S-1-5-18']);
const { unlinkSync } = await import('node:fs');
unlinkSync(join(directory, '.windows-acl.json'));
writeFileSync('foreign.mjs', source);
const foreign = await import(pathToFileURL(resolve('foreign.mjs')));
await assert.rejects(foreign.protectWindowsDirectory(directory, false), /acl_owner/);
console.log('FOREIGN_OWNER_REFUSED=SYSTEM');
