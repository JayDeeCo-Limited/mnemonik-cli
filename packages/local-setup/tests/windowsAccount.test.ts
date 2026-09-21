import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { windowsCurrentUserAcl } from '../src/storage.js';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFileSync: vi.fn(() => '"MACHINE\\agent","S-1-5-21-1-2-3-1001"'),
}));
afterEach(() => vi.unstubAllEnvs());

it('uses the cached process-token SID when SSH advertises a workgroup as USERDOMAIN', async () => {
  vi.stubEnv('SystemRoot', 'C:\\Windows');
  vi.stubEnv('USERDOMAIN', 'WORKGROUP');
  vi.stubEnv('USERNAME', 'agent');
  const execFile = vi.fn((_file, _args, callback) => callback(null, '', ''));
  await windowsCurrentUserAcl('C:\\state', true, { execFile }, true);
  await windowsCurrentUserAcl('C:\\existing', true, { execFile });
  await windowsCurrentUserAcl('C:\\state\\secret', false, { execFile });
  expect(execFile.mock.calls.map((call) => call[1])).toEqual([
    // Only the directory this process created gives up its privileged grants.
    [
      'C:\\state',
      '/inheritance:r',
      '/grant:r',
      '*S-1-5-21-1-2-3-1001:(OI)(CI)F',
      '/remove:g',
      '*S-1-5-32-544',
      '*S-1-5-18',
    ],
    ['C:\\existing', '/inheritance:r', '/grant:r', '*S-1-5-21-1-2-3-1001:(OI)(CI)F'],
    ['C:\\state\\secret', '/inheritance:r', '/grant:r', '*S-1-5-21-1-2-3-1001:F'],
  ]);
  expect(execFileSync).toHaveBeenCalledTimes(1);
  expect(execFileSync).toHaveBeenCalledWith(
    'C:\\Windows\\System32\\cmd.exe',
    [
      '/d',
      '/v:off',
      '/s',
      '/c',
      '"chcp 65001>nul & "C:\\Windows\\System32\\whoami.exe" /user /fo csv /nh"',
    ],
    // fa0ff6474 gives native leaf checks a five-second command budget.
    expect.objectContaining({ timeout: 5000, encoding: 'utf8', windowsVerbatimArguments: true })
  );
});
