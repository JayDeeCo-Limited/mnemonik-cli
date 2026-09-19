import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { runPreflight, type PreflightDependencies } from '../src/preflight.js';
import { enableHostDiscovery } from './setup/hostDiscovery.js';

// The suite runs on developer machines with Claude Code, Codex and Cursor
// installed and on CI runners with none. Either way a fixture that forgets to
// stub discovery must see no editors: the shared setup blinds both lookups.
const offline = (root: string): PreflightDependencies => ({
  cwd: root,
  platform: 'linux',
  fetch: async () => new Response('{}'),
  resolveIdentity: async () => ({
    kind: 'absent',
    root,
    repository: { kind: 'plain', root },
    nested: [],
  }),
  execFile: async () => {
    throw new Error('discovery must not spawn');
  },
});
const scratch: string[] = [];
afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

it('a fixture that does not stub discovery sees no editors on the machine running it', async () => {
  const result = await runPreflight({ ...offline(homedir()), home: homedir() });
  expect(result.hosts).toEqual([]);
});

it('enableHostDiscovery restores the real lookups for a home and PATH the test owns', async () => {
  await enableHostDiscovery();
  const home = await mkdtemp(join(tmpdir(), 'host-discovery-'));
  scratch.push(home);
  await mkdir(join(home, '.codex'), { recursive: true });
  await writeFile(join(home, '.codex', 'config.toml'), '');
  const bin = join(home, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'cursor'), '#!/bin/sh\n');
  await chmod(join(bin, 'cursor'), 0o755);
  const result = await runPreflight({ ...offline(home), home, env: { PATH: bin } });
  expect(result.hosts.map((host) => [host.name, host.path])).toEqual([
    ['Codex', join(home, '.codex', 'config.toml')],
    ['Cursor', join(bin, 'cursor')],
  ]);
});
