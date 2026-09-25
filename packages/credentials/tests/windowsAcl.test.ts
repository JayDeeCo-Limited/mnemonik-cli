/**
 * L-131: the credentials store inspects Windows permissions too. Windows has no
 * mode bits, so the DACL is read (through the shared icacls export) and a file
 * any other account can read is refused as POSIX refuses mode 0644. Driven by
 * fixture icacls output; no Windows host needed.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { CredentialError, SecureFiles } from '../src/storage.js';

const SID = 'S-1-5-21-1-2-3-1001';
let stateDir: string;
let secret: string;

beforeEach(async () => {
  vi.stubEnv('SystemRoot', 'C:\\Windows');
  stateDir = join(await mkdtemp(join(tmpdir(), 'credentials-acl-')), 'state');
  secret = join(stateDir, 'credentials', 'secrets', 'cli.json');
  await mkdir(dirname(secret), { recursive: true });
  await writeFile(secret, '{"refreshToken":"secret"}');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dirname(stateDir), { recursive: true, force: true });
});

/** whoami and icacls as Windows answers them, with `aces` as the file's DACL. */
function nativeWith(aces: string) {
  return vi.fn(async (file: string, args: string[]) => {
    if (file.endsWith('whoami.exe')) return { stdout: `"MACHINE\\agent","${SID}"` };
    if (args.includes('/save'))
      writeFileSync(
        args[args.indexOf('/save') + 1]!,
        `${relative(dirname(args[0]!), args[0]!)}\r\nD:PAI${aces}\r\n`,
        'utf16le'
      );
    return { stdout: '' };
  });
}

const reason = (error: unknown) => (error instanceof CredentialError ? error.reason : error);

it('reads a credential file only the current account can read', async () => {
  const run = nativeWith(`(A;;FA;;;${SID})(D;;FA;;;WD)`);
  const files = new SecureFiles({ stateDir, platform: 'win32', aclRun: run });

  await expect(files.read(secret)).resolves.toEqual(Buffer.from('{"refreshToken":"secret"}'));
  expect(run).toHaveBeenCalledWith(expect.stringMatching(/icacls\.exe$/), [
    secret,
    '/save',
    expect.any(String),
    '/l',
  ]);
});

it.each([
  ['Users', `(A;;FA;;;${SID})(A;;FR;;;BU)`],
  ['Everyone', `(A;;FA;;;${SID})(A;;FR;;;WD)`],
  ['another account', `(A;;FA;;;${SID})(A;;FR;;;S-1-5-21-1-2-3-1002)`],
])('refuses a credential file %s can read', async (_who, aces) => {
  const files = new SecureFiles({ stateDir, platform: 'win32', aclRun: nativeWith(aces) });

  await expect(files.read(secret)).rejects.toSatisfy(
    (error: unknown) => reason(error) === 'weak_permissions'
  );
});
