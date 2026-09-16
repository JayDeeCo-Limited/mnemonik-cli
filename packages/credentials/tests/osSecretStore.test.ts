import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { osSecretStore } from '../src/osSecretStore.js';

function fake() {
  const calls: { file: string; args: string[]; input: string }[] = [];
  let next = { code: 0, stdout: '', stderr: '' };
  const execFile = vi.fn((file, args, _options, callback) => {
    const stdin = new PassThrough();
    const call = { file, args, input: '' };
    calls.push(call);
    stdin.on('data', (bytes) => {
      call.input += bytes.toString();
    });
    stdin.on('finish', () => {
      const result = next;
      next = { code: 0, stdout: '', stderr: '' };
      callback(
        result.code ? Object.assign(new Error('raw secret error'), { code: result.code }) : null,
        result.stdout,
        result.stderr
      );
    });
    return { stdin };
  });
  return {
    calls,
    execFile,
    result: (code: number, stdout = '', stderr = '') => {
      next = { code, stdout, stderr };
    },
  };
}

describe('OS stores use stdin and fail closed to the adapter', () => {
  it.each(['darwin', 'win32', 'linux'] as const)(
    '%s command shape, update and missing delete',
    async (platform) => {
      const f = fake();
      const store = osSecretStore({ platform, execFile: f.execFile as never })!;
      const name = 'mnemonik.credentials.v1:cli-oauth';
      await store.set(name, 'sentinel-secret');
      await store.set(name, 'replacement-secret');
      f.result(
        platform === 'darwin' ? 44 : platform === 'win32' ? 3 : 1,
        '',
        platform === 'darwin' ? 'The specified item could not be found in the keychain.' : ''
      );
      expect(await store.get(name)).toBe('replacement-secret');
      f.result(
        platform === 'darwin' ? 44 : platform === 'win32' ? 3 : 1,
        '',
        platform === 'darwin' ? 'The specified item could not be found in the keychain.' : ''
      );
      await store.delete(name);
      expect(f.calls).toHaveLength(3);
      for (const call of f.calls)
        expect(call.args.join(' ')).not.toMatch(/sentinel-secret|replacement-secret/);
      const first = f.calls[0]!;
      if (platform === 'darwin') {
        expect(first).toMatchObject({ file: 'security', args: ['-i'] });
        expect(first.input).toBe(
          `add-generic-password -U -a "${name}" -s "mnemonik.credentials.v1" -w "sentinel-secret"\n`
        );
      } else if (platform === 'win32') {
        expect(first.file).toBe('powershell');
        expect(first.args.slice(0, 3)).toEqual([
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
        ]);
        const script = Buffer.from(first.args[3]!, 'base64').toString('utf16le');
        expect(script).not.toMatch(/sentinel-secret|replacement-secret/);
        expect(script).toContain('[Console]::In.ReadLine()');
        expect(script).toContain('Persist = 2');
        expect(script).toContain('CredWriteW');
        expect(first.input).toBe(`${name}\n${Buffer.from('sentinel-secret').toString('base64')}\n`);
      } else {
        expect(first).toEqual({
          file: 'secret-tool',
          args: [
            'store',
            '--label=Mnemonik CLI credential',
            'service',
            'mnemonik.credentials.v1',
            'name',
            name,
          ],
          input: 'sentinel-secret',
        });
      }
    }
  );

  it.each(['darwin', 'win32', 'linux'] as const)(
    '%s latches process failure, discards stderr, and caches probe',
    async (platform) => {
      const f = fake();
      const store = osSecretStore({ platform, execFile: f.execFile as never })!;
      f.result(1, '', 'sentinel-secret');
      await expect(store.set('probe', 'sentinel-secret')).rejects.toThrow('os_store_unavailable');
      expect(await store.isAvailable()).toBe(false);
      expect(await store.isAvailable()).toBe(false);
      await expect(store.get('probe')).rejects.toThrow('os_store_unavailable');
      expect(f.calls).toHaveLength(1);
    }
  );

  it.each(['darwin', 'win32', 'linux'] as const)(
    '%s returns the exact stored text without transport framing',
    async (platform) => {
      const f = fake();
      const store = osSecretStore({ platform, execFile: f.execFile as never })!;
      const secret = 'some-utf8-✓';
      f.result(
        0,
        platform === 'win32'
          ? Buffer.from(secret).toString('base64')
          : platform === 'darwin'
            ? `${secret}\n`
            : secret,
        platform === 'win32' ? '#< CLIXML progress only' : ''
      );
      expect(await store.get('cli')).toBe(secret);
      expect(f.execFile.mock.calls[0]?.[2]).not.toHaveProperty('env');
      expect(f.execFile.mock.calls[0]?.[2]).not.toHaveProperty('shell');
    }
  );

  it('caches successful availability and returns platform singleton', async () => {
    const f = fake();
    const store = osSecretStore({ platform: 'linux', execFile: f.execFile as never })!;
    f.result(1);
    expect(await store.isAvailable()).toBe(true);
    expect(await store.isAvailable()).toBe(true);
    expect(f.calls).toHaveLength(1);
    expect(osSecretStore()).toBe(osSecretStore());
    expect(osSecretStore({ platform: 'aix' })).toBeUndefined();
  });

  it('updates cached reads after set and delete', async () => {
    const f = fake();
    const store = osSecretStore({ platform: 'linux', execFile: f.execFile as never })!;
    await store.set('cache-coherence', 'new-value');
    expect(await store.get('cache-coherence')).toBe('new-value');
    expect(f.calls).toHaveLength(1);
    f.result(1);
    await store.delete('cache-coherence');
    expect(await store.get('cache-coherence')).toBeUndefined();
    expect(f.calls).toHaveLength(2);
  });

  it('does not treat a Linux bus error as a missing item', async () => {
    const f = fake();
    const store = osSecretStore({ platform: 'linux', execFile: f.execFile as never })!;
    f.result(1, '', 'Cannot autolaunch D-Bus');
    expect(await store.isAvailable()).toBe(false);
  });

  it('refuses macOS line injection and overlong interactive commands', async () => {
    const f = fake();
    await expect(
      osSecretStore({ platform: 'darwin', execFile: f.execFile as never })!.set('cli', 'x\nquit')
    ).rejects.toThrow('os_store_unavailable');
    await expect(
      osSecretStore({ platform: 'darwin', execFile: f.execFile as never })!.set(
        'cli',
        'x'.repeat(4096)
      )
    ).rejects.toThrow('os_store_unavailable');
    expect(f.calls).toHaveLength(0);
  });
});
