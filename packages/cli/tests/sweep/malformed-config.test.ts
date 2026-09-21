import { afterEach, describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { hostOrder, type HostName } from '../../src/install/adapters.js';
import { makeSweepFixture, type SweepFixture } from '../fixtures/sweep.js';

const fixtures: SweepFixture[] = [];
afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup())));

const cases: Array<{ host: HostName; bytes: string; reason: string }> = [
  { host: 'claude-code', bytes: '{"mcpServers":', reason: 'invalid_json' },
  { host: 'codex', bytes: '[mcp_servers.mnemonik\ncommand =', reason: 'invalid_toml' },
  { host: 'cursor', bytes: '{"schemaVersion":999,"foreign":true}\n', reason: 'foreign_schema' },
];

describe('malformed host configuration', () => {
  it.each(cases)('$host is refused by name while the other hosts install', async (testCase) => {
    const fixture = await makeSweepFixture();
    fixtures.push(fixture);
    const adapter = fixture.adapters.find((candidate) => candidate.name === testCase.host)!;
    await writeFile(fixture.hostPaths[testCase.host], testCase.bytes, { mode: 0o600 });
    adapter.detect = async () => ({
      supported: false,
      version: 'unreadable',
      reason: testCase.reason,
    });

    expect(await fixture.run()).toBe(3);
    expect(fixture.stdout.text).toContain(`${testCase.host}: ${testCase.reason}.`);
    expect(await readFile(fixture.hostPaths[testCase.host], 'utf8')).toBe(testCase.bytes);
    const journal = await fixture.journal();
    expect(journal.state).toBe('LIMITED');
    expect(journal.hosts).not.toContain(testCase.host);
    expect(journal.targets.filter((target) => target.kind === 'host')).toHaveLength(2);
    for (const host of hostOrder.filter((host) => host !== testCase.host))
      expect(await readFile(fixture.hostPaths[host], 'utf8')).toContain(`"mnemonik":"${host}"`);
  });

  for (const host of hostOrder)
    it.todo(`connect ${host} repeats the install-time malformed-config reason`, () => {});
});
