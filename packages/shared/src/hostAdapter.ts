import {
  createHostBinary,
  HostBinaryNotFoundError,
  quoteHostArgument,
  type WindowsBinary,
} from './hostBinary.js';
import { apiOrigin } from './apiOrigin.js';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual, promisify, stripVTControlCharacters } from 'node:util';

export type HostName = 'claude-code' | 'codex' | 'cursor' | 'grok' | 'vscode-copilot';
export interface Target {
  component: 'hooks' | 'mcp';
  scope: 'user' | 'project';
  projectRoot?: string;
  /** Absolute dispatcher path, already verified by the CLI runtime store. */
  runtimeEntry: string;
  /** CLI artifact directory containing current and versioned manifests. */
  runtimeRoot: string;
  /** Non-secret hook component family recorded by the CLI installer. */
  credentialFamily: string;
  /** Machine identity written only to user-scope MCP declarations. */
  installationId?: string;
  /** Config paths known to have been absent before Mnemonik first wrote them. */
  createdFiles?: string[];
  /** Verified first-install config backups supplied by the ownership journal. */
  originalFiles?: Record<string, Buffer | null>;
}
export interface FileChange {
  path: string;
  content: Buffer;
  mode?: number;
  remove?: true;
}
export interface AdapterWriter {
  stage(change: FileChange): Promise<void>;
}
export interface Grant {
  installationId?: string;
  id: string;
  account: string;
  scopes: string[];
}
export interface Inspection {
  resolvedPath?: string;
  declarationPath?: string;
  authenticatedTools: boolean;
  grant?: Grant;
  declarationPresent: boolean;
  enableRequired?: boolean;
  trustPending?: boolean;
  trustDeclined?: boolean;
  otherScopes?: { scope: Target['scope']; path: string }[];
}
export interface HostPlan {
  changes: FileChange[];
  staging: 'inactive' | 'additive';
  requestedScope: string;
  effectiveScope: string;
  version: string;
  artifactDigest: string;
}
export interface HostAdapter {
  name: HostName;
  detect(): Promise<{
    supported: boolean;
    version: string;
    reason?: string;
    resolvedPath?: string;
    searchedLocations?: string[];
  }>;
  capabilities(): {
    scopes: string[];
    revoke: boolean;
    components: Target['component'][];
    nativeConnect: boolean;
    nativeListing?: boolean;
  };
  inspect(target?: Target): Promise<Inspection>;
  plan(target?: Target): Promise<HostPlan>;
  install(writer: AdapterWriter, target: Target): Promise<void>;
  update(writer: AdapterWriter, target: Target): Promise<void>;
  repair(writer: AdapterWriter, target: Target): Promise<void>;
  /** Always return the recovery instruction, including after a native action. */
  launch(input?: { signedIn: boolean }): Promise<string>;
  /** Run the host's native MCP enable action once and return its recovery instruction. */
  enable?(): Promise<string>;
  verify(target?: Target): Promise<Inspection>;
  uninstall(writer: AdapterWriter, target: Target): Promise<void>;
  revoke?(grant: Grant): Promise<boolean>;
  revokeAction: string;
}

export interface AdapterDependencies {
  platform?: NodeJS.Platform;
  binaryExists?: (file: string) => Promise<boolean>;
  target?: Target;
  env?: NodeJS.ProcessEnv;
  /** Verified package provenance supplied by the CLI, never inferred from config. */
  version?: string;
  artifactDigest?: string;
  execFile?: (
    file: string,
    args: string[],
    options: {
      env: NodeJS.ProcessEnv;
      cwd?: string;
      timeout: number;
      maxBuffer: number;
      windowsHide: boolean;
      windowsVerbatimArguments?: boolean;
    }
  ) => Promise<{ stdout: string; stderr: string }>;
}

