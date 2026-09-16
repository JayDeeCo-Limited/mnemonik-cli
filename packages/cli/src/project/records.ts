import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  atomicWrite,
  recordPath,
  stateDirectory,
  withLock,
  type Owner,
  type SetupRecord,
} from '@mnemonik/local-setup';

export interface ProjectCommandRecord {
  resolvedRoot: string;
  decisionReason: string;
  chosenOwner: 'personal' | `team:${string}`;
  projectId: string | null;
  beforeHash: `sha256:${string}` | null;
  afterHash: `sha256:${string}` | null;
}

const digest = (bytes: Buffer): `sha256:${string}` =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export async function identityHash(root: string): Promise<ProjectCommandRecord['beforeHash']> {
  try {
    return digest(await readFile(join(root, '.mnemonik.json')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export const ownerLabel = (owner: Owner | undefined): ProjectCommandRecord['chosenOwner'] =>
  !owner || owner === 'personal' ? 'personal' : `team:${owner.teamId}`;

export async function saveCommandRecord(
  record: ProjectCommandRecord,
  stateDir = stateDirectory()
): Promise<void> {
  const directory = join(
    stateDir,
    'project-commands',
    createHash('sha256').update(record.resolvedRoot).digest('hex')
  );
  const lock = join(directory, '.records');
  await withLock(lock, 60_000, async (assertOwned) => {
    const file = join(directory, `${Date.now().toString().padStart(16, '0')}-${randomUUID()}.json`);
    await atomicWrite(
      file,
      Buffer.from(`${JSON.stringify(record, null, 2)}\n`),
      undefined,
      assertOwned
    );
    const files = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
    for (const stale of files.slice(0, -20)) {
      await assertOwned();
      await unlink(join(directory, stale));
    }
  });
}

export async function readExecutorState(
  root: string,
  stateDir = stateDirectory()
): Promise<string | undefined> {
  try {
    const record = JSON.parse(await readFile(recordPath(root, stateDir), 'utf8')) as SetupRecord;
    if (record.ignored) return 'ignored';
    if (record.steps.rollback.complete) return 'rolled_back';
    if (record.steps.identity.complete) return 'done';
    if (record.staged) return 'staged';
    return record.remote ? 'remote_complete' : 'pending';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return 'record_invalid';
  }
}
