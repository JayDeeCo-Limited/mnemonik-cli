/**
 * @mnemonik/shared - Shared constants and utilities
 *
 * This package provides a single source of truth for constants
 * that need to be shared across Mnemonik packages.
 */
export { MCP_INSTRUCTIONS, MCP_INSTRUCTIONS_RAW, getMcpInstructions } from './instructions.js';
export { USAGE_GUIDE } from './usageGuide.js';
export declare const SCANNER_HEARTBEAT_INTERVAL_MS = 300000;
export { CodeScanner, MAX_SCANNED_FILE_BYTES, MAX_PUSH_CHUNK_CONTENT_LENGTH, AUTHORITY_FILE_MATCHERS, BUILT_IN_IGNORE_DIRS, DEFAULT_INCLUDE_EXTENSIONS, languageForExtension, makeIgnoreMatcher, isGitBoundary, isProjectBoundary, rootProjectId, SCRUB_VERSION, fileOp, statTuple, type FileStatTuple, isLinkedWorktreeCheckout, FIXTURE_PATH_RE, isFixturePath, isSecretFile, isAuthorityOnlyPath, XCODE_AUTHORITY_PATH, isXcodeAuthorityPath, isCmakeListsPath, CMAKE_LISTS_PATH, isCursorRulePath, logAstCapabilityOnce, type CodeChunk, type ScanOptions, type IndexExcludedFile, type IndexRuleFiles, } from './codeScanner.js';
export { INDEX_EXCLUSION_REASONS, BINARY_SNIFF_BYTES, MINIFIED_AVERAGE_LINE_LENGTH, MINIFIED_LONG_LINE_BYTES, DATA_DUMP_INSERT_THRESHOLD, NESTED_IGNORE_TAG, GITATTRIBUTES_TAG, classifyForIndex, softDefaultForPath, softDefaultForDirectory, softDefaultForContent, parseGitattributes, linguistAttributesFor, gitattributesCanReinclude, indexExclusionLabel, indexExclusionNotice, isIndexExclusionReason, encodeNestedIgnoreLine, encodeGitattributesLine, decodeIndexRules, type IndexExclusionReason, type IndexExclusion, type IndexClassification, type IgnoreFileVerdict, type GitattributesLayer, type GitattributesRule, type LinguistAttributes, type ClassifyForIndexOptions, type DecodedIndexRules, } from './indexClassifier.js';
export { makeIndexJudge, type IndexJudge, type IndexJudgement } from './indexJudge.js';
export { AST_LANGUAGE_IDS, QUERY_CHAIN, VENDORED_ARTIFACT_DIR, astArtifactReport, astCapabilityReport, grammarArtifactBasename, loadGrammar, loadedGrammarIds, resolveAstLanguage, objcppSyntaxIssue, type AstLanguageId, type GrammarBinding, type GrammarLoad, type GrammarUnavailableReason, } from './ast/grammars.js';
export { MAX_AST_PARSE_BYTES, chunkWithAst, type AstChunk, type AstChunkResult, } from './ast/astChunker.js';
export { SECRET_PATTERNS, SECRET_REDACTION_PLACEHOLDER, scrubSecrets, redactHighEntropyTokens, } from './secretPatterns.js';
export { scrubSourceSecrets, scrubSourceSecretsInProcess, installSourceRedactor, MAX_SOURCE_REDACTION_BYTES, type SourceRedactor, type SourceRedactionOptions, } from './sourceRedaction.js';
export { SourceRedactionPool, redactionWorkerThread, STRIKE_REASONS, type RedactionChild, runSourceRedactionWorker, redactionHeapMb, cgroupMemory, containerMemoryProbe, scannerMemoryProbe, processCpuSeconds, CPU_CEILING_SECONDS, SCANNER_TOTAL_MEMORY_MB, type MemoryProbe, type MemoryReading, type RedactionPriority, LARGE_FILE_BYTES as LARGE_SOURCE_REDACTION_BYTES, type SourceRedactionPoolOptions, } from './sourceRedactionPool.js';
export { redactCredentials, credentialValues, type RedactCredentialsOptions, } from './redactCredentials.js';
export { FETCH_TIMEOUT_MS, TELEMETRY_TIMEOUT_MS, POST_TOOL_TIMEOUT_MS, MCP_PRECHECK_TIMEOUT_MS, PRECOMPACT_TIMEOUT_MS, HOST_HOOK_TIMEOUT_MS, HOOK_TIMEOUT_MARGIN_MS, HOOK_STDIN_TIMEOUT_MS, hookDeadlineMs, type HookHost, withHookTimeout, } from './hookTimeouts.js';
export { persistJitDeliveryRef, readPendingJitDeliveryRefs, reportJitDeliveryRefsAttached, acknowledgeJitDeliveryRefs, pruneExpiredJitDeliveryRefs, applyJitDeliveryReceiptResponse, normalizeJitHookVersion, type JitReceiptClientEvent, type JitReceiptClientEventName, type JitReceiptEventContext, } from './jitDeliveryAck.js';
export * from './settingsIo.js';
export * from './claudeProxySettings.js';
export * from './repositoryFingerprint.js';
export * from './projectIdentityFile.js';
export * from './repositoryRoot.js';
export * from './protectedPaths.js';
export * from './readiness.js';
export { disclosureCovers } from './scannerDisclosure.js';
export * from './hostAdapter.js';
export * from './grantHost.js';
export * from './hostBinary.js';
export type { ServiceDefinition, SupervisorStatus, ServiceOperation, ServiceResult, } from './scannerSupervisor.js';
export { apiOrigin } from './apiOrigin.js';
export { WINDOWS_SERVICE_BUDGET_MS, SCANNER_SERVICE_RUNNING_BUDGET_MS, SCANNER_STARTUP_BUDGET_MS, SCANNER_RAPID_FAILURE_LIMIT, SCANNER_HANDOFF_BUDGET_MS, SCANNER_RECEIPT_STALE_MS, SCANNER_MAC_COMMAND_BUDGET_MS, SCANNER_STOP_BUDGET_MS, SCANNER_REMOVAL_BUDGET_MS, scannerAttemptHealthy, } from './scannerSupervisor.js';
export { printLaunchdRegistration, stopLaunchdRegistrations, removeMacScanner, authorizeMacService, macScannerPlist, macScannerLauncher, } from './launchdControl.js';
export { uninstallSystemdUnit, userManagerEnvironment, runtimeOwner, type RuntimeOwner, } from './systemdControl.js';
export { pidIsScanner } from './scannerPid.js';
export { parseVueSource, walkVueTemplate, VUE_FIDELITY_MARKER } from './vueSource.js';
//# sourceMappingURL=index.d.ts.map