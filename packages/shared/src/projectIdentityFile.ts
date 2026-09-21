import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RepositoryFingerprint } from './repositoryFingerprint.js';

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const isCanonicalUuid = (value: unknown): value is string =>
  typeof value === 'string' && CANONICAL_UUID.test(value);
const IDENTITY_KEYS = new Set([
  'schemaVersion',
  'projectId',
  'projectName',
  'repositoryFingerprint',
]);
const FINGERPRINT_KEYS = new Set(['algorithmVersion', 'hash']);

export interface ProjectIdentityFile {
  schemaVersion: 1;
  projectId: string;
  projectName?: string;
  repositoryFingerprint?: RepositoryFingerprint;
}

export type IdentityFileResult =
  | { kind: 'ok'; identity: ProjectIdentityFile }
  | { kind: 'unknown_version'; version: unknown }
  | { kind: 'malformed'; detail: string }
  | { kind: 'absent' };

export function parseIdentityFile(text: string): Exclude<IdentityFileResult, { kind: 'absent' }> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { kind: 'malformed', detail: `unparseable JSON: ${(error as Error).message}` };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'malformed', detail: 'identity file must contain a JSON object' };
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) {
    return { kind: 'unknown_version', version: record.schemaVersion };
  }
  const unknownKey = Object.keys(record).find((key) => !IDENTITY_KEYS.has(key));
  if (unknownKey) return { kind: 'malformed', detail: `unknown key "${unknownKey}"` };
  if (!isCanonicalUuid(record.projectId)) {
    return { kind: 'malformed', detail: '"projectId" must be a canonical RFC 4122 UUID string' };
  }
  if ('projectName' in record && typeof record.projectName !== 'string') {
    return { kind: 'malformed', detail: '"projectName" must be a string when present' };
  }
  if (
    'repositoryFingerprint' in record &&
    (!record.repositoryFingerprint ||
      typeof record.repositoryFingerprint !== 'object' ||
      Array.isArray(record.repositoryFingerprint))
  ) {
    return { kind: 'malformed', detail: '"repositoryFingerprint" must be an object when present' };
  }
  const fingerprint = record.repositoryFingerprint as Record<string, unknown> | undefined;
  const unknownFingerprintKey = fingerprint
    ? Object.keys(fingerprint).find((key) => !FINGERPRINT_KEYS.has(key))
    : undefined;
  if (unknownFingerprintKey) {
    return {
      kind: 'malformed',
      detail: `unknown repositoryFingerprint key "${unknownFingerprintKey}"`,
    };
  }
  if (fingerprint && (fingerprint.algorithmVersion !== 1 || typeof fingerprint.hash !== 'string')) {
    return {
      kind: 'malformed',
      detail: '"repositoryFingerprint" must contain algorithmVersion 1 and a string hash',
    };
  }
  const repositoryFingerprint: RepositoryFingerprint | undefined = fingerprint
    ? { algorithmVersion: 1, hash: fingerprint.hash as string }
    : undefined;
  return {
    kind: 'ok',
    identity: {
      schemaVersion: 1,
      projectId: record.projectId,
      ...(record.projectName === undefined ? {} : { projectName: record.projectName as string }),
      ...(repositoryFingerprint ? { repositoryFingerprint } : {}),
    },
  };
}

export async function readIdentityFile(
  dir: string,
  options: { selectedRoot?: boolean } = {}
): Promise<IdentityFileResult> {
  const path = join(dir, '.mnemonik.json');
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return { kind: 'malformed', detail: 'symlink' };
    if (!stat.isFile()) return { kind: 'malformed', detail: 'identity path is not a regular file' };
    const text = await readFile(path, 'utf8');
    if (options.selectedRoot) {
      // A ticked folder with configuration but no identity is a new project.
      // Keep invalid identities and non-regular files on the strict refusal path.
      try {
        const value: unknown = JSON.parse(text);
        if (value && typeof value === 'object' && !Array.isArray(value) && !('projectId' in value))
          return { kind: 'absent' };
      } catch {
        /* The strict parser supplies the diagnostic. */
      }
    }
    return parseIdentityFile(text);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'malformed', detail: `cannot read identity file: ${(error as Error).message}` };
  }
}
