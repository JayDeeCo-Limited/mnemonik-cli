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
import { type IndexExclusionReason } from './indexClassifier.js';
export type IndexJudgement = {
    excluded: false;
    /**
     * Why the soft defaults did not apply: a project rule re-included the
     * path, or it is an authority file (`AUTHORITY_FILE_MATCHERS`) - collected
     * whole for doc-truth, never chunked, and never judged by the defaults on
     * the daemon either. Content rules do not run for any of them.
     */
    override?: 'ignore_file' | 'gitattributes' | 'authority';
} | {
    excluded: true;
    kind: 'hard';
    rule: string;
} | {
    excluded: true;
    kind: 'soft';
    reason: IndexExclusionReason;
    rule: string;
};
export interface IndexJudge {
    /** Hard rules and the path-only soft defaults, with the project's overrides. */
    judgePath(relPath: string): IndexJudgement;
    /**
     * `judgePath`, then the content rules when `content` (decoded, scrubbed
     * text) is supplied and no project rule re-included the path.
     */
    judge(relPath: string, content?: string): IndexJudgement;
}
export declare function makeIndexJudge(storedPatterns?: readonly string[]): IndexJudge;
//# sourceMappingURL=indexJudge.d.ts.map