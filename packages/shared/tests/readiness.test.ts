import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describeReadiness,
  reduceReadiness,
  serializeReadiness,
  type ReadinessCondition,
  type ReadinessState,
} from '../src/readiness.js';

const cases: Array<[ReadinessCondition, ReadinessState]> = [
  [{ kind: 'selected_component_failed', reason: 'Scanner failed.' }, 'FAILED'],
  [{ kind: 'host_trust_pending', reason: 'Approve Cursor.' }, 'ACTION_REQUIRED'],
  [{ kind: 'vendor_policy_pending', reason: 'Allow the extension.' }, 'ACTION_REQUIRED'],
  [{ kind: 'hooks_missing', reason: 'Hook declaration is missing.' }, 'ACTION_REQUIRED'],
  [{ kind: 'host_not_connected', reason: 'Codex has not connected.' }, 'LIMITED'],
  [{ kind: 'scanner_omitted', reason: 'Scanner was omitted.' }, 'LIMITED'],
  [{ kind: 'project_uncovered', reason: 'Project is outside approved roots.' }, 'LIMITED'],
  [{ kind: 'post_commit_upload_failed', reason: 'Result upload failed.' }, 'FAILED'],
];

test('fixed precedence chooses the worse state for every state pair', () => {
  const rank: Record<ReadinessState, number> = {
    READY: 0,
    LIMITED: 1,
    ACTION_REQUIRED: 2,
    FAILED: 3,
  };
  assert.equal(reduceReadiness([]).state, 'READY');
  for (const [left, leftState] of cases) {
    assert.equal(reduceReadiness([left]).state, leftState);
    for (const [right, rightState] of cases) {
      const expected = rank[leftState] >= rank[rightState] ? leftState : rightState;
      assert.equal(reduceReadiness([left, right]).state, expected);
    }
  }
});

test('special cases and indexing semantics stay fixed', () => {
  assert.equal(
    reduceReadiness([
      { kind: 'scanner_omitted', reason: 'Limited Mode was acknowledged.' },
      { kind: 'selected_component_failed', reason: 'Codex failed.' },
    ]).state,
    'FAILED'
  );
  assert.equal(
    reduceReadiness([
      { kind: 'scanner_omitted', reason: 'Limited Mode was acknowledged.' },
      { kind: 'login_pending', reason: 'Sign in.' },
    ]).state,
    'ACTION_REQUIRED'
  );
  assert.deepEqual(
    reduceReadiness([{ kind: 'windows_task_creation_failed', reason: 'Access denied.' }]),
    {
      state: 'LIMITED',
      reasons: ['Access denied.'],
      actions: ['Run mnemonik scanner enable to try again.'],
    }
  );
  assert.equal(
    reduceReadiness([{ kind: 'indexing_stalled', reason: 'No heartbeat in two minutes.' }]).state,
    'FAILED'
  );
});

test('serialization keeps progress separate and omits an unattempted project', () => {
  const withProject = serializeReadiness({
    installation: { conditions: [] },
    projects: [
      {
        projectId: 'project-1',
        summary: { conditions: [] },
        indexing: { total: 3100, completed: 1240 },
      },
    ],
    generatedAt: '2026-09-11T00:00:00.000Z',
  });
  assert.equal(withProject.projects?.[0]?.summary.state, 'READY');
  assert.deepEqual(withProject.projects?.[0]?.indexing, { total: 3100, completed: 1240 });

  const omitted = serializeReadiness({
    installation: { conditions: [] },
    generatedAt: '2026-09-11T00:00:00.000Z',
  });
  assert.equal(Object.hasOwn(omitted, 'projects'), false);
  assert.equal(omitted.scanner, null);
  assert.equal(omitted.devicesAndGrants, null);
});

test('the CLI sentence names the concrete reason and action', () => {
  assert.equal(
    describeReadiness(
      reduceReadiness([
        {
          kind: 'host_skipped',
          component: 'cursor',
          reason: 'Cursor was skipped.',
        },
      ])
    ),
    'Done, with one thing left. Cursor was skipped. Connect it later: mnemonik connect cursor'
  );
});

test('completion counts reasons requiring attention and preserves the development note', () => {
  assert.equal(
    describeReadiness({ state: 'LIMITED', reasons: ['dev_release_source'], actions: [] }),
    'Done. dev_release_source.'
  );
  const reasons = Array.from({ length: 7 }, (_, index) => `problem_${index}`);
  assert.equal(
    describeReadiness({
      state: 'LIMITED',
      reasons: [...reasons, 'dev_release_source'],
      actions: ['mnemonik repair'],
    }),
    `Done, with 7 things left. ${reasons.map((reason) => `${reason}.`).join(' ')} dev_release_source. mnemonik repair`
  );
  assert.equal(
    describeReadiness({
      state: 'LIMITED',
      reasons: ['Scanner needs attention.'],
      actions: ['First action.', 'Second action.'],
    }),
    'Done, with one thing left. Scanner needs attention. First action. Second action.'
  );
});

test('optional version receipts round-trip while old schema-1 documents remain valid', async () => {
  const { isReadinessDocument } = await import('../src/readiness.js');
  const old = serializeReadiness({ installation: { conditions: [] } });
  assert.equal(isReadinessDocument(old), true);
  assert.equal(Object.hasOwn(old, 'versions'), false);
  const versions = {
    cli: '0.1.0',
    scanner: '7.95.2',
    hosts: [
      { host: 'claude_code', editor: '2.1.0', hooks: '0.10.0' },
      { host: 'codex', hooks: '0.9.0' },
    ],
  };
  const current = serializeReadiness({ installation: { conditions: [] }, versions });
  assert.deepEqual(current.versions, versions);
  assert.equal(isReadinessDocument(current), true);
  for (const invalid of [
    null,
    { cli: 12 },
    { scanner: '' },
    { cli: 'bad\nversion' },
    { cli: 'x'.repeat(129) },
    { hosts: [{ host: 'cursor', editor: true }] },
    { hosts: [{ host: 'cursor', token: 'secret' }] },
    { secret: 'no' },
  ])
    assert.equal(isReadinessDocument({ ...old, versions: invalid }), false);
});