/** Common read/propose/stage lifecycle; the host's installer still owns its bytes. */
export function createFileHostAdapter(
  deps: AdapterDependencies,
  host: {
    name: HostName;
    binary: string;
    windowsBinary: WindowsBinary;
    vendorMatch: RegExp;
    instruction: string;
    signedInInstruction?: string;
    mcp?: {
      path(target: Target): string;
      format: 'json' | 'toml';
      type?: 'http';
      headerKey?: 'headers' | 'http_headers';
    };
    nativeConnect?: boolean;
    nativeListing?: boolean;
    desktopPaths?: string[];
    nativeEnable?: string[];
    nativeLogout?: boolean;
    revokeAction?: string;
    path(target: Target): string;
    present(target: Target): Promise<boolean>;
    changes(target: Target, install: boolean): Promise<FileChange[]>;
    classifyVersion?: (output: string) => { supported: boolean; version: string; reason?: string };
  }
): HostAdapter {
  const emptyConfiguration = (content: Buffer) => {
    if (!content.toString().trim()) return true;
    try {
      const config = JSON.parse(content.toString()) as Record<string, unknown>;
      return Object.entries(config).every(
        ([key, value]) =>
          (['hooks', 'mcpServers'].includes(key) &&
            !!value &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            Object.keys(value).length === 0) ||
          (key === 'version' && value === 1)
      );
    } catch {
      return false;
    }
  };
  const run = deps.execFile ?? promisify(execFile);
  const ownedTarget = deps.env?.MNEMONIK_CLI_OWNED_TARGET === '1';
  const targetFor = (target = deps.target): Target => {
    if (
      !target ||
      !['hooks', 'mcp'].includes(target.component) ||
      !['user', 'project'].includes(target.scope) ||
      (target.component === 'hooks' && !isAbsolute(target.runtimeEntry)) ||
      (target.component === 'hooks' && host.name === 'codex' && !isAbsolute(target.runtimeRoot)) ||
      (target.scope === 'project' && (!target.projectRoot || !isAbsolute(target.projectRoot)))
    )
      throw new Error('invalid_target');
    return target;
  };
  // Validate host configuration before any native command can run.
  const nativeEnable = host.nativeEnable;
  for (const argument of nativeEnable ?? []) quoteHostArgument(argument);
  const binary = createHostBinary(deps, host.binary, host.windowsBinary, run, host.desktopPaths);
  let resolvedPath: string | undefined;
  let detection: ReturnType<HostAdapter['detect']> | undefined;
  const detect: HostAdapter['detect'] = () =>
    (detection ??= (async () => {
      try {
        resolvedPath = await binary.resolve();
        const result = await binary.execute(['--version']);
        resolvedPath = await binary.resolve();
        const output = stripVTControlCharacters(`${result.stdout}\n${result.stderr}`).trim();
        const version = output.match(/\b\d+\.\d+\.\d+(?:-[\w.-]+)?\b/)?.[0] ?? '';
        if (output && !host.vendorMatch.test(output))
          return { supported: false, version, reason: 'wrong_vendor', resolvedPath };
        if (host.classifyVersion) return { ...host.classifyVersion(output), resolvedPath };
        if (version) return { supported: true, version, resolvedPath };
      } catch (error) {
        if (error instanceof HostBinaryNotFoundError) {
          resolvedPath = undefined;
          detection = undefined;
          return {
            supported: false,
            version: '',
            reason: 'not_found',
            searchedLocations: error.searchedLocations,
          };
        }
        /* Detection is read-only and otherwise fails closed. */
      }
      // Not cached: an absent or unreadable binary may be installed later in
      // this process, and the next detect() must look again.
      detection = undefined;
      return {
        supported: false,
        version: '',
        reason: 'unverified_version',
        ...(resolvedPath ? { resolvedPath } : {}),
      };
    })());
  const execute = async (args: string[], target?: Target) => {
    const check = await detect();
    if (!check.supported) throw new Error(`${check.reason}: ${check.resolvedPath ?? host.binary}`);
    return binary.execute(args, target?.projectRoot);
  };
  const path = (target: Target) =>
    target.component === 'mcp' && host.mcp ? host.mcp.path(target) : host.path(target);
  const mcp = async (target: Target, install?: boolean): Promise<FileChange[]> => {
    if (!host.mcp) throw new Error('unsupported_component');
    const file = path(target);
    const raw = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    const url = `${apiOrigin(deps.env)}/mcp`;
    const installationHeader =
      target.scope === 'user' && target.installationId
        ? { 'x-mnemonik-installation-id': target.installationId }
        : undefined;
    if (install && target.scope === 'user' && !installationHeader)
      throw new Error('installation_required');
    let content: string;
    if (host.mcp.format === 'json') {
      const config = JSON.parse(raw || '{}');
      if (
        !config ||
        typeof config !== 'object' ||
        Array.isArray(config) ||
        (config.mcpServers !== undefined &&
          (!config.mcpServers ||
            typeof config.mcpServers !== 'object' ||
            Array.isArray(config.mcpServers)))
      )
        throw new Error('invalid_mcp_config');
      const servers = config.mcpServers ?? {};
      const expected = { ...(host.mcp.type ? { type: host.mcp.type } : {}), url };
      const current = servers.mnemonik;
      const connected =
        !!current &&
        typeof current === 'object' &&
        !Array.isArray(current) &&
        Object.entries(expected).every(([key, value]) => current[key] === value);
      const currentHeaders =
        connected &&
        current.headers &&
        typeof current.headers === 'object' &&
        !Array.isArray(current.headers)
          ? current.headers
          : {};
      const exact =
        connected &&
        (installationHeader
          ? currentHeaders['x-mnemonik-installation-id'] === target.installationId
          : !Object.hasOwn(currentHeaders, 'x-mnemonik-installation-id'));
      if (install === undefined) return exact ? [{ path: file, content: Buffer.from(raw) }] : [];
      if (!install && !Object.hasOwn(servers, 'mnemonik')) return [];
      if (Object.hasOwn(servers, 'mnemonik') && !connected && !ownedTarget)
        throw new Error('mcp_name_conflict');
      if (install) {
        const next = {
          ...(current && typeof current === 'object' && !Array.isArray(current) ? current : {}),
          ...expected,
        };
        const headers = { ...currentHeaders, ...installationHeader };
        if (!installationHeader) delete headers['x-mnemonik-installation-id'];
        if (Object.keys(headers).length) next.headers = headers;
        else delete next.headers;
        servers.mnemonik = next;
      } else delete servers.mnemonik;
      config.mcpServers = servers;
      content = JSON.stringify(config, null, 2) + '\n';
    } else {
      // Preserve unrelated TOML bytes. Refuse layouts whose table boundaries are ambiguous.
      if (
        /'''|"""/.test(raw) ||
        /^\s*(?:mcp_servers\s*=|mcp_servers\s*\.)/m.test(raw) ||
        /=\s*\[[^\]\n]*$/m.test(raw)
      )
        throw new Error('unsupported_mcp_toml_layout');
      if (
        /^\s*\[\s*["']?mcp_servers["']?\s*\]/m.test(raw) ||
        /^\s*\[\[\s*["']?mcp_servers/m.test(raw)
      )
        throw new Error('unsupported_mcp_toml_layout');
      const table =
        /^\s*\[\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*\.\s*(?:mnemonik|"mnemonik"|'mnemonik')(?:\s*\.[^\]]+)?\s*\]\s*(?:#.*)?$/;
      const lines = raw.match(/[^\n]*\n|[^\n]+$/g) ?? [];
      const start = lines.findIndex((line) => table.test(line.trimEnd()));
      const end =
        start < 0
          ? -1
          : lines.findIndex((line, index) => index > start && /^\s*\[/.test(line.trimEnd()));
      const stop = end < 0 ? lines.length : end;
      const section = start < 0 ? [] : lines.slice(start, stop);
      const urlIndex = section.findIndex((line) => /^\s*url\s*=/.test(line));
      const connected =
        urlIndex >= 0 &&
        section[urlIndex]?.trimEnd().match(/^\s*url\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/)?.[1] ===
          url;
      const headerKey = host.mcp.headerKey ?? 'http_headers';
      const headerIndex = section.findIndex((line) =>
        new RegExp(`^\\s*${headerKey}\\s*=`).test(line)
      );
      const installationPattern =
        /(?:["']x-mnemonik-installation-id["']|x-mnemonik-installation-id)\s*=\s*["']([^"']*)["']/;
      const installedId =
        headerIndex >= 0 ? section[headerIndex]?.match(installationPattern)?.[1] : undefined;
      const exact =
        connected &&
        (installationHeader ? installedId === target.installationId : installedId === undefined);
      if (install === undefined) return exact ? [{ path: file, content: Buffer.from(raw) }] : [];
      if (!install && start < 0) return [];
      if (start >= 0 && !connected && !ownedTarget) throw new Error('mcp_name_conflict');
      if (!install) content = [...lines.slice(0, start), ...lines.slice(stop)].join('');
      else {
        const next = start < 0 ? ['[mcp_servers.mnemonik]\n', `url = "${url}"\n`] : [...section];
        const nextUrl = next.findIndex((line) => /^\s*url\s*=/.test(line));
        if (nextUrl >= 0) next[nextUrl] = `url = "${url}"\n`;
        const nextHeader = next.findIndex((line) =>
          new RegExp(`^\\s*${headerKey}\\s*=`).test(line)
        );
        if (nextHeader >= 0) {
          const line = next[nextHeader] ?? '';
          if (!/^\s*\w+\s*=\s*\{.*\}\s*(?:#.*)?$/u.test(line.trimEnd()))
            throw new Error('unsupported_mcp_toml_layout');
          if (installationHeader) {
            next[nextHeader] = installationPattern.test(line)
              ? line.replace(installationPattern, (pair) =>
                  pair.replace(/["']([^"']*)["']\s*$/u, JSON.stringify(target.installationId))
                )
              : line.replace(
                  /\}(\s*(?:#.*)?\r?\n?)$/u,
                  (suffix, ending) =>
                    `, "x-mnemonik-installation-id" = ${JSON.stringify(target.installationId)} }${ending}`
                );
          } else if (installationPattern.test(line)) {
            next[nextHeader] = line
              .replace(
                /(?:,\s*)?(?:["']x-mnemonik-installation-id["']|x-mnemonik-installation-id)\s*=\s*["'][^"']*["']\s*,?/u,
                ''
              )
              .replace(/\{\s*,/u, '{')
              .replace(/,\s*\}/u, ' }');
          }
        } else if (installationHeader) {
          const insert = Math.max(1, next.findIndex((line) => /^\s*url\s*=/.test(line)) + 1);
          next.splice(
            insert,
            0,
            `${headerKey} = { "x-mnemonik-installation-id" = ${JSON.stringify(target.installationId)} }\n`
          );
        }
        content =
          start < 0
            ? `${raw}${raw && !raw.endsWith('\n') ? '\n' : ''}${next.join('')}`
            : [...lines.slice(0, start), ...next, ...lines.slice(stop)].join('');
      }
    }
    return [{ path: file, content: Buffer.from(content) }];
  };
  const present = async (target: Target) =>
    target.component === 'mcp' ? (await mcp(target)).length > 0 : host.present(target);
  const changes = (target: Target, install: boolean) =>
    target.component === 'mcp' ? mcp(target, install) : host.changes(target, install);
  const inspect = async (input?: Target): Promise<Inspection> => {
    const target = targetFor(input);
    const other: Target = { ...target, scope: target.scope === 'user' ? 'project' : 'user' };
    const otherScopes: NonNullable<Inspection['otherScopes']> = [];
    if (
      (other.scope === 'user' || other.projectRoot) &&
      path(other) !== path(target) &&
      (await present(other))
    )
      otherScopes.push({ scope: other.scope, path: path(other) });
    return {
      resolvedPath: await binary.resolve().catch(() => undefined),
      ...(host.nativeListing === false ? { declarationPath: path(target) } : {}),
      declarationPresent: await present(target),
      authenticatedTools: false,
      otherScopes,
    };
  };
  const plan = async (input?: Target): Promise<HostPlan> => {
    const target = targetFor(input);
    return {
      changes: await changes(target, true),
      staging: 'inactive',
      requestedScope: target.scope,
      effectiveScope: target.scope,
      version: deps.version ?? '',
      artifactDigest: deps.artifactDigest ?? '',
    };
  };
  const install = async (writer: AdapterWriter, target: Target) => {
    for (const change of (await plan(target)).changes) await writer.stage(change);
  };
  const signedInInstruction =
    host.signedInInstruction ?? `${host.name} is already signed in to Mnemonik.`;
  return {
    name: host.name,
    detect,
    capabilities: () => ({
      scopes: ['user', 'project'],
      revoke: !!host.nativeLogout,
      components: host.mcp ? ['hooks', 'mcp'] : ['hooks'],
      nativeConnect: !!host.nativeConnect,
      ...(host.nativeListing === false ? { nativeListing: false } : {}),
    }),
    inspect,
    plan,
    install,
    // Updating and repairing both replace owned entries through plan + install.
    update: install,
    repair: install,
    launch: async ({ signedIn = false }: { signedIn?: boolean } = {}) => {
      if (host.nativeConnect && !signedIn) {
        try {
          await execute(['mcp', 'login', 'mnemonik'], deps.target);
        } catch {
          /* The recovery instruction remains usable when native login is unavailable. */
        }
      }
      return signedIn ? signedInInstruction : host.instruction;
    },
    ...(nativeEnable
      ? {
          enable: async () => {
            try {
              await execute(nativeEnable, deps.target);
            } catch {
              /* The post-enable listing supplies the actionable result. */
            }
            return signedInInstruction;
          },
        }
      : {}),
    verify: inspect,
    async uninstall(writer, target) {
      const owned = targetFor(target);
      for (const change of await changes(owned, false)) {
        if (owned.originalFiles && Object.hasOwn(owned.originalFiles, change.path)) {
          const original = owned.originalFiles[change.path];
          if (change.path.endsWith('.json')) {
            const before = JSON.parse(
              original
                ?.toString()
                .replace(/^\uFEFF/, '')
                .trim() || '{}'
            );
            const after = JSON.parse(change.content.toString());
            for (const key of ['hooks', 'mcpServers'])
              if (!Object.hasOwn(before, key) && after[key] && Object.keys(after[key]).length === 0)
                delete after[key];
            change.content =
              original && isDeepStrictEqual(before, after)
                ? original
                : Buffer.from(JSON.stringify(after, null, 2) + '\n');
          } else if (
            original &&
            change.content.toString().trimEnd() === original.toString().trimEnd()
          )
            change.content = original;
        }
        await writer.stage({
          ...change,
          ...(owned.createdFiles?.includes(change.path) && emptyConfiguration(change.content)
            ? { remove: true }
            : {}),
        });
      }
    },
    ...(host.nativeLogout
      ? {
          revoke: async () => {
            try {
              await execute(['mcp', 'logout', 'mnemonik'], deps.target);
              return true;
            } catch {
              return false;
            }
          },
        }
      : {}),
    revokeAction:
      host.revokeAction ??
      `Open ${host.name} connection settings and revoke the Mnemonik connection.`,
  };
}
