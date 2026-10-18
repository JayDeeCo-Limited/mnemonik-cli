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
 * What ships to a user: deterministic `.wasm.gz` and `.tags.scm` files, committed
 * here and published inside @mnemonik/shared. A user's install therefore pulls
 * no grammar package, runs no postinstall, needs no compiler, and fetches
 * nothing at runtime - which is the whole reason this plan chose WebAssembly
 * over the native bindings.
 *
 * Run: npx tsx packages/shared/scripts/vendor-grammars.ts [--check | --only=<id>[,<id>...]]
 *   JSX repair: run --only=javascript and --only=tsx; other assets stay untouched.
 *   --check  verify every manifest entry is present and non-empty; write nothing.
 *            This is what CI should run to catch a grammar that silently stopped
 *            shipping an artifact.
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { Language, Parser, Query } from 'web-tree-sitter';
import { AST_LANGUAGE_IDS, QUERY_CHAIN, grammarArtifactBasename } from '../src/ast/grammars.js';

const WASM_DIR = fileURLToPath(new URL('../wasm/', import.meta.url));
/** Local queries for missing or unsuitable upstream declaration captures. */
const OURS_DIR = fileURLToPath(new URL('../queries/', import.meta.url));

interface GrammarSpec {
  /** Vendored artifact basename, and the id the registry keys on. */
  id: string;
  /** npm package/source archive, or the pinned ObjC++ source repository. */
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
   * maintain when the upstream query is absent or captures unsuitable ranges.
   */
  tags: 'upstream' | 'ours' | 'inherited';
  /** Compile committed source, regenerating only obsolete parser ABIs. */
  build?: 'source' | 'regenerate';
  /** Copy the source license alongside new grammar artifacts. */
  licenseFile?: string;
}

/**
 * The vendored set. Deliberately explicit rather than globbed: a glob would
 * quietly produce a smaller language set when a package changes its layout,
 * and losing a language is exactly the silent degradation this plan exists to
 * remove.
 *
 * Markdown retains its document-header chunker. Svelte component parsing is
 * owned by its adapter; it does not need another tree-sitter WASM.
 */
