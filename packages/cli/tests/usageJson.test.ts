import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { helpScreen } from '../src/help.js';
import { help, runCli } from '../src/router.js';

// With --json anywhere in the arguments, a usage error is one JSON object on
// stdout and nothing on stderr; without it, the person gets help as before.

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function run(args: string[]) {
  const home = mkdtempSync(join(tmpdir(), 'usage-json-'));
  homes.push(home);
  const stdout = { text: '', write: (chunk: string) => void (stdout.text += chunk) };
  const stderr = { text: '', write: (chunk: string) => void (stderr.text += chunk) };
  const code = await runCli(args, { home, installStateDir: join(home, 'state'), stdout, stderr });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

const cases = [
  {
    args: ['frobnicate'],
    json: {
      status: 'usage_error',
      reason: 'unknown_command',
      command: 'frobnicate',
      action: 'mnemonik --help',
    },
    human: { stderr: help },
  },
  {
    args: ['project'],
    json: {
      status: 'usage_error',
      reason: 'missing_subcommand',
      command: 'project',
      action: 'mnemonik project --help',
    },
    human: { stderr: helpScreen(['project']) },
  },
  {
    args: ['auth', 'logout', '--bogus'],
    json: {
      status: 'usage_error',
      reason: 'invalid_flag',
      command: 'auth logout',
      detail: '--bogus',
      action: 'mnemonik auth logout --help',
    },
    human: { stderr: 'Unknown flag: --bogus\n' },
  },
  {
    args: ['status', 'extra'],
    json: {
      status: 'usage_error',
      reason: 'unknown_subcommand',
      command: 'status',
      detail: 'extra',
      action: 'mnemonik status --help',
    },
    human: { stderr: helpScreen(['status']) },
  },
];

describe('usage errors', () => {
  it.each(cases)('$args --json prints one JSON object and nothing else', async (entry) => {
    const result = await run([...entry.args, '--json']);
    expect(result.code).toBe(2);
    expect(result.stderr).toBe('');
    expect(result.stdout.endsWith('\n')).toBe(true);
    expect(result.stdout.trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toEqual(entry.json);
    expect(Object.keys(JSON.parse(result.stdout))).toEqual(Object.keys(entry.json));
  });

  it.each(cases)('$args without --json still prints help for a person', async (entry) => {
    const result = await run(entry.args);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(entry.human.stderr);
  });

  it.each([
    [['identity'], 'missing_subcommand', 'identity migrate', undefined],
    [['identity', 'undo'], 'unknown_subcommand', 'identity migrate', 'undo'],
    [['project', 'link'], 'missing_argument', 'project link', undefined],
    [['project', 'delete', 'one', 'two'], 'invalid_value', 'project delete', 'two'],
    [['connect', 'emacs'], 'invalid_value', 'connect', 'emacs'],
    [['auth', 'status', '--host', 'emacs'], 'invalid_value', 'auth status', 'emacs'],
    [['status', '--host'], 'invalid_value', 'status', '--host'],
  ] as const)('%j --json names the reason %s', async (args, reason, command, detail) => {
    const result = await run([...args, '--json']);
    expect(result.code).toBe(2);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      status: 'usage_error',
      reason,
      command,
      ...(detail ? { detail } : {}),
      action: `mnemonik ${command} --help`,
    });
  });

  it('keeps requested help as help, even with --json', async () => {
    const result = await run(['project', '--help', '--json']);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(helpScreen(['project']));
  });
});

// The failure mode is a command added later with the old pattern, a bare
// `(output.error(message), 2)` or `return 2`, which prints text under --json.
// Every exit code 2 in the router must come from usageFailure.
describe('router census: every usage error goes through the JSON-aware path', () => {
  const source = readFileSync(new URL('../src/router.ts', import.meta.url), 'utf8');
  const lines = source.split('\n');

  it('has no usage error that writes text and returns 2 by itself', () => {
    expect(source).not.toMatch(/output\.error\([^;]*?\)\s*,\s*2\s*\)/su);
    expect(source).not.toMatch(/stderr\.write\([^;]*?\)\s*;\s*return 2/su);
  });

  it('returns the number 2 only from usageFailure and the requested help screen', () => {
    // Every value a function in the router can return, down to its leaves:
    // `(a, 2)` returns 2, `x ? 0 : 2` may return 2.
    const file = ts.createSourceFile('router.ts', source, ts.ScriptTarget.Latest, true);
    const leaves = (node: ts.Expression): ts.Expression[] => {
      if (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node))
        return leaves(node.expression);
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken)
        return leaves(node.right);
      if (ts.isConditionalExpression(node))
        return [...leaves(node.whenTrue), ...leaves(node.whenFalse)];
      return [node];
    };
    const owner = (node: ts.Node): string => {
      for (let at: ts.Node | undefined = node.parent; at; at = at.parent)
        if (ts.isFunctionDeclaration(at) && at.name) return at.name.text;
      return '';
    };
    const exits: string[] = [];
    const visit = (node: ts.Node) => {
      const returned =
        ts.isReturnStatement(node) && node.expression
          ? node.expression
          : ts.isArrowFunction(node) && !ts.isBlock(node.body)
            ? node.body
            : undefined;
      if (returned)
        for (const leaf of leaves(returned))
          if (ts.isNumericLiteral(leaf) && leaf.text === '2') {
            const line = file.getLineAndCharacterOfPosition(leaf.getStart()).line + 1;
            exits.push(`${owner(leaf)}:${lines[line - 1]?.trim()}`);
          }
      ts.forEachChild(node, visit);
    };
    visit(file);
    expect(exits).toEqual(['usageFailure:return 2;', 'runCli:return screen ? 0 : 2;']);
  });

  it('routes each usage helper through usageFailure', () => {
    for (const helper of ['usageError', 'argumentError', 'flagError']) {
      const start = source.search(new RegExp(`(?:const|function) ${helper}\\b`, 'u'));
      expect(start, helper).toBeGreaterThan(-1);
      const body = source.slice(start, source.indexOf('\n\n', start));
      expect(body, helper).toMatch(/usageFailure\(|usageError\(/u);
    }
  });
});
