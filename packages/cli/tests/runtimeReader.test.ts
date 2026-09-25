import type * as childProcess from 'node:child_process';
import { chmodSync, readdirSync, lstatSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { basename, dirname, join, relative, win32 } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  auditWindowsPermissions,
  aclRecords,
  execute,
  verifyWindowsAcl,
  prepareWindowsAclDirectory,
} from '../../shared/src/runtimeSigners.js';
import {
  hash,
  RuntimeError,
  RuntimeReader,
  type Manifest,
} from '../../shared/src/runtimeReader.js';

class Reader extends RuntimeReader {
  verify = this.verifyAt.bind(this);
  recordAcl = this.recordAclWrite.bind(this);
}
const platform = process.platform;
let state: string;
beforeEach(async () => {
  state = await mkdtemp(join(tmpdir(), "acl-é 'space-"));
  Object.defineProperty(process, 'platform', { value: 'win32' });
  vi.stubEnv('SystemRoot', 'C:\\Windows');
});
afterEach(async () => {
  Object.defineProperty(process, 'platform', { value: platform });
  vi.unstubAllEnvs();
  await rm(state, { recursive: true, force: true });
});
function runner(verdict: (path: string) => string | undefined = () => 'ok') {
  const user = 'MACHINE\\agent';
  const descendants = (path: string): string[] => [
    path,
    ...(lstatSync(path).isDirectory()
      ? readdirSync(path).flatMap((name) => descendants(join(path, name)))
      : []),
  ];
  return vi.fn(async (file: string, args: string[], _input?: string) => {
    if (file === 'powershell.exe') throw new Error('PowerShell forbidden');
    if (file.endsWith('whoami.exe')) return { stdout: `"${user}","S-1-5-21-1-2-3-1001"` };
    if (file.endsWith('cmd.exe')) {
      const parent = /"(.+)"$/.exec(args[4]!)![1]!;
      const directories = args[4]!.includes('/s ')
        ? descendants(parent).filter((path) => lstatSync(path).isDirectory())
        : [parent];
      return {
        stdout: directories
          .map(
            (dir) =>
              ` Directory of ${dir}\r\n` +
              readdirSync(dir)
                .map((name) =>
                  dirRow(name, verdict(join(dir, name)) === 'owner' ? 'OTHER\\user' : user)
                )
                .join('\r\n')
          )
          .join('\r\n'),
      };
    }
    if (!args.includes('/save')) return { stdout: '' };
    const paths = args.includes('/t') ? descendants(args[0]!) : [args[0]!];
    saveFixture(
      args,
      paths.flatMap((path) => {
        const result = verdict(path);
        return result === undefined && args.includes('/t')
          ? []
          : [
              [path, `(A;;FA;;;S-1-5-21-1-2-3-1001)${result === 'ace' ? '(A;;FR;;;WD)' : ''}`] as [
                string,
                string,
              ],
            ];
      })
    );
    return { stdout: 'OEM display output is deliberately ignored' };
  });
}
function saveFixture(args: string[], records: Array<[string, string]>) {
  const destination = args[args.indexOf('/save') + 1]!;
  writeFileSync(
    destination,
    records
      .map(([path, aces]) => `${relative(dirname(args[0]!), path)}\r\nD:PAI${aces}\r\n`)
      .join(''),
    'utf16le'
  );
}
const saved = (path: string, recursive = false) => [
  path,
  '/save',
  expect.any(String),
  ...(recursive ? ['/t'] : []),
  '/l',
];
const batches = (run: ReturnType<typeof runner>) =>
  run.mock.calls.filter(([, args]) => args.includes('/t'));
const dirRow = (name: string, owner = 'MACHINE\\agent', size = '1') =>
  '09/12/2026  03:00 PM'.padEnd(20) +
  size.padStart(15) +
  '    ' +
  owner.slice(0, 23).padEnd(23) +
  name;

it('reads native UTF16 SDDL rather than the corrupted icacls display names', async () => {
  vi.resetModules();
  const { verifyWindowsAcl: verify } = await import('../../shared/src/runtimeSigners.js');
  const bytes = await readFile(
    new URL(
      '../../../docs/development/onboarding/phase3/evidence/windows-run-2026-09-13/jose/state-icacls-save.utf16',
      import.meta.url
    )
  );
  const path = join(state, 'Mnemonik');
  await mkdir(path);
  const run = vi.fn(async (file: string, args: string[]) => {
    if (file.endsWith('whoami.exe'))
      return {
        stdout: '"WINDOWS11-AGENT\\José-Müller","S-1-5-21-445873388-187762693-612573903-1002"',
      };
    if (args.includes('/save')) await writeFile(args[args.indexOf('/save') + 1]!, bytes);
    return { stdout: `${path} WINDOWS11-AGENT\\Jos�-M�ller:(F)` };
  });
  await expect(verify(path, run)).resolves.toBeUndefined();
  const save = run.mock.calls.find(([, args]) => args.includes('/save'))!;
  expect(save[1]).toEqual([path, '/save', expect.any(String), '/l']);
  expect(readdirSync(join(path, 'audit-tmp'))).toEqual([]);
});

it.each(['S-1-5-21-1-2-3-1002', 'S-1-5-21-1-2-3-1003', undefined])(
  'retains the native José fixed-width rows and verifies their complete owner SID (%s)',
  async (sid) => {
    vi.resetModules();
    const { auditWindowsPermissions: audit } = await import('../../shared/src/runtimeSigners.js');
    const fixture = new URL(
      '../../../docs/development/onboarding/phase3/evidence/windows-run-2026-09-13/jose/',
      import.meta.url
    );
    const user = 'WINDOWS11-AGENT\\José-Müller';
    const nativeState = 'C:\\Users\\José-Müller\\AppData\\Local\\Mnemonik';
    const listing = await readFile(new URL('state-dir-q.utf16', fixture), 'utf16le');
    // The original CP850 bytes are retained beside this lossless UTF8 transcription.

    const row = listing.split(/\r?\n/).find((line) => line.endsWith('José-Müruntimes'))!;
    expect(row.slice(36, 59)).toBe('WINDOWS11-AGENT\\José-Mü');
    expect(row.slice(59)).toBe('runtimes');
    const normalize = (text: string) =>
      text
        .replaceAll(nativeState, state)
        .replaceAll(`${state}\\runtimes\\cli`, join(state, 'runtimes', 'cli'))
        .replaceAll(`${state}\\runtimes`, join(state, 'runtimes'));
    const shortPath = join(state, 'short-owner.ts');
    const shortRow = dirRow('short-owner.ts', 'MACHINE\\other');
    const paths = [state, join(state, 'runtimes'), join(state, 'runtimes', 'cli'), shortPath];
    const run = vi.fn(async (file: string, args: string[], input?: string) => {
      if (args.includes('/save'))
        saveFixture(
          args,
          paths.map((path) => [path, '(A;;FA;;;S-1-5-21-1-2-3-1002)'])
        );
      return {
        stdout: file.endsWith('whoami.exe')
          ? `"${user}","S-1-5-21-1-2-3-1002"`
          : file.endsWith('powershell.exe')
            ? input!
                .trimEnd()
                .split('\n')
                .flatMap((path) =>
                  path === shortPath
                    ? [`${path}\tS-1-5-21-9-9-9-1001`]
                    : sid
                      ? [`${path}\t${sid}`]
                      : []
                )
                .join('\n')
            : file.endsWith('cmd.exe')
              ? normalize(listing.replace(row, row + '\r\n' + shortRow))
              : '',
      };
    });
    const result = await audit(state, paths, run);
    for (const path of paths.slice(0, 3))
      expect(result.get(path)).toBe(
        sid === undefined ? 'acl_unavailable' : sid.endsWith('1002') ? 'ok' : 'owner'
      );
    expect(result.get(shortPath)).toBe('owner');
    const fallback = run.mock.calls.filter(([file]) => file.endsWith('powershell.exe'));
    expect(fallback).toHaveLength(1);
    expect(fallback[0]![2]!.trimEnd().split('\n').sort()).toEqual(paths.sort());
  }
);