const GRAMMARS: GrammarSpec[] = [
  // fwcd MIT 0.3.8, e1a2d5ad1f61f5740677183cd4125bb071cd2f30, ABI 14.
  {
    id: 'kotlin',
    pkg: 'tree-sitter-kotlin@0.3.8',
    tags: 'ours',
    build: 'source',
    licenseFile: 'LICENSE',
  },
  // UserNobody14 ISC 1.0.0, 53485a8f301254e19c518aa20c80f1bcf7cf5c62.
  // Rebuild ABI-14 source: its published WASM has obsolete dynamic-link metadata.
  {
    id: 'dart',
    pkg: 'tree-sitter-dart@1.0.0',
    tags: 'ours',
    build: 'source',
    licenseFile: 'LICENSE',
  },
  // WhatsApp Apache-2.0, committed ABI 15. The unscoped npm name is a security holder.
  {
    id: 'erlang',
    pkg: 'https://codeload.github.com/WhatsApp/tree-sitter-erlang/tar.gz/62c82e67b73e13f3ef06e4c8c07ff035a8235d30',
    tags: 'ours',
    build: 'source',
    licenseFile: 'LICENSE',
  },
  // MIT 0.23.1, c30d812bc90827f1a54106a25bc9a6307f5cdcec, packaged ABI 14.
  { id: 'haskell', pkg: 'tree-sitter-haskell@0.23.1', tags: 'ours', licenseFile: 'LICENSE' },
  // MIT 0.24.2, 0cc270ff90ca09c29d0f2f9dec69ddfef55a3eff, packaged ABI 14.
  {
    id: 'ocaml',
    pkg: 'tree-sitter-ocaml@0.24.2',
    wasmFile: 'tree-sitter-ocaml.wasm',
    tags: 'ours',
    licenseFile: 'LICENSE',
  },
  {
    id: 'ocaml_interface',
    pkg: 'tree-sitter-ocaml@0.24.2',
    wasmFile: 'tree-sitter-ocaml_interface.wasm',
    tags: 'ours',
    licenseFile: 'LICENSE',
  },
  // oakmac MIT 0.4.0, 290a67a3368be3847b1dd15327bd3a63f2f671ad; regenerate ABI 9.
  {
    id: 'clojure',
    pkg: 'tree-sitter-clojure@0.4.0',
    tags: 'ours',
    build: 'regenerate',
    licenseFile: 'LICENSE.md',
  },
  // MIT 0.23.1, a8e1262997d5a45520a06cbe1b86c0737d507054, packaged ABI 14.
  { id: 'julia', pkg: 'tree-sitter-julia@0.23.1', tags: 'ours', licenseFile: 'LICENSE' },
  // MIT 2.0.0, 50904961d6a87c5191e611276aa2ecb9d66ca4ff, committed ABI 15.
  {
    id: 'perl',
    pkg: 'tree-sitter-perl@2.0.0',
    tags: 'ours',
    build: 'source',
    licenseFile: 'LICENSE',
  },
  // r-lib MIT 1.3.0, committed ABI 14. The unscoped npm name is a security holder.
  {
    id: 'r',
    pkg: 'https://codeload.github.com/r-lib/tree-sitter-r/tar.gz/58a22794466c0fc15b0d3b40531db751593721e8',
    tags: 'ours',
    build: 'source',
    licenseFile: 'LICENSE',
  },
  // GrayJack BSD-3-Clause 0.2.0, fb8e54448f19f5d78d7cdc664b35bffa8ec48876; regenerate ABI 10.
  {
    id: 'zig',
    pkg: 'tree-sitter-zig@0.2.0',
    tags: 'ours',
    build: 'regenerate',
    licenseFile: 'LICENSE',
  },
  // treywood MIT 0.1.0, committed ABI 14; verified upstream source and license.
  {
    id: 'protobuf',
    pkg: 'https://codeload.github.com/treywood/tree-sitter-proto/tar.gz/e9f6b43f6844bd2189b50a422d4e2094313f6aa3',
    wasmFile: 'tree-sitter-proto.wasm',
    tags: 'ours',
    build: 'source',
    licenseFile: 'LICENSE',
  },
  // bkegley MIT 0.0.1, committed ABI 13; avoid the unrelated ISC npm package.
  {
    id: 'graphql',
    pkg: 'https://codeload.github.com/bkegley/tree-sitter-graphql/tar.gz/5e66e961eee421786bdda8495ed1db045e06b5fe',
    tags: 'ours',
    build: 'regenerate',
    licenseFile: 'LICENSE',
  },
  {
    // Uy Ha 0.7.5, MIT; build the committed ABI-14 source without native dependencies.
    id: 'cmake',
    pkg: 'https://codeload.github.com/uyha/tree-sitter-cmake/tar.gz/58993af75218bc99a1f5a04c832a5937e7c422cb',
    wasmFile: 'tree-sitter-cmake.wasm',
    tags: 'ours',
  },
  {
    // nix-community 0.3.0, MIT; use its committed generated ABI-15 parser unchanged.
    id: 'nix',
    pkg: 'https://codeload.github.com/nix-community/tree-sitter-nix/tar.gz/32c3ce98afdafc2ec9aedf0280a678750f76254c',
    wasmFile: 'tree-sitter-nix.wasm',
    tags: 'ours',
  },
  {
    id: 'typescript',
    pkg: 'tree-sitter-typescript@0.23.2',
    wasmFile: 'tree-sitter-typescript.wasm',
    tags: 'upstream',
  },
  {
    id: 'tsx',
    pkg: 'tree-sitter-typescript@0.23.2',
    wasmFile: 'tree-sitter-tsx.wasm',
    tags: 'inherited',
  },
  { id: 'javascript', pkg: 'tree-sitter-javascript@0.25.0', tags: 'upstream' },
  { id: 'python', pkg: 'tree-sitter-python', tags: 'upstream' },
  { id: 'go', pkg: 'tree-sitter-go', tags: 'upstream' },
  { id: 'java', pkg: 'tree-sitter-java', tags: 'upstream' },
  { id: 'c', pkg: 'tree-sitter-c', tags: 'upstream' },
  // MIT 0.23.4, gitHead f41e1a044c8a84ea9fa8577fdd2eab92ec96de02.
  { id: 'cpp', pkg: 'tree-sitter-cpp@0.23.4', tags: 'upstream' },
  {
    // MIT Objective-C++ 0.1.0; pinned source, not the pure Objective-C npm grammar.
    id: 'objcpp',
    pkg: 'https://tangled.org/dunkirk.sh/dots',
    wasmFile: 'tree-sitter-objcpp.wasm',
    tags: 'ours',
  },
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
  // MIT 0.25.1, gitHead 801326684a26ffc4e749bb016c50c6c30bdfa345.
  { id: 'bash', pkg: 'tree-sitter-bash@0.25.1', tags: 'ours' },
  {
    // Upstream MIT 0.4.1, gitHead 816840c592ab973500ae9750763c707b447e7fef; shipped ABI-15 WASM.
    id: 'lua',
    pkg: '@tree-sitter-grammars/tree-sitter-lua@0.4.1',
    wasmFile: 'tree-sitter-lua.wasm',
    tags: 'upstream',
  },
  {
    // Apache-2.0 v1.2.0, gitHead fad991865fee927dd1de5e172fb3f08ac674d914; packaged ABI-14 WASM.
    id: 'terraform',
    pkg: '@tree-sitter-grammars/tree-sitter-hcl@1.2.0',
    wasmFile: 'tree-sitter-terraform.wasm',
    tags: 'ours',
  },
  // MIT 0.1.2, gitHead 70efb0b9b50f95bcbd89dcfd42b275e0304e10cf.
  { id: 'groovy', pkg: 'tree-sitter-groovy@0.1.2', tags: 'ours' },
  { id: 'powershell', pkg: 'tree-sitter-powershell', tags: 'ours' },
  {
    id: 'swift',
    // Upstream 0.7.3, MIT. Pin source, not an opaque workflow WASM.
    pkg: 'https://codeload.github.com/alex-pinkus/tree-sitter-swift/tar.gz/b8b22bffbb3441780e6471665bacfb263741c86a',
    wasmFile: 'tree-sitter-swift.wasm',
    tags: 'ours',
  },
  {
    id: 'sql',
    // @derekstride/tree-sitter-sql 0.3.11 gitHead, MIT; source includes the external scanner.
    pkg: 'https://codeload.github.com/derekstride/tree-sitter-sql/tar.gz/7b51ecda191d36b92f5a90a8d1bc3faef1c7b8b8',
    wasmFile: 'tree-sitter-sql.wasm',
    tags: 'ours',
  },
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
    const wasm = join(WASM_DIR, `${spec.id}.wasm.gz`);
    if (!existsSync(wasm) || statSync(wasm).size === 0) {
      problems.push({ id: spec.id, detail: `missing or empty ${spec.id}.wasm` });
      continue;
    }

    let language: Language;
    try {
      language = await Language.load(gunzipSync(readFileSync(wasm)));
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

/**
 * Repair demonstrated syntax omissions in pinned 0.23.2 without changing source positions.
 * Keep contextual names and type-only forms distinct from runtime calls; retain
 * expression ambiguity through explicit GLR conflicts instead of guessing.
 * Source: https://github.com/tree-sitter/tree-sitter-typescript/tree/v0.23.2
 * MIT; CLI 0.24.4 uses emscripten/emsdk:3.1.64 for the WASM build.
 */
function rebuildTypescript(dir: string, work: string, only?: string): void {
  const grammarPath = join(dir, 'common', 'define-grammar.js');
  let grammar = readFileSync(grammarPath, 'utf8');
  for (const [before, after] of [
    [
      '      _reserved_identifier: (_, previous) => choice(',
      "      _reserved_identifier: (_, previous) => choice(\n        'unique',\n        'as',",
    ],
    ['      [$.call_expression, $._type_query_call_expression],\n', ''],
    [
      '    conflicts: ($, previous) => previous.concat([',
      '    conflicts: ($, previous) => previous.concat([\n      [$.call_expression, $._type_query_call_expression],\n      [$.primary_expression, $.arrow_function, $.method_definition],',
    ],
    [
      "          field('type_arguments', optional($.type_arguments)),\n          field('arguments', $.arguments),",
      "          field('type_arguments', optional($.type_arguments)),\n          field('arguments', choice($.arguments, $.template_string)),",
    ],
    [
      "      type_parameter: $ => seq(\n        optional('const'),\n        field('name', $._type_identifier),",
      "      type_parameter: $ => seq(\n        optional(choice('const', 'in', 'out', seq('in', 'out'))),\n        field('name', choice($._type_identifier, alias('out', $.type_identifier))),",
    ],
    [
      '          $.export_clause,\n          optional($._from_clause),',
      "          choice(\n            seq($.export_clause, optional($._from_clause)),\n            seq(choice('*', $.namespace_export), $._from_clause),\n          ),",
    ],
    [
      "            choice(',', $._semicolon),\n            choice(",
      "            choice(',', $._semicolon, $._function_signature_automatic_semicolon),\n            choice(",
    ],
    [
      "      mapped_type_clause: $ => seq(\n        field('name', $._type_identifier),",
      "      mapped_type_clause: $ => seq(\n        field('name', choice($._type_identifier, alias('type', $.type_identifier))),",
    ],
    [
      '          alias($._template_chars, $.string_fragment),\n          $.template_type,',
      '          alias($._template_chars, $.string_fragment),\n          $.escape_sequence,\n          $.template_type,',
    ],
    [
      "          field('name', choice($.identifier, $._destructuring_pattern)),",
      "          field('name', choice($.identifier, alias('as', $.identifier), $._destructuring_pattern)),",
    ],
  ] as const) {
    if (!grammar.includes(before)) throw new Error('TypeScript grammar patch no longer applies');
    grammar = grammar.replace(before, after);
  }
  // Import types are primary types, so postfix [] applies without changing their expression aliases.
  const importTypes = `        prec(-1, alias($._type_query_member_expression_in_type_annotation, $.member_expression)),
        prec(-1, alias($._type_query_call_expression_in_type_annotation, $.call_expression)),
`;
  const exportSpecifier = `      export_specifier: (_, previous) => seq(
        optional(choice('type', 'typeof')),
        previous,
      ),`;
  if (
    !grammar.includes(importTypes) ||
    !grammar.includes(exportSpecifier) ||
    !grammar.includes('      primary_type: $ => choice(')
  )
    throw new Error('TypeScript import-type/export patch no longer applies');
  grammar = grammar
    .replace(importTypes, '')
    .replace(
      '      primary_type: $ => choice(',
      '      primary_type: $ => choice(\n' + importTypes.trimEnd()
    );
  grammar = grammar.replace(
    exportSpecifier,
    `      export_specifier: $ => seq(
        optional(choice('type', 'typeof')),
        field('name', choice($._module_export_name, alias('type', $.identifier))),
        optional(seq('as', field('alias', $._module_export_name))),
      ),`
  );
  writeFileSync(grammarPath, grammar);
  const scannerPath = join(dir, 'common', 'scanner.h');
  let scanner = readFileSync(scannerPath, 'utf8');
  const before = "        case '<':\n";
  if (!scanner.includes(before))
    throw new Error('TypeScript generic-overload ASI patch no longer applies');
  scanner = scanner
    .replace(before, '')
    .replace(
      "        case '{':",
      "        case '<':\n            // Only type-member/signature boundaries may precede a new generic overload.\n            return valid_symbols[FUNCTION_SIGNATURE_AUTOMATIC_SEMICOLON] && !valid_symbols[LOGICAL_OR];\n\n        case '{':"
    );
  const inBoundary =
    '            if (!iswalpha(lexer->lookahead)) {\n                return false;\n            }';
  if (!scanner.includes(inBoundary))
    throw new Error('TypeScript in-property ASI patch no longer applies');
  scanner = scanner.replace(
    inBoundary,
    '            if (!iswalpha(lexer->lookahead)) {\n                return !valid_symbols[LOGICAL_OR];\n            }'
  );
  const optionalTuple =
    "lexer->lookahead == ':' || lexer->lookahead == ')' || lexer->lookahead == ','";
  if (!scanner.includes(optionalTuple))
    throw new Error('TypeScript optional-tuple patch no longer applies');
  scanner = scanner.replace(optionalTuple, optionalTuple + " || lexer->lookahead == ']'");
  writeFileSync(scannerPath, scanner);
  // Retain our type/enum declaration captures when the vendor loop copies the query.
  copyFileSync(join(WASM_DIR, 'typescript.tags.scm'), join(dir, 'queries', 'tags.scm'));
  const tools = join(work, 'typescript-build');
  execFileSync('npm', [
    'install',
    '--prefix',
    tools,
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
    'tree-sitter-cli@0.24.4',
    'tree-sitter-javascript@0.23.1',
  ]);
  const cli = join(tools, 'node_modules', '.bin', 'tree-sitter');
  for (const dialect of ['typescript', 'tsx']) {
    if (only && !only.split(',').includes(dialect)) continue;
    // Apply the JSX scanner and attribute repairs only to TSX.
    if (dialect === 'tsx') {
      patchJsxScanner(join(dir, 'common', 'scanner.h'));
      patchJsxAttributes(join(tools, 'node_modules', 'tree-sitter-javascript', 'grammar.js'));
    }
    const options = {
      cwd: join(dir, dialect),
      env: { ...process.env, NODE_PATH: join(tools, 'node_modules') },
    };
    execFileSync(cli, ['generate'], options);
    execFileSync(
      cli,
      ['build', '--wasm', '--docker', '--output', join(dir, `tree-sitter-${dialect}.wasm`)],
      options
    );
    chmodSync(join(dir, `tree-sitter-${dialect}.wasm`), 0o644);
  }
}

/** Upstream f8637eb: preserve entity boundaries while accepting bare JSX ampersands. */
function patchJsxScanner(scannerPath: string): void {
  execFileSync('patch', ['--batch', scannerPath], {
    input: readFileSync(new URL('./jsx-bare-ampersand.patch', import.meta.url)),
  });
}

/** Bare attribute ampersands are fragments; complete entity tokens retain precedence. */
function patchJsxAttributes(grammarPath: string): void {
  let grammar = readFileSync(grammarPath, 'utf8');
  for (const [before, after] of [
    [
      'alias($.unescaped_double_jsx_string_fragment, $.string_fragment),',
      "alias($.unescaped_double_jsx_string_fragment, $.string_fragment),\n          alias(token.immediate(prec(-1, '&')), $.string_fragment),",
    ],
    [
      'alias($.unescaped_single_jsx_string_fragment, $.string_fragment),',
      "alias($.unescaped_single_jsx_string_fragment, $.string_fragment),\n          alias(token.immediate(prec(-1, '&')), $.string_fragment),",
    ],
    ['/([^"&]|&[^#A-Za-z])+/', '/[^"&]+/'],
    ["/([^'&]|&[^#A-Za-z])+/", "/[^'&]+/"],
  ] as const) {
    if (!grammar.includes(before)) throw new Error('JSX attribute patch no longer applies');
    grammar = grammar.replace(before, after);
  }
  writeFileSync(grammarPath, grammar);
}

/** 0.25.0's reserved-word DSL needs generator 0.25.8; keep the existing WASM build tool. */
function rebuildJavascript(dir: string, work: string): void {
  patchJsxScanner(join(dir, 'src', 'scanner.c'));
  patchJsxAttributes(join(dir, 'grammar.js'));
  const generator = join(work, 'javascript-generator');
  execFileSync('npm', [
    'install',
    '--prefix',
    generator,
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
    'tree-sitter-cli@0.25.8',
  ]);
  execFileSync(join(generator, 'node_modules', '.bin', 'tree-sitter'), ['generate'], { cwd: dir });
  const tools = join(work, 'javascript-build');
  execFileSync('npm', [
    'install',
    '--prefix',
    tools,
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
    'tree-sitter-cli@0.24.4',
  ]);
  // CLI 0.24.4 pins emscripten/emsdk:3.1.64 for --docker.
  execFileSync(
    join(tools, 'node_modules', '.bin', 'tree-sitter'),
    ['build', '--wasm', '--docker', '--output', join(dir, 'tree-sitter-javascript.wasm')],
    { cwd: dir }
  );
}

/** Same CLI/emsdk as the repaired TS grammars; no native binding or grammar dependency. */
function rebuildSwift(dir: string, work: string): void {
  // A double optional marker must be adjacent to its type. The external ?? token
  // skips whitespace, swallowing `as? Int ?? 0` into optional_type and rejecting 0.
  const grammarPath = join(dir, 'grammar.js');
  const grammar = readFileSync(grammarPath, 'utf8');
  const before = '              alias($._nil_coalescing_operator, "??")';
  if (!grammar.includes(before)) throw new Error('Swift optional-marker patch no longer applies');
  // Keep a conditional's braces outside nested `try await`, just as for direct calls.
  const awaited =
    '              prec.left(0, $.call_expression),\n              // Similarly special case';
  if (!grammar.includes(awaited)) throw new Error('Swift try-await patch no longer applies');
  const conflict = '    [$.try_expression, $._expression],';
  if (!grammar.includes(conflict))
    throw new Error('Swift try-await conflict patch no longer applies');
  writeFileSync(
    grammarPath,
    grammar
      .replace(before, '              token.immediate("??")')
      .replace(
        awaited,
        '              prec.left(0, $.call_expression),\n              prec.left(0, $.await_expression),\n              // Similarly special case'
      )
      .replace(conflict, conflict + '\n    [$.try_expression, $._primary_expression],')
  );
  const scannerPath = join(dir, 'src', 'scanner.c');
  const scanner = readFileSync(scannerPath, 'utf8');
  const continuation =
    '    // Let\'s consume operators that can live after a "semicolon" style newline.';
  if (!scanner.includes(continuation))
    throw new Error('Swift multiplication patch no longer applies');
  writeFileSync(
    scannerPath,
    scanner.replace(
      continuation,
      `    // A whitespace-delimited multiplication operator continues the preceding expression.
    // Keep mark_end before '*' so a non-binary spelling can still emit the newline.
    if (ws_directive == CONTINUE_PARSING_TOKEN_FOUND && lookahead == '*') {
        lexer->advance(lexer, false);
        if (iswspace(lexer->lookahead)) return STOP_PARSING_NOTHING_FOUND;
    }

${continuation}`
    )
  );
  const tools = join(work, 'swift-build');
  execFileSync('npm', [
    'install',
    '--prefix',
    tools,
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
    'tree-sitter-cli@0.24.4',
  ]);
  const cli = join(tools, 'node_modules', '.bin', 'tree-sitter');
  execFileSync(cli, ['generate'], { cwd: dir });
  // CLI 0.24.4 pins emscripten/emsdk:3.1.64 for --docker.
  execFileSync(
    cli,
    ['build', '--wasm', '--docker', '--output', join(dir, 'tree-sitter-swift.wasm')],
    { cwd: dir }
  );
  copyFileSync(join(dir, 'LICENSE'), join(WASM_DIR, 'swift.LICENSE'));
}

/** Build committed generated C without installing the dots repository or its grammar ancestors. */
function vendorObjcpp(work: string, repository: string): string {
  const root = join(work, 'objcpp-source');
  mkdirSync(root);
  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: root });
  };
  git(['init', '--quiet']);
  git(['remote', 'add', 'origin', repository]);
  git(['config', 'remote.origin.promisor', 'true']);
  git(['config', 'remote.origin.partialclonefilter', 'blob:none']);
  git(['sparse-checkout', 'set', '--no-cone', '/LICENSE.md', '/packages/tree-sitter-objcpp/']);
  git([
    'fetch',
    '--quiet',
    '--depth=1',
    '--filter=blob:none',
    'origin',
    '8c861a98d84c6325a0300ec88dfa334aa6ab150e',
  ]);
  git(['checkout', '--quiet', '--detach', 'FETCH_HEAD']);
  const dir = join(root, 'packages', 'tree-sitter-objcpp');
  const grammarPath = join(dir, 'grammar.js');
  let grammar = readFileSync(grammarPath, 'utf8');
  const before = '    _objc_implementation_item: $ => choice(\n';
  if (!grammar.includes(before))
    throw new Error('Objective-C++ macro-body patch no longer applies');
  grammar = grammar.replace(
    before,
    "    objc_macro_body: $ => seq($.objc_macro_invocation, field('body', $.compound_statement)),\n\n" +
      before +
      '      $.objc_macro_body,\n'
  );
  writeFileSync(grammarPath, grammar);
  const tools = join(work, 'objcpp-build');
  execFileSync('npm', [
    'install',
    '--prefix',
    tools,
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
    'tree-sitter-cli@0.24.4',
    // Match the pinned source's lockfile; these are grammar sources, never runtime dependencies.
    'tree-sitter-c@0.23.6',
    'tree-sitter-cpp@0.23.4',
  ]);
  const cli = join(tools, 'node_modules', '.bin', 'tree-sitter');
  execFileSync(cli, ['generate'], {
    cwd: dir,
    env: { ...process.env, NODE_PATH: join(tools, 'node_modules') },
  });
  execFileSync(
    cli,
    ['build', '--wasm', '--docker', '--output', join(dir, 'tree-sitter-objcpp.wasm')],
    { cwd: dir }
  );
  writeFileSync(
    join(WASM_DIR, 'objcpp.LICENSE'),
    readFileSync(join(root, 'LICENSE.md'), 'utf8').replace(/[\u201c\u201d]/g, '"') +
      '\nInherited C/C++ parser and scanner portions: Copyright (c) 2014 Max Brunsfeld.\nThe MIT grant and conditions above apply to these portions too.\n'
  );
  return dir;
}

