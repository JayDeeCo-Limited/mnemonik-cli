import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../src/runtime/bootstrap.js', () => ({ bootstrap: vi.fn() }));
const argv = process.argv;
const exitCode = process.exitCode;
afterEach(() => {
  process.argv = argv;
  process.exitCode = exitCode;
  vi.restoreAllMocks();
});

it.each([
  'permission',
  'acl_unavailable',
  'digest_mismatch',
  'manifest_missing',
  'unsigned',
  'runtime_failed',
  'future_reason',
])('explains bootstrap failure %s without exposing its internal reason', async (reason) => {
  vi.resetModules();
  const current = await import('../src/runtime/bootstrap.js');
  vi.mocked(current.bootstrap).mockRejectedValueOnce(
    Object.assign(new Error(reason), { name: 'RuntimeError', reason })
  );
  process.argv = ['node', 'mnemonik', 'install'];
  process.exitCode = undefined;
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  await import('../src/bin.js');
  const text = stderr.mock.calls.map(([line]) => line).join('');
  expect(text).toContain('Installation stopped.');
  expect(text).toContain('Run npx -y @mnemonik/cli@latest install to try again.');
  expect(text).not.toContain(reason);
  expect(process.exitCode).toBe(1);
});

it.each(['permission', 'lock_held'])(
  'preserves the bootstrap --json contract for %s',
  async (reason) => {
    vi.resetModules();
    const current = await import('../src/runtime/bootstrap.js');
    vi.mocked(current.bootstrap).mockRejectedValueOnce(
      Object.assign(new Error(reason), { name: 'RuntimeError', reason })
    );
    process.argv = ['node', 'mnemonik', 'install', '--json'];
    process.exitCode = undefined;
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await import('../src/bin.js');
    expect(stdout.mock.calls.map(([line]) => line).join('')).toBe(
      reason === 'lock_held' ? '{"status":"FAILED","reason":"lock_held"}\n' : ''
    );
    expect(stderr.mock.calls.map(([line]) => line).join('')).toBe(
      reason === 'lock_held' ? '' : `${reason}\n`
    );
  }
);
