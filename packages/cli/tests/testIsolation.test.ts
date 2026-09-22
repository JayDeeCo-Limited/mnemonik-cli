import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { Socket } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { osSecretStore } from '@mnemonik/credentials';
import { resolveProjectIdentity } from '@mnemonik/shared';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);

describe('CLI test isolation', () => {
  it('keeps temporary repositories below the empty home boundary', async () => {
    expect(relative(homedir(), tmpdir())).not.toMatch(/^\.\./u);
    const root = await mkdtemp(join(tmpdir(), 'identity-'));
    const result = await resolveProjectIdentity(root);
    expect(result).toMatchObject({ kind: 'absent', root });
  });

  it('does not inherit an outer checkout identity for a new Git fixture', async () => {
    const root = await mkdtemp(join(tmpdir(), 'git-identity-'));
    await exec('git', ['init', '--quiet', root], { cwd: root });
    const result = await resolveProjectIdentity(root);
    expect(result).toMatchObject({ kind: 'absent', root });
    await expect(
      exec('git', ['rev-parse', '--show-toplevel'], { cwd: dirname(homedir()) })
    ).rejects.toMatchObject({ code: 128 });
  });

  it('still resolves an identity inside the fixture boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'own-identity-'));
    const child = join(root, 'child');
    await mkdir(child);
    await writeFile(
      join(root, '.mnemonik.json'),
      JSON.stringify({
        schemaVersion: 1,
        projectId: '12345678-1234-4234-8234-123456789012',
      })
    );
    expect(await resolveProjectIdentity(child)).toMatchObject({ kind: 'ok', root });
  });

  it('refuses external fetch before transport', async () => {
    await expect(fetch('https://example.invalid/')).rejects.toThrow(
      'CLI tests cannot access external networks'
    );
  });

  it('refuses native socket connections before transport', () => {
    const socket = new Socket();
    socket.on('error', () => {});
    try {
      expect(() => socket.connect({ host: 'example.invalid', port: 443 })).toThrow(
        'CLI tests cannot access external networks'
      );
    } finally {
      socket.destroy();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'cannot locate real native credential tools',
    async () => {
      expect(process.env.PATH).toBe(join(homedir(), 'bin'));
      for (const command of ['security', 'secret-tool', 'powershell']) {
        await expect(exec(command, ['--version'])).rejects.toMatchObject({ code: 'ENOENT' });
      }
      expect(await osSecretStore()?.isAvailable()).toBe(false);
    }
  );

  it('permits a loopback HTTP fixture', async () => {
    const server = createServer((_request, response) => response.end('fixture'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing local address');
      expect(await (await fetch(`http://127.0.0.1:${address.port}/`)).text()).toBe('fixture');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
