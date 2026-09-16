import { appendFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDiagnosticsCommand } from '../../scanner/src/diagnostics/cli.js';
import { DiagnosticsError, previewDiagnostics, sendDiagnostics } from '../src/diagnostics.js';

describe('diagnostics commands', () => {
  const temporary: string[] = [];
  afterEach(async () =>
    Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true })))
  );

  async function fixture() {
    const stateDir = await mkdtemp(join(tmpdir(), 'mnk-cli-diagnostics-'));
    temporary.push(stateDir);
    await mkdir(join(stateDir, 'scanner'), { recursive: true });
    await writeFile(
      join(stateDir, 'scanner', 'state.json'),
      JSON.stringify({
        schemaVersion: 1,
        paused: false,
        pauseIntervals: [],
        config: {
          roots: [stateDir],
          serverUrl: 'https://api.mnemonik.dev',
          credentialFamilyId: 'scanner-family',
        },
      })
    );
    await writeFile(
      join(stateDir, 'scanner', 'status.json'),
      JSON.stringify({ recordedAt: 1, snapshot: { schemaVersion: 1, version: 'test' } })
    );
    const execFile = vi.fn(
      (
        _file: string,
        args: string[],
        _options: object,
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        let stdout = '';
        void runDiagnosticsCommand(args, {
          stateDir,
          now: () => Date.parse('2026-09-11T00:00:00.000Z'),
          stdout: { write: (value) => (stdout += value) },
        }).then(
          () => callback(null, stdout, ''),
          (error: Error) => callback(error, '', '')
        );
        return {} as never;
      }
    );
    let uploaded: Buffer | undefined;
    const fetcher = vi.fn(async (_input: unknown, init?: { body?: unknown }) => {
      uploaded = Buffer.from(init?.body as Buffer);
      return new Response(JSON.stringify({ stored: true }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    });
    const credentials = {
      withCredential: async <T>(
        _family: string,
        _transport: unknown,
        work: (token: string) => Promise<T>
      ) => work('mnc_test'),
    };
    return { stateDir, execFile, fetcher, credentials, uploaded: () => uploaded };
  }

  it('sends byte-for-byte the previously written preview', async () => {
    const f = await fixture();
    const preview = await previewDiagnostics(undefined, {
      stateDir: f.stateDir,
      scannerBinary: async () => '/verified/scanner',
      execFile: f.execFile as never,
    });
    const expected = await readFile(preview.path);
    const sent = await sendDiagnostics(preview.manifest.bundleId, {
      stateDir: f.stateDir,
      fetch: f.fetcher as never,
      credentials: f.credentials as never,
      rotation: {} as never,
    });
    expect(f.uploaded()?.equals(expected)).toBe(true);
    expect(sent).toMatchObject({ stored: true, bytes: expected.length, sha256: preview.sha256 });
  });

  it('refuses a modified preview without making a request', async () => {
    const f = await fixture();
    const preview = await previewDiagnostics(undefined, {
      stateDir: f.stateDir,
      scannerBinary: async () => '/verified/scanner',
      execFile: f.execFile as never,
    });
    await appendFile(preview.path, 'modified');
    await expect(
      sendDiagnostics(preview.manifest.bundleId, {
        stateDir: f.stateDir,
        fetch: f.fetcher as never,
        credentials: f.credentials as never,
      })
    ).rejects.toEqual(new DiagnosticsError('bundle_hash_mismatch'));
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('keeps the upload function exclusive to the explicit send command', async () => {
    const roots = [
      new URL('../src/', import.meta.url),
      new URL('../../scanner/src/', import.meta.url),
      new URL('../../../src/', import.meta.url),
    ];
    const sources: string[] = [];
    const walk = async (directory: URL): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const location = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
        if (entry.isDirectory()) await walk(location);
        else if (entry.name.endsWith('.ts')) sources.push(await readFile(location, 'utf8'));
      }
    };
    await Promise.all(roots.map(walk));
    const source = sources.join('\n');
    expect(source.match(/uploadDiagnosticsBundle\(/gu)).toHaveLength(2);
    expect(source).toMatch(/sendDiagnostics[\s\S]*uploadDiagnosticsBundle\(/u);
  });
});
