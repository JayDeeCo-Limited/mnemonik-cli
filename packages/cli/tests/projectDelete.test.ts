import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';

const scanner = vi.hoisted(() => ({ enable: vi.fn(), update: vi.fn() }));
vi.mock('../src/scanner/enable.js', async (original) => ({
  ...(await original<typeof import('../src/scanner/enable.js')>()),
  enableScanner: scanner.enable,
  updateScannerRoots: scanner.update,
}));

import { runCli, type CliDependencies } from '../src/router.js';

const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const created: string[] = [];
const capture = () => ({
  text: '',
  write(chunk: string) {
    this.text += chunk;
  },
});

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(
  options: {
    typed?: string;
    deleteStatus?: number;
    name?: string;
    listing?: number | 'network';
  } = {}
) {
  const name = options.name ?? 'Atlas';
  const home = await mkdtemp(join(tmpdir(), 'project-delete-'));
  created.push(home);
  const stateDir = join(home, 'state');
  const root = join(home, 'Projects', 'app');
  await mkdir(join(stateDir, 'scanner'), { recursive: true });
  await mkdir(root, { recursive: true });
  await writeFile(
    join(stateDir, 'scanner/state.json'),
    JSON.stringify({
      schemaVersion: 1,
      config: { roots: [root], exclusions: [], serverUrl: 'https://api.mnemonik.dev' },
      paused: false,
      pauseIntervals: [],
    })
  );
  const calls: { method: string; url: string; body?: string }[] = [];
  const grantFetch = vi.fn(
    async (url: string | URL, init?: { method?: string; body?: unknown }) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, url: String(url), body: init?.body as string | undefined });
      if (method === 'GET' && options.listing === 'network') throw new TypeError('fetch failed');
      if (method === 'GET' && typeof options.listing === 'number')
        return new Response(JSON.stringify({ error: 'refused' }), { status: options.listing });
      if (method === 'GET')
        return new Response(JSON.stringify([{ id: PROJECT_ID, name }]), { status: 200 });
      const status = options.deleteStatus ?? 200;
      return new Response(
        JSON.stringify(status === 200 ? { success: true } : { error: 'refused' }),
        {
          status,
        }
      );
    }
  ) as unknown as typeof fetch;
  const stdout = capture();
  const stderr = capture();
  const deps: CliDependencies = {
    home,
    cwd: root,
    installStateDir: stateDir,
    input: Readable.from(`${options.typed ?? 'atlas'}\n`),
    stdout,
    stderr,
    grantFetch,
    cliAuth: {
      signIn: vi.fn(),
      getCliBearer: async () => 'cli-token',
      logout: async () => undefined,
    },
    projectResolver: {
      resolveProjectIdentity: async () => ({
        kind: 'ok',
        root,
        repository: { kind: 'plain', root },
        nested: [],
        identity: { schemaVersion: 1, projectId: PROJECT_ID, projectName: name },
      }),
    } as CliDependencies['projectResolver'],
  };
  return { deps, root, stdout, stderr, calls };
}

it('deletes the project the folder belongs to when the name is typed in another case', async () => {
  const f = await fixture({ typed: 'ATLAS' });
  scanner.update.mockResolvedValue({ status: 'updated', state: { config: { roots: [] } } });

  expect(await runCli(['project', 'delete'], f.deps)).toBe(0);

  expect(f.stdout.text).toContain(
    'Deleting Atlas removes its memories, code index and summaries for everyone. This cannot be undone.'
  );
  expect(f.stdout.text).toContain('Deleted Atlas.');
  expect(f.stdout.text).toContain(
    "This folder's .mnemonik.json still points at the deleted project."
  );
  const deletion = f.calls.find((call) => call.method === 'DELETE');
  expect(deletion?.url).toContain(`/api/v1/projects/${PROJECT_ID}`);
  expect(deletion?.body).toBe(JSON.stringify({ confirmProjectName: 'ATLAS' }));
});

it('takes the folder out of the watched list once the project is gone', async () => {
  const f = await fixture();
  scanner.update.mockResolvedValue({ status: 'updated', state: { config: { roots: [] } } });

  expect(await runCli(['project', 'delete'], f.deps)).toBe(0);

  expect(scanner.update).toHaveBeenCalledWith(
    expect.objectContaining({ add: [], remove: [f.root], bearer: 'cli-token' })
  );
});