it.each(['async', 'sync'])(
  'uses the same fixed owner column and stdin SID lookup in %s hooks',
  async (mode) => {
    vi.resetModules();
    const user = 'WINDOWS11-AGENT\\José-Müller';
    const sid = 'S-1-5-21-1-2-3-1002';
    const calls: Array<{ file: string; args: string[]; input?: string }> = [];
    const respond = (file: string, args: string[], input?: string): string => {
      calls.push({ file, args, ...(input !== undefined ? { input } : {}) });
      const command = args.at(-1) ?? '';
      if (file.endsWith('powershell.exe')) return `${state}\t${sid}\n`;
      if (file.endsWith('whoami.exe') || command.includes('whoami.exe'))
        return `"${user}","${sid}"`;
      if (file.endsWith('icacls.exe')) {
        if (args.includes('/save')) saveFixture(args, [[state, `(A;OICI;FA;;;${sid})`]]);
        return '';
      }
      return dirRow(basename(state), user, '<DIR>');
    };
    if (mode === 'sync')
      vi.doMock('node:child_process', async (original) => ({
        ...(await original<typeof childProcess>()),
        execFileSync: (file: string, args: string[], options: { input?: string }) =>
          respond(file, args, options.input),
      }));
    try {
      const hooks = await import('../../shared/src/runtimeSigners.js');
      if (mode === 'sync') hooks.ensureWindowsPrivateDirectorySync(state);
      else
        await hooks.protectWindowsDirectory(state, false, async (...args) => ({
          stdout: respond(...args),
        }));
      const fallback = calls.filter(({ file }) => file.endsWith('powershell.exe'));
      expect(fallback).toHaveLength(1);
      expect(fallback[0]!.input).toBe(state + '\n');
      expect(fallback[0]!.args.join(' ')).not.toContain(state);
      expect(
        JSON.parse(await readFile(join(state, '.windows-acl.json'), 'utf8')).identity.sid
      ).toBe(sid);
    } finally {
      vi.doUnmock('node:child_process');
    }
  }
);

it.each(['batch', 'fallback'])('names a timed-out %s ACL subprocess unavailable', async (where) => {
  const native = runner();
  const run = async (file: string, args: string[]) => {
    if (file.endsWith('icacls.exe')) {
      if (where === 'fallback' && args.includes('/t')) return { stdout: '' };
      throw Object.assign(new Error('native command timed out'), {
        killed: true,
        signal: 'SIGTERM',
      });
    }
    return native(file, args);
  };
  await expect(new Reader(state, run).inspect(state, true)).rejects.toMatchObject({
    reason: 'acl_unavailable',
  });
});

it('gives native tree listings 30 seconds and leaf calls 5 seconds', async () => {
  vi.resetModules();
  const calls: { command: string; timeout: number }[] = [];
  const native = ((
    _file: string,
    args: string[],
    options: { timeout: number },
    callback: (error: null, output: string) => void
  ) => {
    const command = args.at(-1)!;
    calls.push({ command, timeout: options.timeout });
    if (args.includes('/save')) saveFixture(args, [[state, '(A;;FA;;;S-1-5-21-1-2-3-1001)']]);
    callback(
      null,
      command.includes('whoami.exe')
        ? '"MACHINE\\agent","S-1-5-21-1-2-3-1001"'
        : command.includes('icacls.exe')
          ? `${state} MACHINE\\agent:(F)`
          : ` Directory of ${state}\r\n${dirRow('.', 'MACHINE\\agent', '<DIR>')}`
    );
    return {};
  }) as typeof childProcess.execFile;
  vi.doMock('node:child_process', async (original) => ({
    ...(await original<typeof childProcess>()),
    execFile: native,
  }));
  try {
    const { auditWindowsPermissions: audit } = await import('../../shared/src/runtimeSigners.js');
    await audit(state, [state], undefined, false);
    await audit(state, [state]);
    expect(calls.map(({ timeout }) => timeout)).toEqual([
      5000, 5000, 5000, 5000, 5000, 30000, 30000,
    ]);
  } finally {
    vi.doUnmock('node:child_process');
  }
});

async function payload(signer?: Manifest['signer']) {
  const directory = join(state, 'runtimes/cli/1.0.0');
  const names = Array.from({ length: 148 }, (_, i) => `a/b/c/file-${i}.js`);
  await mkdir(join(directory, 'a/b/c'), { recursive: true });
  await Promise.all(names.map((name) => writeFile(join(directory, name), 'x')));
  const manifest: Manifest = {
    signer,
    schemaVersion: 1,
    artifact: 'cli',
    version: '1.0.0',
    entry: names[0]!,
    totalSize: 148,
    files: Object.fromEntries(
      names.map((name) => [name, { sha256: hash('x'), size: 1, executable: false }])
    ),
    source: {
      kind: 'npm',
      launchedFrom: 'fixture',
      packages: [
        {
          name: '@mnemonik/cli',
          version: '1.0.0',
          integrity: 'fixture',
          tarball: 'fixture',
          tarballSha256: hash('x'),
        },
      ],
    },
  };
  const bytes = JSON.stringify(manifest);
  const ref = { version: '1.0.0', manifestSha256: hash(bytes) };
  await writeFile(join(directory, 'manifest.json'), bytes);
  await writeFile(join(dirname(directory), 'current'), JSON.stringify({ current: ref }));
  return { directory, ref, names };
}

