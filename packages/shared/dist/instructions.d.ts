/**
 * MCP Instructions - Persistent agent guidance
 *
 * This is the SINGLE SOURCE OF TRUTH for MCP instructions.
 * Shared instruction content imported by the server.
 *
 * Version: 2.110
 * Updated: 2026-08-27
 *
 * v2.110 - Reordered and compressed the universal instructions to fit the
 *          2,048-character transport limit. The first 512 characters now carry
 *          the server purpose, self-scoping bootstrap condition, required cwd,
 *          and memory-as-augmentation stance. The retrieval, task pagination,
 *          and tool-floor capabilities remain in a shorter factual form.
 *
 * v2.109 - Compressed the v2.108 memory-search clause. It restated, verbatim,
 *          the same search guidance carried by SESSION_OPENER_INSTRUCTION
 *          (bootstrapDigestRender.ts) - and both co-occur in the same agent
 *          session as the bootstrap digest's capabilities.search block, which
 *          already states the memory_search/code_search call signatures in
 *          full. Kept the essential behavior (memory holds the why; search it
 *          before assuming files or git history are the whole story; verify
 *          with Grep/Read; reach for code_search when concepts don't share
 *          the user's words), dropped the restated call shapes, and pointed at
 *          the session context's capabilities block for the exact signatures
 *          once it loads - this text fires at `initialize`, before any
 *          digest exists, so it cannot point "above" the way the trimmed
 *          SESSION_OPENER clause does. recall-first-class plan, Task A3
 *          rider (reviewer-flagged: character-for-character duplicate).
 * v2.108 - Added front-loaded education that persistent project memory is part
 *          of the agent's working knowledge. A live Config-B fixture rejected
 *          the first generic invitation: the agent searched code, docs, and git
 *          history, then called the rationale undocumented without searching
 *          memory. The instruction now names the missing reasoning step and its
 *          address: rationale/intent questions use mnemonik.memory_search inside
 *          memory_tools, paired with current-source inspection; conceptual code
 *          discovery uses code_search alongside exact Grep/Read. The accepted
 *          wording stays a compact startup floor, not a token-heavy tutorial or
 *          recurring nudge.
 *
 * v2.106 - Added a static "Which tool for what" floor map. Rides the already-
 *         cached instructions at near-zero cost and gives every agent a baseline
 *         "which tool for what" for the under-surfaced tools (memory_add,
 *         memory_state, memory_info, memory_links, assist, search_summaries,
 *         policy, tasks). This is the floor under the reactive tool-education
 *         nudges; memory_info in particular has no reactive trigger, so the floor
 *         is its only education.
 *
 * v2.105 - Bootstrap's agent-facing label is generic project context. Use the
 *         canonical text body's stable `PROJECT_CONTEXT schemaVersion=` marker
 *         for the self-scoping check instead of teaching agents to call the
 *         user's project "Mnemonik".
 *
 * v2.104 - Disambiguated persistent project task memories from Claude Code's
 *         host-local TaskList and made completeness proactive. A request for a
 *         complete/all list must build cursor continuation into the first Code
 *         Mode program; guidance returned after an incomplete outer call is too
 *         late to preserve the one-round-trip workflow.
 *
 * v2.103 - Added the compact Discover -> Select -> Hydrate interpretation
 *         fallback for Config-A. Dynamic response orchestration remains
 *         authoritative; this sentence only teaches an un-orchestrated client
 *         how to act on retrieval envelopes without walking full bodies.
 *
 * v2.102 - Strengthened the self-bootstrap trigger to a compelling imperative.
 *         The v2.101 phrasing ("At the start of a session, unless ... call ...")
 *         was too soft; agents on a blind first turn skipped it. Real-world hole
 *         it must cover: Cursor's FIRST chat after an IDE open fires no
 *         sessionStart (confirmed by hook-stdin capture), and beforeSubmitPrompt
 *         has NO model-facing output field (only user_message, shown to the
 *         human) - so neither the silent digest nor the hook's
 *         session_bootstrap_required directive reaches the model. The MCP
 *         instruction is the ONLY model-facing channel left for that turn, so it
 *         now leads with the blind-state check + a hard "FIRST action MUST be
 *         session_bootstrap, before you reply" and an explicit cwd-REQUIRED
 *         clause. Still self-scoping: skips when the "Mnemonik project context"
 *         block is already present (working hook/proxy delivery), so config-B/C
 *         with live delivery don't double-call. cwd stays host-agnostic - the
 *         agent passes the project root it is working in (Cursor exposes the
 *         working dir to HOOKS via the stdin `workspace_roots[0]`, which cwdOf
 *         already reads; it is NOT an agent-readable env var, so the instruction
 *         must not name one).
 *
 * v2.101 - Stripped to a single instruction: the session_bootstrap trigger.
 *         MCP instructions are set at Server construction (initialize), before
 *         the server knows the client, so they cannot be scoped per-IDE - and
 *         IDE != config (a Claude Code user may be config-B or -C). The content
 *         is therefore universal and SELF-SCOPING: it conditions on whether a
 *         "Mnemonik project context" block is already present (config-B/C with
 *         working delivery -> skip; config-A and any host where hook/proxy
 *         delivery missed -> call). Re-enabled in production
 *         (MNEMONIK_INSTRUCTIONS_ENABLED=true in both ECS task defs). This is the
 *         reliable trigger that makes the agent self-bootstrap - tool results
 *         always reach the model, which hook injection cannot guarantee on a
 *         no-tool-call turn (e.g. Cursor "hello").
 *
 * v2.100 - Skill + IDE rule templates retired entirely. They were the
 *         file-written home of the workflow; agents followed them unreliably and
 *         forgot them over long sessions (the same fate these MCP instructions
 *         suffer), so they are gone. `filesToWrite` now carries only
 *         `.mnemonik.json`. Dropped the trailing pointer that sent agents to
 *         read a skill that no longer exists. Behavioral alignment now rides the
 *         orchestration layer (host hooks + proxy); these instructions stay lean
 *         and are the Config-A fallback only.
 *
 * v2.99 - Orchestration-aware framing. These static MCP instructions are
 *         delivered at `initialize`, before the server knows the actor's tier
 *         (no project/proxy/hooks state yet), so they cannot be served per-tier.
 *         Instead the CONTENT is now tier-correct: the self-drive calls
 *         (memory_search / file_context / checkpoint) are framed as the
 *         MCP-only (Config-A) fallback, and Config-B/C agents are told to
 *         follow the injected orchestration (cached bootstrap block,
 *         file_context, checkpoint nudges) rather than duplicate the calls.
 *         The orchestration layer (proxy + host hooks) is authoritative for
 *         B/C; this block is primarily Config-A's driver.
 *
 * v2.98 - Doc truth contracts are the normal drift surface. linkedDocs and
 *         doc_code_couplings remain legacy diagnostics only; docs drift
 *         defaults to truth findings and legacy:true is explicit debug.
 * v2.97 - Dropped legacy doc-coupling action guidance. Coupling rows are
 *         not truth findings (plan §1).
 * v2.96 - Replace conditional memory_discover guidance with structural fix:
 *         bootstrap now includes _methodCatalog (discoverMemoryTools({})) so
 *         agents have the memory_tools calling convention from turn one.
 *         Instruction updated to reference _methodCatalog directly.
 *         Superseded 2026-07-13: a real Config-B host persisted the expanded
 *         15.1KB hook output instead of injecting it. Bootstrap now carries a
 *         compact discovery bridge; memory_discover({}) owns the full catalog.
 * v2.95 - Drop `augments` from JIT directive verdict list per plan §5 default
 *         (augments downgrades to ambient via the parallel recall gate, not
 *         the directive lane). See jit-knowledge-injector.md §5 decision note.
 * v2.94 - Add JIT directive teaching (docs/development/jit-knowledge-injector.md §2.3).
 *
 * Code mode permanent - all memory operations via memory_tools sandbox.
 *        memory_add, file_context etc. are now mnemonik.* methods, not standalone tools.
 *
 * Zero-cooperation rewrite. Context auto-loads if session_bootstrap is skipped.
 *        Session summaries are auto-saved if agent doesn't call mnemonik.memory_add().
 *        Instructions drastically simplified - the server handles the workflow now.
 *
 * Token-optimised rewrite (superseded by later instruction rewrites).
 */