it('cancels and deletes nothing when the wrong name is typed', async () => {
  const f = await fixture({ typed: 'atlas-two' });

  expect(await runCli(['project', 'delete'], f.deps)).toBe(130);

  expect(f.stdout.text).toContain('Nothing was deleted.');
  expect(f.calls.some((call) => call.method === 'DELETE')).toBe(false);
  expect(scanner.update).not.toHaveBeenCalled();
});

it('refuses in one line when nobody can be asked and --confirm is missing', async () => {
  const f = await fixture();

  expect(await runCli(['project', 'delete', '--non-interactive'], f.deps)).toBe(3);

  expect(f.stderr.text.trim()).toContain(
    'To skip this check, run mnemonik project delete Atlas --confirm "Atlas".'
  );
  expect(f.calls.some((call) => call.method === 'DELETE')).toBe(false);
});

it('tells someone who is not the owner that only the owner can delete it', async () => {
  const f = await fixture({ deleteStatus: 403 });

  expect(
    await runCli(['project', 'delete', '--non-interactive', '--confirm', 'Atlas'], f.deps)
  ).toBe(3);

  expect(f.stderr.text).toContain('Only the owner of Atlas can delete it.');
  expect(scanner.update).not.toHaveBeenCalled();
});

it('confirms a name with a space, and says how to type it', async () => {
  const asked = await fixture({ name: 'My App' });

  expect(await runCli(['project', 'delete', '--non-interactive'], asked.deps)).toBe(3);
  expect(asked.stderr.text).toContain(
    'To skip this check, run mnemonik project delete My App --confirm "My App".'
  );

  const f = await fixture({ name: 'My App' });
  scanner.update.mockResolvedValue({ status: 'updated', state: { config: { roots: [] } } });

  expect(
    await runCli(['project', 'delete', '--non-interactive', '--confirm', 'My App'], f.deps)
  ).toBe(0);
  expect(f.stdout.text).toContain('Deleted My App.');
});

it('reports a deletion the watched list could not follow', async () => {
  const f = await fixture({ typed: 'Atlas' });
  scanner.update.mockRejectedValue(new Error('scanner_request_500'));

  expect(await runCli(['project', 'delete'], f.deps)).toBe(0);

  expect(f.stdout.text).toContain('Deleted Atlas.');
  // Output writes a home-relative path.
  expect(f.stdout.text).toContain(
    'The folder is still being indexed. Run mnemonik remove ~/Projects/app to stop that.'
  );
});

it('keeps a word after --confirm for the command that owns it', async () => {
  const f = await fixture();

  // auth logout names a host, and uninstall names a component.
  expect(await runCli(['auth', 'logout', '--confirm', 'claude-code'], f.deps)).toBe(2);
  expect(
    await runCli(['uninstall', '--component', 'scanner', '--confirm', 'claude-code'], f.deps)
  ).toBe(2);
});

// The project list is read before anything is deleted. When that read fails,
// the answer names why, and nothing is deleted.
it.each([
  [401, 'renew', 'mnemonik auth renew'],
  [403, 'renew', 'mnemonik auth renew'],
  ['network', 'unreachable', 'retry'],
  [500, 'server_error', 'retry'],
] as const)(
  'a listing that fails with %s says %s and deletes nothing',
  async (listing, reason, action) => {
    const f = await fixture({ listing });

    expect(
      await runCli(
        ['project', 'delete', '--non-interactive', '--json', '--confirm', 'Atlas'],
        f.deps
      )
    ).toBe(3);

    expect(JSON.parse(f.stdout.text)).toEqual({ status: 'action_required', reason, action });
    expect(f.calls.map((call) => call.method)).toEqual(['GET']);
  }
);

it('says in words why the listing failed, and only a lost connection is unreachable', async () => {
  const refused = await fixture({ listing: 401 });
  expect(
    await runCli(['project', 'delete', '--non-interactive', '--confirm', 'Atlas'], refused.deps)
  ).toBe(3);
  expect(refused.stderr.text).toContain('Mnemonik no longer accepts the sign-in on this computer.');
  expect(refused.stderr.text).not.toContain('could not be reached');

  const lost = await fixture({ listing: 'network' });
  expect(
    await runCli(['project', 'delete', '--non-interactive', '--confirm', 'Atlas'], lost.deps)
  ).toBe(3);
  expect(lost.stderr.text).toContain('Mnemonik could not be reached.');
  expect(lost.calls.some((call) => call.method === 'DELETE')).toBe(false);
});