it.each([
  [150, 'cli', false, false],
  [560, 'claude-code', false, false],
  [150, 'cli', true, false],
  [150, 'cli', false, true],
] as const)(
  'bounds audits while staging %i files for %s (foreign write: %s, upgrade: %s)',
  async (count, artifact, foreignWrite, upgrade) => {
    const names = Array.from(
      { length: count },
      (_, i) => `node_modules/package-${i % 10}/dist/file-${i}.js`
    );
    let regrant = false;
    const grant = vi.fn(async (path: string) => {
      if (!regrant) return;
      // Inheritable ACL replacement changes descendant ctimes, even with unchanged access.
      const touch = (part: string) => {
        const stat = lstatSync(part);
        if (stat.isDirectory()) for (const name of readdirSync(part)) touch(join(part, name));
        chmodSync(part, stat.mode);
      };
      touch(path);
    });
    // Keep real staging and locking; replace Windows ACL-setting and manifest publication only.
    vi.doMock('@mnemonik/local-setup', async (original) => ({
      ...(await original<typeof import('@mnemonik/local-setup')>()),
      windowsCurrentUserAcl: grant,
      atomicWrite: async (path: string, bytes: Buffer) => {
        if (foreignWrite && path.endsWith('manifest.json'))
          await writeFile(join(dirname(path), names[0]!), 'foreign');
        await writeFile(path, bytes);
      },
    }));
    try {
      const { RuntimeStore } = await import('../src/runtime/store.js');
      const { directory } = await payload();
      const manifest = JSON.parse(
        await readFile(join(directory, 'manifest.json'), 'utf8')
      ) as Manifest;
      manifest.artifact = artifact;
      manifest.entry = names[0]!;
      manifest.files = Object.fromEntries(
        names.map((name) => [name, { sha256: hash('x'), size: 1, executable: false }])
      );
      manifest.totalSize = count;
      await rm(join(state, 'runtimes'), { recursive: true });
      const native = runner();
      let now = 0;
      const run = vi.fn(async (...args: Parameters<typeof native>) => {
        // Native work can take longer than the reader's two-second TTL.
        now += 10_000;
        return native(...args);
      });
      const phases: Array<{ recursive: number; reads: number }> = [];
      class Store extends RuntimeStore {
        protected override async verifyAt(...args: Parameters<Reader['verify']>) {
          const before = batches(run).length;
          const readCount = reads.mock.calls.length;
          const result = await super.verifyAt(...args);
          phases.push({
            recursive: batches(run).length - before,
            reads: reads.mock.calls.length - readCount,
          });
          return result;
        }
      }
      const store = new Store(state, run, {}, () => now);
      const reads = vi.spyOn(store, 'bytes');
      if (upgrade) {
        await store.installRuntime(artifact, '1.0.0', {
          manifest: structuredClone(manifest),
          files: Object.fromEntries(names.map((name) => [name, Buffer.from('x')])),
        });
        await store.verifyRuntime(artifact); // runHosts verifies the old runtime before install.
        manifest.version = '2.0.0';
        if (manifest.source.kind === 'npm') manifest.source.packages[0]!.version = '2.0.0';
        run.mockClear();
        reads.mockClear();
        grant.mockClear();
        phases.length = 0;
        regrant = true;
      }
      let beforeWrites = 0;
      let readsBeforeWrites = 0;
      const install = store.installRuntime(artifact, manifest.version, {
        manifest,
        get files() {
          beforeWrites = batches(run).length;
          readsBeforeWrites = reads.mock.calls.length;
          return Object.fromEntries(names.map((name) => [name, Buffer.from('x')]));
        },
      });
      if (foreignWrite) {
        await expect(install).rejects.toMatchObject({ reason: 'digest_mismatch' });
        expect(readdirSync(dirname(store.pointerPath(artifact)))).toEqual([]);
        return;
      }
      await install;
      if (upgrade) {
        expect(grant).not.toHaveBeenCalled();
        expect(batches(run)).toHaveLength(5);
        expect(run).toHaveBeenCalledTimes(27);
        return;
      }
      expect(beforeWrites).toBe(1);
      expect(batches(run)).toHaveLength(4);
      expect(
        run.mock.calls.filter(([, args]) => args.at(-1)?.includes('dir /q /a /s '))
      ).toHaveLength(4);
      expect(
        run.mock.calls.filter(
          ([file, args]) => !file.endsWith('whoami.exe') && !args.includes('/inheritance:r')
        )
      ).toHaveLength(18);
      expect(phases.map(({ recursive, reads }) => ({ recursive, reads }))).toEqual([
        { recursive: 1, reads: count + 1 },
        { recursive: 1, reads: count + 1 },
      ]);
      expect(
        reads.mock.calls.slice(readsBeforeWrites).filter(([path]) => path.includes('/.stage-'))
      ).toHaveLength(count + 1);
    } finally {
      vi.doUnmock('@mnemonik/local-setup');
    }
  },
  30_000
);

it('bounds host audits through runHosts and the packed adapter import', async () => {
  vi.doMock('@mnemonik/local-setup', async (original) => ({
    ...(await original<typeof import('@mnemonik/local-setup')>()),
    windowsCurrentUserAcl: async () => {},
    atomicWrite: async (path: string, bytes: Buffer) => writeFile(path, bytes),
  }));
  const { packedHosts } = await import('./fixtures/hostRuntime.js');
  const packed = await packedHosts();
  const { RuntimeStore } = await import('../src/runtime/store.js');
  const { runHosts } = await import('../src/install/hosts.js');
  const { hostPackageImports } = await import('../src/install/adapters.js');
  const native = runner();
  let now = 0;
  const run = vi.fn(async (...args: Parameters<typeof native>) => {
    now += 10_000;
    return native(...args);
  });
  const original = RuntimeStore.prototype.installRuntime;
  const install = vi.spyOn(RuntimeStore.prototype, 'installRuntime').mockImplementation(function (
    this: InstanceType<typeof RuntimeStore>,
    ...args
  ) {
    Object.defineProperty(this, 'run', { value: run });
    Object.defineProperty(this, 'now', { value: () => now });
    return original.apply(this, args);
  });
  try {
    const source = packed.sources['claude-code'];
    expect(source.files['node_modules/@mnemonik/shared/dist/runtimeReader.js']).toEqual(
      await readFile(new URL('../../shared/dist/runtimeReader.js', import.meta.url))
    );
    const result = await runHosts(
      'install',
      [{ host: 'claude-code', scope: 'user', component: 'mcp', home: join(state, 'home') }],
      {
        stateDir: state,
        account: 'owner',
        source: async () => source,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        imports: {
          ...hostPackageImports,
          'claude-code': async (runtime) => {
            const module = await hostPackageImports['claude-code'](runtime);
            return {
              createHostAdapter: (deps) =>
                module.createHostAdapter({
                  ...deps,
                  platform: 'linux',
                  execFile: async (_file, args) => ({
                    stdout: args.includes('--version')
                      ? '1.0.100 (Claude Code)'
                      : 'mnemonik: Connected',
                    stderr: '',
                  }),
                }),
            };
          },
        },
      }
    );
    expect(install).toHaveBeenCalledTimes(1);
    expect(batches(run)).toHaveLength(4);
    expect(result.results[0]?.status).not.toBe('FAILED');
  } finally {
    install.mockRestore();
    vi.doUnmock('@mnemonik/local-setup');
    await rm(packed.root, { recursive: true, force: true });
  }
}, 120_000);

