import { readFileSync } from 'node:fs';

// prepack/prepublishOnly run for our pack/publish, not a registry consumer install.
const pkg = JSON.parse(readFileSync(0, 'utf8'));
for (const key of ['preinstall', 'install', 'postinstall', 'prepare']) {
  if (Object.hasOwn(pkg.scripts ?? {}, key)) {
    throw new Error(`Refusing ${pkg.name}: packed package.json contains lifecycle script ${key}`);
  }
}
