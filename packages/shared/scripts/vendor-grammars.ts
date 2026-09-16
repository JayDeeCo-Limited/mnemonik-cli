/**
 * Vendor tree-sitter grammar artifacts into packages/shared/wasm/.
 *
 * WHY `npm pack` AND NOT devDependencies. The first attempt added the grammar
 * packages to this workspace's devDependencies and npm refused the tree:
 * tree-sitter-groovy declares a `peerOptional` on the NATIVE tree-sitter
 * (^0.21.1), which this design deliberately never installs. Rather than force
 * the resolution. These packages have no business in the dependency graph at
 * all: we want two files out of each of them, at build time, on our
 * machine. `npm pack` fetches a tarball and performs NO dependency resolution,
 * so there is no peer graph to satisfy, `npm ci` stays fast for every developer
 * and every CI run, and nobody downloads ~283 MB of grammars to build the repo.
 *
 * What ships to a user: the extracted `.wasm` and `.tags.scm` files, committed
 * here and published inside @mnemonik/shared. A user's install therefore pulls
 * no grammar package, runs no postinstall, needs no compiler, and fetches
 * nothing at runtime - which is the whole reason this plan chose WebAssembly
 * over the native bindings.
 *
 * Run: npx tsx packages/shared/scripts/vendor-grammars.ts [--check]
 *   --check  verify every manifest entry is present and non-empty; write nothing.
 *            This is what CI should run to catch a grammar that silently stopped
 *            shipping an artifact.
 */

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Language, Parser, Query } from 'web-tree-sitter';
import { AST_LANGUAGE_IDS, QUERY_CHAIN, grammarArtifactBasename } from '../src/ast/grammars.js';

const WASM_DIR = fileURLToPath(new URL('../wasm/', import.meta.url));
/** Queries we author ourselves, for grammars whose upstream ships none. */
const OURS_DIR = fileURLToPath(new URL('../queries/', import.meta.url));

interface GrammarSpec {
  /** Vendored artifact basename, and the id the registry keys on. */
  id: string;
  /** npm package to fetch. */
  pkg: string;
  /**
   * `.wasm` basename inside the tarball when it differs from the package's own
   * name - tree-sitter-typescript ships two, and tree-sitter-c-sharp names its
   * file with an `_` separator.
   */
  wasmFile?: string;
  /**
   * Where the tag query comes from. 'upstream' copies queries/tags.scm out of
   * the tarball; 'ours' copies packages/shared/queries/<id>.tags.scm, which we
   * maintain because the grammar ships no tags.scm at all.
   */
  tags: 'upstream' | 'ours' | 'inherited';
}

/**
 * The vendored set. Deliberately explicit rather than globbed: a glob would
 * quietly produce a smaller language set when a package changes its layout,
 * and losing a language is exactly the silent degradation this plan exists to
 * remove.
 *
 * Absent on purpose:
 *   julia, objc, haskell - the three largest grammars that ALSO ship no tag
 *     query, so each costs both its size (6.1/5.2/3.7 MB) and a hand-written
 *     query. Dropped to keep the payload under 40 MB; still indexed via the
 *     allowlist, still chunked heuristically.
 *   dart - its bundled .wasm (package v1.0.0, 2023) fails Language.load under
 *     web-tree-sitter 0.26.11 with a dylink-metadata error: the artifact
 *     predates the current wasm ABI. Presence is not loadability, which is why
 *     --check verifies both. Flutter matters, so this is worth revisiting by
 *     compiling from source with tree-sitter-cli.
 *   kotlin, swift, lua, perl, zig - bundle no .wasm, so they need a build step
 *     with tree-sitter-cli. Deferred until the grammars above are proven; they
 *     keep the heuristic chunker meanwhile.
 *   markdown - keeps chunkMarkdown. Headers already are a document's semantic
 *     unit; an AST would not improve on them.
 */