it.each(['1', 'misses'])(
  'emits opt-in audit decisions without file contents (%s)',
  async (level) => {
    const path = join(state, 'status.json');
    await writeFile(path, 'private fixture contents');
    let now = 0;
    const reader = new Reader(state, runner(), {}, () => now);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      vi.stubEnv('MNEMONIK_AUDIT_TRACE', '0');
      await reader.inspect(path);
      expect(stderr).not.toHaveBeenCalled();
      vi.stubEnv('MNEMONIK_AUDIT_TRACE', level);
      now = 3_000;
      await reader.inspect(path);
      await writeFile(path, 'changed fixture contents');
      await reader.inspect(path);
      const output = stderr.mock.calls.map(([line]) => String(line)).join('');
      const events = output
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(events).toContainEqual(
        expect.objectContaining({
          event: 'cache',
          path,
          cache: 'ttl-expired',
          activeOperation: false,
        })
      );
      expect(events).toContainEqual(
        expect.objectContaining({ event: 'audit', root: path, recursive: false })
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          event: 'invalidate',
          path,
          reason: 'stat-identity',
          previous: expect.any(String),
          current: expect.any(String),
        })
      );
      expect(output).not.toContain('fixture contents');
      if (level === 'misses') expect(events.every((event) => event.cache !== 'hit')).toBe(true);
    } finally {
      stderr.mockRestore();
    }
  }
);

it('re-audits an owned ACL write once and still detects a later foreign write', async () => {
  const { directory, names } = await payload();
  const run = runner();
  const reader = new Reader(state, run);
  await reader.verifyRuntime('cli');
  const root = dirname(directory);
  for (const path of [
    root,
    ...readdirSync(root, { recursive: true }).map((name) => join(root, String(name))),
  ])
    chmodSync(path, lstatSync(path).mode);
  await reader.recordAcl(root);
  await reader.verifyRuntime('cli');
  expect(batches(run)).toHaveLength(2);
  await writeFile(join(directory, names[0]!), 'foreign');
  await expect(reader.verifyRuntime('cli')).rejects.toMatchObject({ reason: 'digest_mismatch' });
  expect(batches(run)).toHaveLength(3);
});

it('scopes the recursive audit to cli and checks only its ancestors shallowly', async () => {
  await payload();
  for (const sibling of ['claude-code', 'codex', 'cursor', 'grok']) {
    await mkdir(join(state, 'runtimes', sibling, '1.0.0'), { recursive: true });
    await writeFile(join(state, 'runtimes', sibling, '1.0.0', 'hook.js'), 'x');
  }
  const run = runner();
  await new Reader(state, run).verifyRuntime('cli');
  const base = join(state, 'runtimes', 'cli');
  expect(
    run.mock.calls.filter(
      ([file, args]) =>
        !args.includes('/inheritance:r') &&
        (file.endsWith('cmd.exe') || file.endsWith('icacls.exe'))
    )
  ).toEqual([
    [
      win32.join(process.env.SystemRoot!, 'System32', 'cmd.exe'),
      ['/d', '/v:off', '/s', '/c', `dir /q /a "${dirname(state)}"`],
    ],
    [win32.join(process.env.SystemRoot!, 'System32', 'icacls.exe'), saved(state)],
    [
      win32.join(process.env.SystemRoot!, 'System32', 'cmd.exe'),
      ['/d', '/v:off', '/s', '/c', `dir /q /a "${state}"`],
    ],
    [win32.join(process.env.SystemRoot!, 'System32', 'icacls.exe'), saved(join(state, 'runtimes'))],
    [
      win32.join(process.env.SystemRoot!, 'System32', 'cmd.exe'),
      ['/d', '/v:off', '/s', '/c', `dir /q /a "${dirname(base)}"`],
    ],
    [
      win32.join(process.env.SystemRoot!, 'System32', 'cmd.exe'),
      ['/d', '/v:off', '/s', '/c', `dir /q /a /s "${base}"`],
    ],
    [win32.join(process.env.SystemRoot!, 'System32', 'icacls.exe'), saved(base, true)],
  ]);
});

it('audits a plain state leaf and its ancestors without recursion', async () => {
  for (const artifact of ['cli', 'scanner', 'codex'])
    await mkdir(join(state, 'runtimes', artifact), { recursive: true });
  const path = join(state, 'scanner', 'status.json');
  await mkdir(dirname(path));
  await writeFile(path, '{}');
  const run = runner();
  await new Reader(state, run).inspect(path);
  expect(
    run.mock.calls.filter(
      ([file, args]) => !file.endsWith('whoami.exe') && !args.includes('/inheritance:r')
    )
  ).toEqual(
    [state, dirname(path), path].flatMap((part) => [
      [
        win32.join(process.env.SystemRoot!, 'System32', 'cmd.exe'),
        ['/d', '/v:off', '/s', '/c', `dir /q /a "${dirname(part)}"`],
      ],
      [win32.join(process.env.SystemRoot!, 'System32', 'icacls.exe'), saved(part)],
    ])
  );
});

it.each([false, true])('shares an in-flight native audit (failure: %s)', async (failure) => {
  await payload();
  const native = runner();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = vi.fn(async (file: string, args: string[]) => {
    await blocked;
    if (failure) throw new Error('native audit failed');
    return native(file, args);
  });
  const reader = new Reader(state, run);
  const first = reader.inspect(reader.pointerPath('cli'));
  const second = reader.inspect(reader.pointerPath('cli'));
  const results = Promise.allSettled([first, second]);
  await vi.waitFor(() => expect(run).toHaveBeenCalled());
  release();
  if (failure) {
    expect(await results).toEqual(
      [0, 1].map(() => ({
        status: 'rejected',
        reason: new RuntimeError('acl_unavailable'),
      }))
    );
    expect(run).toHaveBeenCalledTimes(1);
  } else {
    expect((await results).every((result) => result.status === 'fulfilled')).toBe(true);
    expect(batches(run)).toHaveLength(1);
  }
});

