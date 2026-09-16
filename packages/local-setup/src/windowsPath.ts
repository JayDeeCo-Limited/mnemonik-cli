import { execFile as nodeExecFile } from 'node:child_process';
import { win32 } from 'node:path';
import type { ExecFile } from './storage.js';

/** Raw HKCU value: preserve expansion tokens, empty/absent values and registry type. */
export type WindowsPathValue = { value: string; kind: 'String' | 'ExpandString' } | null;
export interface WindowsPathOptions {
  execFile?: ExecFile;
  env?: NodeJS.ProcessEnv;
}

const normalizeWindowsPathEntry = (part: string, env: NodeJS.ProcessEnv): string =>
  win32
    .normalize(
      part
        .replace(/^"(.*)"$/, '$1')
        .replace(
          /%([^%]+)%/g,
          (token, name: string) =>
            Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ??
            token
        )
    )
    .replace(/[\\/]+$/, '')
    .toLowerCase();

export function windowsPathIncludes(path: string, directory: string, env = process.env): boolean {
  const directoryKey = normalizeWindowsPathEntry(directory, env);
  return path
    .split(';')
    .some((part) => part !== '' && normalizeWindowsPathEntry(part, env) === directoryKey);
}

export function removeWindowsPathEntry(
  path: string,
  directory: string,
  preferredIndex: number,
  env = process.env
): string {
  const parts = path.split(';');
  const directoryKey = normalizeWindowsPathEntry(directory, env);
  const matches = (part: string) =>
    part !== '' && normalizeWindowsPathEntry(part, env) === directoryKey;
  const index = matches(parts[preferredIndex] ?? '') ? preferredIndex : parts.findIndex(matches);
  if (index !== -1) parts.splice(index, 1);
  return parts.join(';');
}

export function appendWindowsPath(
  before: WindowsPathValue,
  directory: string,
  env = process.env
): WindowsPathValue {
  if (windowsPathIncludes(before?.value ?? '', directory, env)) return before;
  return {
    value: before?.value
      ? `${before.value}${before.value.endsWith(';') ? '' : ';'}${directory}`
      : directory,
    kind: before?.kind ?? 'ExpandString',
  };
}

const readScript = `
$value = $key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
$current = if ($null -eq $value) { $null } else { @{ value = [string]$value; kind = [string]$key.GetValueKind('Path') } }
`;
async function powershell(script: string, options: WindowsPathOptions): Promise<string> {
  const executable = win32.join(
    options.env?.SystemRoot ?? process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  return new Promise((resolve, reject) => {
    (options.execFile ?? (nodeExecFile as unknown as ExecFile))(
      executable,
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(
          `$ErrorActionPreference = 'Stop'\n[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n${script}`,
          'utf16le'
        ).toString('base64'),
      ],
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    );
  });
}

export async function readWindowsUserPath(
  options: WindowsPathOptions = {}
): Promise<WindowsPathValue> {
  const text = await powershell(
    `
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
if ($null -eq $key) { 'null'; exit }
try { ${readScript}
ConvertTo-Json -InputObject $current -Compress
} finally { $key.Dispose() }
`,
    options
  );
  const result = JSON.parse(text.trim()) as WindowsPathValue;
  if (
    result !== null &&
    (typeof result.value !== 'string' || !['String', 'ExpandString'].includes(result.kind))
  )
    throw new Error('user_path_invalid');
  return result;
}

/** Compare-and-set in the same process; never overwrite a separately edited PATH. */
export async function writeWindowsUserPath(
  before: WindowsPathValue,
  after: WindowsPathValue,
  options: WindowsPathOptions = {}
): Promise<void> {
  const payload = Buffer.from(JSON.stringify({ before, after })).toString('base64');
  await powershell(
    `
$change = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
try { ${readScript}
if (($null -eq $current) -ne ($null -eq $change.before) -or
    ($null -ne $current -and ($current.value -cne $change.before.value -or $current.kind -cne $change.before.kind))) { throw 'user_path_changed' }
if ($null -eq $change.after) { $key.DeleteValue('Path', $false) }
else { $key.SetValue('Path', [string]$change.after.value, [Microsoft.Win32.RegistryValueKind]$change.after.kind) }
} finally { $key.Dispose() }
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class MnemonikEnvironment { [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, string l, uint f, uint t, out UIntPtr r); }'
$result = [UIntPtr]::Zero
[void][MnemonikEnvironment]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
`,
    options
  );
}
