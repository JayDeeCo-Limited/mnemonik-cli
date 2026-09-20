import { execFile as nodeExecFile, ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ExecFile, WindowsPathValue } from '@mnemonik/local-setup';
import {
  ensureLauncher,
  launcherPathAction,
  launcherStatus,
  removeLauncher,
  type LauncherOptions,
} from '../src/launcher.js';
import { runCli, type CliDependencies } from '../src/router.js';

const homes: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
async function fixture(platform: NodeJS.Platform = 'linux') {
  const home = await mkdtemp(join(tmpdir(), 'cli-launcher-'));
  homes.push(home);
  const options: LauncherOptions = {
    home,
    stateDir: join(home, 'state'),
    platform,
    env: { PATH: '/usr/bin', SHELL: '/bin/bash', LOCALAPPDATA: join(home, 'Local AppData') },
  };
  return { home, options, path: (await launcherStatus(options)).path };
}
function windows(before: WindowsPathValue) {
  let current = before;
  const changes: Array<{ before: WindowsPathValue; after: WindowsPathValue }> = [];
  const execFile: ExecFile = (_file, args, callback) => {
    const script = Buffer.from(args[3]!, 'base64').toString('utf16le');
    const payload = /FromBase64String\('([^']+)'\)/.exec(script)?.[1];
    if (payload) {
      const change = JSON.parse(
        Buffer.from(payload, 'base64').toString()
      ) as (typeof changes)[number];
      expect(change.before).toEqual(current);
      changes.push(change);
      current = change.after;
    }
    callback(null, JSON.stringify(current), '');
  };
  return {
    execFile,
    changes,
    get current() {
      return current;
    },
    set current(value) {
      current = value;
    },
  };
}
function dependencies(f: Awaited<ReturnType<typeof fixture>>): CliDependencies {
  return {
    home: f.home,
    cwd: f.home,
    installStateDir: f.options.stateDir,
    launcher: f.options,
    stdout: { write() {} },
    stderr: { write() {} },
    cliAuth: {
      getCliBearer: async () => ({ status: 'ACTION_REQUIRED', reason: 'signed_out' }),
      signIn: async () => {},
      logout: async () => {},
    },
    preflight: {
      nodeVersion: '24.21.0',
      platform: f.options.platform,
      pathExists: async () => false,
      fetch: async () => Response.json({}),
      resolveIdentity: async () => ({
        kind: 'absent',
        root: f.home,
        repository: { kind: 'plain', root: f.home },
        nested: [],
      }),
    },
    scannerStatus: async () => ({ roots: [], exclusions: [], repositories: [] }),
    projectHookConditions: [],
    codexTrustConditions: async () => [],
  };
}

it.each(['linux', 'darwin'] as const)(
  'writes the fixed %s launcher with executable mode and PATH lookup',
  async (platform) => {
    const f = await fixture(platform);
    const status = await ensureLauncher(f.options);
    const node = await realpath(process.execPath);
    expect(await readFile(f.path, 'utf8')).toBe(
      `#!/bin/sh\n# --mnemonik-owner=cli\nif [ ! -x "${node}" ]; then\n  echo 'The Node installation that Mnemonik was set up with has moved; run the install command again.' >&2\n  exit 1\nfi\nexec "${node}" "${f.options.stateDir}/runtimes/bootstrap/dist/bin.js" "$@"\n`
    );
    expect((await stat(f.path)).mode & 0o777).toBe(0o755);
    expect(status).toMatchObject({ ownership: 'ours', onPath: false });
    expect(
      await launcherStatus({ ...f.options, env: { PATH: `${dirname(f.path)}/:/bin` } })
    ).toMatchObject({ onPath: true });
  }
);