/** Upstream package.json pins CLI 0.24.7. SQL function bodies only, not general PL/pgSQL. */
function rebuildSql(dir: string, work: string): void {
  const grammarPath = join(dir, 'grammar.js');
  let grammar = readFileSync(grammarPath, 'utf8');
  const patch = (before: string, after: string): void => {
    if (!grammar.includes(before)) throw new Error(`SQL patch no longer applies: ${before}`);
    grammar = grammar.replace(before, after);
  };
  // Bounded repairs demonstrated by migrations 289/279/283 and the escaped-name regression.
  const constraint = `    _constraint_literal: $ => seq(
      $.keyword_constraint,
      field('name', $.identifier),
      choice(`;
  patch(constraint, constraint + '\n        $._key_constraint,');
  patch('_double_quote_string: _ => /"[^"]*"/', '_double_quote_string: _ => /"([^"]|"")*"/');
  patch(
    'wrapped_in_parenthesis($.binary_expression)\n    ),\n\n    _default_expression',
    'wrapped_in_parenthesis($._expression)\n    ),\n\n    _default_expression'
  );
  patch(
    'field("custom_type", $.object_reference)',
    'seq(field("custom_type", $.object_reference), optional(wrapped_in_parenthesis($._natural_number)))'
  );
  patch(
    `      $.keyword_conflict,
      seq(`,
    `      $.keyword_conflict,
      optional($._column_list),
      seq(`
  );
  patch(
    `              $.keyword_brin
            ),`,
    `              $.keyword_brin,
              $.identifier
            ),`
  );
  patch(
    `        $.index_fields
      ),`,
    `        $.index_fields
      ),
      optional($.storage_parameters),`
  );
  patch(
    `        $.drop_function,
      ),`,
    `        $.drop_function,
        $.drop_trigger,
      ),`
  );
  patch(
    '    drop_table: $ => seq(',
    `    drop_trigger: $ => seq(
      $.keyword_drop, $.keyword_trigger, optional($._if_exists),
      $.identifier, $.keyword_on, $.object_reference, optional($._drop_behavior),
    ),

    drop_table: $ => seq(`
  );
  // Only the policy clauses and RLS action observed in the four fixed PostgreSQL migrations.
  patch('        $.create_trigger,', '        $.create_trigger,\n        $.create_policy,');
  patch(
    '    _alter_specifications: $ => choice(',
    `    _alter_specifications: $ => choice(
      seq(make_keyword("enable"), $.keyword_row, $.keyword_level, $.keyword_security),`
  );
  patch(
    '    create_table: $ => prec.left(',
    `    policy_relation: $ => $.object_reference,
    create_policy: $ => seq(
      $.keyword_create, make_keyword("policy"), field('name', $.identifier),
      $.keyword_on, alias($.policy_relation, $.relation),
      optional(seq($.keyword_for, choice($.keyword_select, $.keyword_insert, $.keyword_update, $.keyword_delete))),
      optional(seq($.keyword_to, comma_list($.identifier, true))),
      optional(seq($.keyword_using, wrapped_in_parenthesis($._expression))),
      optional(seq($.keyword_with, $.keyword_check, wrapped_in_parenthesis($._expression))),
    ),
    create_table: $ => prec.left(`
  );
  // These stored migrations use qualified enum names and table/sequence grants.
  patch(
    `    alter_type: $ => seq(
      $.keyword_alter,
      $.keyword_type,
      $.identifier,`,
    `    alter_type: $ => seq(
      $.keyword_alter,
      $.keyword_type,
      $.object_reference,`
  );
  patch('      $.reset_statement,', '      $.reset_statement,\n      $.grant_statement,');
  patch(
    '    _cte: $ => seq(',
    `    grant_statement: $ => seq(
      make_keyword("grant"),
      comma_list(choice($.keyword_select, $.keyword_insert, $.keyword_update, $.keyword_delete, make_keyword("usage")), true),
      $.keyword_on, optional($.keyword_sequence), comma_list($.object_reference, true),
      $.keyword_to, comma_list($.identifier, true),
    ),

    _cte: $ => seq(`
  );
  // Dollar-quoted procedural code is one literal, never a parsed SQL statement list.
  patch('      $.reset_statement,', '      $.reset_statement,\n      $.do_statement,');
  patch(
    '    _cte: $ => seq(',
    `    do_statement: $ => seq($.keyword_do, alias($._dollar_quoted_string, $.literal)),

    _cte: $ => seq(`
  );
  // Keep both parses until NOT NULL (constraint) or NOT LIKE (expression) is known.
  // Match _expression's precedence so it cannot discard the completed default first.
  patch(
    '    _inner_default_expression: $ => choice(',
    '    _inner_default_expression: $ => prec(1, choice('
  );
  patch(
    'alias($.implicit_cast, $.cast),\n    ),\n\n    constraints:',
    'alias($.implicit_cast, $.cast),\n    )),\n\n    constraints:'
  );
  patch(
    '  conflicts: $ => [',
    '  conflicts: $ => [\n    [$._expression, $._inner_default_expression],\n    [$.create_function],'
  );
  // Fixed R2 cohort: change individual upstream rules, retaining the scanner and AST names.
  const patchRule = (name: string, before: string, after: string): void => {
    const start = grammar.indexOf(`    ${name}:`);
    if (start < 0) throw new Error(`SQL rule missing: ${name}`);
    const next = grammar.slice(start + 1).search(/^    [a-zA-Z_]\w*\s*:/m);
    const end = next < 0 ? grammar.length : start + 1 + next;
    const rule = grammar.slice(start, end);
    if (!rule.includes(before)) throw new Error(`SQL ${name} patch no longer applies`);
    grammar = grammar.slice(0, start) + rule.replace(before, after) + grammar.slice(end);
  };
  patchRule('_type', 'prec.left(', 'prec.right(');
  patchRule('array_size_definition', 'prec.left(', 'prec.right(');
  patchRule(
    '_type',
    '$.keyword_geography,',
    `seq($.keyword_geography, optional(wrapped_in_parenthesis(
            seq($.identifier, optional(seq(',', $._natural_number)))
          ))),`
  );
  patchRule(
    '_column_constraint',
    '$.keyword_auto_increment,',
    `choice($.keyword_auto_increment, make_keyword("autoincrement")),`
  );
  patchRule('function_argument', '$.literal,', '$._expression,');
  patchRule(
    '_inner_default_expression',
    '$.keyword_current_timestamp,',
    `$.keyword_current_timestamp,
        make_keyword("current_date"),`
  );
  patchRule('create_policy', '$.keyword_delete))),', '$.keyword_delete, $.keyword_all))),');
  patchRule(
    '_create_statement',
    '$.create_function,',
    'alias($.create_procedure, $.create_function),\n        $.create_function,'
  );
  patchRule(
    '_drop_statement',
    '$.drop_function,',
    '$.drop_function,\n        $.drop_procedure,\n        $.drop_policy,'
  );
  patchRule('_alter_statement', '$.alter_type,', '$.alter_type,\n        $.alter_policy,');
  patchRule(
    'drop_function',
    '$.object_reference,',
    '$.object_reference,\n      optional($.function_arguments),'
  );
  patchRule('drop_index', 'field("name", $.identifier)', 'field("name", $.object_reference)');
  patchRule(
    'alter_column',
    "field('type', $._type),",
    "field('type', $._type),\n          optional(seq($.keyword_using, $._expression)),"
  );
  patchRule(
    'add_constraint',
    '$.constraint,',
    '$.constraint,\n      optional(seq($.keyword_not, make_keyword("valid"))),'
  );
  patchRule(
    '_alter_specifications',
    '$.set_schema,',
    `$.set_schema,
      seq(make_keyword("validate"), $.keyword_constraint, $.identifier),
      seq($.keyword_rename, $.keyword_constraint, $.identifier, $.keyword_to, $.identifier),
      seq($.keyword_set, paren_list(seq($.identifier, '=', $.literal), true)),
      seq($.keyword_reset, paren_list($.identifier, true)),`
  );
  patchRule(
    '_table_settings',
    '$.table_partition,',
    `seq($.keyword_on, $.keyword_commit, $.keyword_drop),
      $.table_partition,`
  );
  patchRule(
    'create_index',
    '$.index_fields',
    `$.index_fields,
        optional(seq(make_keyword("include"), paren_list($.identifier, true)))`
  );
  patchRule(
    'transaction',
    "      optional(';'),",
    `      optional(choice(
        seq($.keyword_read, $.keyword_only),
        seq($.keyword_isolation, $.keyword_level, $.keyword_repeatable, $.keyword_read)
      )),
      optional(';'),`
  );
  patchRule(
    'limit',
    '$.literal,',
    'choice($.literal, $.parameter, alias($._qualified_field, $.field)),'
  );
  patchRule(
    'offset',
    '$.literal,',
    'choice($.literal, $.parameter, alias($._qualified_field, $.field)),'
  );
  patchRule(
    'statement',
    `        optional($.keyword_analyze),
        optional($.keyword_verbose),`,
    `        choice(
          seq(optional($.keyword_analyze), optional($.keyword_verbose)),
          paren_list(seq(choice($.identifier, $.keyword_analyze, $.keyword_verbose),
            optional(choice($.keyword_on, $.keyword_off, $.keyword_true, $.keyword_false))), true)
        ),`
  );
  patchRule(
    '_ddl_statement',
    '$.reset_statement,',
    `$.reset_statement,
      $.revoke_statement,
      $.alter_default_privileges,
      $.analyze_statement,
      $.lock_statement,
      $.prepare_statement,
      $.execute_statement,
      $.call_statement,`
  );
  patchRule(
    '_delete_from',
    '$.object_reference,',
    `$.object_reference,
      optional($._alias),
      optional(seq($.keyword_using, comma_list($.relation, true))),`
  );
  patchRule(
    'cte',
    'choice($._dml_read, $._dml_write)',
    'choice($._dml_read, $._dml_write, $.values)'
  );
  patchRule(
    '_on_conflict',
    'optional($._column_list),',
    'optional(seq(paren_list($._expression, true), optional($.where))),'
  );
  patchRule('from', `comma_list($.relation, true),`, '$.relation,');
  patchRule(
    'from',
    `          $.join,`,
    `          seq(',', $.relation),
          $.join,`
  );
  patchRule('from', '      optional($.order_by),\n      optional($.limit),', '');
  patchRule(
    '_select_statement',
    '        optional($.from),',
    `        optional($.from),
        optional($.order_by),
        optional($.limit),`
  );
  patchRule(
    'set_operation',
    `      ),\n    ),`,
    `      ),
      optional($.order_by),
      optional($.limit),
    ),`
  );
  patchRule('op_other', "        '<->',", "        '<->',\n        '<=>',");
  patchRule('_expression', '$.interval,', '$.interval,\n        $.at_time_zone,');
  const support = '          $.function_support,\n';
  if (grammar.split(support).length !== 3) throw new Error('SQL function options changed');
  grammar = grammar.replaceAll(support, support + '          $.function_configuration,\n');
  patchRule(
    'grant_statement',
    `comma_list(choice($.keyword_select, $.keyword_insert, $.keyword_update, $.keyword_delete, make_keyword("usage")), true),
      $.keyword_on, optional($.keyword_sequence), comma_list($.object_reference, true),`,
    `$._privilege_list,
      $.keyword_on, $._privilege_target,`
  );
  patch(
    '    _cte: $ => seq(',
    `    _privilege_list: $ => comma_list(choice(
      $.keyword_select, $.keyword_insert, $.keyword_update, $.keyword_delete,
      make_keyword("usage"), make_keyword("execute"), make_keyword("truncate"),
      seq($.keyword_all, optional(make_keyword("privileges")))
    ), true),
    routine_signature: $ => seq($.object_reference, optional($.function_arguments)),
    _privilege_target: $ => choice(
      seq($.keyword_function, comma_list($.routine_signature, true)),
      seq($.keyword_schema, comma_list($.identifier, true)),
      seq($.keyword_all, choice(make_keyword("tables"), make_keyword("sequences"), make_keyword("functions")),
        $.keyword_in, $.keyword_schema, comma_list($.identifier, true)),
      seq(optional(choice($.keyword_table, $.keyword_sequence)), comma_list($.object_reference, true))
    ),
    revoke_statement: $ => seq(make_keyword("revoke"), $._privilege_list, $.keyword_on,
      $._privilege_target, $.keyword_from, comma_list($.identifier, true)),
    alter_default_privileges: $ => seq(
      $.keyword_alter, $.keyword_default, make_keyword("privileges"),
      optional(seq($.keyword_for, $.keyword_role, comma_list($.identifier, true))),
      optional(seq($.keyword_in, $.keyword_schema, comma_list($.identifier, true))),
      choice(
        seq(make_keyword("grant"), $._privilege_list, $.keyword_on,
          choice(make_keyword("tables"), make_keyword("sequences"), make_keyword("functions")),
          $.keyword_to, comma_list($.identifier, true)),
        seq(make_keyword("revoke"), $._privilege_list, $.keyword_on,
          choice(make_keyword("tables"), make_keyword("sequences"), make_keyword("functions")),
          $.keyword_from, comma_list($.identifier, true))
      )
    ),
    drop_policy: $ => seq($.keyword_drop, make_keyword("policy"), optional($._if_exists),
      $.identifier, $.keyword_on, alias($.policy_relation, $.relation)),
    alter_policy: $ => seq($.keyword_alter, make_keyword("policy"), $.identifier,
      $.keyword_on, alias($.policy_relation, $.relation), $.keyword_rename, $.keyword_to, $.identifier),
    function_configuration: $ => seq($.keyword_set, $.object_reference,
      choice(seq($.keyword_from, make_keyword("current")),
        seq(choice('=', $.keyword_to), comma_list(choice($.literal, $.identifier), true)))),
    _procedure_option: $ => choice($.function_security, $.function_configuration),
    create_procedure: $ => seq(
      $.keyword_create, optional($._or_replace), $.keyword_procedure,
      $.object_reference, $.function_arguments, repeat($._procedure_option),
      choice(
        seq($.function_language, repeat($._procedure_option), alias($.opaque_function_body, $.function_body)),
        seq(alias($.opaque_function_body, $.function_body), repeat($._procedure_option), $.function_language)
      ), repeat($._procedure_option)
    ),
    drop_procedure: $ => seq($.keyword_drop, $.keyword_procedure, optional($._if_exists),
      $.routine_signature, optional($._drop_behavior)),
    call_statement: $ => seq(make_keyword("call"), $.invocation),
    analyze_statement: $ => seq($.keyword_analyze, $.object_reference, optional(paren_list($.identifier, true))),
    lock_statement: $ => seq(make_keyword("lock"), $.keyword_table, comma_list($.object_reference, true),
      $.keyword_in, choice(seq(make_keyword("share"), $.keyword_row, make_keyword("exclusive")),
        seq(make_keyword("access"), make_keyword("exclusive"))), make_keyword("mode")),
    prepare_statement: $ => seq(make_keyword("prepare"), $.identifier,
      optional(paren_list($._type, true)), $.keyword_as, choice($._dml_read, $._dml_write)),
    execute_statement: $ => seq(make_keyword("execute"), $.identifier, optional(paren_list($._expression))),
    at_time_zone: $ => prec.left('binary_times', seq($._expression,
      make_keyword("at"), make_keyword("time"), make_keyword("zone"), $._expression)),

    _cte: $ => seq(`
  );
  const functionStart = grammar.indexOf('    create_function: $ => seq(');
  const functionEnd = grammar.indexOf('    _function_return:', functionStart);
  if (functionStart < 0 || functionEnd < 0) throw new Error('SQL function patch no longer applies');
  const original = grammar.slice(functionStart, functionEnd).trimEnd();
  const languageOption = '          $.function_language,\n';
  const optionsStart = original.indexOf('      repeat(');
  const optionsEnd = original.indexOf('      // ensure');
  const options = original.slice(optionsStart, optionsEnd).replace(languageOption, '');
  const procedural =
    original.slice(0, optionsStart) +
    options +
    '      alias($.plpgsql_function_language, $.function_language),\n' +
    options +
    '      alias($.opaque_function_body, $.function_body),\n' +
    options +
    '    )';
  patch(
    original,
    procedural.replace('create_function: $ => seq(', 'create_function: $ => choice(prec(1, seq(') +
      '),\n' +
      original.slice(original.indexOf('seq('), -1) +
      '),'
  );
  patch(
    '    $._dollar_quoted_string,\n  ],',
    '    $._dollar_quoted_string,\n    $._trailing_plpgsql_body,\n  ],'
  );
  // Named rules retain complete body/language ranges; aliasing a sequence only names its first token.
  patch(
    '    function_body: $ => choice(',
    `    opaque_function_body: $ => seq(
      $.keyword_as,
      alias(choice($._dollar_quoted_string, $._single_quote_string, $._double_quote_string), $.literal),
    ),
    plpgsql_function_language: $ => seq(
      $.keyword_language, alias(make_keyword("plpgsql"), $.identifier),
    ),
    function_body: $ => choice(
      seq(
        $.keyword_as,
        alias($._dollar_quoted_string_start_tag, $.dollar_quote),
        alias($._trailing_plpgsql_body, $.literal),
        alias($._dollar_quoted_string_end_tag, $.dollar_quote),
      ),`
  );
  const languageStart = grammar.indexOf('    function_language: $ => seq(');
  const languageEnd = grammar.indexOf('    function_volatility:', languageStart);
  if (languageStart < 0 || languageEnd < 0) throw new Error('SQL language patch no longer applies');
  const language = grammar.slice(languageStart, languageEnd);
  patch(
    language,
    language.replace(
      '      $.identifier',
      `      choice(
        $.identifier,
        alias(token(prec(1, seq("'", make_keyword("plpgsql"), "'"))), $.identifier),
      )`
    )
  );
  writeFileSync(grammarPath, grammar);
  const scannerPath = join(dir, 'src', 'scanner.c');
  let scanner = readFileSync(scannerPath, 'utf8');
  const token = '  DOLLAR_QUOTED_STRING\n';
  const start =
    '  if (valid_symbols[DOLLAR_QUOTED_STRING_START_TAG] && state->start_tag == NULL) {';
  if (!scanner.includes(token) || !scanner.includes(start))
    throw new Error('SQL procedural scanner patch no longer applies');
  scanner = scanner.replace(token, '  DOLLAR_QUOTED_STRING,\n  TRAILING_PLPGSQL_BODY\n');
  scanner = scanner.replace(
    start,
    () =>
      `  if (valid_symbols[TRAILING_PLPGSQL_BODY] && state->start_tag != NULL) {
    bool consumed = false;
    for (;;) {
      if (lexer->eof(lexer)) return false;
      if (lexer->lookahead != '$') {
        lexer->advance(lexer, false);
        consumed = true;
        continue;
      }
      lexer->mark_end(lexer);
      char *tag = scan_dollar_string_tag(lexer);
      bool closing = tag != NULL && strcmp(tag, state->start_tag) == 0;
      free(tag);
      if (closing) break;
      consumed = true;
    }
    if (!consumed) return false;
    // Look ahead without moving the marked body end; SQL bodies keep their normal AST.
    while (iswspace(lexer->lookahead)) lexer->advance(lexer, false);
    const char *keyword = "language";
    for (unsigned i = 0; keyword[i]; i++) {
      if (towlower(lexer->lookahead) != keyword[i]) return false;
      lexer->advance(lexer, false);
    }
    while (iswspace(lexer->lookahead)) lexer->advance(lexer, false);
    bool quoted = lexer->lookahead == 39;
    if (quoted) lexer->advance(lexer, false);
    const char *language = "plpgsql";
    for (unsigned i = 0; language[i]; i++) {
      if (towlower(lexer->lookahead) != language[i]) return false;
      lexer->advance(lexer, false);
    }
    if (quoted ? lexer->lookahead != 39 : (iswalnum(lexer->lookahead) || lexer->lookahead == '_' || lexer->lookahead == '$')) return false;
    lexer->result_symbol = TRAILING_PLPGSQL_BODY;
    return true;
  }

` + start
  );
  writeFileSync(scannerPath, scanner);
  const tools = join(work, 'sql-build');
  execFileSync('npm', [
    'install',
    '--prefix',
    tools,
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
    'tree-sitter-cli@0.24.7',
  ]);
  const cli = join(tools, 'node_modules', '.bin', 'tree-sitter');
  execFileSync(cli, ['generate'], { cwd: dir });
  execFileSync(
    cli,
    ['build', '--wasm', '--docker', '--output', join(dir, 'tree-sitter-sql.wasm')],
    { cwd: dir }
  );
  copyFileSync(join(dir, 'LICENSE'), join(WASM_DIR, 'sql.LICENSE'));
}