it('reuses inspect then verify audits and invalidates a rewritten manifest or pointer', async () => {
  const { directory, ref } = await payload();
  const run = runner();
  let now = 0;
  const reader = new Reader(state, run, {}, () => now);
  await reader.inspect(reader.pointerPath('cli'));
  now = 10_000;
  await reader.verify('cli', ref, directory);
  await reader.verifyRuntime('cli');
  expect(batches(run)).toHaveLength(1);
  for (const path of [join(directory, 'manifest.json'), reader.pointerPath('cli')]) {
    await writeFile(path, (await readFile(path, 'utf8')) + ' ');
    if (path.endsWith('manifest.json')) {
      await expect(reader.verify('cli', ref, directory)).rejects.toMatchObject({
        reason: 'digest_mismatch',
      });
    } else {
      await expect(reader.verifyRuntime('cli')).rejects.toMatchObject({
        reason: 'digest_mismatch',
      });
    }
  }
  expect(batches(run)).toHaveLength(3);
});

it('invalidates the artifact audit after an observed payload write', async () => {
  const { directory, ref, names } = await payload();
  const path = join(directory, names[0]!);
  let changed = false;
  const run = runner((candidate) => (changed && candidate === path ? 'ace' : 'ok'));
  const reader = new Reader(state, run);
  await reader.verify('cli', ref, directory);
  await writeFile(path, 'changed');
  changed = true;
  await expect(reader.verify('cli', ref, directory)).rejects.toMatchObject({
    reason: 'permission',
  });
  expect(batches(run)).toHaveLength(2);
});

it.each([false, true])(
  'audits 148 files at six directory levels (include current: %s)',
  async (includeCurrent) => {
    const { directory, ref, names } = await payload();
    const run = runner();
    let now = 0;
    const reader = new Reader(state, run, {}, () => (now += 3_000));
    if (includeCurrent) await reader.verifyRuntime('cli');
    else await reader.verify('cli', ref, directory);
    expect(batches(run)).toHaveLength(1);
    expect(run.mock.calls.length).toBeLessThanOrEqual(8);
    for (const [command] of run.mock.calls)
      expect(win32.dirname(command)).toBe('C:\\Windows\\System32');
    expect(names).toHaveLength(148);
  }
);

it('verifies the 148-file payload with zero PowerShell and at most eight native starts', async () => {
  await payload();
  const run = runner();
  await new Reader(state, run).verifyRuntime('cli');
  expect(run.mock.calls.filter(([file]) => /powershell/i.test(file))).toHaveLength(0);
  expect(run.mock.calls.length).toBeLessThanOrEqual(8);
});

it('resolves 3000 records with fewer than four prefix lookups per record', () => {
  const paths = Array.from({ length: 3000 }, (_, i) => join(state, `file ${i}.js`));
  const entries = ['(A;;FA;;;S-1-5-21-1-2-3-1001)', '(A;;FR;;;S-1-5-21-1-2-3-1001)'];
  const acl = paths
    .map((path, i) => `${relative(dirname(state), path)}\r\nD:${entries[i % 2]}`)
    .join('\r\n');
  let lookups = 0;
  expect(aclRecords(acl, state, paths, () => lookups++)).toEqual(
    new Map(paths.map((path, i) => [path, [entries[i % 2]]]))
  );
  expect(lookups).toBeGreaterThanOrEqual(paths.length);
  expect(lookups).toBeLessThan(4 * paths.length);
});

it('attributes adjacent SDDL records independently and rejects malformed ACEs', async () => {
  const bad = join(state, 'foreign (copy).json');
  const good = join(state, 'sibling');
  await writeFile(bad, 'x');
  await writeFile(good, 'x');
  const run = runner((path) => (path === bad ? 'ace' : 'ok'));
  expect(await auditWindowsPermissions(state, [state, bad, good], run)).toEqual(
    new Map([
      [state, 'ok'],
      [bad, 'ace'],
      [good, 'ok'],
    ])
  );
});

it.each(['\u202f', '\u00a0', ' ', ',', '.', '\u2009'])(
  'accepts the French-culture VM staged tree with grouped file sizes (%j)',
  async (separator) => {
    vi.resetModules();
    const { auditWindowsPermissions: audit } = await import('../../shared/src/runtimeSigners.js');
    const captures = new URL(
      '../../../docs/development/onboarding/phase3/evidence/windows-run-2026-09-13/',
      import.meta.url
    );
    const nativeState = 'C:\\Users\\agent\\AppData\\Local\\Mnemonik';
    const user = 'WINDOWS11-AGENT\\agent';
    // Preserve native columns and Unicode separators; adapt only paths for the test OS.
    const normalize = (raw: string) =>
      raw
        .split(/\r?\n/)
        .map((line) => {
          const at = line.indexOf(nativeState);
          if (at < 0) return line;
          const end = line.indexOf(` ${user}:`, at);
          const path = line.slice(at, end < 0 ? undefined : end);
          return (
            line.slice(0, at) +
            path.replace(nativeState, state).replaceAll('\\', '/') +
            (end < 0 ? '' : line.slice(end))
          );
        })
        .join('\r\n');
    const listing = normalize(await readFile(new URL('failed-stage-dir.txt', captures), 'utf16le'));
    const acl = normalize(await readFile(new URL('failed-stage-icacls.txt', captures), 'utf8'));
    expect(listing).toContain(`25\u202f995 ${user}  manifest.json`);
    const run = vi.fn(async (file: string, args: string[]) => {
      if (args.includes('/save'))
        saveFixture(
          args,
          acl
            .split(/\r?\n/)
            .flatMap((line) =>
              line.includes(` ${user}:`)
                ? [
                    [line.split(` ${user}:`)[0]!, '(A;;FA;;;S-1-5-21-1-2-3-1001)'] as [
                      string,
                      string,
                    ],
                  ]
                : []
            )
        );
      return {
        stdout: file.endsWith('whoami.exe')
          ? `"${user}","S-1-5-21-1-2-3-1001"`
          : file.endsWith('cmd.exe')
            ? args.at(-1)!.includes('/s ')
              ? listing.replaceAll('\u202f', separator)
              : ''
            : '',
      };
    });
    const verdicts = await audit(state, [state], run);
    expect(verdicts.size).toBeGreaterThan(150);
    expect([...verdicts].filter(([, verdict]) => verdict !== 'ok')).toEqual([]);
  }
);

