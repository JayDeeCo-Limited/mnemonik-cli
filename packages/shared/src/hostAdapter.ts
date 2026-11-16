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
import { parse as parseToml, TomlError } from 'smol-toml';

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
  /**
   * Set when uninstall only moves the declaration to the other scope; the
   * installation stays, so project files it still uses are kept.
   */
  scopeMigration?: true;
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

const MCP_OAUTH_STORE_KEY =
  /^(\s*(?:mcp_oauth_credentials_store|"mcp_oauth_credentials_store"|'mcp_oauth_credentials_store')\s*=\s*)/;
const CODEX_MCP_TABLE =
  /^\s*\[\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*\.\s*(?:mnemonik|"mnemonik"|'mnemonik')\s*\]\s*(?:#.*)?$/;

function ensureCodexFileMcpCredentials(raw: string): string {
  const newline = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line.trimEnd()));
  const rootEnd = firstTable < 0 ? lines.length : firstTable;
  const rootKeys = lines
    .slice(0, rootEnd)
    .map((line, index) => (MCP_OAUTH_STORE_KEY.test(line) ? index : -1))
    .filter((index) => index >= 0);
  const tableStart = lines.findIndex((line) => CODEX_MCP_TABLE.test(line.trimEnd()));
  const tableEnd =
    tableStart < 0
      ? -1
      : lines.findIndex((line, index) => index > tableStart && /^\s*\[/.test(line.trimEnd()));
  const misplaced = new Set<number>();
  if (tableStart >= 0)
    for (let index = tableStart + 1; index < (tableEnd < 0 ? lines.length : tableEnd); index += 1)
      if (MCP_OAUTH_STORE_KEY.test(lines[index] ?? '')) misplaced.add(index);

  const rootKey = rootKeys[0];
  if (rootKey !== undefined) {
    const line = lines[rootKey] ?? '';
    if (!MCP_OAUTH_STORE_KEY.test(line)) throw new Error('invalid_mcp_oauth_store');
    const ending = line.match(/\r?\n$/)?.[0] ?? '';
    const body = ending ? line.slice(0, -ending.length) : line;
    const comment = body.match(/([ \t]*#.*)$/)?.[1] ?? '';
    const prefix = body.match(MCP_OAUTH_STORE_KEY)?.[1] ?? '';
    lines[rootKey] = `${prefix}"file"${comment}${ending}`;
    for (const duplicate of rootKeys.slice(1)) misplaced.add(duplicate);
  }

  const next = lines.filter((_line, index) => !misplaced.has(index));
  if (rootKey !== undefined) return next.join('');
  const insertion = next.findIndex((line) => /^\s*\[/.test(line.trimEnd()));
  const setting = `mcp_oauth_credentials_store = "file"${newline}`;
  if (insertion >= 0) next.splice(insertion, 0, setting);
  else if (next.length === 0) next.push(setting);
  else {
    if (!next.at(-1)?.endsWith('\n')) next.push(newline);
    next.push(setting);
  }
  return next.join('');
}

const INSTALLATION_HEADER = 'x-mnemonik-installation-id';
const CODEX_MNEMONIK_SECTION =
  /^\s*\[\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*\.\s*(?:mnemonik|"mnemonik"|'mnemonik')((?:\s*\.\s*[^\]\s.]+)*)\s*\]\s*(?:#.*)?$/;
const INSTALLATION_PAIR =
  /(?:["']x-mnemonik-installation-id["']|x-mnemonik-installation-id)\s*=\s*["']([^"']*)["']/;
const INSTALLATION_KEY_LINE =
  /^\s*(?:"x-mnemonik-installation-id"|'x-mnemonik-installation-id'|x-mnemonik-installation-id)\s*=/;

type TomlParse = { value: Record<string, unknown> } | { error: unknown };
function tryParseToml(text: string): TomlParse {
  try {
    return { value: parseToml(text) as Record<string, unknown> };
  } catch (error) {
    return { error };
  }
}
/** Where and why a TOML file does not parse, in words a person can act on. */
function tomlProblem(file: string, error: unknown): string {
  if (error instanceof TomlError) {
    const reason = error.message
      .split('\n')[0]
      ?.replace(/^Invalid TOML document:\s*/u, '')
      .trim();
    return `${file} is not valid TOML (line ${error.line}, column ${error.column})${reason ? `: ${reason}` : ''}`;
  }
  return `${file} is not valid TOML: ${error instanceof Error ? error.message : String(error)}`;
}
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
/** The Mnemonik declaration as Codex will read it, or undefined when absent. */
function codexDeclaration(config: Record<string, unknown>) {
  return record(record(config.mcp_servers)?.mnemonik);
}

/**
 * Codex reads `http_headers` as either an inline table under `url` or a
 * `[mcp_servers.mnemonik.http_headers]` sub-table. Defining both is invalid
 * TOML that Codex refuses to load, so an existing sub-table is updated in place
 * (an inline definition beside it is folded into it), an inline table is
 * updated in place, and only a declaration with neither gains the inline form.
 * Every proposal is parsed before it is returned: a file that cannot be made
 * valid by this edit is refused, never written.
 */
function writeCodexMcpToml(input: {
  file: string;
  raw: string;
  url: string;
  headerKey: string;
  installationId?: string;
  install: boolean;
  ownedTarget: boolean;
}): string | undefined {
  const { file, raw, url, headerKey, installationId, install } = input;
  const before = tryParseToml(raw);
  const newline = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const isHeader = (line: string) => /^\s*\[/.test(line.trimEnd());
  type Section = { start: number; stop: number; path: string };
  const sections: Section[] = [];
  lines.forEach((line, index) => {
    const match = isHeader(line) ? CODEX_MNEMONIK_SECTION.exec(line.trimEnd()) : null;
    if (!match) return;
    const end = lines.findIndex((next, at) => at > index && isHeader(next));
    sections.push({
      start: index,
      stop: end < 0 ? lines.length : end,
      path: (match[1] ?? '').replace(/[\s"']/gu, ''),
    });
  });
  const main = sections.find((section) => section.path === '');
  const headerTable = sections.find((section) => section.path === `.${headerKey}`);
  const keyLine = (line: string, key: string) => new RegExp(`^\\s*${key}\\s*=`).test(line);
  const mainLines = main ? lines.slice(main.start + 1, main.stop) : [];
  const urlLine = mainLines.find((line) => /^\s*url\s*=/.test(line));
  const connected =
    urlLine?.trimEnd().match(/^\s*url\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/)?.[1] === url;
  if (!install && !sections.length) return undefined;
  if (main && !connected && !input.ownedTarget) throw new Error('mcp_name_conflict');
  if (mainLines.some((line) => new RegExp(`^\\s*${headerKey}\\s*\\.`).test(line)))
    throw new Error('unsupported_mcp_toml_layout');

  const next = [...lines];
  const drop = new Set<number>();
  const insertAfter = new Map<number, string[]>();
  const append: string[] = [];
  const queue = (index: number, line: string) =>
    insertAfter.set(index, [...(insertAfter.get(index) ?? []), line]);
  if (!install)
    for (const section of sections)
      for (let at = section.start; at < section.stop; at++) drop.add(at);
  else {
    const idLine = (id: string) => `${INSTALLATION_HEADER} = ${JSON.stringify(id)}${newline}`;
    // The url, in place or right under the table name.
    if (main) {
      const at = lines.findIndex(
        (line, index) => index > main.start && index < main.stop && /^\s*url\s*=/.test(line)
      );
      if (at >= 0) next[at] = `url = "${url}"${newline}`;
      else queue(main.start, `url = "${url}"${newline}`);
    }
    const inlineAt = main
      ? lines.findIndex(
          (line, index) => index > main.start && index < main.stop && keyLine(line, headerKey)
        )
      : -1;
    const inline = inlineAt >= 0 ? (lines[inlineAt] ?? '') : undefined;
    if (inline !== undefined && !/^\s*\w+\s*=\s*\{.*\}\s*(?:#.*)?$/u.test(inline.trimEnd()))
      throw new Error('unsupported_mcp_toml_layout');
    if (headerTable) {
      // The sub-table is the one definition; fold any inline headers into it.
      const body = lines.slice(headerTable.start + 1, headerTable.stop);
      const tableKeys = tryParseToml(body.join(''));
      if (!('value' in tableKeys)) throw new Error('unsupported_mcp_toml_layout');
      if (inline !== undefined) {
        const parsedInline = tryParseToml(inline.trimEnd());
        const pairs = 'value' in parsedInline ? record(parsedInline.value[headerKey]) : undefined;
        if (!pairs) throw new Error('unsupported_mcp_toml_layout');
        drop.add(inlineAt);
        for (const [key, value] of Object.entries(pairs)) {
          if (key === INSTALLATION_HEADER || Object.hasOwn(tableKeys.value, key)) continue;
          if (typeof value !== 'string') throw new Error('unsupported_mcp_toml_layout');
          const name = /^[A-Za-z0-9_-]+$/u.test(key) ? key : JSON.stringify(key);
          queue(lastKeyLine(lines, headerTable), `${name} = ${JSON.stringify(value)}${newline}`);
        }
      }
      const idAt = lines.findIndex(
        (line, index) =>
          index > headerTable.start && index < headerTable.stop && INSTALLATION_KEY_LINE.test(line)
      );
      if (installationId) {
        if (idAt >= 0)
          next[idAt] = (lines[idAt] ?? '').replace(INSTALLATION_PAIR, (pair) =>
            pair.replace(/["']([^"']*)["']\s*$/u, JSON.stringify(installationId))
          );
        else {
          const at = lastKeyLine(lines, headerTable);
          insertAfter.set(at, [idLine(installationId), ...(insertAfter.get(at) ?? [])]);
        }
      } else if (idAt >= 0) drop.add(idAt);
    } else if (inline !== undefined) {
      if (installationId)
        next[inlineAt] = INSTALLATION_PAIR.test(inline)
          ? inline.replace(INSTALLATION_PAIR, (pair) =>
              pair.replace(/["']([^"']*)["']\s*$/u, JSON.stringify(installationId))
            )
          : inline.replace(
              /(\{\s*)?\}(\s*(?:#.*)?\r?\n?)$/u,
              (_suffix, empty: string | undefined, ending: string) =>
                `${empty ? '{ ' : ', '}"${INSTALLATION_HEADER}" = ${JSON.stringify(installationId)} }${ending}`
            );
      else if (INSTALLATION_PAIR.test(inline))
        next[inlineAt] = inline
          .replace(
            /(?:,\s*)?(?:["']x-mnemonik-installation-id["']|x-mnemonik-installation-id)\s*=\s*["'][^"']*["']\s*,?/u,
            ''
          )
          .replace(/\{\s*,/u, '{')
          .replace(/,\s*\}/u, ' }');
    }
    const inlineHeader = installationId
      ? `${headerKey} = { "${INSTALLATION_HEADER}" = ${JSON.stringify(installationId)} }${newline}`
      : undefined;
    if (!main) {
      append.push(`[mcp_servers.mnemonik]${newline}`, `url = "${url}"${newline}`);
      if (!headerTable && inlineHeader) append.push(inlineHeader);
    } else if (!headerTable && inline === undefined && inlineHeader) {
      const urlAt = lines.findIndex(
        (line, index) => index > main.start && index < main.stop && /^\s*url\s*=/.test(line)
      );
      // A missing url was queued under the table name; the header follows it.
      queue(urlAt >= 0 ? urlAt : main.start, inlineHeader);
    }
  }
  const out: string[] = [];
  next.forEach((line, index) => {
    if (!drop.has(index)) out.push(line);
    out.push(...(insertAfter.get(index) ?? []));
  });
  let content = out.join('');
  if (append.length)
    content = `${content}${content && !content.endsWith('\n') ? newline : ''}${append.join('')}`;

  const after = tryParseToml(content);
  if (!('value' in after)) {
    // A file that was already broken elsewhere stays the person's to fix.
    if (!('value' in before))
      throw new Error('invalid_mcp_toml', { cause: new Error(tomlProblem(file, before.error)) });
    throw new Error('mcp_toml_write_refused', {
      cause: new Error(
        `Mnemonik's change would leave ${tomlProblem(file, after.error).replace(` is not`, ' not')}; ${file} was left unchanged`
      ),
    });
  }
  const declared = codexDeclaration(after.value);
  const headers = record(declared?.[headerKey]);
  const holds = install
    ? declared?.url === url &&
      (installationId
        ? headers?.[INSTALLATION_HEADER] === installationId
        : !headers || !Object.hasOwn(headers, INSTALLATION_HEADER))
    : declared === undefined;
  if (!holds)
    throw new Error('mcp_toml_write_refused', {
      cause: new Error(
        `Mnemonik could not ${install ? 'declare' : 'remove'} its connection in ${file}; the file was left unchanged`
      ),
    });
  return content;
}
/** The last key line of a section, so additions land before its trailing blank lines. */
function lastKeyLine(lines: string[], section: { start: number; stop: number }): number {
  for (let index = section.stop - 1; index > section.start; index--)
    if (/\S/u.test(lines[index] ?? '') && !/^\s*#/u.test(lines[index] ?? '')) return index;
  return section.start;
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
      const tomlRaw =
        install &&
        host.name === 'codex' &&
        target.scope === 'user' &&
        (deps.platform ?? process.platform) === 'darwin'
          ? ensureCodexFileMcpCredentials(raw)
          : raw;
      // Preserve unrelated TOML bytes. Refuse layouts whose table boundaries are ambiguous.
      if (
        /'''|"""/.test(tomlRaw) ||
        /^\s*(?:mcp_servers\s*=|mcp_servers\s*\.)/m.test(tomlRaw) ||
        /=\s*\[[^\]\n]*$/m.test(tomlRaw)
      )
        throw new Error('unsupported_mcp_toml_layout');
      if (
        /^\s*\[\s*["']?mcp_servers["']?\s*\]/m.test(tomlRaw) ||
        /^\s*\[\[\s*["']?mcp_servers/m.test(tomlRaw)
      )
        throw new Error('unsupported_mcp_toml_layout');
      const headerKey = host.mcp.headerKey ?? 'http_headers';
      if (install === undefined) {
        // Present only as Codex will read it: a file that does not parse declares nothing.
        const parsed = tryParseToml(raw);
        const declared = 'value' in parsed ? codexDeclaration(parsed.value) : undefined;
        const headers = record(declared?.[headerKey]);
        const exact =
          declared?.url === url &&
          (installationHeader
            ? headers?.[INSTALLATION_HEADER] === target.installationId
            : !headers || !Object.hasOwn(headers, INSTALLATION_HEADER));
        return exact ? [{ path: file, content: Buffer.from(raw) }] : [];
      }
      const written = writeCodexMcpToml({
        file,
        raw: tomlRaw,
        url,
        headerKey,
        ...(installationHeader ? { installationId: target.installationId } : {}),
        install,
        ownedTarget,
      });
      if (written === undefined) return [];
      content = written;
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
