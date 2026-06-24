// Internal compatibility surface used by local unit and smoke tests.
export { buildHeaders, buildPayload, cleanText, extractResponseText, extractTextsFromLine, generate, generateStream, getUrl, wrbResponseShapeSummary } from "./gemini/client";
export { CONFIG_ENV_KEYS } from "./config";
export { createGeminiCompletionProvider } from "./gemini/completion-provider";
export { createStreamTextExtractor, stripArtifacts } from "./gemini/client/parser";
export { configWithCachedGeminiBuildLabel, getCachedGeminiBuildLabel, getFreshGeminiBuildLabel, resetGeminiBuildLabelCacheForTest, setCachedGeminiBuildLabel, waitBeforeRetry } from "./gemini/client/retry";
export { invalidGeminiCookieError, isInvalidGeminiCookieError, unverifiedGeminiCookieError } from "./gemini/client/errors";
export { configWithActiveGeminiCookie, mergeSetCookieHeaders, parseCookieHeader, resetActiveGeminiCookieForTest, rotateGeminiCookieForRetry, rotateGeminiCookieForRetryWithReason, splitSetCookieHeader } from "./gemini/cookies";
export {
  filenameFromUrl,
  firstNonEmptyString,
  genericFilenameFromMime,
  imageFilenameFromMime,
  imageFilenameFromObject,
  mimeFromFilename,
  normalizeUploadFileInput,
  parseImageUrl,
  parseUploadUrl,
  sanitizeUploadFilename,
} from "./attachments/media";
export {
  abortError,
  canFallbackAfterSocketError,
  errorLogSummary,
  isAbortError,
  log,
  logInfo,
  logStage,
  makeSapisidHash,
  randomBytes,
  randHex,
  sleep,
  throwIfAborted,
  timeoutSignal,
  upstreamErrorCode,
  upstreamErrorMessage,
  upstreamErrorStatus,
  uuid,
  _sapisidHashCache,
} from "./shared/runtime";
export {
  buildTextWithTokens,
  codePointLength,
  codePointLengthAtLeast,
  createPromptByteLengthSniffer,
  createTokenCounter,
  promptByteLength,
  promptByteLengthBounded,
  promptByteLengthGreaterThan,
  tokenCharCounts,
  tokenEst,
  trimContinuationOverlap,
} from "./shared/tokens";
export { readJsonRequest } from "./http/core/json";
export { readRouteJsonPost } from "./http/core/route-json";
export { sseResponse } from "./http/core/sse";
export { streamErrorText, streamInterruptedWarningText, streamWarningObject, writeStreamWarningEvent } from "./http/core/stream-errors";
export { httpFetch } from "./gemini/transport/http";
export { base64ToBytes } from "./attachments/media";
export { collectOpenAIInlineUploadImages, collectOpenAIRequestAttachmentPlan } from "./attachments/collect-openai";
export { createAttachmentPlan } from "./attachments/plan";
export { attachmentDrop, droppedAttachmentNote } from "./attachments/notes";
export { getCachedGeminiPushId, getGeminiPushId, getPageTokens, refreshGeminiPushId, resetGeminiUploadCachesForTest, setCachedGeminiPushId } from "./gemini/uploads/tokens";
export { resolveFiles, resolveImages, uploadImage, uploadTextFile } from "./gemini/uploads/execute";
export {
  contextFilePromptByteCheck,
  contextFileThreshold,
  contextFileUploadFailure,
  latestInputInlineLimit,
  latestInputPromptForContextFile,
  oversizedInlineContextFailure,
  prepareContextFiles,
  prepareContextFilesWithUploader,
  prepareGoogleGeminiContext,
  prepareOpenAIGeminiContext,
  shouldConsiderContextFiles,
  shouldUseContextFiles,
} from "./completion/context";
export { ensureInlineToolPrompt } from "./completion/tool-prompt-guard";
export {
  EMPTY_UPSTREAM_MSG,
  consumeBufferedToolTextDeltas,
  consumePlainTextDeltas,
  consumeToolSieveTextDeltas,
  finalizeOpenAICompletionResult,
  streamBufferedToolTextCompletionEvents,
  streamPlainCompletionEvents,
  streamToolSieveCompletionEvents,
  upstreamEmptyWarning,
} from "./completion";
export { finalizeGoogleCompletionResult } from "./completion/google-turn";
export {
  appendStructuredOutputInstructionToPrepared,
  appendStructuredOutputInstructionWithTokens,
  appendTextToPreparedWithTokens,
  withGeminiNativeHiddenToolsPromptForPrepared,
  withGeminiNativeHiddenToolsPromptWithTokens,
} from "./promptcompat/prompt-build";
export { createPromptPartAccumulator } from "./promptcompat/prompt-text";
export { messagesToPrompt } from "./promptcompat/messages";
export { buildGoogleToolPrompt, googleContentsToOpenAIMessages, googleContentsToPrompt, googleToolChoiceInstruction } from "./promptcompat/google";
export { buildGoogleHistoryTranscript, buildOpenAIHistoryTranscript, latestGoogleUserInputText, latestOpenAIUserInputText } from "./promptcompat/history";
export { normalizeResponsesInputAsMessages, normalizeResponsesInputValueAsMessages, responsesMessagesFromRequest, stringifyToolCallArguments } from "./promptcompat/responses-input";
export {
  buildCorrectToolExamples,
  buildReadToolCacheGuard,
  exampleBasicParams,
  exampleNestedParams,
  exampleScriptParams,
  firstBasicExample,
  firstNestedExample,
  firstNonNil,
  firstNBasicExamples,
  firstScriptExample,
  contentTextForHistory,
  createToolBundle,
  extractToolMeta,
  filterToolBundleByPolicy,
  filterGoogleToolsByConfig,
  findToolCallSyntaxCandidateStart,
  hasToolCallMarkupSyntaxCandidate,
  hasReadLikeTool,
  isInsideMarkdownFence,
  isInsideSimpleMarkdownCodeSpan,
  isMarkdownProtectedPosition,
  isPartialToolCallSyntaxPrefix,
  markdownProtectedRanges,
  markdownProtectedSpanStartAtCut,
  markdownProtectedTailStart,
  maskMarkdownProtectedSpans,
  mergeFileRefs,
  messageContentToPrompt,
  buildToolSchemaIndex,
  looksLikeArraySchema,
  looksLikeObjectSchema,
  normalizeParsedToolCallsForSchemas,
  normalizeToolValueWithSchema,
  nullableOpenAIFunctionTools,
  openAIToolDefs,
  parseGoogleFunctionCalls,
  parseGoogleToolChoicePolicy,
  parseMarkdownFenceLine,
  openMarkdownCodeSpanStart,
  openMarkdownFenceStart,
  reasoningTextForHistory,
  responsesContentToText,
  shouldCoerceSchemaToString,
  stringifySchemaValue,
  normalizeToolsToOpenAIFunctionTools,
  renderToolExampleBlock,
  toolCallInstructionsFor,
  toolDefsFromTools,
  toolFunctionDeclarations,
  toolItemsFromTools,
  toolMetasFromTools,
  toolNamesForPromptSource,
  toolPromptBlockFor,
  toolsContextTranscriptFor,
  uniqueToolNames,
  validateGoogleFunctionCalls,
  validateGoogleToolChoiceConfig,
} from "./toolcall";
export {
  allowedToolNameFromItem,
  buildToolCallInstructions,
  buildToolChoiceInstructionFromPolicy,
  ensureStreamToolCallID,
  extractToolNames,
  filterToolsByPolicy,
  formatOpenAIStreamToolCalls,
  formatOpenAIToolCalls,
  namesToSet,
  parseAllowedToolNames,
  parseForcedToolName,
  parseOpenAIToolChoicePolicy,
  policyHasAllowed,
  toolPolicyAllows,
  validateRequiredToolCalls,
  validateToolPolicyCalls,
} from "./toolcall";
export {
  appendMarkupValue,
  decodeCDATA,
  decodeXmlEntities,
  findNextAnyXmlTag,
  findNextXmlTag,
  findTopLevelXmlElementBlocks,
  findXmlElementBlocks,
  findXmlTagEnd,
  parseTagAttributes,
  scanXmlTagAt,
  skipCDATAAt,
} from "./toolcall/xml";
export {
  normalizeDSMLToolCallMarkup,
  parseCanonicalDSMLToolCallsFast,
  parseDSMLToolCallsDetailed,
  parseMarkupValue,
  parseScalarValue,
  restoreToolCallProtectedMarkdown,
  shouldSkipToolCallParsingForCodeFenceExample,
  stripFencedCodeBlocks,
  unwrapToolArgumentMarkdown,
} from "./toolcall/dsml";
export { indentPromptParameters, promptCDATA, wrapParameter, xmlEscapeAttr } from "./toolcall/prompt-xml";
export { formatPromptParamValue, formatPromptToolCallBlock, isSafeXmlElementName } from "./toolcall";
export {
  buildStructuredOutputRequirement,
  canonicalizeStructuredOutputText,
  extractFirstJsonDocument,
  finalizeStructuredOutputText,
  getStructuredResponseFormat,
  jsonValuesEqual,
  parseStructuredJsonCandidate,
  STRUCTURED_JSON_NOT_FOUND,
  validateStructuredOutputValue,
} from "./toolcall/structured";
export {
  createToolSieveState,
  flushToolSieve,
  flushToolSievePlainPrefix,
  hasToolCallCloseSyntax,
  hasToolSieveSentinel,
  processToolSieveChunk,
  TOOL_SIEVE_PLAIN_TEXT_KEEP,
} from "./toolstream";
export { streamOpenAIChatPlain, streamOpenAIChatWithToolSieve } from "./http/openai/chat-stream";
export { createDeltaCoalescer } from "./http/stream/coalescer";
export { handleResponses } from "./http/openai/responses";
export { handleChat } from "./http/openai/chat";
export {
  buildResponsesOutput,
  openAIChatChunk,
  openAIChatUsageFromCompletionTokens,
  openAIResponsesUsage,
  writeOpenAIChatStreamError,
  writeOpenAIChatUsageTokenChunk,
} from "./http/openai/format";
export { googleGenerateContentResponse, googleStreamDonePayload } from "./http/google/format";
export { openAIErrorResponse, openAIErrorType, openAIUpstreamErrorResponse } from "./http/openai/errors";
export { handleGoogleGenerate } from "./http/google/handlers";
export { streamGooglePlain, streamGoogleTools } from "./http/google/stream";
export { streamResponsesWithToolSieve } from "./http/openai/responses-stream";
export { streamGoogleToolCompletionEvents } from "./completion/google";
export { _joinByteChunks, _setConnectForTest, bytesFromBody, closeIdleSocketPool, closeSocketQuietly, createByteQueue, createSocketPool, parseHttpChunkSizeLine, socketHttp, socketTimeoutError, withSocketTimeout } from "./gemini/transport/socket";
