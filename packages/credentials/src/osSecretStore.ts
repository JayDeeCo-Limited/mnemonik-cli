import { execFile as nodeExecFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { SecretStore } from './contracts.js';

const service = 'mnemonik.credentials.v1';
type Options = { platform?: NodeJS.Platform; execFile?: typeof nodeExecFile };
type Operation = 'get' | 'set' | 'delete';
const unavailable = () => new Error('os_store_unavailable');
const cachedReads = new Map<string, Promise<string | undefined>>();

// The script is fixed code. Target and UTF-8 secret arrive on separate stdin lines.
// CredFree/FreeHGlobal run even if marshaling or a native operation fails.
const windowsCode = `
using System;
using System.Runtime.InteropServices;
using System.Text;
public class MnemonikCredential {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct Credential {
    public uint Flags, Type;
    public string TargetName, Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist, AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias, UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredWriteW(ref Credential value, uint flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredReadW(string target, uint type, uint flags, out IntPtr value);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredDeleteW(string target, uint type, uint flags);
  [DllImport("advapi32.dll")]
  public static extern void CredFree(IntPtr value);
  public static int Run(string op, string target, string encoded) {
    bool ok;
    int error = 0;
    if (op == "set") {
      byte[] bytes = Convert.FromBase64String(encoded);
      IntPtr blob = Marshal.AllocHGlobal(bytes.Length);
      try {
        Marshal.Copy(bytes, 0, blob, bytes.Length);
        Credential value = new Credential { Type = 1, TargetName = target, Persist = 2,
          CredentialBlobSize = (uint)bytes.Length, CredentialBlob = blob };
        ok = CredWriteW(ref value, 0);
        if (!ok) error = Marshal.GetLastWin32Error();
      } finally { Marshal.FreeHGlobal(blob); }
    } else if (op == "delete") {
      ok = CredDeleteW(target, 1, 0);
      if (!ok) error = Marshal.GetLastWin32Error();
    } else {
      IntPtr pointer;
      ok = CredReadW(target, 1, 0, out pointer);
      if (!ok) error = Marshal.GetLastWin32Error();
      if (ok) {
        try {
          Credential value = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
          byte[] bytes = new byte[value.CredentialBlobSize];
          Marshal.Copy(value.CredentialBlob, bytes, 0, bytes.Length);
          Console.Write(Convert.ToBase64String(bytes));
        } finally { CredFree(pointer); }
      }
    }
    return ok ? 0 : error == 1168 ? 3 : 1;
  }
}`.replace(/\n\s*/gu, ' ');

function createStore(platform: NodeJS.Platform, execFile: typeof nodeExecFile): SecretStore {
  let failed = false;
  let availability: Promise<boolean> | undefined;
  const kind =
    platform === 'darwin'
      ? 'keychain'
      : platform === 'win32'
        ? 'credential-manager'
        : 'secret-service';
  const cacheKey = (name: string) => `${kind}\0${name}`;

  async function run(file: string, args: string[], input: string, missing: boolean) {
    if (failed) throw unavailable();
    return new Promise<string | undefined>((resolve, reject) => {
      const fail = () => {
        failed = true;
        reject(unavailable());
      };
      try {
        const child = execFile(
          file,
          args,
          {
            encoding: 'utf8',
            timeout: platform === 'win32' ? 60_000 : 10_000,
            maxBuffer: 64 * 1024,
            windowsHide: true,
          },
          (error, stdout, stderr) => {
            const code = error?.code;
            const notFound =
              missing &&
              (platform === 'darwin'
                ? code === 44 &&
                  stderr.includes('The specified item could not be found in the keychain.')
                : platform === 'win32'
                  ? code === 3
                  : code === 1 && !stderr);
            if (notFound) resolve(undefined);
            else if (error) fail();
            else resolve(stdout);
          }
        );
        child.stdin?.on('error', fail);
        child.stdin?.end(input);
      } catch {
        fail();
      }
    });
  }

  async function operation(op: Operation, name: string, secret = ''): Promise<string | undefined> {
    try {
      if (failed || !/^[\w.:-]+$/u.test(name)) throw unavailable();
      if (platform === 'darwin') {
        // security's interactive parser accepts quoted arguments but not embedded line breaks.
        const quote = (value: string) => `"${value.replace(/[\\"]/gu, '\\$&')}"`;
        const command =
          op === 'set'
            ? 'add-generic-password -U'
            : op === 'get'
              ? 'find-generic-password -w'
              : 'delete-generic-password';
        const input = `${command} -a ${quote(name)} -s ${quote(service)}${op === 'set' ? ` -w ${quote(secret)}` : ''}\n`;
        if (/[\r\n\0]/u.test(secret) || Buffer.byteLength(input) >= 4096) throw unavailable();
        const result = await run('security', ['-i'], input, op !== 'set');
        return result?.replace(/\r?\n$/u, '');
      }
      if (platform === 'win32') {
        const target = name.startsWith(`${service}:`) ? name : `${service}:${name}`;
        const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; try { Add-Type -TypeDefinition '${windowsCode}'; $target=[Console]::In.ReadLine(); $secret=[Console]::In.ReadLine(); exit [MnemonikCredential]::Run('${op}', $target, $secret) } catch { exit 1 }`;
        const output = await run(
          'powershell',
          [
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            Buffer.from(script, 'utf16le').toString('base64'),
          ],
          `${target}\n${Buffer.from(secret, 'utf8').toString('base64')}\n`,
          op !== 'set'
        );
        if (output === undefined) return undefined;
        if (!/^[A-Za-z0-9+/=\r\n]*$/u.test(output)) throw unavailable();
        return Buffer.from(output.trim(), 'base64').toString('utf8');
      }
      return await run(
        'secret-tool',
        [
          op === 'set' ? 'store' : op === 'get' ? 'lookup' : 'clear',
          ...(op === 'set' ? ['--label=Mnemonik CLI credential'] : []),
          'service',
          service,
          'name',
          name,
        ],
        op === 'set' ? secret : '',
        op !== 'set'
      );
    } catch {
      failed = true;
      throw unavailable();
    }
  }

  return {
    kind,
    isAvailable() {
      if (failed) return Promise.resolve(false);
      return (availability ??= (async () => {
        const probe = `${service}:probe:${randomUUID()}`;
        if (platform === 'darwin') {
          await run('security', ['-i'], 'default-keychain -d user\n', false);
          await operation('set', probe, 'availability-probe');
          await operation('delete', probe);
        } else await operation('get', probe);
        return true;
      })().catch(() => false));
    },
    async get(name) {
      const key = cacheKey(name);
      let read = cachedReads.get(key);
      if (!read) {
        read = operation('get', name);
        cachedReads.set(key, read);
      }
      try {
        return await read;
      } catch (error) {
        if (cachedReads.get(key) === read) cachedReads.delete(key);
        throw error;
      }
    },
    async set(name, secret) {
      await operation('set', name, secret);
      cachedReads.set(cacheKey(name), Promise.resolve(secret));
    },
    async delete(name) {
      await operation('delete', name);
      cachedReads.set(cacheKey(name), Promise.resolve(undefined));
    },
  };
}

let current: SecretStore | undefined;
/** CLI wiring opts in. Production availability/failure is shared for this process. */
export function osSecretStore(options?: Options): SecretStore | undefined {
  const platform = options?.platform ?? process.platform;
  if (!['darwin', 'win32', 'linux'].includes(platform)) return undefined;
  if (options) return createStore(platform, options.execFile ?? nodeExecFile);
  return (current ??= createStore(platform, nodeExecFile));
}