/** Permit existing dotted property expressions as command-call arguments. */
function rebuildGroovy(dir: string, work: string): void {
  const path = join(dir, 'grammar.js');
  let source = readFileSync(path, 'utf8');
  const before =
    '    _juxt_argument_list: $ => commaSep1(choice($._literal, $.map_item, $.identifier)),';
  if (!source.includes(before)) throw new Error('Groovy argument patch no longer applies');
  source = source.replace(before, before.replace('$.identifier)', '$.identifier, $.field_access)'));
  const conflicts = '  conflicts: ($, original) => original.concat([';
  if (!source.includes(conflicts)) throw new Error('Groovy conflict patch no longer applies');
  source = source.replace(
    conflicts,
    conflicts +
      `
    [$.method_invocation, $._juxt_argument_list],
    [$.generic_type, $._juxt_argument_list],
    [$.primary_expression, $._unannotated_type, $._juxt_argument_list],
    [$._unannotated_type, $._juxt_argument_list],
    [$.primary_expression, $._juxt_argument_list],`
  );
  writeFileSync(path, source);
  const tools = join(work, 'groovy-build');
  execFileSync('npm', [
    'install',
    '--prefix',
    tools,
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
    'tree-sitter-cli@0.24.4',
    'tree-sitter-java@0.23.4',
  ]);
  const cli = join(tools, 'node_modules', '.bin', 'tree-sitter');
  const options = { cwd: dir, env: { ...process.env, NODE_PATH: join(tools, 'node_modules') } };
  execFileSync(cli, ['generate'], options);
  execFileSync(
    cli,
    ['build', '--wasm', '--docker', '--output', join(dir, 'tree-sitter-groovy.wasm')],
    options
  );
  // Upstream publishes its MIT declaration in package.json/grammar.js, with no LICENSE file.
  writeFileSync(
    join(WASM_DIR, 'groovy.LICENSE'),
    'tree-sitter-groovy 0.1.2, by Amaan Qureshi <amaanq12@gmail.com>.\n' +
      'Upstream package.json and grammar.js declare MIT. Source: https://github.com/amaanq/tree-sitter-groovy/tree/70efb0b9b50f95bcbd89dcfd42b275e0304e10cf\n\n' +
      'Inherited tree-sitter-java 0.23.4 (MIT):\n' +
      readFileSync(join(tools, 'node_modules', 'tree-sitter-java', 'LICENSE'), 'utf8')
  );
}

