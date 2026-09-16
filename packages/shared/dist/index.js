/**
 * @mnemonik/shared - Shared constants and utilities
 *
 * This package provides a single source of truth for constants
 * that need to be shared across Mnemonik packages.
 */
export { MCP_INSTRUCTIONS, MCP_INSTRUCTIONS_RAW, getMcpInstructions } from './instructions.js';
export { USAGE_GUIDE } from './usageGuide.js';
export { CodeScanner, MAX_SCANNED_FILE_BYTES, MAX_PUSH_CHUNK_CONTENT_LENGTH, AUTHORITY_FILE_MATCHERS, BUILT_IN_IGNORE_DIRS, DEFAULT_INCLUDE_EXTENSIONS, languageForExtension, makeIgnoreMatcher, isGitBoundary, FIXTURE_PATH_RE, isFixturePath, isSecretFile, isAuthorityOnlyPath, logAstCapabilityOnce, } from './codeScanner.js';
export { AST_LANGUAGE_IDS, QUERY_CHAIN, VENDORED_ARTIFACT_DIR, astArtifactReport, astCapabilityReport, grammarArtifactBasename, loadGrammar, loadedGrammarIds, resolveAstLanguage, } from './ast/grammars.js';
export { MAX_AST_PARSE_BYTES, chunkWithAst, } from './ast/astChunker.js';
export { SECRET_PATTERNS, SECRET_REDACTION_PLACEHOLDER, scrubSecrets, redactHighEntropyTokens, } from './secretPatterns.js';
export { FETCH_TIMEOUT_MS, TELEMETRY_TIMEOUT_MS, POST_TOOL_TIMEOUT_MS, MCP_PRECHECK_TIMEOUT_MS, withHookTimeout, } from './hookTimeouts.js';
export { persistJitDeliveryRef, readPendingJitDeliveryRefs, reportJitDeliveryRefsAttached, acknowledgeJitDeliveryRefs, pruneExpiredJitDeliveryRefs, applyJitDeliveryReceiptResponse, normalizeJitHookVersion, } from './jitDeliveryAck.js';
export * from './settingsIo.js';
export * from './claudeProxySettings.js';
export * from './repositoryFingerprint.js';
export * from './projectIdentityFile.js';
export * from './repositoryRoot.js';
export * from './protectedPaths.js';
export * from './readiness.js';
export * from './hostAdapter.js';
export * from './hostBinary.js';
export { apiOrigin } from './apiOrigin.js';
export { WINDOWS_SERVICE_BUDGET_MS } from './scannerSupervisor.js';
//# sourceMappingURL=index.js.map