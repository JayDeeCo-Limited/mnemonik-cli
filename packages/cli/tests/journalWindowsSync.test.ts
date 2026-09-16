import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal, digest, type Target } from '../src/install/journal.js';

const flushed = vi.hoisted(
  () => [] as Array<{ flags: string | number | undefined; chmod: boolean }>
);
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      let chmod = false;
      return {
        chmod: async (mode: number) => {
          chmod = true;
          await handle.chmod(mode);
        },
        sync: async () => {
          flushed.push({ flags: args[1], chmod });
          if (args[1] === 'r')
            throw Object.assign(new Error('EPERM: operation not permitted, fsync'), {
              code: 'EPERM',
            });
          await handle.sync();
        },
        close: () => handle.close(),
      };
    },
  };
});
vi.mock('@mnemonik/local-setup', () => ({ atomicWrite: writeFile }));

let directory: string;
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});
it('flushes journal metadata on its writable handle and skips Windows directory flushes', async () => {
  directory = await mkdtemp(join(tmpdir(), 'journal-windows-'));
  const proposed = Buffer.from('public proposed runtime pointer');
  const target = {
    path: join(directory, 'current'),
    proposed: join(directory, 'proposal'),
    beforeHash: null,
    proposedHash: digest(proposed),
    mode: 0o600,
  } as Target;
  await writeFile(target.proposed, proposed);
  vi.stubGlobal('process', { ...process, platform: 'win32' });
  const journal = new Journal(directory, {} as never);
  await journal.change(target, false);
  expect(await readFile(target.path)).toEqual(proposed);
  expect(flushed).toEqual([{ flags: 'r+', chmod: true }]);
});
