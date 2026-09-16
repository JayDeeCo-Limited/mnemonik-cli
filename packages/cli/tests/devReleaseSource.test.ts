import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { releaseBytes, devReadiness } from '../src/runtime/releaseSource.js';
import { serializeReadiness } from '@mnemonik/shared';

let root = '';
afterEach(async () => {
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});
it('uses only local internal packages and scanner assets, with no transport or escaping symlink', async () => {
  root = await mkdtemp(join(tmpdir(), 'dev-release-'));
  const pkg = join(root, 'pkg');
  await mkdir(pkg);
  await writeFile(
    join(pkg, 'package.json'),
    JSON.stringify({ name: '@mnemonik/cursor-hooks', version: '1.2.3' })
  );
  execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', root], {
    cwd: pkg,
    stdio: 'pipe',
  });
  vi.stubEnv('MNEMONIK_DEV_RELEASE_DIR', root);
  const transport = vi.fn<typeof fetch>();
  const metadata = JSON.parse(
    (
      await releaseBytes('https://registry.npmjs.org/%40mnemonik%2Fcursor-hooks/1.2.3', transport)
    ).toString()
  );
  expect(metadata.version).toBe('1.2.3');
  expect((await releaseBytes(metadata.dist.tarball, transport)).length).toBeGreaterThan(0);
  await writeFile(
    join(root, 'index.json'),
    JSON.stringify({
      ignore: {
        version: '7.0.6',
        tarball: 'mnemonik-cursor-hooks-1.2.3.tgz',
        integrity: metadata.dist.integrity,
      },
    })
  );
  const dependency = JSON.parse(
    (await releaseBytes('https://registry.npmjs.org/ignore/%5E7.0.6', transport)).toString()
  );
  expect(dependency).toMatchObject({ name: 'ignore', version: '7.0.6' });
  expect(await releaseBytes(dependency.dist.tarball, transport)).toEqual(
    await releaseBytes(metadata.dist.tarball, transport)
  );
  await writeFile(join(root, 'scanner-linux-x64'), 'scanner');
  expect(
    (
      await releaseBytes(
        'https://github.com/JayDeeCo-Limited/mnemonik-cli/releases/download/scanner-v1.2.3/scanner-linux-x64',
        transport
      )
    ).toString()
  ).toBe('scanner');
  await symlink('/etc/hostname', join(root, 'digests.json'));
  await expect(
    releaseBytes(
      'https://github.com/JayDeeCo-Limited/mnemonik-cli/releases/download/scanner-v1.2.3/digests.json',
      transport
    )
  ).rejects.toMatchObject({ reason: 'permission' });
  await expect(releaseBytes('file:///etc/hostname', transport)).rejects.toMatchObject({
    reason: 'permission',
  });
  await expect(
    releaseBytes('https://evil.test/scanner-linux-x64', transport)
  ).rejects.toMatchObject({ reason: 'permission' });
  expect(transport).not.toHaveBeenCalled();
});
it('retains a development readiness floor after the environment is removed without hiding failures', async () => {
  root = await mkdtemp(join(tmpdir(), 'dev-state-'));
  vi.stubEnv('MNEMONIK_STATE_DIR', root);
  await writeFile(join(root, 'host-ownership.json'), JSON.stringify({ devReleaseSource: true }));
  const document = devReadiness(serializeReadiness({ installation: { conditions: [] } }));
  expect(document.devReleaseSource).toBe(true);
  expect(document.installation).toMatchObject({
    state: 'LIMITED',
    reasons: ['dev_release_source'],
  });
  expect(
    devReadiness(
      serializeReadiness({ installation: { state: 'FAILED', reasons: ['failure'], actions: [] } })
    ).installation.state
  ).toBe('FAILED');
});