/** Build the official committed Nix parser without installing its native Node binding. */
function rebuildNixOrCmake(dir: string, work: string, id: 'nix' | 'cmake'): void {
  const tools = join(work, `${id}-build`);
  execFileSync('npm', [
    'install',
    '--prefix',
    tools,
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
    'tree-sitter-cli@0.24.4',
  ]);
  // Build the pinned generated source; CLI 0.24.4 pins emscripten/emsdk:3.1.64.
  execFileSync(
    join(tools, 'node_modules', '.bin', 'tree-sitter'),
    ['build', '--wasm', '--docker', '--output', join(dir, `tree-sitter-${id}.wasm`)],
    { cwd: dir }
  );
  copyFileSync(join(dir, 'LICENSE'), join(WASM_DIR, `${id}.LICENSE`));
}

/** The published grammar JSON freezes its C ancestor; add only the two JNI modifier spellings. */
function rebuildCpp(dir: string, work: string): void {
  const path = join(dir, 'src', 'grammar.json');
  const grammar = JSON.parse(readFileSync(path, 'utf8')) as {
    rules: Record<string, { type: string; members: unknown[] }>;
  };
  for (const [name, value] of [
    ['type_qualifier', 'JNIEXPORT'],
    ['ms_call_modifier', 'JNICALL'],
  ] as const) {
    const rule = grammar.rules[name];
    if (!rule || rule.type !== 'CHOICE' || !Array.isArray(rule.members))
      throw new Error(`C++ JNI patch no longer applies: ${name}`);
    rule.members.push({ type: 'STRING', value });
  }
  writeFileSync(path, JSON.stringify(grammar));
  const tools = join(work, 'cpp-build');
  execFileSync('npm', [
    'install',
    '--prefix',
    tools,
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
    'tree-sitter-cli@0.24.4',
  ]);
  const cli = join(tools, 'node_modules', '.bin', 'tree-sitter');
  execFileSync(cli, ['generate', 'src/grammar.json'], { cwd: dir });
  execFileSync(
    cli,
    ['build', '--wasm', '--docker', '--output', join(dir, 'tree-sitter-cpp.wasm')],
    { cwd: dir }
  );
  copyFileSync(join(dir, 'LICENSE'), join(WASM_DIR, 'cpp.LICENSE'));
}