const GRAMMARS: GrammarSpec[] = [
  {
    id: 'typescript',
    pkg: 'tree-sitter-typescript',
    wasmFile: 'tree-sitter-typescript.wasm',
    tags: 'upstream',
  },
  { id: 'tsx', pkg: 'tree-sitter-typescript', wasmFile: 'tree-sitter-tsx.wasm', tags: 'inherited' },
  { id: 'javascript', pkg: 'tree-sitter-javascript', tags: 'upstream' },
  { id: 'python', pkg: 'tree-sitter-python', tags: 'upstream' },
  { id: 'go', pkg: 'tree-sitter-go', tags: 'upstream' },
  { id: 'java', pkg: 'tree-sitter-java', tags: 'upstream' },
  { id: 'c', pkg: 'tree-sitter-c', tags: 'upstream' },
  { id: 'cpp', pkg: 'tree-sitter-cpp', tags: 'upstream' },
  {
    id: 'c-sharp',
    pkg: 'tree-sitter-c-sharp',
    wasmFile: 'tree-sitter-c_sharp.wasm',
    tags: 'upstream',
  },
  { id: 'ruby', pkg: 'tree-sitter-ruby', tags: 'upstream' },
  { id: 'php', pkg: 'tree-sitter-php', wasmFile: 'tree-sitter-php.wasm', tags: 'upstream' },
  { id: 'rust', pkg: 'tree-sitter-rust', tags: 'upstream' },
  { id: 'scala', pkg: 'tree-sitter-scala', tags: 'upstream' },
  { id: 'elixir', pkg: 'tree-sitter-elixir', tags: 'upstream' },
  { id: 'solidity', pkg: 'tree-sitter-solidity', tags: 'upstream' },
  { id: 'bash', pkg: 'tree-sitter-bash', tags: 'ours' },
  { id: 'groovy', pkg: 'tree-sitter-groovy', tags: 'ours' },
  { id: 'powershell', pkg: 'tree-sitter-powershell', tags: 'ours' },
];

/**
 * Ordered tag-query files composing each grammar's EFFECTIVE query, keyed by
 * VENDORED ARTIFACT BASENAME (`c-sharp`, not `csharp`) because that is what this
 * script names files with.
 *
 * Derived, not declared: the chains themselves live in the runtime registry
 * (`src/ast/grammars.ts`), which is the module that has to compose them for real
 * work. A second hand-maintained copy here could drift from the one the scanner
 * uses, and a drifted chain does not fail - it silently under-matches, which is
 * the exact failure this vendoring step exists to catch. See that module for why
 * tag queries are deltas and what composing them is worth (948 TypeScript
 * definitions against 6,471).
 */
const CHAIN_BY_ARTIFACT: Record<string, string[]> = Object.fromEntries(
  AST_LANGUAGE_IDS.map((id) => [
    grammarArtifactBasename(id),
    QUERY_CHAIN[id].map((part) => grammarArtifactBasename(part)),
  ])
);

interface Problem {
  id: string;
  detail: string;
}

/**
 * Verify each manifest entry is present, LOADS, and compiles its composed query.
 *
 * Presence alone is not enough, proven here: tree-sitter-dart's bundled .wasm
 * exists and is 741 KB, and `Language.load` rejects it under web-tree-sitter
 * 0.26.11 because the artifact predates the current wasm ABI. A check that only
 * stats the file would have called that grammar vendored and shipped a language
 * that silently never parses.
 */
async function checkOnly(): Promise<Problem[]> {
  const problems: Problem[] = [];
  await Parser.init();

  for (const spec of GRAMMARS) {
    const wasm = join(WASM_DIR, `${spec.id}.wasm`);
    if (!existsSync(wasm) || statSync(wasm).size === 0) {
      problems.push({ id: spec.id, detail: `missing or empty ${spec.id}.wasm` });
      continue;
    }

    let language: Language;
    try {
      language = await Language.load(wasm);
    } catch (err) {
      problems.push({
        id: spec.id,
        detail: `${spec.id}.wasm exists but Language.load rejected it (ABI mismatch?): ${
          err instanceof Error ? err.message || err.constructor.name : String(err)
        }`,
      });
      continue;
    }

    const chain = CHAIN_BY_ARTIFACT[spec.id];
    if (!chain) {
      problems.push({
        id: spec.id,
        detail: `no QUERY_CHAIN entry in src/ast/grammars.ts - the grammar would load and match nothing`,
      });
      continue;
    }

    let source = '';
    for (const part of chain) {
      const file = join(WASM_DIR, `${part}.tags.scm`);
      if (!existsSync(file) || statSync(file).size === 0) {
        problems.push({ id: spec.id, detail: `chain part missing or empty: ${part}.tags.scm` });
        source = '';
        break;
      }
      source += readFileSync(file, 'utf8') + '\n';
    }
    if (!source) continue;

    try {
      const query = new Query(language, source);
      const captures = query.captureNames;
      if (!captures.some((c) => c.startsWith('definition.'))) {
        problems.push({
          id: spec.id,
          detail: `composed query compiles but captures no definition.* - it would name nothing`,
        });
      }
    } catch (err) {
      problems.push({
        id: spec.id,
        detail: `composed query failed to compile: ${
          err instanceof Error ? err.message.slice(0, 140) : String(err)
        }`,
      });
    }
  }
  return problems;
}

