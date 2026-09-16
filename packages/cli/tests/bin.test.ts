import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ bootstrap: vi.fn() }));
vi.mock('../src/runtime/bootstrap.js', () => ({
  bootstrap: mocks.bootstrap,
}));

const argv = process.argv;

beforeEach(async () => {
  vi.resetModules();
  const { RuntimeError } = await import('../../shared/src/runtimeReader.js');
  mocks.bootstrap.mockRejectedValue(new RuntimeError('lock_held'));
  process.exitCode = undefined;
});

afterEach(() => {
  process.argv = argv;
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe('runtime lock output', () => {
  it('writes the lock_held reason as one JSON document and exits one', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    process.argv = ['node', 'mnemonik', '--json'];
    await import('../src/bin.js');
    expect(stdout).toHaveBeenCalledExactlyOnceWith('{"status":"FAILED","reason":"lock_held"}\n');
    expect(stderr).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('writes the actionable lock message in text mode and exits one', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    process.argv = ['node', 'mnemonik', 'status'];
    await import('../src/bin.js');
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledExactlyOnceWith(
      'Another mnemonik command holds the state lock; retry in a moment.\n'
    );
    expect(process.exitCode).toBe(1);
  });

  it('prints a thrown Error message without replacing an existing exit code', async () => {
    const error = new Error('release manifest is malformed');
    mocks.bootstrap.mockRejectedValueOnce(error);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    process.argv = ['node', 'mnemonik', 'status'];
    process.exitCode = 7;
    await import('../src/bin.js');
    expect(stderr).toHaveBeenCalledExactlyOnceWith('release manifest is malformed\n');
    expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining(error.stack ?? 'Error'));
    expect(process.exitCode).toBe(7);
  });
});