it('serializes concurrent verification operations on one reader', async () => {
  const { directory, ref } = await payload();
  let active = 0;
  let peak = 0;
  const respond = runner();
  const run = vi.fn(async (file: string, args: string[], input?: string) => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 0));
    active--;
    return respond(file, args, input);
  });
  const reader = new Reader(state, run);
  await Promise.all([reader.verify('cli', ref, directory), reader.verify('cli', ref, directory)]);
  expect(peak).toBe(1);
  expect(batches(run)).toHaveLength(1);
});

it.each(['owner', 'ace'])('rejects only the path with a batch %s verdict', async (verdict) => {
  const { directory, ref, names } = await payload();
  const bad = join(directory, names[0]!);
  const run = runner((path) => (path === bad ? verdict : 'ok'));
  const reader = new Reader(state, run);
  await expect(reader.verify('cli', ref, directory)).rejects.toEqual(
    new RuntimeError('permission')
  );
  await expect(reader.inspect(bad)).rejects.toEqual(new RuntimeError('permission'));
  await expect(reader.inspect(join(directory, names[1]!))).resolves.toBeUndefined();
  expect(batches(run)).toHaveLength(1);
});

it('falls back once for an omitted verdict, then caches that per-path success', async () => {
  const path = join(state, 'runtimes/cli/file');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, 'x');
  const run = runner((candidate) => (candidate === path ? undefined : 'ok'));
  const reader = new Reader(state, run);
  await reader.inspect(path);
  await reader.inspect(path);
  expect(batches(run)).toHaveLength(1);
  expect(
    run.mock.calls.filter(
      ([file, args]) => file.endsWith('icacls.exe') && args[0] === path && !args.includes('/t')
    )
  ).toHaveLength(1);
});

it('re-audits a cached ACL verdict after two seconds', async () => {
  const path = join(state, 'file');
  await writeFile(path, 'x');
  let now = 0;
  const run = runner();
  const reader = new Reader(state, run, {}, () => now);
  await reader.inspect(path);
  now = 1_999;
  await reader.inspect(path);
  expect(
    run.mock.calls.filter(([file, args]) => file.endsWith('icacls.exe') && args[0] === path)
  ).toHaveLength(1);
  now = 2_001;
  await reader.inspect(path);
  expect(
    run.mock.calls.filter(([file, args]) => file.endsWith('icacls.exe') && args[0] === path)
  ).toHaveLength(2);
});

it.each(['ace', 'unavailable'])('fails closed on cached config leaf drift: %s', async (failure) => {
  const path = join(state, 'config.json');
  await writeFile(path, '{}');
  let now = 0;
  let drift = false;
  const native = runner(() => (drift ? 'ace' : 'ok'));
  const run = vi.fn(async (file: string, args: string[]) => {
    if (drift && failure === 'unavailable') throw new Error('subprocess failed');
    return native(file, args);
  });
  const reader = new Reader(state, run, { cacheDirectories: true }, () => now);
  await reader.inspect(path);
  run.mockClear();
  drift = true;
  now = 2_000;
  await expect(reader.inspect(path)).rejects.toMatchObject({
    reason: failure === 'ace' ? 'permission' : 'acl_unavailable',
  });
  expect(run.mock.calls).toEqual([
    [win32.join(process.env.SystemRoot!, 'System32', 'icacls.exe'), saved(path)],
  ]);
  await rm(path);
  await symlink(state, path);
  await expect(reader.inspect(path, false, true, true)).rejects.toMatchObject({
    reason: 'permission',
  });
  expect(run).toHaveBeenCalledTimes(1);
});

it('rejects an ACL verdict that changes after cache expiry', async () => {
  const path = join(state, 'file');
  await writeFile(path, 'x');
  let now = 0;
  let verdict = 'ok';
  const run = runner(() => verdict);
  const reader = new Reader(state, run, {}, () => now);
  await reader.inspect(path);
  verdict = 'ace';
  now = 2_001;
  await expect(reader.inspect(path)).rejects.toEqual(new RuntimeError('permission'));
});

it('expires operation cache entries two seconds after the operation ends', async () => {
  const { directory, ref, names } = await payload();
  let now = 0;
  const run = runner();
  const reader = new Reader(state, run, {}, () => now);
  await reader.verify('cli', ref, directory);
  expect(batches(run)).toHaveLength(1);
  now = 2_001;
  await reader.inspect(join(directory, names[0]!));
  expect(batches(run)).toHaveLength(2);
});

it('rejects a failed fallback and does not use ACL cache to bypass Node guards', async () => {
  const path = join(state, 'file');
  await writeFile(path, 'x');
  const run = runner(() => undefined);
  run.mockImplementationOnce(async () => ({ stdout: '' }));
  run.mockRejectedValueOnce(new Error('ACL failure'));
  await expect(new Reader(state, run).inspect(path)).rejects.toEqual(
    new RuntimeError('acl_unavailable')
  );
  const cachedRun = runner();
  const reader = new Reader(state, cachedRun);
  await reader.inspect(path);
  await expect(reader.inspect(state + '-outside/file')).rejects.toEqual(
    new RuntimeError('permission')
  );
  await expect(reader.inspect(join(state, 'line\ninjection'))).rejects.toEqual(
    new RuntimeError('permission')
  );
  await expect(reader.inspect(path, true)).rejects.toEqual(new RuntimeError('permission'));
  await rm(path);
  await symlink(state, path);
  await expect(reader.inspect(path)).rejects.toEqual(new RuntimeError('permission'));
  expect(cachedRun.mock.calls.filter(([file]) => file.endsWith('icacls.exe'))).toHaveLength(2);
});

it('checks existing ancestors when the requested path may be missing', async () => {
  const run = runner(() => 'owner');
  await expect(
    new Reader(state, run).inspect(join(state, 'missing/child'), true, true)
  ).rejects.toEqual(new RuntimeError('permission'));
  expect(run.mock.calls.filter(([, args]) => args.includes('/save'))).toHaveLength(1);
  expect(batches(run)).toHaveLength(0);
});

it('writes UTF-8 stdin and rejects a child that exits before consuming it', async () => {
  const input = `${state}\n${state}/file\n`;
  await expect(
    execute(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], input)
  ).resolves.toMatchObject({ stdout: input });
  await expect(
    execute(process.execPath, ['-e', 'process.exit(1)'], 'x'.repeat(1024 * 1024))
  ).rejects.toBeInstanceOf(Error);
});

