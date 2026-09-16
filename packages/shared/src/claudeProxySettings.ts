import { dirname, join, resolve } from 'node:path';
import { chmod, mkdir } from 'node:fs/promises';
import {
  atomicWriteText,
  canonicalizeConfigTargets,
  installerConfigLockPath,
  readTextIfExists,
  withFileLocks,
} from './settingsIo.js';

const PROXY_TOKEN_PATTERN = /^pxt_[a-f0-9]{32}$/;

export type ClaudeBaseUrlState = { kind: 'absent' } | { kind: 'value'; value: string };

export type ClaudeProxyStatus = 'on' | 'off' | 'custom' | 'not-paired' | 'invalid';

export interface ClaudeProxySettingsOptions {
  homeDir?: string;
  settingsPath?: string;
  configPath?: string;
}

export type ClaudeProxyPairingConfig = Record<string, unknown> & {
  server: string;
  proxyToken: string;
};

export interface ClaudeProxyMutationResult {
  changed: boolean;
  handoffCleanupUnconfirmed: boolean;
}

export interface ClaudeProxyOffResult extends ClaudeProxyMutationResult {
  outcome: 'disabled' | 'already-off';
}

export interface ClaudeProxyOnResult extends ClaudeProxyMutationResult {
  outcome: 'enabled' | 'already-on';
}

interface ClaudeProxyPaths {
  settingsPath: string;
  configPath: string;
  lockPath: string;
  configLockPath: string;
}

interface ClaudeProxyBasePaths {
  homeDir: string;
  configPath: string;
}

interface ParsedSettings {
  raw: string | null;
  value: Record<string, unknown>;
  baseUrl: ClaudeBaseUrlState;
}

interface PairedProxyConfig {
  raw: string;
  value: Record<string, unknown>;
  server: string;
  proxyToken: string;
  previousProxyToken: string | null;
  proxyUrl: string;
}

export class ClaudeProxyConflictError extends Error {
  constructor() {
    super('Claude Code already has a base URL that does not match this paired device.');
    this.name = 'ClaudeProxyConflictError';
  }
}

export class ClaudeProxySettingsError extends Error {
  constructor() {
    super('Claude settings are invalid or unreadable.');
    this.name = 'ClaudeProxySettingsError';
  }
}

export class ClaudeProxyNotPairedError extends Error {
  constructor() {
    super('This device is not paired with Mnemonik. Run pairing first.');
    this.name = 'ClaudeProxyNotPairedError';
  }
}

function resolveHomeDirectory(
  env: Partial<Record<'HOME' | 'USERPROFILE', string | undefined>> = process.env
): string {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  if (!home) throw new ClaudeProxyNotPairedError();
  return resolve(home);
}

function resolveBasePaths(options: ClaudeProxySettingsOptions): ClaudeProxyBasePaths {
  const homeDir = resolve(options.homeDir ?? resolveHomeDirectory());
  const configPath = resolve(options.configPath ?? join(homeDir, '.mnemonik', 'config.json'));
  return { homeDir, configPath };
}

async function resolvePaths(
  options: ClaudeProxySettingsOptions,
  basePaths = resolveBasePaths(options)
): Promise<ClaudeProxyPaths> {
  const requestedSettingsPath = resolve(
    options.settingsPath ?? join(basePaths.homeDir, '.claude', 'settings.json')
  );
  const [settingsPath, configPath] = await canonicalizeConfigTargets([
    requestedSettingsPath,
    basePaths.configPath,
  ]);
  if (!settingsPath || !configPath) throw new ClaudeProxySettingsError();
  const runtimeParent = join(basePaths.homeDir, '.mnemonik', 'hooks');
  return {
    settingsPath,
    configPath,
    lockPath: installerConfigLockPath(settingsPath, runtimeParent),
    configLockPath: installerConfigLockPath(configPath, runtimeParent),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseSettingsRaw(raw: string | null): ParsedSettings {
  if (raw === null) return { raw: null, value: {}, baseUrl: { kind: 'absent' } };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ClaudeProxySettingsError();
  }
  if (!isRecord(parsed)) throw new ClaudeProxySettingsError();
  if (parsed.env === undefined) return { raw, value: parsed, baseUrl: { kind: 'absent' } };
  if (!isRecord(parsed.env)) throw new ClaudeProxySettingsError();
  const baseUrl = parsed.env.ANTHROPIC_BASE_URL;
  if (baseUrl === undefined) return { raw, value: parsed, baseUrl: { kind: 'absent' } };
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    throw new ClaudeProxySettingsError();
  }
  return { raw, value: parsed, baseUrl: { kind: 'value', value: baseUrl } };
}

