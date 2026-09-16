import { expect, it, vi } from 'vitest';
import {
  appendWindowsPath,
  readWindowsUserPath,
  removeWindowsPathEntry,
  writeWindowsUserPath,
} from '../src/windowsPath.js';

it('appends once while preserving raw PATH bytes and registry kind', () => {
  const before = { value: '%USERPROFILE%\\tools;;C:\\Other;', kind: 'ExpandString' as const };
  expect(appendWindowsPath(before, 'C:\\Users\\Ada\\Mnemonik\\bin')).toEqual({
    ...before,
    value: before.value + 'C:\\Users\\Ada\\Mnemonik\\bin',
  });
  const present = {
    value: 'C:\\other;"%LOCALAPPDATA%\\mnemonik\\BIN\\";',
    kind: 'String' as const,
  };
  expect(
    appendWindowsPath(present, 'C:\\Users\\Ada\\AppData\\Local\\Mnemonik\\bin', {
      LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local',
    })
  ).toBe(present);
});

it('removes one normalized PATH entry, preferring its recorded component position', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local' };
  const directory = 'C:\\Users\\Ada\\AppData\\Local\\Mnemonik\\bin';
  expect(
    removeWindowsPathEntry(
      `C:\\old;"%LOCALAPPDATA%\\MNEMONIK\\BIN\\";${directory};C:\\later`,
      directory,
      1,
      env
    )
  ).toBe(`C:\\old;${directory};C:\\later`);
});

it.each([
  null,
  { value: '', kind: 'String' },
  { value: '%USERPROFILE%\\é !;C:\\old;;', kind: 'ExpandString' },
] as const)('reads and restores the raw HKCU value %j through ExecFile', async (before) => {
  const scripts: string[] = [];
  const execFile = vi.fn((file, args, callback) => {
    expect(file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    const script = Buffer.from(args[3], 'base64').toString('utf16le');
    scripts.push(script);
    expect(script).toContain('[Microsoft.Win32.Registry]::CurrentUser');
    expect(script).not.toMatch(/LocalMachine|RunAs|SetEnvironmentVariable/);
    callback(null, JSON.stringify(before), '');
  });
  const options = { execFile, env: { SystemRoot: 'C:\\Windows' } };
  expect(await readWindowsUserPath(options)).toEqual(before);
  const after = appendWindowsPath(before, 'C:\\Mnemonik\\bin');
  await writeWindowsUserPath(after, before, options);
  expect(scripts[0]).toContain('DoNotExpandEnvironmentNames');
  expect(scripts[1]).toContain("throw 'user_path_changed'");
  expect(scripts[1]).toContain('SendMessageTimeout');
  const encoded = /FromBase64String\('([^']+)'\)/.exec(scripts[1]!)![1]!;
  expect(JSON.parse(Buffer.from(encoded, 'base64').toString())).toEqual({
    before: after,
    after: before,
  });
});

it('propagates denied registry access rather than claiming PATH was set', async () => {
  const execFile = vi.fn((_file, _args, callback) => callback(new Error('Access denied'), '', ''));
  await expect(
    writeWindowsUserPath(null, { value: 'C:\\bin', kind: 'String' }, { execFile })
  ).rejects.toThrow('Access denied');
});
