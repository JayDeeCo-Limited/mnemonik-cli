import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { helpScreen } from '../src/help.js';
import { humanReason } from '../src/humanReason.js';
import { runCli, type CliDependencies } from '../src/router.js';

// `renew` is what the CLI and the hook tell a person to run when the server
// refuses this computer's sign-in. The stored token looks valid on this
// computer, so `mnemonik auth renew` signs in again without trusting it, where
// `mnemonik auth login` shows who is already signed in.

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'auth-renew-'));
  homes.push(home);
  const stdout = { text: '', write: (chunk: string) => void (stdout.text += chunk) };
  const stderr = { text: '', write: (chunk: string) => void (stderr.text += chunk) };
  // A stored, unexpired token that the server has refused. Signing in stores a new one.
  let stored = 'stored-token';
  const cliAuth = {
    signIn: vi.fn(async () => {
      stored = 'fresh-token';
    }),
    getCliBearer: vi.fn(async () => stored),
    accountEmail: vi.fn(async () => 'person@example.com'),
    logout: vi.fn(async () => undefined),
  };
  const deps: CliDependencies = {
    home,
    installStateDir: join(home, 'state'),
    stdout,
    stderr,
    cliAuth,
  };
  return { deps, stdout, stderr, cliAuth };
}

describe('mnemonik auth renew', () => {
  it('prints its screen for --help', async () => {
    const f = fixture();
    expect(await runCli(['auth', 'renew', '--help'], f.deps)).toBe(0);
    expect(f.stdout.text).toBe(helpScreen(['auth', 'renew']));
    expect(f.stdout.text).toContain(
      "Renew this computer's sign-in to Mnemonik: signs in again even if it looks signed in."
    );
    expect(f.stdout.text).toContain('Usage: mnemonik auth renew [options]');
    expect(f.stdout.text).toContain(helpScreen(['auth', 'login'])!.split('\n')[0]);
  });

  it('signs in again even with a stored unexpired token, never using that token', async () => {
    const f = fixture();
    expect(await runCli(['auth', 'renew', '--json'], f.deps)).toBe(0);
    expect(f.cliAuth.signIn).toHaveBeenCalledOnce();
    const signedIn = f.cliAuth.signIn.mock.invocationCallOrder[0]!;
    // Nothing reads the stored token, or looks the account up with it, before signing in.
    for (const order of f.cliAuth.getCliBearer.mock.invocationCallOrder)
      expect(order).toBeGreaterThan(signedIn);
    expect(f.cliAuth.accountEmail).not.toHaveBeenCalledWith('stored-token');
    expect(f.stdout.text).toBe(
      'Signed in as person@example.com\nRun mnemonik logout to switch account.\n'
    );
    expect(f.stderr.text).toBe('');
  });

  it('leaves auth login showing who is signed in, without signing in again', async () => {
    const f = fixture();
    expect(await runCli(['auth', 'login', '--json'], f.deps)).toBe(0);
    expect(f.cliAuth.signIn).not.toHaveBeenCalled();
    expect(f.cliAuth.accountEmail).toHaveBeenCalledWith('stored-token');
    expect(f.stdout.text).toContain('Signed in as person@example.com');
  });

  it('is listed in auth --help', async () => {
    const f = fixture();
    expect(await runCli(['auth', '--help'], f.deps)).toBe(0);
    expect(f.stdout.text).toContain(
      '  renew                       Sign this computer in again, even if it looks signed in.\n'
    );
  });

  it('is a usage error with command "auth renew" for a flag it does not take', async () => {
    const f = fixture();
    expect(await runCli(['auth', 'renew', '--bogus', '--json'], f.deps)).toBe(2);
    expect(f.stderr.text).toBe('');
    expect(JSON.parse(f.stdout.text)).toEqual({
      status: 'usage_error',
      reason: 'invalid_flag',
      command: 'auth renew',
      detail: '--bogus',
      action: 'mnemonik auth renew --help',
    });
  });

  it('is the command the renew sentence names', () => {
    expect(humanReason('renew')).toContain('Run mnemonik auth renew');
  });
});