async function readSettings(settingsPath: string): Promise<ParsedSettings> {
  try {
    return parseSettingsRaw(await readTextIfExists(settingsPath));
  } catch (error) {
    if (error instanceof ClaudeProxySettingsError) throw error;
    throw new ClaudeProxySettingsError();
  }
}

export function buildClaudeProxyUrl(server: string, proxyToken: string): string {
  const trimmedServer = server.trim();
  if (!trimmedServer || !PROXY_TOKEN_PATTERN.test(proxyToken)) {
    throw new ClaudeProxyNotPairedError();
  }
  const proxyUrl = `${trimmedServer.replace(/\/$/, '')}/proxy/${proxyToken}`;
  try {
    const parsed = new URL(proxyUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ClaudeProxyNotPairedError();
    }
  } catch (error) {
    if (error instanceof ClaudeProxyNotPairedError) throw error;
    throw new ClaudeProxyNotPairedError();
  }
  return proxyUrl;
}

function parsePairedProxyConfig(raw: string | null): PairedProxyConfig | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.server !== 'string') return null;
  if (typeof parsed.proxyToken !== 'string') return null;
  const previousProxyToken = parsed.previousProxyToken;
  if (
    previousProxyToken !== undefined &&
    (typeof previousProxyToken !== 'string' || !PROXY_TOKEN_PATTERN.test(previousProxyToken))
  ) {
    return null;
  }
  try {
    const normalizedPreviousToken =
      previousProxyToken && previousProxyToken !== parsed.proxyToken ? previousProxyToken : null;
    return {
      raw,
      value: parsed,
      server: parsed.server,
      proxyToken: parsed.proxyToken,
      previousProxyToken: normalizedPreviousToken,
      proxyUrl: buildClaudeProxyUrl(parsed.server, parsed.proxyToken),
    };
  } catch {
    return null;
  }
}

async function readPairedProxyConfig(configPath: string): Promise<PairedProxyConfig | null> {
  try {
    return parsePairedProxyConfig(await readTextIfExists(configPath));
  } catch {
    return null;
  }
}

function managedProxyTokenForUrl(baseUrl: string, config: PairedProxyConfig): string | null {
  if (matchesProxyUrlForToken(baseUrl, config.server, config.proxyToken)) {
    return config.proxyToken;
  }
  if (
    config.previousProxyToken &&
    matchesProxyUrlForToken(baseUrl, config.server, config.previousProxyToken)
  ) {
    return config.previousProxyToken;
  }
  return null;
}

function matchesProxyUrlForToken(baseUrl: string, server: string, proxyToken: string): boolean {
  return (
    baseUrl === buildClaudeProxyUrl(server, proxyToken) ||
    baseUrl === `${server}/proxy/${proxyToken}`
  );
}

function matchesManagedProxyUrl(baseUrl: string, config: PairedProxyConfig): boolean {
  return managedProxyTokenForUrl(baseUrl, config) !== null;
}

function serializeConfig(config: Record<string, unknown>): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

async function clearPreviousProxyToken(
  paths: ClaudeProxyPaths,
  config: PairedProxyConfig,
  expectedProxyToken: string
): Promise<void> {
  if (config.proxyToken !== expectedProxyToken || config.previousProxyToken === null) return;
  const nextConfig = { ...config.value };
  delete nextConfig.previousProxyToken;
  await atomicWriteText(paths.configPath, serializeConfig(nextConfig), config.raw, { mode: 0o600 });
  await chmod(paths.configPath, 0o600);
}

async function tryClearPreviousProxyToken(
  paths: ClaudeProxyPaths,
  config: PairedProxyConfig,
  expectedProxyToken: string
): Promise<boolean> {
  try {
    await clearPreviousProxyToken(paths, config, expectedProxyToken);
    return false;
  } catch {
    return true;
  }
}

function withProxyLocks<T>(paths: ClaudeProxyPaths, action: () => Promise<T>): Promise<T> {
  return withFileLocks([paths.lockPath, paths.configLockPath], action);
}