/** A radix value may use $name as well as ${name}; keep the source and expansion node intact. */
function rebuildBash(dir: string, work: string): void {
  const path = join(dir, 'grammar.js');
  const grammar = readFileSync(path, 'utf8');
  const before = 'seq(/-?(0x)?[0-9]+#/, choice($.expansion, $.command_substitution))';
  if (!grammar.includes(before)) throw new Error('Bash radix patch no longer applies');
  writeFileSync(
    path,
    grammar.replace(
      before,
      'seq(/-?(0x)?[0-9]+#/, choice($.simple_expansion, $.expansion, $.command_substitution))'
    )
  );
  const scannerPath = join(dir, 'src', 'scanner.c');
  const scanner = readFileSync(scannerPath, 'utf8');
  const variableScan = `        return false;
    }

    if (valid_symbols[BARE_DOLLAR] && !in_error_recovery(valid_symbols) && scan_bare_dollar(lexer)) {`;
  if (!scanner.includes(variableScan))
    throw new Error('Bash expansion-word patch no longer applies');
  const parenStart = scanner.indexOf(
    "            if (lexer->lookahead == '(' && !(advanced_once || advance_once_space)) {"
  );
  const parenEnd = scanner.indexOf(
    String.raw`            if (lexer->lookahead == '\'') {`,
    parenStart
  );
  const concatParens = "lexer->lookahead == ')' || lexer->lookahead == '('";
  if (parenStart < 0 || parenEnd <= parenStart || !scanner.includes(concatParens))
    throw new Error('Bash literal-parenthesis patch no longer applies');
  // The variable-name scan consumes a default's prefix but rejects | before reaching expansion_word.
  // Inside ${...}, parentheses are word pieces around expansions, not shell groups.
  writeFileSync(
    scannerPath,
    (scanner.slice(0, parenStart) + scanner.slice(parenEnd))
      .replace(
        variableScan,
        "        if (valid_symbols[EXPANSION_WORD] && lexer->lookahead == '|') goto expansion_word;\n\n" +
          variableScan
      )
      .replace(
        concatParens,
        "((lexer->lookahead == ')' || lexer->lookahead == '(') && !valid_symbols[CLOSING_BRACE])"
      )
  );
  const generator = join(work, 'bash-generator');
  execFileSync('npm', [
    'install',
    '--prefix',
    generator,
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
    'tree-sitter-cli@0.25.8',
  ]);
  execFileSync(join(generator, 'node_modules', '.bin', 'tree-sitter'), ['generate'], { cwd: dir });
  const tools = join(work, 'bash-build');
  execFileSync('npm', [
    'install',
    '--prefix',
    tools,
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
    'tree-sitter-cli@0.24.4',
  ]);
  // CLI 0.24.4 pins emscripten/emsdk:3.1.64 for --docker.
  execFileSync(
    join(tools, 'node_modules', '.bin', 'tree-sitter'),
    ['build', '--wasm', '--docker', '--output', join(dir, 'tree-sitter-bash.wasm')],
    { cwd: dir }
  );
}