/**
 * Get MCP instructions, respecting MNEMONIK_INSTRUCTIONS_ENABLED env var.
 * Set MNEMONIK_INSTRUCTIONS_ENABLED=false to disable for testing.
 *
 * Reads env through globalThis so this package compiles cleanly without
 * `@types/node` (shared package's tsconfig doesn't include it, which made
 * IDEs flag `process` as an unknown global even though the workspace
 * tsc resolution found it).
 */
export declare function getMcpInstructions(): string;
/**
 * Raw instructions content (always returns the content, ignores env var).
 * Use getMcpInstructions() for production code.
 */
export declare const MCP_INSTRUCTIONS_RAW = "Mnemonik provides persistent project memory: decisions, rationale, tasks, and policies across sessions. If no block begins \"PROJECT_CONTEXT schemaVersion=\", session_bootstrap({ cwd }) loads project context when cwd is the real absolute path of the project root; a placeholder or relative path fails. With that block, context is loaded and no session_bootstrap call is needed. Code and docs show current artifacts, git shows changes, and memory carries the why; memory_search recalls rationale or intent, then Grep or Read verifies current source.\n\nmemory_discover supplies exact schemas and examples for unfamiliar or action-based methods; memory_tools runs their async JavaScript.\n\nRetrieval pages use hydrated for complete records, index for pointer rows, extent for totals, and cursor for continuation. Relevant IDs can be selected before exact originals are hydrated; a refined query or cursor reveals more without paging full bodies merely to discover what exists.\n\nProject work items live in tasks. A pending list requires action:\"list\" and status:\"pending\". Each page is { hydrated, index, extent, cursor }; a complete listing combines hydrated and index and follows cursor until null.\n\nWhich tool for what:\n- memory_get: hydrates exact originals by id.\n- memory_add: saves a discrete decision or root cause.\n- memory_state: corrects wrong, outdated, or conflicting memory.\n- memory_info: explains confidence or origin when memory looks suspect.\n- memory_links: connects related decisions so they surface together.\n- assist: measures coverage when search results are thin or empty.\n- search_summaries: finds past work by topic or date across sessions.\n- policy: stores durable enforced rules or preferences, not memories.\n- tasks: creates follow-up work and closes completed work.\n- code_search: finds conceptual code when source wording differs.\n- memory_search: finds rationale, intent, decisions, and prior work.";
/**
 * Default export for convenience.
 * Note: This respects the MNEMONIK_INSTRUCTIONS_ENABLED env var.
 */
export declare const MCP_INSTRUCTIONS: string;
//# sourceMappingURL=instructions.d.ts.map