function setBaseUrl(
  settings: Record<string, unknown>,
  next: ClaudeBaseUrlState
): Record<string, unknown> {
  const updated = { ...settings };
  if (next.kind === 'value') {
    const env = isRecord(settings.env) ? { ...settings.env } : {};
    env.ANTHROPIC_BASE_URL = next.value;
    updated.env = env;
    return updated;
  }

  if (!isRecord(settings.env)) return updated;
  const env = { ...settings.env };
  delete env.ANTHROPIC_BASE_URL;
  if (Object.keys(env).length === 0) delete updated.env;
  else updated.env = env;
  return updated;
}

function serializeSettings(settings: Record<string, unknown>): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

async function writeBaseUrl(
  settingsPath: string,
  settings: ParsedSettings,
  next: ClaudeBaseUrlState
): Promise<void> {
  await atomicWriteText(
    settingsPath,
    serializeSettings(setBaseUrl(settings.value, next)),
    settings.raw
  );
}

async function pairedConfigOrThrow(configPath: string): Promise<PairedProxyConfig> {
  const config = await readPairedProxyConfig(configPath);
  if (!config) throw new ClaudeProxyNotPairedError();
  return config;
}

export async function stageClaudeProxyPairingConfig(
  nextConfig: ClaudeProxyPairingConfig,
  options: ClaudeProxySettingsOptions = {}
): Promise<void> {
  const nextProxyUrl = buildClaudeProxyUrl(nextConfig.server, nextConfig.proxyToken);
  const basePaths = resolveBasePaths(options);
  await mkdir(dirname(basePaths.configPath), { recursive: true, mode: 0o700 });
  await chmod(dirname(basePaths.configPath), 0o700);
  const paths = await resolvePaths(options, basePaths);
  await withProxyLocks(paths, async () => {
    const currentRaw = await readTextIfExists(paths.configPath);
    const currentConfig = parsePairedProxyConfig(currentRaw);
    const settings = await readSettings(paths.settingsPath);
    let previousProxyToken: string | null = null;

    if (settings.baseUrl.kind === 'value') {
      if (!currentConfig) throw new ClaudeProxyConflictError();
      previousProxyToken = managedProxyTokenForUrl(settings.baseUrl.value, currentConfig);
      if (!previousProxyToken) throw new ClaudeProxyConflictError();
      if (settings.baseUrl.value === nextProxyUrl) {
        previousProxyToken = null;
      } else if (
        !matchesProxyUrlForToken(settings.baseUrl.value, nextConfig.server, previousProxyToken)
      ) {
        throw new ClaudeProxyConflictError();
      } else if (previousProxyToken === nextConfig.proxyToken) {
        previousProxyToken = null;
      }
    }

    const serializedConfig = { ...nextConfig };
    delete serializedConfig.previousProxyToken;
    if (previousProxyToken) serializedConfig.previousProxyToken = previousProxyToken;
    await atomicWriteText(paths.configPath, serializeConfig(serializedConfig), currentRaw, {
      mode: 0o600,
    });
    await chmod(paths.configPath, 0o600);
  });
}

export async function assertClaudeProxyCanBeConfigured(
  options: ClaudeProxySettingsOptions = {}
): Promise<void> {
  const paths = await resolvePaths(options);
  return withProxyLocks(paths, async () => {
    const config = await readPairedProxyConfig(paths.configPath);
    const settings = await readSettings(paths.settingsPath);
    if (
      settings.baseUrl.kind === 'value' &&
      (!config || !matchesManagedProxyUrl(settings.baseUrl.value, config))
    ) {
      throw new ClaudeProxyConflictError();
    }
  });
}

export async function configureClaudeProxy(
  server: string,
  proxyToken: string,
  options: ClaudeProxySettingsOptions = {}
): Promise<ClaudeProxyMutationResult> {
  const proxyUrl = buildClaudeProxyUrl(server, proxyToken);
  const paths = await resolvePaths(options);
  return withProxyLocks(paths, async () => {
    const config = await pairedConfigOrThrow(paths.configPath);
    if (config.proxyToken !== proxyToken || config.proxyUrl !== proxyUrl) {
      throw new ClaudeProxyConflictError();
    }
    const settings = await readSettings(paths.settingsPath);
    let changed = false;
    if (settings.baseUrl.kind === 'value') {
      if (!matchesManagedProxyUrl(settings.baseUrl.value, config)) {
        throw new ClaudeProxyConflictError();
      }
      if (settings.baseUrl.value !== proxyUrl) {
        await writeBaseUrl(paths.settingsPath, settings, { kind: 'value', value: proxyUrl });
        changed = true;
      }
    } else {
      await writeBaseUrl(paths.settingsPath, settings, { kind: 'value', value: proxyUrl });
      changed = true;
    }
    const handoffCleanupUnconfirmed = await tryClearPreviousProxyToken(paths, config, proxyToken);
    return { changed, handoffCleanupUnconfirmed };
  });
}