it.each([
  ['(A;ID;FA;;;S-1-5-21-1-2-3-1001)', true],
  ['(A;;FA;;;S-1-5-21-1-2-3-1001)', true],
  ['(D;;FR;;;WD)', true],
  ['(A;ID;FA;;;SY)', false],
  ['(A;;FR;;;WD)', false],
  ['unparseable', false],
])('checks fresh leaf ACL %s with one icacls process', async (ace, valid) => {
  const path = join(state, 'config');
  await writeFile(path, '{}');
  const run = vi.fn(async (file: string, args: string[]) => {
    if (args.includes('/save')) saveFixture(args, [[path, ace]]);
    return {
      stdout: file.endsWith('whoami.exe') ? '"MACHINE\\agent","S-1-5-21-1-2-3-1001"' : '',
    };
  });
  await prepareWindowsAclDirectory(state, runner());
  run.mockClear();
  const check = verifyWindowsAcl(path, run);
  if (valid) await expect(check).resolves.toBeUndefined();
  else await expect(check).rejects.toThrow();
  expect(run.mock.calls.filter(([, args]) => args.includes('/save'))).toHaveLength(1);
  expect(run).toHaveBeenCalledWith('C:\\Windows\\System32\\icacls.exe', saved(path));
});

it('pays one Authenticode start across readers until the signed file digest changes', async () => {
  const { directory, names } = await payload({ platform: 'win32', identity: 'A'.repeat(40) });
  const native = runner();
  const run = vi.fn(async (file: string, args: string[], input?: string) =>
    file === 'powershell.exe' ? { stdout: '' } : native(file, args, input)
  );
  await new Reader(state, run).verifyRuntime('cli');
  await new Reader(state, run).verifyRuntime('cli');
  expect(run.mock.calls.filter(([file]) => file === 'powershell.exe')).toHaveLength(1);
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as Manifest;
  await writeFile(join(directory, names[0]!), 'y');
  manifest.files[names[0]!]!.sha256 = hash('y');
  const bytes = JSON.stringify(manifest);
  await writeFile(join(directory, 'manifest.json'), bytes);
  await writeFile(
    join(dirname(directory), 'current'),
    JSON.stringify({ current: { version: '1.0.0', manifestSha256: hash(bytes) } })
  );
  await new Reader(state, run).verifyRuntime('cli');
  expect(run.mock.calls.filter(([file]) => file === 'powershell.exe')).toHaveLength(2);
});

it('round-trips é and 日本 paths and a Unicode username using explicit native encodings', async () => {
  vi.resetModules();
  const root = join(state, 'José 日本');
  await mkdir(root);
  const user = 'MACHINE\\José日本';
  const calls: string[][] = [];
  const native = ((
    file: string,
    args: string[],
    options: { encoding: 'utf8' | 'utf16le' },
    callback: (error: null, output: string) => void
  ) => {
    calls.push(args);
    if (args.includes('/save')) saveFixture(args, [[root, '(A;;FA;;;S-1-5-21-1-2-3-1001)']]);
    const command = args.at(-1)!;
    const output =
      file.endsWith('whoami.exe') || command.includes('whoami.exe')
        ? `"${user}","S-1-5-21-1-2-3-1001"`
        : file.endsWith('icacls.exe') || command.includes('icacls.exe')
          ? `${root} ${user}:(F)\r\nSuccessfully processed 1 files; Failed processing 0 files`
          : ` Directory of ${dirname(root)}\r\n${dirRow('José 日本', user, '<DIR>')}`;
    const encoding = command.includes('dir /q') ? 'utf16le' : 'utf8';
    callback(null, Buffer.from(output, encoding).toString(options.encoding));
    return {};
  }) as typeof childProcess.execFile;
  vi.doMock('node:child_process', async (original) => ({
    ...(await original<typeof childProcess>()),
    execFile: native,
  }));
  const { auditWindowsPermissions: audit } = await import('../../shared/src/runtimeSigners.js');
  try {
    expect(await audit(root, [root], undefined, false)).toEqual(new Map([[root, 'ok']]));
    expect(calls).toEqual([
      [
        '/d',
        '/v:off',
        '/s',
        '/c',
        '"chcp 65001>nul & "C:\\Windows\\System32\\whoami.exe" /user /fo csv /nh"',
      ],
      ['/u', '/d', '/v:off', '/s', '/c', `dir /q /a "${dirname(root)}"`],
      [
        join(root, 'audit-tmp'),
        '/inheritance:r',
        '/grant:r',
        '*S-1-5-21-1-2-3-1001:(OI)(CI)F',
        '/remove:g',
        '*S-1-5-32-544',
        '*S-1-5-18',
      ],
      saved(root),
    ]);
  } finally {
    vi.doUnmock('node:child_process');
  }
});

it.each(['S-1-5-21-1-2-3-1001', 'S-1-5-21-9-9-9-1001', undefined])(
  'batches truncated owners once and fails closed for missing fallback (%s)',
  async (owner) => {
    const paths = [join(state, 'one'), join(state, 'two')];
    for (const path of paths) await writeFile(path, 'x');
    const native = runner();
    const run = vi.fn(async (file: string, args: string[], input?: string) => {
      if (file.endsWith('powershell.exe'))
        return { stdout: owner ? paths.map((path) => `${path}\t${owner}`).join('\n') : '' };
      const result = await native(file, args, input);
      if (file.endsWith('cmd.exe'))
        result.stdout = result.stdout.replaceAll(
          'MACHINE\\agent'.padEnd(23),
          'MACHINE\\a...'.padEnd(23)
        );
      return result;
    });
    const result = await auditWindowsPermissions(state, paths, run);
    for (const path of paths)
      expect(result.get(path)).toBe(
        owner === undefined ? 'acl_unavailable' : owner.endsWith('3-1001') ? 'ok' : 'owner'
      );
    const fallback = run.mock.calls.filter(([file]) => file.endsWith('powershell.exe'));
    expect(fallback).toHaveLength(1);
    expect(fallback[0]![2]).toContain(paths.join('\n'));
  }
);

it('cleans the export on native failure and keeps artifact directory identities stable', async () => {
  const { directory } = await payload();
  const run = runner();
  const reader = new Reader(state, run);
  await reader.verifyRuntime('cli');
  const before = lstatSync(directory);
  await verifyWindowsAcl(join(directory, 'manifest.json'), run, state);
  expect(lstatSync(directory).mtimeMs).toBe(before.mtimeMs);
  expect(readdirSync(join(state, 'audit-tmp'))).toEqual([]);
  await expect(
    verifyWindowsAcl(
      directory,
      async () => {
        throw new Error('save failed');
      },
      state
    )
  ).rejects.toThrow('save failed');
  expect(readdirSync(join(state, 'audit-tmp'))).toEqual([]);
});

