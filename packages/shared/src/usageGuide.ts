/**
 * Mnemonik Usage Guide - Procedural workflow guidance for agents
 *
 * This is the SINGLE SOURCE OF TRUTH for the usage guide.
 * Shared usage guide content imported by the server.
 *
 * Version: 2.85
 * Updated: 2026-07-18 - Change-scoped, document-parallel doc-drift workflow.
 *
 * This guide focuses on HOW to use Mnemonik effectively, not WHAT tools exist.
 * Tool schemas already tell agents what's available - they need the workflow.
 */

export const USAGE_GUIDE = `# Mnemonik Workflow Guide (v2.85)

## Workflow

session_bootstrap -> memory_search -> file_context -> [work] -> memory_add -> memory_state

## Tool Selection by Stage

### Session start
- session_bootstrap: loads context, policies, pending tasks (call once, first thing)
- memory_search: search by task domain; set workflowContext (feature_implementation, debugging, exploration, policy_review)
- projects: resolve project IDs if context unclear
- policy: review safety rules

### Before editing files
- file_context: fetch memories for the file - call for EVERY file you edit
- memory_search: second search scoped to file/module if needed
- mnemonik.docs({ action: 'drift', scopePath }): check doc-truth findings for the file

### During implementation
- memory_get: retrieve specific memory by id
- memory_update: refine memory created this session
- memory_info: query history, provenance, confidence breakdown, links, graph
- assist: get tool guidance if uncertain

### Documentation drift
- An unscoped mnemonik.docs({ action: 'drift' }) call defaults to the schema-v3 affected-document inventory; a scoped call defaults to its detailed packet. Each document is an independent work unit. Recommended default: delegate each affected document to a subagent and start available document workers together; pass docPath and the compact retrieve call instead of copying finding bodies. This is advisory orchestration, not a host-enforced ownership rule.
- Detailed retrieval defaults to one document and returns at most 8 findings within 16 KiB. Each packet carries compact causal triggers plus current Markdown and code locations resolved from stable identities; line numbers are display metadata and may move.
- Complete every finding in the document: edit update_doc/regenerate_doc items, submit mnemonik.docs({ action: 'verdicts', scopePath, items: [...] }) with independently cited evidence for settled verify_and_report items, or call mnemonik.docs({ action: 'flag_for_review', scopePath, findingId, evidence }) when inspected evidence cannot settle a claim.
- The document under review cannot confirm or refute its own claim. Verdict evidence must cite an independent source; route a rejected circular verdict to flag_for_review.
- Absence of repository evidence is not refutation. Claims about human intent, plans, positioning, or external facts require affirmative contradictory evidence to refute; otherwise flag them for review.
- Follow the document-local retrieveMore call until that document is complete, and follow inventory cursors until every affected document has a terminal disposition.

### After significant work
- memory_add: save decisions, outcomes, patterns, bug root causes
- memory_state: reinforce (memory helped), supersede (replace outdated), deprecate, penalize, dispute
- tasks: mark tasks in progress or complete
- mnemonik.docs({ action: 'status' }): view doc-truth health (legacy coupling counts are diagnostic only - do not act on them as drift)

### Diagnostics
- doctor: when tool calls fail or behavior is inconsistent
- scanner: metrics (is the indexing daemon alive), history, drift. Nothing here starts indexing - the daemon owns it

## Skip conditions

Skip memory tools for: formatting-only edits, trivial one-line changes, mechanical refactors, git operations, running tests.

## Completion gate

Never tell the user significant work is done without calling memory_add first in the same response. Changes made + responding next = completion. "Progress updates" count.

## Memory search tips

- Query should include task intent + key entities
- Set workflowContext when you know the phase
- Use currentFile to boost file-linked memories
- Use filterOnly:true only for narrow filters (no embedding, requires >=1 filter)

## Proactive heuristics

- Long sessions: re-run memory_search after switching topics
- Conflicting info: use memory_state to supersede/dispute
- High-impact changes: save memory immediately after verification
- Treat each affected document in docTruthFindings/_docDrift as an independent work unit. Complete its scoped packet with edits, supported verdicts, or an evidenced review disposition. linkedDocs and stale-coupling counts alone remain legacy diagnostics

## Anti-fade (every ~10 tool calls)

Check: (1) memory_search before work? (2) file_context before edit? (3) memory_add after completing? No session_bootstrap? Call it now.
`;