/** Reuse the existing offline WASM toolchain; never install native grammar bindings. */
function buildPrerequisite(dir: string, work: string, spec: GrammarSpec): void {
  const config = join(dir, 'tree-sitter.json');
  const buildRepositories: Record<string, string> = {
    clojure: 'https://github.com/oakmac/tree-sitter-clojure',
    zig: 'https://github.com/GrayJack/tree-sitter-zig',
    graphql: 'https://github.com/bkegley/tree-sitter-graphql',
  };
  if (!existsSync(config) && buildRepositories[spec.id]) {
    // Old packages omit the build metadata required by the current WASM builder.
    writeFileSync(
      config,
      JSON.stringify({
        grammars: [
          {
            name: spec.id === 'protobuf' ? 'proto' : spec.id,
            scope: `source.${spec.id}`,
            path: '.',
            'file-types': [],
          },
        ],
        metadata: {
          version: (
            JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string }
          ).version,
          license: spec.id === 'zig' ? 'BSD-3-Clause' : 'MIT',
          description: 'Pinned parser WASM build',
          authors: [],
          links: { repository: buildRepositories[spec.id] },
        },
        bindings: {},
      })
    );
  }
  if (spec.id === 'graphql') {
    // The pinned quoted-string rule rejects every escape, including valid GraphQL \n.
    // Keep the upstream block-string rule and all source offsets unchanged.
    const path = join(dir, 'grammar.js');
    const grammar = readFileSync(path, 'utf8');
    const before = String.raw`seq('"', /[^"\\\n]*/, '"')`;
    const after = String.raw`seq('"', /([^"\\\r\n]|\\(["\\/bfnrt]|u[0-9a-fA-F]{4}))*/, '"')`;
    if (!grammar.includes(before)) throw new Error('GraphQL string escape patch no longer applies');
    writeFileSync(path, grammar.replace(before, after));
  }
  if (spec.id === 'zig') {
    const path = join(dir, 'grammar.js');
    const grammar = readFileSync(path, 'utf8');
    const before = '/u{[0-9a-fA-F]+}/';
    if (!grammar.includes(before))
      throw new Error('Zig Unicode escape compatibility patch no longer applies');
    writeFileSync(path, grammar.replace(before, String.raw`/u\{[0-9a-fA-F]+\}/`));
  }
  const tools = join(work, 'prerequisite-build');
  const cli = join(tools, 'node_modules', '.bin', 'tree-sitter');
  if (!existsSync(cli)) {
    execFileSync('npm', [
      'install',
      '--prefix',
      tools,
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      'tree-sitter-cli@0.24.4',
    ]);
  }
  const deadline = Date.now() + 300_000;
  if (spec.build === 'regenerate') {
    execFileSync(cli, ['generate'], { cwd: dir, timeout: 300_000 });
  }
  execFileSync(
    cli,
    [
      'build',
      '--wasm',
      '--docker',
      '--output',
      join(dir, spec.wasmFile ?? `tree-sitter-${spec.id}.wasm`),
    ],
    {
      cwd: dir,
      timeout: Math.max(1, deadline - Date.now()),
    }
  );
}