export async function turnClaudeProxyOff(
  options: ClaudeProxySettingsOptions = {}
): Promise<ClaudeProxyOffResult> {
  const basePaths = resolveBasePaths(options);
  await pairedConfigOrThrow(basePaths.configPath);
  const paths = await resolvePaths(options, basePaths);
  return withProxyLocks(paths, async () => {
    const config = await pairedConfigOrThrow(paths.configPath);
    const settings = await readSettings(paths.settingsPath);
    if (settings.baseUrl.kind === 'absent') {
      const handoffCleanupUnconfirmed = await tryClearPreviousProxyToken(
        paths,
        config,
        config.proxyToken
      );
      return { changed: false, outcome: 'already-off', handoffCleanupUnconfirmed };
    }
    if (!matchesManagedProxyUrl(settings.baseUrl.value, config)) {
      throw new ClaudeProxyConflictError();
    }
    await writeBaseUrl(paths.settingsPath, settings, { kind: 'absent' });
    const handoffCleanupUnconfirmed = await tryClearPreviousProxyToken(
      paths,
      config,
      config.proxyToken
    );
    return { changed: true, outcome: 'disabled', handoffCleanupUnconfirmed };
  });
}

export async function turnClaudeProxyOn(
  options: ClaudeProxySettingsOptions = {}
): Promise<ClaudeProxyOnResult> {
  const basePaths = resolveBasePaths(options);
  await pairedConfigOrThrow(basePaths.configPath);
  const paths = await resolvePaths(options, basePaths);
  return withProxyLocks(paths, async () => {
    const config = await pairedConfigOrThrow(paths.configPath);
    const settings = await readSettings(paths.settingsPath);
    if (settings.baseUrl.kind === 'value') {
      if (settings.baseUrl.value === config.proxyUrl) {
        const handoffCleanupUnconfirmed = await tryClearPreviousProxyToken(
          paths,
          config,
          config.proxyToken
        );
        return { changed: false, outcome: 'already-on', handoffCleanupUnconfirmed };
      }
      if (!matchesManagedProxyUrl(settings.baseUrl.value, config)) {
        throw new ClaudeProxyConflictError();
      }
    }
    await writeBaseUrl(paths.settingsPath, settings, {
      kind: 'value',
      value: config.proxyUrl,
    });
    const handoffCleanupUnconfirmed = await tryClearPreviousProxyToken(
      paths,
      config,
      config.proxyToken
    );
    return { changed: true, outcome: 'enabled', handoffCleanupUnconfirmed };
  });
}

export async function getClaudeProxyStatus(
  options: ClaudeProxySettingsOptions = {}
): Promise<ClaudeProxyStatus> {
  try {
    const basePaths = resolveBasePaths(options);
    if (!(await readPairedProxyConfig(basePaths.configPath))) return 'not-paired';
    const paths = await resolvePaths(options, basePaths);
    return await withProxyLocks(paths, async () => {
      const config = await readPairedProxyConfig(paths.configPath);
      if (!config) return 'not-paired';
      const settings = await readSettings(paths.settingsPath);
      if (settings.baseUrl.kind === 'absent') return 'off';
      return matchesManagedProxyUrl(settings.baseUrl.value, config) ? 'on' : 'custom';
    });
  } catch {
    return 'invalid';
  }
}

export function formatClaudeProxyStatus(status: ClaudeProxyStatus): string {
  switch (status) {
    case 'on':
      return 'Mnemonik proxy is on and correctly configured.';
    case 'off':
      return 'Mnemonik proxy is off.';
    case 'custom':
      return 'Claude Code has a base URL that does not match this paired device.';
    case 'not-paired':
      return 'This device is not paired with Mnemonik.';
    case 'invalid':
      return 'Claude settings are invalid or unreadable.';
  }
}

export function formatClaudeProxyCleanupWarning(result: ClaudeProxyMutationResult): string | null {
  return result.handoffCleanupUnconfirmed
    ? 'Mnemonik could not confirm cleanup of the saved token handoff. The next proxy-changing command will check and retry it.'
    : null;
}
