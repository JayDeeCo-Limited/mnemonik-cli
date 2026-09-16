import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// Give npm only the shipped dependency closure; monorepo dev workspace ranges are not SBOM inputs.
export function sbom(workspace) {
  const scratch = mkdtempSync(join(tmpdir(), 'mnemonik-sbom-'));
  const versions = new Map();
  const visit = (source, target) => {
    const pkg = JSON.parse(readFileSync(join(source, 'package.json')));
    delete pkg.devDependencies;
    delete pkg.scripts;
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'package.json'), JSON.stringify(pkg));
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      let parent = realpathSync(source);
      while (!existsSync(join(parent, 'node_modules', name, 'package.json'))) {
        const next = dirname(parent);
        if (next === parent) throw Error(`Missing SBOM dependency ${name}`);
        parent = next;
      }
      const dependency = join(parent, 'node_modules', name);
      const version = JSON.parse(readFileSync(join(dependency, 'package.json'))).version;
      if (versions.has(name)) {
        if (versions.get(name) !== version) throw Error(`SBOM needs nested versions for ${name}`);
        continue;
      }
      versions.set(name, version);
      visit(dependency, join(scratch, 'node_modules', name));
    }
  };
  try {
    visit(resolve('packages', workspace), scratch);
    const document = JSON.parse(
      execFileSync(
        process.platform === 'win32' ? 'npm.cmd' : 'npm',
        ['sbom', '--sbom-format=cyclonedx', '--omit=dev'],
        { cwd: scratch, shell: process.platform === 'win32' }
      )
    );
    document.metadata.component.name = `@mnemonik/${workspace}`;
    if (workspace === 'scanner')
      document.components.push({
        type: 'application',
        name: 'node',
        version: process.versions.node,
        'bom-ref': `node@${process.versions.node}`,
        licenses: [{ license: { id: 'MIT' } }],
      });
    if (workspace === 'scanner')
      for (const name of readdirSync('packages/shared/wasm')) {
        document.components.push({
          type: 'file',
          name,
          'bom-ref': `grammar:${name}`,
          hashes: [
            {
              alg: 'SHA-256',
              content: createHash('sha256')
                .update(readFileSync(`packages/shared/wasm/${name}`))
                .digest('hex'),
            },
          ],
          properties: [
            {
              name: 'mnemonik:license-evidence',
              value: 'Version and license not recorded by existing grammar vendoring script',
            },
          ],
        });
      }
    return Buffer.from(JSON.stringify(document, null, 2) + '\n');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