function vendor(): Problem[] {
  mkdirSync(WASM_DIR, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'ts-grammars-'));
  const problems: Problem[] = [];
  // One tarball may serve several ids (typescript + tsx), so fetch each package
  // once and extract from the shared checkout.
  const extracted = new Map<string, string>();

  try {
    for (const spec of GRAMMARS) {
      let dir = extracted.get(spec.pkg);
      if (!dir) {
        try {
          const out = execFileSync(
            'npm',
            ['pack', spec.pkg, '--silent', '--pack-destination', work],
            {
              cwd: work,
              encoding: 'utf8',
            }
          );
          const tarball = out.trim().split('\n').pop() ?? '';
          dir = join(work, spec.pkg.replace(/[^a-z0-9-]/gi, '_'));
          mkdirSync(dir, { recursive: true });
          execFileSync('tar', [
            'xzf',
            join(work, basename(tarball)),
            '-C',
            dir,
            '--strip-components=1',
          ]);
          extracted.set(spec.pkg, dir);
        } catch (err) {
          problems.push({
            id: spec.id,
            detail: `npm pack/extract failed for ${spec.pkg}: ${err instanceof Error ? err.message.slice(0, 160) : err}`,
          });
          continue;
        }
      }

      const wasmName =
        spec.wasmFile ?? readdirSync(dir).find((f) => f.endsWith('.wasm')) ?? `${spec.pkg}.wasm`;
      const wasmSrc = join(dir, wasmName);
      if (!existsSync(wasmSrc)) {
        problems.push({ id: spec.id, detail: `${spec.pkg} ships no ${wasmName}` });
      } else {
        copyFileSync(wasmSrc, join(WASM_DIR, `${spec.id}.wasm`));
      }

      if (spec.tags === 'upstream') {
        const tagsSrc = join(dir, 'queries', 'tags.scm');
        if (!existsSync(tagsSrc)) {
          problems.push({
            id: spec.id,
            detail: `${spec.pkg} ships no queries/tags.scm - reclassify this entry as 'ours' and author one`,
          });
        } else {
          copyFileSync(tagsSrc, join(WASM_DIR, `${spec.id}.tags.scm`));
        }
      } else if (spec.tags === 'ours') {
        const ourSrc = join(OURS_DIR, `${spec.id}.tags.scm`);
        if (!existsSync(ourSrc)) {
          problems.push({
            id: spec.id,
            detail: `no hand-written query at packages/shared/queries/${spec.id}.tags.scm`,
          });
        } else {
          copyFileSync(ourSrc, join(WASM_DIR, `${spec.id}.tags.scm`));
        }
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return problems;
}

const problems = process.argv.includes('--check') ? await checkOnly() : vendor();

if (problems.length > 0) {
  // Non-zero and loud: a grammar that stops shipping an artifact must break the
  // build, never silently remove a language from the product.
  console.error('VENDOR_GRAMMARS_FAILED');
  for (const p of problems) console.error(`  ${p.id}: ${p.detail}`);
  process.exit(1);
}

const sizes = GRAMMARS.map((g) => statSync(join(WASM_DIR, `${g.id}.wasm`)).size);
const totalMB = +(sizes.reduce((a, b) => a + b, 0) / 1048576).toFixed(1);
console.log(
  `VENDOR_GRAMMARS_OK ${JSON.stringify({ grammars: GRAMMARS.length, totalWasmMB: totalMB })}`
);
// The plan's ceiling. Install size is a cost every user pays, so it fails the
// build rather than drifting upward one grammar at a time.
if (totalMB > 40) {
  console.error(`VENDOR_GRAMMARS_TOO_LARGE ${totalMB}MB exceeds the 40MB ceiling`);
  process.exit(1);
}
