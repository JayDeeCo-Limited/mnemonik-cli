import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { URLSearchParams } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { readInstallation, readInstallations, saveInstallation } from '../src/installation.js';
import { RuntimeStore } from '../src/runtime/store.js';
import { createCliAuth } from '../src/auth/index.js';
import { createCredentialAdapter } from '@mnemonik/credentials';
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture(ids: string[] = []) {
  const state = await mkdtemp(join(tmpdir(), 'installation-'));
  dirs.push(state);
  await mkdir(join(state, 'scanner'));
  await writeFile(
    join(state, 'scanner/state.json'),
    JSON.stringify({ config: { deviceInstallationId: 'retired' } })
  );
  await writeFile(
    join(state, 'host-ownership.json'),
    JSON.stringify({
      schemaVersion: 1,
      generation: 1,
      targets: ids.map((id, i) => ({
        id: String(i),
        profilePath: '/fixture',
        component: 'mcp',
        files: [],
        grant: { installationId: id },
      })),
    })
  );
  return state;
}
it('recovers unique host identity before retired scanner state and persists it privately', async () => {
  const state = await fixture(['owned', 'owned']);
  expect(await readInstallation(state)).toBe('owned');
  expect((await stat(join(state, 'installation.json'))).mode & 0o777).toBe(0o600);
  await writeFile(join(state, 'host-ownership.json'), '{}');
  expect(await readInstallation(state)).toBe('owned');
});
it('durable identity wins over conflicting legacy sources', async () => {
  const state = await fixture(['one', 'two']);
  await saveInstallation(state, 'durable');
  expect(await readInstallation(state)).toBe('durable');
  await expect(saveInstallation(state, 'different')).rejects.toThrow('installation_conflict');
});
it('refuses ambiguous owned identities', async () => {
  await expect(readInstallation(await fixture(['one', 'two']))).rejects.toThrow(
    'installation_conflict'
  );
});
it('ignores retired scanner state but recovers an installed scanner', async () => {
  const state = await fixture();
  expect(await readInstallation(state)).toBeUndefined();
  const pointer = new RuntimeStore(state).pointerPath('scanner');
  await mkdir(join(state, 'runtimes/scanner'), { recursive: true });
  await writeFile(pointer, '{}');
  expect(await readInstallation(state)).toBe('retired');
});
it('a later login sends the durable identity learned from an authenticated login response', async () => {
  const stateDir = await fixture();
  const credentials = createCredentialAdapter({ stateDir });
  const auth = createCliAuth({
    stateDir,
    credentials,
    noBrowser: true,
    fetch: async () =>
      Response.json({ email: 'owner@example.test', deviceInstallationId: 'confirmed' }),
  });
  await auth.accountEmail('fixture-access');
  expect(JSON.parse(await readFile(join(stateDir, 'installation.json'), 'utf8'))).toEqual({
    deviceInstallationId: 'confirmed',
  });
  const fetcher = vi.fn(async (_url, options) => {
    expect(new URLSearchParams(String(options?.body)).get('device_installation_id')).toBe(
      'confirmed'
    );
    throw new Error('stop_after_authorization');
  });
  await expect(
    createCliAuth({
      stateDir,
      credentials,
      noBrowser: true,
      fetch: fetcher,
      print: () => undefined,
    }).signIn()
  ).rejects.toThrow('stop_after_authorization');
});

it('concurrent different identities cannot both replace the durable record', async () => {
  const state = await fixture();
  const results = await Promise.allSettled([
    saveInstallation(state, 'one'),
    saveInstallation(state, 'two'),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const rejected = results.find((result) => result.status === 'rejected');
  expect(rejected).toMatchObject({ reason: { message: 'installation_conflict' } });
  expect(await readInstallation(state)).toBe(results[0]?.status === 'fulfilled' ? 'one' : 'two');
});

it('stateDir selects the default credential adapter as well as identity storage', async () => {
  const stateDir = await fixture();
  await createCredentialAdapter({ stateDir }).putCliOAuth(
    {
      issuer: 'issuer',
      clientId: 'cli',
      familyId: 'cli',
      scopes: [],
      lastRotationTime: new Date().toISOString(),
    },
    {
      accessToken: 'custom-state-access',
      refreshToken: 'custom-state-refresh',
      accessExpiresAt: new Date(Date.now() + 600000).toISOString(),
    }
  );
  expect(await createCliAuth({ stateDir }).getCliBearer()).toBe('custom-state-access');
});

it('stores server-selected identities per account and reselects the authenticated account', async () => {
  const stateDir = await fixture();
  await saveInstallation(stateDir, 'legacy-installation');
  const auth = createCliAuth({
    stateDir,
    fetch: async (_url, options) => {
      const bearer = new Headers(options?.headers).get('authorization');
      return Response.json(
        bearer === 'Bearer account-a'
          ? {
              account: 'account-a',
              email: 'a@example.test',
              deviceInstallationId: 'installation-a',
            }
          : {
              account: 'account-b',
              email: 'b@example.test',
              deviceInstallationId: 'installation-b',
            }
      );
    },
  });
  await auth.accountEmail('account-a');
  await auth.accountEmail('account-b');
  expect(await readInstallation(stateDir, 'account-a')).toBe('installation-a');
  expect(await readInstallation(stateDir, 'account-b')).toBe('installation-b');
  expect(await readInstallation(stateDir, 'unknown-account')).toBeUndefined();
  expect(await readInstallation(stateDir)).toBe('installation-b');
  expect(await readInstallations(stateDir)).toEqual([
    'installation-b',
    'installation-a',
    'legacy-installation',
  ]);
  await auth.accountEmail('account-a');
  expect(await readInstallation(stateDir)).toBe('installation-a');
  const fetcher = vi.fn(async (_url, options) => {
    const form = new URLSearchParams(String(options?.body));
    expect(JSON.parse(form.get('device_installation_ids')!)).toEqual([
      'installation-a',
      'installation-b',
      'legacy-installation',
    ]);
    throw new Error('stop_after_authorization');
  });
  await expect(
    createCliAuth({ stateDir, noBrowser: true, fetch: fetcher, print: () => undefined }).signIn()
  ).rejects.toThrow('stop_after_authorization');
  const record = JSON.parse(await readFile(join(stateDir, 'installation.json'), 'utf8'));
  expect(record.accounts['account-a']).toEqual({
    deviceInstallationId: 'installation-a',
    email: 'a@example.test',
  });
  expect(record.accounts['account-b']).toEqual({
    deviceInstallationId: 'installation-b',
    email: 'b@example.test',
  });
  expect(record.legacyDeviceInstallationId).toBe('legacy-installation');
  expect((await stat(join(stateDir, 'installation.json'))).mode & 0o777).toBe(0o600);
});

it('concurrent account identities are preserved while conflicting ids for one account are refused', async () => {
  const stateDir = await fixture();
  await Promise.all([
    saveInstallation(stateDir, 'installation-a', { account: 'a', email: 'a@example.test' }),
    saveInstallation(stateDir, 'installation-b', { account: 'b', email: 'b@example.test' }),
  ]);
  expect(await readInstallation(stateDir, 'a')).toBe('installation-a');
  expect(await readInstallation(stateDir, 'b')).toBe('installation-b');
  await expect(
    saveInstallation(stateDir, 'different', { account: 'a', email: 'a@example.test' })
  ).rejects.toThrow('installation_conflict');
});
