import { appendFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile as nodeExecFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDiagnosticsCommand } from '../../scanner/src/diagnostics/cli.js';
import { DiagnosticsError, previewDiagnostics, sendDiagnostics } from '../src/diagnostics.js';
import { runCli } from '../src/router.js';

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
        void runDiagnosticsCommand(args.slice(1), {
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

  it('creates a preview through the scanner dispatcher', async () => {
    const f = await fixture();
    const result = await previewDiagnostics(undefined, {
      stateDir: f.stateDir,
      scannerBinary: async () => 'scanner',
      execFile: ((
        _file: string,
        args: string[],
        options: object,
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) =>
        nodeExecFile(
          process.execPath,
          [
            '--import',
            import.meta.resolve('tsx'),
            fileURLToPath(new URL('../../scanner/src/index.ts', import.meta.url)),
            ...args,
          ],
          { ...options, env: { ...process.env, MNEMONIK_STATE_DIR: f.stateDir } },
          callback
        )) as never,
    });
    expect(result.manifest.bundleId).toMatch(/^diag-/u);
  });

  it('explains a preview failure without internal storage words', async () => {
    const f = await fixture();
    let text = '';
    expect(
      await runCli(['diagnostics', 'preview'], {
        stderr: { write: (value) => void (text += value) },
        diagnostics: {
          stateDir: f.stateDir,
          scannerBinary: async () => {
            throw new DiagnosticsError('manifest_missing');
          },
        },
      })
    ).toBe(1);
    expect(text).toBe('Diagnostics could not be created.\nRun mnemonik install to try again.\n');
    expect(text).not.toMatch(/bundle|manifest/iu);
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
    // Plain string searches: a [\s\S]* regex over every source file overflowed
    // the stack on the CI runner once the tree grew past a few megabytes.
    expect(source.split('uploadDiagnosticsBundle(').length - 1).toBe(2);
    const sendIndex = source.indexOf('sendDiagnostics');
    expect(sendIndex).toBeGreaterThan(-1);
    expect(source.indexOf('uploadDiagnosticsBundle(', sendIndex)).toBeGreaterThan(-1);
  });
});