// L-131: LA is resolved to a SID, never accepted by name. A local account's token
// carries S-1-5-113, so LA is its own domain's RID 500; the account and host
// names play no part ('renamed-host' names a machine the host name does not match,
// 'domain-admin' names this host yet is not a local account).
it.each([
  'local-admin',
  'renamed-host',
  'other-user',
  'domain-admin',
  'shared-admin',
  'shared-system',
])('resolves the local Administrator SDDL alias by SID (%s)', async (mode) => {
  vi.resetModules();
  const { verifyWindowsAcl: verify } = await import('../../shared/src/runtimeSigners.js');
  const sid = `S-1-5-21-1-2-3-${mode === 'other-user' ? '1001' : '500'}`;
  const account = `${mode === 'renamed-host' ? 'OLD-NAME' : hostname()}\\admin`;
  const localAccount = mode !== 'domain-admin';
  const run = async (file: string, args: string[]) => {
    if (file.endsWith('whoami.exe'))
      return {
        stdout: args.includes('/groups')
          ? [
              '"Everyone","Well-known group","S-1-1-0","Mandatory group, Enabled by default, Enabled group"',
              ...(localAccount
                ? [
                    '"NT AUTHORITY\\Local account","Well-known group","S-1-5-113","Mandatory group, Enabled by default, Enabled group"',
                  ]
                : []),
            ].join('\r\n')
          : `"${account}","${sid}"`,
      };
    if (args.includes('/save'))
      saveFixture(args, [
        [
          state,
          `(A;OICI;FA;;;LA)${mode === 'shared-admin' ? '(A;;FA;;;BA)' : mode === 'shared-system' ? '(A;;FA;;;SY)' : ''}`,
        ],
      ]);
    return { stdout: '' };
  };
  if (mode === 'local-admin' || mode === 'renamed-host')
    await expect(verify(state, run)).resolves.toBeUndefined();
  else await expect(verify(state, run)).rejects.toThrow('acl_permissions');
});

it('fails closed for duplicate SDDL paths and missing or null DACLs', () => {
  const path = basename(state);
  expect(() =>
    aclRecords(`${path}\nD:(A;;FA;;;WD)\n${path}\nD:(A;;FA;;;WD)`, state, [state])
  ).toThrow('acl_unavailable');
  expect(aclRecords(`${path}\nD:NO_ACCESS_CONTROL`, state, [state]).get(state)).toEqual([]);
  expect(aclRecords(`${path}\nD:PAI`, state, [state]).get(state)).toEqual([]);
});

it.each(['ok', 'foreign', 'shared', 'unchanged'])(
  'repairs elevated Windows ownership only for a private current-user path (%s)',
  async (mode) => {
    vi.resetModules();
    const { auditWindowsPermissions: audit } = await import('../../shared/src/runtimeSigners.js');
    const sid = 'S-1-5-21-1-2-3-1001';
    let owner = mode === 'foreign' ? 'S-1-5-21-1-2-3-1002' : 'S-1-5-32-544';
    const native = runner(() => (mode === 'shared' ? 'ace' : 'ok'));
    const run = vi.fn(async (file: string, args: string[], input?: string) => {
      if (file.endsWith('powershell.exe')) {
        if (args.at(-1)?.includes('/setowner') && mode !== 'unchanged') owner = sid;
        return { stdout: `${state}\t${owner}\n` };
      }
      const result = await native(file, args, input);
      if (file.endsWith('cmd.exe'))
        result.stdout = result.stdout.replaceAll(
          'MACHINE\\agent'.padEnd(23),
          'BUILTIN\\Administrators'.padEnd(23)
        );
      return result;
    });
    const result = await audit(state, [state], run, false);
    expect(result.get(state)).toBe(mode === 'ok' ? 'ok' : 'owner');
    const writes = run.mock.calls.filter(([, args]) => args.at(-1)?.includes('/setowner'));
    expect(writes).toHaveLength(mode === 'ok' || mode === 'unchanged' ? 1 : 0);
    if (mode === 'ok') {
      expect(owner).toBe(sid);
      expect(writes[0]![2]).toBe(state + '\n');
    }
  }
);

it.each(
  ['async', 'sync'].flatMap((mode) =>
    ['fresh', 'retry', 'foreign', 'shared', 'unchanged'].map((condition) => [mode, condition])
  )
)('protects %s hook caches with elevated ownership (%s)', async (mode, condition) => {
  vi.resetModules();
  const path = join(state, 'session');
  const fresh = condition === 'fresh';
  if (!fresh || mode === 'async') await mkdir(path);
  const sid = 'S-1-5-21-1-2-3-1001';
  let owner = condition === 'foreign' ? 'S-1-5-21-1-2-3-1002' : 'S-1-5-32-544';
  let privateAcl = !fresh && condition !== 'shared';
  let ownerWrites = 0;
  let directoryAclWrites = 0;
  const respond = (file: string, args: string[], input?: string): string => {
    if (file.endsWith('whoami.exe') || args.at(-1)?.includes('whoami.exe'))
      return `"MACHINE\\agent","${sid}"`;
    if (file.endsWith('powershell.exe')) {
      expect(input).toBe(path + '\n');
      if (args.at(-1)?.includes('/setowner')) {
        expect(privateAcl).toBe(true);
        ownerWrites++;
        if (condition !== 'unchanged') owner = sid;
      }
      return `${path}\t${owner}\n`;
    }
    if (file.endsWith('cmd.exe')) return dirRow('session', 'BUILTIN\\Administrators', '<DIR>');
    if (args[0] === path && args.includes('/grant:r')) {
      privateAcl = true;
      directoryAclWrites++;
    }
    if (args.includes('/save'))
      saveFixture(args, [[path, `(A;OICI;FA;;;${sid})${privateAcl ? '' : '(A;OICI;FR;;;WD)'}`]]);
    return '';
  };
  if (mode === 'sync')
    vi.doMock('node:child_process', async (original) => ({
      ...(await original<typeof childProcess>()),
      execFileSync: (file: string, args: string[], options: { input?: string }) =>
        respond(file, args, options.input),
    }));
  try {
    const hooks = await import('../../shared/src/runtimeSigners.js');
    const protect = async () => {
      if (mode === 'sync') hooks.ensureWindowsPrivateDirectorySync(path);
      else
        await hooks.protectWindowsDirectory(path, fresh, async (...args) => ({
          stdout: respond(...args),
        }));
    };
    if (condition === 'fresh' || condition === 'retry') {
      await expect(protect()).resolves.toBeUndefined();
      expect(owner).toBe(sid);
      expect(JSON.parse(await readFile(join(path, '.windows-acl.json'), 'utf8')).identity.sid).toBe(
        sid
      );
    } else
      await expect(protect()).rejects.toThrow(
        condition === 'shared' ? 'acl_permissions' : 'acl_owner'
      );
    expect(ownerWrites).toBe(['fresh', 'retry', 'unchanged'].includes(condition!) ? 1 : 0);
    expect(directoryAclWrites).toBe(fresh ? 1 : 0);
  } finally {
    vi.doUnmock('node:child_process');
  }
});
