import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
const targets = process.argv.slice(2);
if (!targets.length) throw new Error('Usage: tells-gate.mjs TARGET...');
const joined = (...parts) => parts.join('');
const alternatives = (values) => values.map((value) => `(?:${value})`).join('|');
const literal = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const words = [
  joined('addi', 'tionally'),
  joined('cru', 'cial'),
  joined('del', 've'),
  joined('endu', 'ring'),
  joined('enha', 'nce'),
  joined('foste', 'ring'),
  joined('gar', 'ner'),
  joined('inter', 'play'),
  joined('intri', 'cate'),
  joined('land', 'scape'),
  joined('piv', 'otal'),
  joined('show', 'case'),
  joined('tape', 'stry'),
  joined('testa', 'ment'),
  joined('under', 'score'),
  joined('vib', 'rant'),
  joined('leve', 'rage'),
  joined('uti', 'lize'),
  joined('facili', 'tate'),
  joined('ro', 'bust'),
  joined('seam', 'less'),
  joined('compre', 'hensive'),
];
const phrases = [
  joined('it is important', ' to note'),
  joined('in order', ' to'),
  joined('note', ' that'),
  joined('worth', ' noting'),
  joined('we', ' now'),
  joined('this', ' fix'),
  joined('the previous', ' implementation'),
  joined('as the reviewer', ' found'),
  joined('watched', ' fail'),
  joined('red-', 'first'),
  joined('regression', ' for'),
];
const privateTerms = [
  joined('coor', 'dinator'),
  joined('br', 'ief'),
  joined('codex-', 'fleet'),
  joined('led', 'ger'),
  joined('windows-', 'pass'),
  joined('ubuntu-', 'pass'),
  joined('mac-', 'pass'),
  joined('/tmp/', 'reports'),
];
const expressions = [
  new RegExp(joined('Co-', 'Authored-By'), 'giu'),
  new RegExp(joined('Generated', ' with'), 'gu'),
  new RegExp(joined('Claude', ' Code <'), 'giu'),
  new RegExp(joined('noreply@', 'anthropic.com'), 'giu'),
  new RegExp(`\\bauthor\\b[^\\n]*\\b${joined('Anth', 'ropic')}\\b`, 'giu'),
  /(?:\p{Emoji_Presentation}|\p{Emoji}\ufe0f)/gu,
  new RegExp(`\\b(?:${alternatives(privateTerms.map(literal))})\\b`, 'giu'),
  new RegExp(joined('\\bfl', 'eet/'), 'giu'),
  /\bP(?:[0-4]-\d{2}|5-0[1-4])\b/gu,
  /\bPhase \d+\b/gu,
  /\bD-(?:[1-9]|[1-3]\d|40)\b/gu,
  /\bAC-[A-Za-z0-9][A-Za-z0-9-]*\b/gu,
  new RegExp(
    `\\b(?:${joined('INFE', 'RRED')}|${joined('ASSU', 'MED')}|${joined(
      'UNVER',
      'IFIED'
    )})(?:,\\s*|\\s+)(?:NOT\\s+DOCUMENTED|NO\\s+(?:SOURCE|EVIDENCE))\\b`,
    'gu'
  ),
  /\b(?:verified|checked|confirmed)\s+(?:on\s+)?20\d{2}-\d{2}-\d{2}\b/giu,
  /[\u2013\u2014\u2018\u2019\u201c\u201d\u2026\u2192\u2500-\u257f]/gu,
  /^\s*(?:\/\/|#|\/\*|\*)[^\n]*\*\*[^*\n]+:\*\*/gu,
  new RegExp(`\\b(?:${alternatives(words)})\\b`, 'giu'),
  new RegExp(`\\b(?:${alternatives(phrases.map(literal))})\\b`, 'giu'),
];
const packedExpressions = expressions.slice(0, -2);
const toolNames = /\b(?:Claude Code|Codex|Cursor|ChatGPT|Anthropic|OpenAI)\b/giu;
const findings = new Set();
function inspect(text, name, rules = expressions) {
  if (text.includes('\0')) return;
  if (name.endsWith('package.json')) {
    try {
      const author = JSON.parse(text).author;
      if (new RegExp(joined('Anth', 'ropic'), 'iu').test(JSON.stringify(author))) {
        const index = text
          .split(/\r?\n/)
          .findIndex((line) => new RegExp(joined('Anth', 'ropic'), 'iu').test(line));
        findings.add(`${name}:${index + 1}: ${joined('Anth', 'ropic')} author`);
      }
    } catch {}
  }
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const checks = [...rules];
    if (name.endsWith('.github/workflows/publish-cli.yml') && /git commit\b/.test(line)) {
      checks.push(toolNames);
    }
    for (const expression of checks) {
      expression.lastIndex = 0;
      for (const match of line.matchAll(expression)) {
        findings.add(`${name}:${index + 1}: ${match[0]}`);
      }
    }
  }
}
function inspectDirectory(root) {
  const ignored = new Set(['.git', 'node_modules', 'dist-package']);
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      if (ignored.has(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && !/\.(?:tgz|tar\.gz)$/i.test(path))
        inspect(readFileSync(path, 'utf8'), relative(root, path));
    }
  };
  visit(root);
}
function inspectArchive(path) {
  const entries = execFileSync('tar', ['-tzf', path], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter((entry) => entry && !entry.endsWith('/'));
  for (const entry of entries) {
    const content = execFileSync('tar', ['-xOzf', path, entry]);
    inspect(content.toString('utf8'), `${basename(path)}:${entry}`, packedExpressions);
  }
}
for (const target of targets) {
  const path = resolve(target);
  if (statSync(path).isDirectory()) inspectDirectory(path);
  else if (/\.(?:tgz|tar\.gz)$/i.test(path)) inspectArchive(path);
  else inspect(readFileSync(path, 'utf8'), relative(process.cwd(), path));
}

if (findings.size) {
  process.stderr.write([...findings].sort().join('\n') + '\n');
  process.exitCode = 1;
}
