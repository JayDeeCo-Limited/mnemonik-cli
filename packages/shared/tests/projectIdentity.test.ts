import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseIdentityFile, readIdentityFile } from '../src/projectIdentityFile.js';
import { resolveProjectIdentity, resolveRepositoryRoot } from '../src/repositoryRoot.js';
import { runIdentityFixtureSuite } from '../test-fixtures/identity/runner.mjs';

runIdentityFixtureSuite(test, {
  parse: parseIdentityFile,
  read: readIdentityFile,
  resolveRoot: resolveRepositoryRoot,
  resolve: resolveProjectIdentity,
});

test('schema-v1 field type errors are malformed', () => {
  const projectId = '11111111-1111-4111-8111-111111111111';
  for (const value of [
    { schemaVersion: 1, projectId: 42 },
    { schemaVersion: 1, projectId, projectName: null },
    { schemaVersion: 1, projectId, repositoryFingerprint: [] },
    { schemaVersion: 1, projectId, repositoryFingerprint: { algorithmVersion: 2, hash: 'x' } },
  ]) {
    assert.equal(parseIdentityFile(JSON.stringify(value)).kind, 'malformed');
  }
});

test('schema-v1 rejects unknown keys and names them', () => {
  for (const value of [
    {
      schemaVersion: 1,
      projectId: '11111111-1111-4111-8111-111111111111',
      accessToken: 'Bearer secret',
    },
    {
      schemaVersion: 1,
      projectId: '11111111-1111-4111-8111-111111111111',
      repositoryFingerprint: { algorithmVersion: 1, hash: 'x', secret: 'value' },
    },
  ]) {
    const result = parseIdentityFile(JSON.stringify(value));
    assert.equal(result.kind, 'malformed');
    assert.match(result.detail, /accessToken|secret/);
  }
});

test('schema-v1 requires canonical RFC 4122 UUID spelling', () => {
  for (const projectId of [
    '11111111-1111-1111-1111-111111111111',
    '11111111-1111-4111-7111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'.toUpperCase(),
  ]) {
    assert.equal(
      parseIdentityFile(JSON.stringify({ schemaVersion: 1, projectId })).kind,
      'malformed'
    );
  }
});

test('only a selected regular JSON object without a project id is treated as unassigned', async () => {
  const { mkdtemp, writeFile, rm, symlink } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'selected-identity-'));
  const path = join(root, '.mnemonik.json');
  try {
    for (const text of ['{}', '{"scan":{"enabled":true}}', '{"schemaVersion":1}']) {
      await writeFile(path, text);
      assert.notEqual((await readIdentityFile(root)).kind, 'absent');
      assert.equal((await readIdentityFile(root, { selectedRoot: true })).kind, 'absent');
    }
    for (const text of ['{', 'null', '[]', '{"projectId":null}', '{"projectId":"invalid"}']) {
      await writeFile(path, text);
      assert.notEqual((await readIdentityFile(root, { selectedRoot: true })).kind, 'absent');
    }
    if (process.platform !== 'win32') {
      await rm(path);
      const target = join(root, 'other.json');
      await writeFile(target, '{}');
      await symlink(target, path);
      assert.equal((await readIdentityFile(root, { selectedRoot: true })).kind, 'malformed');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
