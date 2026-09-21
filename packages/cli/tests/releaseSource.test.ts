import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { ReadableStream } from 'node:stream/web';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  npmReleaseSource,
  releaseBytes,
  scannerReleaseSource,
  type ReleaseManifest,
} from '../src/runtime/releaseSource.js';
import { hash, RuntimeStore } from '../src/runtime/store.js';

const base = 'https://github.com/JayDeeCo-Limited/mnemonik-cli/releases/download/scanner-v1.2.3/';
const content = Buffer.from('scanner');
const descriptor = { sha256: hash(content), size: content.length, executable: true };
const index = Buffer.from(JSON.stringify({ files: { scanner: descriptor } }));
const trusted: ReleaseManifest = {
  version: '1.2.3',
  digestsSha256: hash(index),
  platforms: {
    'linux-x64': {
      schemaVersion: 1,
      artifact: 'scanner',
      version: '1.2.3',
      entry: 'scanner',
      files: { scanner: descriptor },
      totalSize: content.length,
      source: { kind: 'release', url: base },
    },
  },
};
const fixture =
  (digest = index, asset = content): typeof fetch =>
  async (url) =>
    new Response(new Uint8Array(String(url).endsWith('digests.json') ? digest : asset));

describe('release source trust boundary', () => {
  let server: Server;
  let address: string;
  beforeAll(async () => {
    server = createServer((req, res) =>
      res.end(req.url?.endsWith('digests.json') ? index : content)
    );
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    address = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((done) => server.close(() => done())));
  it('accepts a fixture served locally through an injected transport, without a production localhost exception', async () => {
    const local: typeof fetch = async (url, options) =>
      fetch(address + new URL(String(url)).pathname, options);
    const source = await scannerReleaseSource(trusted, local, 'linux-x64');
    expect(source.files.scanner).toEqual(content);
    await expect(releaseBytes(address)).rejects.toMatchObject({ reason: 'permission' });
  });
  it('refuses a digest index changed at the release origin', async () => {
    await expect(
      scannerReleaseSource(trusted, fixture(Buffer.concat([index, Buffer.from(' ')])), 'linux-x64')
    ).rejects.toMatchObject({ reason: 'digest_mismatch' });
  });
  it('refuses substituted asset bytes', async () => {
    await expect(
      scannerReleaseSource(trusted, fixture(index, Buffer.from('changed')), 'linux-x64')
    ).rejects.toMatchObject({ reason: 'digest_mismatch' });
  });
  it('keeps an active scanner download alive beyond the stall limit', async () => {
    const bytes = releaseBytes(
      base + 'scanner',
      async (_url, options) => {
        const signal = options?.signal;
        return new Response(
          new ReadableStream({
            start(controller) {
              let timer: ReturnType<typeof setTimeout>;
              let sent = 0;
              const push = () => {
                if (signal?.aborted) return;
                if (sent === 10) return controller.close();
                controller.enqueue(Uint8Array.of(97 + sent++));
                timer = setTimeout(push, 10);
              };
              signal?.addEventListener(
                'abort',
                () => {
                  clearTimeout(timer);
                  controller.error(signal.reason);
                },
                { once: true }
              );
              timer = setTimeout(push, 10);
            },
          })
        );
      },
      80
    );
    await expect(bytes).resolves.toEqual(Buffer.from('abcdefghij'));
  });
  it.each([
    'https://evil.test/a',
    'https://github.com/evil/cli/releases/download/x/a',
    'https://github.com/JayDeeCo-Limited/mnemonik-cli/raw/main/a',
    'http://registry.npmjs.org/a',
    'https://registry.npmjs.org.evil.test/a',
    'https://user@registry.npmjs.org/a',
    'https://release-assets.githubusercontent.com/a',
  ])('refuses %s before transport', async (url) => {
    await expect(
      releaseBytes(url, async () => {
        throw Error('must not fetch');
      })
    ).rejects.toMatchObject({ reason: 'permission' });
  });
  it('permits exactly one HTTPS hop to a pinned GitHub CDN', async () => {
    let calls = 0;
    const transport: typeof fetch = async () =>
      ++calls === 1
        ? new Response(null, {
            status: 302,
            headers: { location: 'https://release-assets.githubusercontent.com/asset' },
          })
        : new Response('ok');
    expect((await releaseBytes(base + 'scanner', transport)).toString()).toBe('ok');
    expect(calls).toBe(2);
  });
  it.each([
    'https://evil.test/a',
    'http://objects.githubusercontent.com/a',
    'https://objects.githubusercontent.com:444/a',
  ])('refuses redirected %s', async (location) => {
    await expect(
      releaseBytes(
        base + 'scanner',
        async () => new Response(null, { status: 302, headers: { location } })
      )
    ).rejects.toMatchObject({ reason: 'permission' });
  });
  it('refuses a second redirect', async () => {
    await expect(
      releaseBytes(
        base + 'scanner',
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: 'https://objects.githubusercontent.com/a' },
          })
      )
    ).rejects.toMatchObject({ reason: 'permission' });
  });
  it('verifies npm integrity and hands a complete tarball runtime to the same installer', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'mnemonik-cli-pack-'));
    try {
      await writeFile(
        join(scratch, 'package.json'),
        JSON.stringify({ name: '@mnemonik/cli', version: '1.2.3' })
      );
      const packed = JSON.parse(
        execFileSync('npm', ['pack', '--json', '--ignore-scripts'], {
          cwd: scratch,
          encoding: 'utf8',
        })
      );
      const tarball = await readFile(join(scratch, packed[0].filename));
      const view = async () => ({
        version: '1.2.3',
        'dist.tarball': 'https://registry.npmjs.org/cli.tgz',
        'dist.integrity': 'sha512-' + createHash('sha512').update(tarball).digest('base64'),
      });
      const source = await npmReleaseSource(async () => new Response(tarball), view);
      expect(source.files['node_modules/@mnemonik/cli/package.json']).toBeDefined();
      await expect(
        npmReleaseSource(async () => new Response('tampered'), view)
      ).rejects.toMatchObject({ reason: 'digest_mismatch' });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});