it('ignores a foreign Node on PATH and forwards literal arguments and exit status', async () => {
  const f = await fixture();
  f.options.stateDir = join(f.home, 'state $HOME `echo unsafe` " quote');
  await ensureLauncher(f.options);
  const entry = join(f.options.stateDir, 'runtimes/bootstrap/dist/bin.js');
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(
    entry,
    'process.stdout.write(JSON.stringify(process.argv.slice(2))); process.exitCode = 17;'
  );
  const bin = join(f.home, 'node-bin');
  await mkdir(bin);
  const foreign = join(bin, 'node');
  const sentinel = join(f.home, 'foreign-node-ran');
  await writeFile(foreign, `#!/bin/sh\nprintf attacked > "${sentinel}"\nexit 99\n`);
  await chmod(foreign, 0o755);
  const args = ['status', 'space here', '$HOME', 'a"b', '*'];
  await expect(promisify(nodeExecFile)(f.path, args, { env: { PATH: bin } })).rejects.toMatchObject(
    {
      code: 17,
      stdout: JSON.stringify(args),
    }
  );
  await expect(readFile(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('prints one plain line and exits non-zero when the pinned Node has moved', async () => {
  const f = await fixture();
  await ensureLauncher(f.options);
  const node = await realpath(process.execPath);
  const missing = join(f.home, 'moved-node');
  await writeFile(f.path, (await readFile(f.path, 'utf8')).replaceAll(`"${node}"`, `"${missing}"`));
  await expect(
    promisify(nodeExecFile)(f.path, [], { env: { PATH: '/usr/bin' } })
  ).rejects.toMatchObject({
    code: 1,
    stdout: '',
    stderr:
      'The Node installation that Mnemonik was set up with has moved; run the install command again.\n',
  });
});

it.each(['foreign', 'marker-only', 'symlink'] as const)(
  'refuses a %s launcher with path and manual action',
  async (kind) => {
    const f = await fixture();
    await mkdir(dirname(f.path), { recursive: true });
    const bytes = kind === 'marker-only' ? '# --mnemonik-owner=cli\necho unsafe\n' : 'my command\n';
    if (kind === 'symlink') await symlink('/missing', f.path);
    else await writeFile(f.path, bytes);
    await expect(ensureLauncher(f.options)).rejects.toMatchObject({
      status: 'ACTION_REQUIRED',
      launcher: {
        path: f.path,
        ownership: 'not_ours',
        action: expect.stringContaining('npx -y @mnemonik/cli@latest install'),
      },
    });
    await expect(removeLauncher(f.options)).rejects.toMatchObject({ status: 'ACTION_REQUIRED' });
    if (kind !== 'symlink') expect(await readFile(f.path, 'utf8')).toBe(bytes);
  }
);

it('repair restores a missing launcher, preserves an owned file byte-for-byte, and refuses a replacement', async () => {
  const f = await fixture();
  const deps = dependencies(f);
  expect(await runCli(['repair', '--json'], deps)).toBe(0);
  const original = await readFile(f.path);
  await utimes(f.path, 1000, 1000);
  expect(await runCli(['repair', '--json'], deps)).toBe(0);
  expect((await stat(f.path)).mtimeMs).toBe(1000000);
  expect(await readFile(f.path)).toEqual(original);
  await writeFile(f.path, 'somebody else');
  expect(await runCli(['repair', '--json'], deps)).toBe(3);
  expect(await readFile(f.path, 'utf8')).toBe('somebody else');
});

it.each(['update', 'repair'] as const)(
  '%s re-pins a changed Node path and then leaves the launcher alone',
  async (command) => {
    const f = await fixture();
    const node = await realpath(process.execPath);
    const oldNode = join(f.home, 'old-node');
    await ensureLauncher(f.options);
    await writeFile(
      f.path,
      (await readFile(f.path, 'utf8')).replaceAll(`"${node}"`, `"${oldNode}"`)
    );
    const recordPath = join(f.options.stateDir!, 'launcher.json');
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    await writeFile(recordPath, JSON.stringify({ ...record, node: oldNode }));

    expect(await runCli([command, '--json'], dependencies(f))).toBe(0);
    expect(await readFile(f.path, 'utf8')).toContain(`exec "${node}"`);
    expect(JSON.parse(await readFile(recordPath, 'utf8')).node).toBe(node);
    await utimes(f.path, 1000, 1000);
    expect(await runCli([command, '--json'], dependencies(f))).toBe(0);
    expect((await stat(f.path)).mtimeMs).toBe(1000000);
  }
);

it('plain uninstall removes the launcher even when no hosts or scanner remain', async () => {
  const f = await fixture();
  await ensureLauncher(f.options);
  const deps = dependencies(f);
  let text = '';
  deps.stdout = {
    write(chunk) {
      text += chunk;
    },
  };
  expect(await runCli(['uninstall', '--non-interactive', '--confirm'], deps)).toBe(0);
  expect(text).toBe(
    'Stopped collection; removed local software. Credentials, cloud data and consent retained.\n'
  );
  expect((await launcherStatus(f.options)).ownership).toBe('missing');
  await expect(readFile(join(f.options.stateDir!, 'launcher.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });

  text = '';
  expect(await runCli(['uninstall', '--non-interactive', '--confirm', '--json'], deps)).toBe(0);
  expect(JSON.parse(text)).toMatchObject({
    targets: [],
    scanner: { status: 'not_installed' },
    launcher: { status: 'not_installed' },
  });
});

it.each([
  null,
  { value: '', kind: 'String' },
  { value: '%USERPROFILE%\\é !;;C:\\other;', kind: 'ExpandString' },
] as const)('Windows uninstall restores journaled PATH %j byte for byte', async (before) => {
  const f = await fixture('win32');
  const env = windows(before);
  f.options.execFile = env.execFile;
  const result = await ensureLauncher(f.options);
  const bytes = await readFile(f.path, 'utf8');
  expect(bytes).toBe(
    `@echo off\r\nrem --mnemonik-owner=cli\r\nsetlocal DisableDelayedExpansion\r\nif not exist "${await realpath(process.execPath)}" (\r\n  echo The Node installation that Mnemonik was set up with has moved; run the install command again. 1>&2\r\n  exit /b 1\r\n)\r\nset "MNEMONIK_LAUNCHER=1"\r\n"${await realpath(process.execPath)}" "${f.options.stateDir}/runtimes/bootstrap/dist/bin.js" %*\r\nexit /b %errorlevel%\r\n`
  );
  expect(bytes.split('\r\n').at(-2)).toBe('exit /b %errorlevel%');
  expect(bytes).not.toContain('EnableDelayedExpansion');
  expect(bytes).not.toContain('!errorlevel!');
  const record = JSON.parse(await readFile(join(f.options.stateDir!, 'launcher.json'), 'utf8'));
  expect(record.windowsPath).toEqual({ before, after: env.current });
  expect(result.path).toBe(join(f.options.env!.LOCALAPPDATA!, 'Mnemonik/bin/mnemonik.cmd'));
  expect(result).toMatchObject({
    onPath: false,
    action: 'Open a new terminal, then run mnemonik status.',
  });
  await utimes(f.path, 1000, 1000);
  await ensureLauncher(f.options);
  expect((await stat(f.path)).mtimeMs).toBe(1000000);
  expect(env.changes).toHaveLength(1);
  expect(
    await runCli(['uninstall', '--non-interactive', '--confirm', '--json'], dependencies(f))
  ).toBe(0);
  expect(env.current).toEqual(before);
  expect(env.changes).toHaveLength(2);
  expect((await launcherStatus(f.options)).ownership).toBe('missing');
});

it.each([
  ['update', 'two-line'],
  ['repair', 'two-line'],
  ['update', 'one-line'],
  ['repair', 'one-line'],
] as const)(
  '%s recognizes and rewrites the previous Windows %s launcher',
  async (command, shape) => {
    const f = await fixture('win32');
    const env = windows(null);
    f.options.execFile = env.execFile;
    await ensureLauncher(f.options);
    const node = await realpath(process.execPath);
    const previous =
      `@echo off\r\nrem --mnemonik-owner=cli\r\nsetlocal DisableDelayedExpansion\r\nif not exist "${node}" (\r\n` +
      '  echo The Node installation that Mnemonik was set up with has moved; run the install command again. 1>&2\r\n' +
      '  exit /b 1\r\n)\r\n' +
      `"${node}" "${f.options.stateDir}/runtimes/bootstrap/dist/bin.js" %*\r\n` +
      'exit /b %errorlevel%\r\n';
    await writeFile(
      f.path,
      shape === 'two-line'
        ? previous
        : previous.replace('%*\r\nexit /b %errorlevel%', '%* & exit /b')
    );

    expect((await launcherStatus(f.options)).ownership).toBe('ours');
    expect(await runCli([command, '--json'], dependencies(f))).toBe(0);
    const current = await readFile(f.path, 'utf8');
    expect(current).toContain('set "MNEMONIK_LAUNCHER=1"\r\n');
    expect(current).toMatch(/ %\*\r\nexit \/b %errorlevel%\r\n$/);
    expect((await launcherStatus(f.options)).ownership).toBe('ours');
    await utimes(f.path, 1000, 1000);
    expect(await runCli([command, '--json'], dependencies(f))).toBe(0);
    expect((await stat(f.path)).mtimeMs).toBe(1000000);
  }
);

it('quotes and doubles percent signs on the Windows Node line', async () => {
  const f = await fixture('win32');
  f.options.stateDir = join(f.home, '%state%');
  f.options.execFile = windows(null).execFile;
  await ensureLauncher(f.options);
  const node = await realpath(process.execPath);
  expect((await readFile(f.path, 'utf8')).split('\r\n').at(-3)).toBe(
    `"${node.replaceAll('%', '%%')}" "${f.options.stateDir.replaceAll('%', '%%')}/runtimes/bootstrap/dist/bin.js" %*`
  );
});

it.each([true, false])(
  'Windows removal defers only when the launcher marker is %s',
  async (marked) => {
    const f = await fixture('win32');
    f.options.env!.LOCALAPPDATA = join(f.home, "User's [apps] ! %data%");
    f.path = (await launcherStatus(f.options)).path;
    const env = windows(null);
    f.options.execFile = env.execFile;
    if (marked) f.options.env!.MNEMONIK_LAUNCHER = '1';
    const child = new ChildProcess();
    const spawn = vi.fn(() => {
      process.nextTick(() => child.emit('exit', 0, null));
      return child;
    });
    Object.assign(f.options, { spawn });
    await ensureLauncher(f.options);
    const original = await readFile(f.path);

    expect(await removeLauncher(f.options)).toBe(true);
    if (marked) {
      const helper = Buffer.from(
        `Start-Sleep -Seconds 2; Remove-Item -LiteralPath '${f.path.replaceAll("'", "''")}' -Force`,
        'utf16le'
      ).toString('base64');
      expect(spawn).toHaveBeenCalledExactlyOnceWith(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Start-Process -FilePath powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','${helper}')`,
        ],
        { stdio: 'ignore', windowsHide: true }
      );
      expect(await readFile(f.path)).toEqual(original);
      expect((await launcherStatus(f.options)).ownership).toBe('ours');
    } else {
      expect(spawn).not.toHaveBeenCalled();
      expect((await launcherStatus(f.options)).ownership).toBe('missing');
    }
    expect(env.current).toBeNull();
    await expect(readFile(join(f.options.stateDir!, 'launcher.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  }
);

it.each([false, true])('Windows deferred uninstall explains removal with json=%s', async (json) => {
  const f = await fixture('win32');
  f.options.execFile = windows(null).execFile;
  f.options.env!.MNEMONIK_LAUNCHER = '1';
  Object.assign(f.options, {
    spawn: () => {
      const child = new ChildProcess();
      process.nextTick(() => child.emit('exit', 0, null));
      return child;
    },
  });
  await ensureLauncher(f.options);
  const deps = dependencies(f);
  let text = '';
  deps.stdout = {
    write(chunk) {
      text += chunk;
    },
  };
  expect(
    await runCli(['uninstall', '--non-interactive', '--confirm', ...(json ? ['--json'] : [])], deps)
  ).toBe(0);
  if (json) expect(JSON.parse(text)).toMatchObject({ launcher: { status: 'removed' } });
  else expect(text).toContain('The command file is removed a moment after this command finishes.');
  expect((await launcherStatus(f.options)).ownership).toBe('ours');
});

it('keeps the launcher and recovery record when the removal helper cannot start', async () => {
  const f = await fixture('win32');
  f.options.execFile = windows(null).execFile;
  f.options.env!.MNEMONIK_LAUNCHER = '1';
  Object.assign(f.options, {
    spawn: () => {
      const child = new ChildProcess();
      process.nextTick(() => child.emit('error', new Error('spawn denied')));
      return child;
    },
  });
  await ensureLauncher(f.options);
  await expect(removeLauncher(f.options)).rejects.toThrow('spawn denied');
  expect((await launcherStatus(f.options)).ownership).toBe('ours');
  expect(
    JSON.parse(await readFile(join(f.options.stateDir!, 'launcher.json'), 'utf8'))
  ).toMatchObject({ phase: 'removing' });
});

it('keeps a pre-existing Windows PATH entry and unrelated edits made after install', async () => {
  const f = await fixture('win32');
  const directory = dirname(f.path);
  const before = { value: `C:\\old;${directory}`, kind: 'String' as const };
  const env = windows(before);
  f.options.execFile = env.execFile;
  await ensureLauncher(f.options);
  await removeLauncher(f.options);
  expect(env.current).toEqual(before);
  expect(env.changes).toHaveLength(0);
  env.current = { value: 'C:\\old;;', kind: 'String' };
  await ensureLauncher(f.options);
  env.current = { ...env.current!, value: `${env.current!.value};C:\\later` };
  await removeLauncher(f.options);
  expect(env.current).toEqual({ value: 'C:\\old;;C:\\later', kind: 'String' });
});

it('Windows uninstall removes only the recorded occurrence when the user adds a duplicate', async () => {
  const f = await fixture('win32');
  const directory = dirname(f.path);
  const env = windows({ value: 'C:\\old', kind: 'String' });
  f.options.execFile = env.execFile;
  await ensureLauncher(f.options);
  env.current = { value: `C:\\old;${directory};${directory};C:\\later`, kind: 'String' };
  await removeLauncher(f.options);
  expect(env.current).toEqual({ value: `C:\\old;${directory};C:\\later`, kind: 'String' });
});

it('Windows uninstall removes one normalized rewrite of the recorded occurrence', async () => {
  const f = await fixture('win32');
  const directory = dirname(f.path);
  const env = windows({ value: 'C:\\old', kind: 'String' });
  f.options.execFile = env.execFile;
  await ensureLauncher(f.options);
  env.current = { value: `C:\\old;"${directory.toUpperCase()}\\";C:\\later`, kind: 'String' };
  await removeLauncher(f.options);
  expect(env.current).toEqual({ value: 'C:\\old;C:\\later', kind: 'String' });
});

it('retains the original Windows PATH journal when a write fails and can resume', async () => {
  const f = await fixture('win32');
  const before = { value: '%USERPROFILE%\\tools;;', kind: 'ExpandString' as const };
  const env = windows(before);
  let fail = true;
  f.options.execFile = (file, args, callback) => {
    const script = Buffer.from(args[3]!, 'base64').toString('utf16le');
    if (fail && script.includes('FromBase64String')) {
      fail = false;
      callback(new Error('Access denied'), '', '');
    } else env.execFile(file, args, callback);
  };
  await expect(ensureLauncher(f.options)).rejects.toThrow('Access denied');
  expect(env.current).toEqual(before);
  expect(
    JSON.parse(await readFile(join(f.options.stateDir!, 'launcher.json'), 'utf8'))
  ).toMatchObject({ phase: 'installing', windowsPath: { before } });
  await ensureLauncher(f.options);
  await removeLauncher(f.options);
  expect(env.current).toEqual(before);
});

it.each(['status', 'doctor'])(
  '%s reports all ownership and current PATH states with actions',
  async (command) => {
    const f = await fixture();
    const deps = dependencies(f);
    for (const ownership of ['missing', 'ours', 'not_ours']) {
      if (ownership === 'ours') await ensureLauncher(f.options);
      if (ownership === 'not_ours') await writeFile(f.path, 'foreign');
      for (const onPath of [true, false]) {
        deps.launcher = {
          ...f.options,
          env: { SHELL: '/bin/zsh', PATH: onPath ? dirname(f.path) : '/usr/bin' },
        };
        let text = '';
        deps.stdout = {
          write: (chunk) => {
            text += chunk;
          },
        };
        await runCli([command, '--json'], deps);
        expect(JSON.parse(text).launcher).toMatchObject({
          ownership,
          onPath,
          action: expect.any(String),
        });
        text = '';
        await runCli([command], deps);
        if (command === 'status') {
          expect(text).not.toContain('Launcher:');
          expect(text).not.toContain(f.path);
        } else {
          expect(text).toContain(
            `Launcher: ${ownership === 'ours' ? 'present and ours' : ownership === 'not_ours' ? 'present and not ours' : 'missing'}`
          );
          expect(text).toContain(`directory ${onPath ? 'on' : 'off'} current PATH`);
          if (!onPath) expect(text).toContain('export PATH="$HOME/.local/bin:$PATH" to ~/.zshrc');
        }
      }
    }
  }
);

it.each([
  ['linux', '/bin/bash', '~/.bashrc'],
  ['darwin', '/bin/bash', '~/.bashrc and ~/.bash_profile'],
  ['darwin', '/bin/zsh', '~/.zshrc'],
  ['linux', '/usr/bin/fish', 'fish_add_path ~/.local/bin'],
] as const)('names the %s %s shell instruction', (platform, SHELL, expected) => {
  expect(launcherPathAction({ platform, env: { SHELL } })).toContain(expected);
  expect(launcherPathAction({ platform, env: { SHELL } })).toContain('new terminal after');
});

it.each([
  ['unset', undefined],
  ['unknown', '/opt/nushell'],
  ['sh', '/bin/sh'],
] as const)('gives an actionable POSIX instruction when SHELL is %s', (_name, SHELL) => {
  const action = launcherPathAction({ platform: 'linux', env: SHELL ? { SHELL } : {} });
  expect(action).toContain('export PATH="$HOME/.local/bin:$PATH"');
  expect(action).toContain('start-up file of the shell you use');
  expect(action).toContain('shell could not be detected');
});
