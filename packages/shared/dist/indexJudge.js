/**
 * Judge a stored or pushed path the way the daemon judged it, from the rules
 * the daemon uploaded (`projects.scanner_ignore_patterns`).
 *
 * The daemon walks the disk with every rule file in front of it. The server
 * never sees the disk; it has the root .gitignore / .mnemonikignore lines (the
 * privacy list) plus the tagged nested-ignore and .gitattributes lines the
 * daemon uploads beside them (`indexClassifier.ts`, "Rule upload"). This
 * module rebuilds the same precedence from those lines so the /scan/push
 * backstop, file_push, the dropped-path marker bookkeeping and retirement all
 * reach the daemon's answer:
 *
 *   hard   built-in directories, secret files, the root ignore patterns
 *          (makeIgnoreMatcher - unchanged, never overridable), and a nested
 *          ignore file that ignores the path;
 *   soft   classifyForIndex: `!pattern` and .gitattributes overrides, then the
 *          soft defaults - path rules always, content rules when content is
 *          supplied.
 */
import ignore from 'ignore';
import { AUTHORITY_FILE_MATCHERS, makeIgnoreMatcher } from './codeScanner.js';
import { classifyForIndex, decodeIndexRules, parseGitattributes, softDefaultForContent, } from './indexClassifier.js';
function compile(lines) {
    const cleaned = lines.filter((line) => typeof line === 'string' && line.trim().length > 0);
    if (cleaned.length === 0)
        return null;
    try {
        return ignore().add([...cleaned]);
    }
    catch {
        return null;
    }
}
/** Deepest layer with an opinion wins, as CodeScanner's walk resolves it. */
function verdictFor(path, layers) {
    for (let i = layers.length - 1; i >= 0; i--) {
        const layer = layers[i];
        if (!layer)
            continue;
        let sub;
        if (layer.baseRel === '')
            sub = path;
        else if (path.startsWith(`${layer.baseRel}/`))
            sub = path.slice(layer.baseRel.length + 1);
        else
            continue;
        try {
            const res = layer.ig.test(sub);
            if (res.ignored)
                return 'ignored';
            if (res.unignored)
                return 'unignored';
        }
        catch {
            // `ignore` throws on paths it considers invalid; such a path has no verdict.
        }
    }
    return 'unmatched';
}
const depth = (baseRel) => (baseRel === '' ? 0 : baseRel.split('/').length);
export function makeIndexJudge(storedPatterns = []) {
    const rules = decodeIndexRules(storedPatterns);
    // The privacy net is exactly what it was: root patterns, built-in dirs, secrets.
    const isHardIgnored = makeIgnoreMatcher(rules.rootIgnore);
    const layers = [];
    const root = compile(rules.rootIgnore);
    if (root)
        layers.push({ baseRel: '', ig: root });
    const nested = [...rules.nestedIgnore.entries()].sort(([a], [b]) => depth(a) - depth(b));
    for (const [baseRel, lines] of nested) {
        const ig = compile(lines);
        if (ig)
            layers.push({ baseRel, ig });
    }
    const attributes = [...rules.attributes.entries()].map(([baseRel, lines]) => ({ baseRel, rules: parseGitattributes(lines.join('\n')) }));
    const judgePath = (relPath) => {
        const path = relPath.replace(/\\/g, '/');
        if (!path)
            return { excluded: false };
        if (isHardIgnored(path))
            return { excluded: true, kind: 'hard', rule: 'ignore rule' };
        const verdict = verdictFor(path, layers);
        if (verdict === 'ignored') {
            return { excluded: true, kind: 'hard', rule: 'nested ignore file' };
        }
        if (AUTHORITY_FILE_MATCHERS.some((matches) => matches(path))) {
            return { excluded: false, override: 'authority' };
        }
        const classification = classifyForIndex(path, {
            ignoreFileVerdict: verdict,
            attributes,
        });
        if (!classification.include) {
            return {
                excluded: true,
                kind: 'soft',
                reason: classification.reason,
                rule: classification.rule,
            };
        }
        return classification.override
            ? { excluded: false, override: classification.override }
            : { excluded: false };
    };
    return {
        judgePath,
        judge(relPath, content) {
            const byPath = judgePath(relPath);
            if (byPath.excluded || byPath.override || content === undefined)
                return byPath;
            const byContent = softDefaultForContent(relPath, content);
            return byContent ? { excluded: true, kind: 'soft', ...byContent } : byPath;
        },
    };
}
//# sourceMappingURL=indexJudge.js.map