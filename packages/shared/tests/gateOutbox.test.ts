import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  GATE_OUTBOX_CAP,
  GATE_OUTBOX_MAX_AGE_MS,
  GATE_OUTBOX_MAX_EVENTS,
  GATE_OUTBOX_STRAY_MS,
  queueGateEvent,
  returnGateEvents,
  takeGateEvents,
} from '../src/gateOutbox.js';

// Gate telemetry rides the session's next injections request instead of an
// awaited POST of its own (about 30% of a PreToolUse hook's process time on
// 26 October 2026). These pin the queue: claimed once, bounded, re-sendable,
// never throws.

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});
async function outbox(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mnemonik-gate-outbox-'));
  roots.push(root);
  return join(root, 'session', 'gate-outbox');
}
const event = (outcome: string, at = Date.now()) => ({
  tool: 'Bash',
  mode: 'advisory',
  outcome,
  at,
});

test('queued events are taken once, oldest first, each with its own id', async () => {
  const folder = await outbox();
  const now = Date.now();
  assert.equal(queueGateEvent(folder, event('b', now)), true);
  queueGateEvent(folder, event('a', now - 10));
  const taken = takeGateEvents(folder);
  assert.deepEqual(
    taken.map((e) => e.outcome),
    ['a', 'b']
  );
  assert.equal(new Set(taken.map((e) => e.id)).size, 2);
  // A second request of the same session finds nothing to send twice.
  assert.deepEqual(takeGateEvents(folder), []);
});

test('events a request could not deliver go back, with the same ids', async () => {
  const folder = await outbox();
  queueGateEvent(folder, event('x'));
  const taken = takeGateEvents(folder);
  returnGateEvents(folder, taken);
  assert.deepEqual(
    takeGateEvents(folder).map((e) => e.id),
    taken.map((e) => e.id)
  );
});

test('an empty or missing outbox yields nothing', async () => {
  assert.deepEqual(takeGateEvents(await outbox()), []);
});

test('stale and malformed events are dropped; a request carries at most the cap', async () => {
  const folder = await outbox();
  const now = Date.now();
  queueGateEvent(folder, event('stale', now - GATE_OUTBOX_MAX_AGE_MS - 1));
  for (let i = 0; i < GATE_OUTBOX_MAX_EVENTS + 5; i += 1)
    queueGateEvent(folder, event(`e${i}`, now));
  await writeFile(join(folder, '999999999999999-torn.json'), '{"tool":"Bash"');
  const first = takeGateEvents(folder, now);
  assert.equal(first.length, GATE_OUTBOX_MAX_EVENTS);
  assert.ok(first.every((e) => e.outcome !== 'stale'));
  const rest = takeGateEvents(folder, now);
  assert.equal(first.length + rest.length, GATE_OUTBOX_MAX_EVENTS + 5);
  assert.ok(GATE_OUTBOX_MAX_AGE_MS >= 24 * 60 * 60 * 1000);
});

test('a queue that cannot be written reports false instead of throwing', async () => {
  // A regular file where the session folder should be: no folder can be made.
  const folder = await outbox();
  queueGateEvent(folder, event('x'));
  const file = join(folder, 'not-a-folder');
  await writeFile(file, 'x');
  assert.equal(queueGateEvent(join(file, 'gate-outbox'), event('y')), false);
});

test('the outbox holds at most the cap, dropping the oldest', async () => {
  // A server that stays unreachable: every request returns its events.
  const folder = await outbox();
  const now = Date.now();
  for (let i = 0; i < GATE_OUTBOX_CAP + 20; i += 1) queueGateEvent(folder, event(`e${i}`, now + i));
  const queued = readdirSync(folder).filter((name) => name.endsWith('.json'));
  assert.equal(queued.length, GATE_OUTBOX_CAP);
  const taken = takeGateEvents(folder, now + GATE_OUTBOX_CAP + 20);
  assert.equal(taken[0]?.outcome, 'e20');
  returnGateEvents(folder, taken);
  queueGateEvent(folder, event('newest', now + GATE_OUTBOX_CAP + 21));
  assert.equal(
    readdirSync(folder).filter((name) => name.endsWith('.json')).length,
    GATE_OUTBOX_CAP
  );
});

test('temporary and claimed files a killed hook left are swept after ten minutes', async () => {
  const folder = await outbox();
  queueGateEvent(folder, event('x'));
  const strayTmp = join(folder, '.000000000000001-a.json.tmp');
  const strayClaim = join(folder, '.000000000000002-b.json.123.claimed');
  const freshTmp = join(folder, '.000000000000003-c.json.tmp');
  for (const path of [strayTmp, strayClaim, freshTmp]) await writeFile(path, '{}');
  const old = new Date(Date.now() - GATE_OUTBOX_STRAY_MS - 60_000);
  await utimes(strayTmp, old, old);
  await utimes(strayClaim, old, old);
  assert.equal(takeGateEvents(folder).length, 1);
  assert.deepEqual(readdirSync(folder).sort(), ['.000000000000003-c.json.tmp']);
});