// Explicit opt-in: this invokes the real platform build, not a fake executable fixture.
it.skipIf(process.env.RELEASE_ARTIFACT_TEST !== 'true')(
  'builds Linux SEA evidence and verifies a real minisign signature',
  async () => {
    const root = resolve(import.meta.dirname, '../../..');
    // The SEA build resolves postject from the public mirror's own lockfile,
    // which a plain `npm ci` at the root does not install.
    expect(
      existsSync(join(root, 'deploy/cli-public/node_modules/postject')),
      'run `npm ci --prefix deploy/cli-public --ignore-scripts` first'
    ).toBe(true);
    const scratch = await mkdtemp(join(tmpdir(), 'mnemonik-artifacts-test-'));
    try {
      const output = join(scratch, 'artifacts');
      const secret = join(scratch, 'secret.key'),
        publicKey = join(scratch, 'public.key');
      execFileSync('minisign', ['-G', '-W', '-s', secret, '-p', publicKey]);
      const identity = (await readFile(publicKey, 'utf8')).trim().split('\n').at(-1)!;
      execFileSync(process.execPath, ['scripts/release-artifacts.mjs', 'build', output], {
        cwd: root,
        env: {
          ...process.env,
          DRY_RUN: 'false',
          LINUX_MINISIGN_SECRET_KEY: await readFile(secret, 'utf8'),
          LINUX_MINISIGN_PUBLIC_KEY: identity,
        },
        stdio: 'pipe',
      });
      expect((await readdir(output)).sort()).toEqual([
        'digests.json',
        'linux-x64.attestation.json',
        'linux-x64.licenses.json',
        'linux-x64.manifest.json',
        'linux-x64.sbom.json',
        'scanner-linux-x64',
        'scanner-linux-x64.minisig',
        'scanner-release.json',
      ]);
      const release = JSON.parse(
        await readFile(join(output, 'scanner-release.json'), 'utf8')
      ) as ReleaseManifest;
      const source = await scannerReleaseSource(
        release,
        async (url) =>
          new Response(
            await readFile(join(output, new URL(String(url)).pathname.split('/').at(-1)!))
          )
      );
      const store = new RuntimeStore(join(scratch, 'state'));
      await store.installRuntime('scanner', release.version, source);
      const verified = await store.verifyRuntime('scanner');
      expect(execFileSync(verified.entry, ['--version'], { encoding: 'utf8' }).trim()).toBe(
        release.version
      );
      delete source.manifest.signer;
      await expect(
        new RuntimeStore(join(scratch, 'unsigned')).installRuntime(
          'scanner',
          release.version,
          source
        )
      ).rejects.toMatchObject({ reason: 'unsigned' });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
  120_000
);

it.skipIf(!process.env.PUBLIC_CLI_TARBALL)(
  'public tarball finds its package.json and boots through real npx',
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'mnemonik-public-pack-'));
    try {
      const tarball = resolve(process.env.PUBLIC_CLI_TARBALL!);
      const prefix = join(scratch, 'prefix');
      execFileSync('npm', [
        'install',
        '--prefix',
        prefix,
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        tarball,
      ]);
      const pkg = JSON.parse(
        await readFile(join(prefix, 'node_modules/@mnemonik/cli/package.json'), 'utf8')
      );
      // This catches bundlers moving auth/index's ../../package.json lookup into dist/router.js.
      expect(
        execFileSync(
          process.execPath,
          [join(prefix, 'node_modules/@mnemonik/cli/dist/bin.js'), '--version'],
          {
            env: { ...process.env, MNEMONIK_STATE_DIR: join(scratch, 'direct-state') },
            encoding: 'utf8',
          }
        ).trim()
      ).toBe(pkg.version);
      const state = join(scratch, 'npx-state');
      const help = execFileSync(
        'npx',
        ['--yes', '--cache', join(scratch, 'cache'), '--package', tarball, 'mnemonik', '--help'],
        { cwd: scratch, env: { ...process.env, MNEMONIK_STATE_DIR: state }, encoding: 'utf8' }
      );
      expect(help).toContain('Usage: mnemonik <command>');
      const requests: string[] = [];
      const issuer = createServer((req, res) => {
        requests.push(req.url ?? '');
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'qualification_login_reached' }));
      });
      await new Promise<void>((done) => issuer.listen(0, '127.0.0.1', done));
      try {
        await expect(
          promisify(execFile)(
            'npx',
            [
              '--yes',
              '--cache',
              join(scratch, 'cache'),
              '--package',
              tarball,
              'mnemonik',
              'auth',
              'login',
              '--no-browser',
            ],
            {
              cwd: scratch,
              env: {
                ...process.env,
                MNEMONIK_STATE_DIR: state,
                MNEMONIK_OAUTH_ISSUER: `http://127.0.0.1:${(issuer.address() as { port: number }).port}`,
              },
            }
          )
        ).rejects.toMatchObject({ code: 1 });
        expect(requests).toContain('/oauth/device_authorization');
      } finally {
        await new Promise<void>((done) => issuer.close(() => done()));
      }

      expect((await new RuntimeStore(state).verifyRuntime('cli')).manifest.version).toBe(
        pkg.version
      );
      const index = JSON.parse(
        await readFile(join(prefix, 'node_modules/@mnemonik/cli/dist/digests.json'), 'utf8')
      );
      expect(Object.keys(index)).toContain('dist/scanner-release.json');
      const packedBytes = await readFile(tarball);
      const downloaded = await npmReleaseSource(
        async () => new Response(packedBytes),
        async () => ({
          version: pkg.version,
          'dist.tarball': 'https://registry.npmjs.org/cli.tgz',
          'dist.integrity': 'sha512-' + createHash('sha512').update(packedBytes).digest('base64'),
        })
      );
      const updated = await new RuntimeStore(join(scratch, 'update-state')).installRuntime(
        'cli',
        pkg.version,
        downloaded
      );
      expect(updated.manifest.version).toBe(pkg.version);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
  120_000
);