function vendor(): Problem[] {
  const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice(7);
  const selected = only?.split(',');
  if (selected?.some((id) => !GRAMMARS.some((spec) => spec.id === id)))
    throw new Error(`Unknown grammar: ${only}`);
  mkdirSync(WASM_DIR, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'ts-grammars-'));
  const problems: Problem[] = [];
  // One tarball may serve several ids (typescript + tsx), so fetch each package
  // once and extract from the shared checkout.
  const extracted = new Map<string, string>();

  try {
    for (const spec of GRAMMARS) {
      if (selected && !selected.includes(spec.id)) continue;
      let dir = extracted.get(spec.pkg);
      if (!dir) {
        try {
          if (spec.id === 'objcpp') {
            dir = vendorObjcpp(work, spec.pkg);
          } else {
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
            if (spec.id === 'typescript' || spec.id === 'tsx') rebuildTypescript(dir, work, only);
            if (spec.id === 'javascript') rebuildJavascript(dir, work);
            if (spec.id === 'swift') rebuildSwift(dir, work);
            if (spec.id === 'sql') rebuildSql(dir, work);
            if (spec.id === 'groovy') rebuildGroovy(dir, work);
            if (spec.id === 'cpp') rebuildCpp(dir, work);
            if (spec.id === 'bash') rebuildBash(dir, work);
            if (spec.id === 'nix' || spec.id === 'cmake') rebuildNixOrCmake(dir, work, spec.id);
            if (spec.build) buildPrerequisite(dir, work, spec);
          }
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
        const compressed = gzipSync(readFileSync(wasmSrc), { level: 9 });
        // Timestamp is zero in Node gzip; normalize the OS byte across build hosts too.
        compressed[9] = 255;
        writeFileSync(join(WASM_DIR, `${spec.id}.wasm.gz`), compressed, { mode: 0o644 });
        rmSync(join(WASM_DIR, `${spec.id}.wasm`), { force: true });
        if (spec.licenseFile)
          writeFileSync(
            join(WASM_DIR, `${spec.id}.LICENSE`),
            readFileSync(join(dir, spec.licenseFile), 'utf8')
              .replace(/\r\n/g, '\n')
              .replace(/[\u201c\u201d]/g, '"')
          );
        if (spec.id === 'lua') copyFileSync(join(dir, 'LICENSE.md'), join(WASM_DIR, 'lua.LICENSE'));
        if (spec.id === 'terraform')
          copyFileSync(join(dir, 'LICENSE'), join(WASM_DIR, 'terraform.LICENSE'));
        if (
          spec.id === 'javascript' ||
          spec.id === 'tsx' ||
          spec.id === 'objcpp' ||
          spec.id === 'groovy' ||
          spec.id === 'cpp' ||
          spec.id === 'bash' ||
          spec.id === 'nix' ||
          spec.id === 'cmake'
        )
          chmodSync(join(WASM_DIR, `${spec.id}.wasm.gz`), 0o644);
      }

      // A targeted JS scanner rebuild must retain our module-scope binding query additions.
      if (only === 'javascript') continue;
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

const sizes = GRAMMARS.map((g) => statSync(join(WASM_DIR, `${g.id}.wasm.gz`)).size);
const totalBytes = sizes.reduce((a, b) => a + b, 0);
const inflatedBytes = GRAMMARS.reduce(
  (total, g) => total + gunzipSync(readFileSync(join(WASM_DIR, `${g.id}.wasm.gz`))).length,
  0
);
const totalMB = +(totalBytes / 1048576).toFixed(1);
console.log(
  `VENDOR_GRAMMARS_OK ${JSON.stringify({ grammars: GRAMMARS.length, shippedBytes: totalBytes, inflatedBytes, totalWasmMB: totalMB })}`
);
// Owner-approved Objective-C++ cost: repaired bundle 43.58 MiB (43.67 with Terraform 667475e93), bounded at 45 MiB.
if (totalBytes > 45 * 1048576) {
  console.error(`VENDOR_GRAMMARS_TOO_LARGE ${totalMB}MB exceeds the 45MB ceiling`);
  process.exit(1);
}
