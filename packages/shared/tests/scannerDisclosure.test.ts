import assert from 'node:assert/strict';
import test from 'node:test';
import { disclosureCovers } from '../src/scannerDisclosure.js';

test('an acceptance covers the notice it names', () => {
  assert.equal(disclosureCovers('2026.09.1', '2026.09.1'), true);
  assert.equal(disclosureCovers(undefined, '2026.09.1'), false);
  assert.equal(disclosureCovers(null, '2026.09.1'), false);
  assert.equal(disclosureCovers('2026.08.1', '2026.09.1'), false);
});

test('the withdrawn 2026.09.2 wording covers 2026.09.1, never the reverse', () => {
  // 2026.09.2 changed one word of 2026.09.1 and was withdrawn: a person who
  // accepted it accepted the same notice.
  assert.equal(disclosureCovers('2026.09.2', '2026.09.1'), true);
  // A 7.110-7.111 scanner checks for 2026.09.2 exactly and pauses without it,
  // so a 2026.09.1 acceptance must never install one.
  assert.equal(disclosureCovers('2026.09.1', '2026.09.2'), false);
});
