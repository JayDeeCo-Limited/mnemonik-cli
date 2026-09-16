import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeRemote, selectRemote } from '../src/repositoryFingerprint.js';

const golden = JSON.parse(
  readFileSync(new URL('./fixtures/repository-fingerprint-v1.golden.json', import.meta.url), 'utf8')
);
for (const row of golden.remotes) {
  test(`${row.group}/${row.name}`, () =>
    assert.deepEqual(canonicalizeRemote(row.url), row.expected));
}
for (const row of golden.selections) {
  test(`selection/${row.name}`, () => assert.deepEqual(selectRemote(row.remotes), row.expected));
}
test('all golden hashes are SHA-256 of the exact canonical UTF-8', () => {
  for (const row of [...golden.remotes, ...golden.selections]) {
    const expected = row.expected.fingerprint ?? row.expected;
    if (expected.canonical)
      assert.equal(
        expected.hash,
        createHash('sha256').update(expected.canonical, 'utf8').digest('hex')
      );
  }
});
