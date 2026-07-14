// Internal compatibility surface used by local unit and smoke tests.
export { handleApplicationRequest } from "./app";
export { createAccountsWithLimitFallback } from "./admin-ui/api";
export { isAccount, parseMutation, parseOverview } from "./admin-ui/schemas";
export { loadAccounts } from "./admin-ui/actions";
export { detectLanguage, statusLabel } from "./admin-ui/i18n";
export {
	accountStats,
	adminKey,
	accounts,
	authExpanded,
	connectionVerified,
} from "./admin-ui/state";
export { resolveTheme } from "./admin-ui/theme";
export {
	accountBusyLabel,
	accountDisplayName,
	accountResourcePath,
	destructiveConfirmationText,
	identifier,
	identifierKey,
	isCooling,
	mergeMutationResults,
	parseBatchImport,
	relativeTime,
	resultSummary,
	validateCookieValue,
} from "./admin-ui/logic";
export {
	createInputFromAccount as createGeminiAccountInputFromAdmin,
	hasAccountUpdate,
	listFilterFromSearchParams as geminiAccountListFilterFromSearchParams,
	normalizeBulkAction as normalizeGeminiAccountBulkAction,
	normalizeCreateAccounts,
	normalizeListFilter as normalizeGeminiAccountListFilter,
	updateFromBody as geminiAccountUpdateFromAdminBody,
} from "./gemini/accounts/admin-input";
export {
	buildHeaders,
	buildPayload,
	cleanText,
	extractResponseParts,
	extractResponseText,
	extractTextsFromLine,
	generate,
	generateRich,
	generateStream,
	getUrl,
	richResponseShapeSummary,
	wrbResponseShapeSummary,
} from "./gemini/client";
export {
	DEFAULT_GENERATED_IMAGE_HYDRATION_LIMITS,
	generatedImageFetchHeaders,
	generatedImagePreviewFetchUrls,
	hydrateGeneratedImages,
} from "./gemini/client/generated-images";
export {
	CONFIG_ENV_KEYS,
	createRuntimeConfig,
	getConfig,
	RuntimeConfigError,
} from "./config";
export { createGeminiCompletionProvider } from "./gemini/completion-provider";
export {
	createStreamTextExtractor,
	stripArtifacts,
} from "./gemini/client/parser";
export {
	configWithCachedGeminiBuildLabel,
	getCachedGeminiBuildLabel,
	getFreshGeminiBuildLabel,
	resetGeminiBuildLabelCacheForTest,
	setCachedGeminiBuildLabel,
	waitBeforeRetry,
} from "./gemini/client/retry";
export {
	invalidGeminiCookieError,
	isInvalidGeminiCookieError,
	unverifiedGeminiCookieError,
} from "./gemini/client/errors";
export {
	configWithActiveGeminiCookie,
	mergeSetCookieHeaders,
	parseCookieHeader,
	resetActiveGeminiCookieForTest,
	rotateGeminiCookieForRetry,
	rotateGeminiCookieForRetryWithReason,
	splitSetCookieHeader,
} from "./gemini/cookies";
export { D1GeminiAccountStore } from "./gemini/accounts/store-d1";
export {
	createGeminiAccountAdminServiceFromD1,
	createGeminiAccountAdminServiceFromEnv,
	GeminiAccountAdminError,
	GeminiAccountAdminService,
} from "./gemini/accounts/admin";
export { AccountPoolService } from "./gemini/accounts/pool";
export { classifyGeminiAccountOutcome } from "./gemini/accounts/classify";
export {
	createGeminiAccountRuntimeFromEnv,
	d1BindingFromEnv,
	getGeminiAccountRuntimeFromEnv,
	GeminiAccountRuntime,
} from "./gemini/accounts/runtime";
export {
	changedRows,
	cleanAccountString,
	normalizeGeminiCookieHeader,
	sha256Hex,
} from "./gemini/accounts/normalize";
export {
	boundedGeminiAccountPageLimit,
	geminiAccountState,
	isDurableGeminiAccountIssue,
	isGeminiAccountIssue,
	isGeminiAccountState,
	isTemporaryGeminiAccountIssue,
	visibleGeminiAccountIssue,
} from "./gemini/accounts/domain";
export {
	extractGeminiAppPageTokens,
	extractGeminiBuildLabel,
	extractGeminiPushId,
} from "./gemini/app-page";
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
	logStage,
	randomBytes,
	randHex,
	sleep,
	throwIfAborted,
	timeoutSignal,
	upstreamErrorCode,
	upstreamErrorMessage,
	upstreamErrorStatus,
	uuid,
} from "./shared/runtime";
export { _sapisidHashCache, makeSapisidHash } from "./gemini/auth";
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
export {
	adminAuthorized,
	handleGeminiAccountAdminRequest,
	isGeminiAccountAdminPath,
} from "./http/admin/gemini-accounts";
export {
	handleGeminiAccountAdminUiRequest,
	isGeminiAccountAdminUiPath,
} from "./http/admin/gemini-account-webui";
export { sseResponse } from "./http/core/sse";
export {
	streamErrorText,
	streamInterruptedWarningText,
	streamWarningObject,
	writeStreamWarningEvent,
} from "./http/core/stream-errors";
export { httpFetch } from "./gemini/transport/http";
export {
	createOriginScopedStringCache,
	geminiAccountCacheScope,
} from "./gemini/cache";
export { base64ToBytes } from "./attachments/media";
export {
	collectOpenAIInlineUploadImages,
	collectOpenAIRequestAttachmentPlan,
} from "./attachments/collect-openai";
export { createAttachmentPlan } from "./attachments/plan";
export { attachmentDrop, droppedAttachmentNote } from "./attachments/notes";
export {
	getCachedGeminiPushId,
	getGeminiPushId,
	getPageTokens,
	refreshGeminiPushId,
	resetGeminiUploadCachesForTest,
	setCachedGeminiPushId,
} from "./gemini/uploads/tokens";
export { buildMultipartFileBody } from "./gemini/uploads/multipart";
export {
	attachmentDedupeKeyForTest,
	resolveFiles,
	resolveImages,
	uploadImage,
	uploadTextFile,
} from "./gemini/uploads/execute";
export { mapWithConcurrencyAndWeight } from "./gemini/concurrency";
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
export { prepareOpenAIImageGenerationCompletion } from "./completion/image-generation";
export { ensureInlineToolPrompt } from "./completion/tool-prompt-guard";
export {
	EMPTY_UPSTREAM_MSG,
	createCompletionStreamLifecycle,
	finalizeOpenAICompletionResult,
	recordCompletionStreamEvent,
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
export {
	buildGoogleToolPrompt,
	googleContentsToOpenAIMessages,
	googleContentsToPrompt,
	googleToolChoiceInstruction,
} from "./promptcompat/google";
export {
	buildGoogleHistoryTranscript,
	buildOpenAIHistoryTranscript,
	latestGoogleUserInputText,
	latestOpenAIUserInputText,
} from "./promptcompat/history";
export {
	normalizeResponsesInputAsMessages,
	normalizeResponsesInputAsMessagesStrict,
	normalizeResponsesInputValueAsMessages,
	responsesMessagesFromRequest,
	stringifyToolCallArguments,
} from "./promptcompat/responses-input";
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
export {
	indentPromptParameters,
	promptCDATA,
	wrapParameter,
	xmlEscapeAttr,
} from "./toolcall/prompt-xml";
export {
	formatPromptParamValue,
	formatPromptToolCallBlock,
	isSafeXmlElementName,
} from "./toolcall";
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
export {
	streamOpenAIChatPlain,
	streamOpenAIChatWithToolSieve,
} from "./http/openai/chat-stream";
export { createDeltaCoalescer } from "./http/stream/coalescer";
export { handleResponses } from "./http/openai/responses";
export { handleChat } from "./http/openai/chat";
export {
	handleImageEdits,
	handleImageEditsMultipart,
	handleImageGenerations,
} from "./http/openai/images";
export {
	imageGenerationMode,
	isImageGenerationRequest,
} from "./http/openai/image-generation";
export {
	buildOpenAIImagesResponse,
	buildResponsesOutput,
	openAIChatChunk,
	openAIChatUsageFromCompletionTokens,
	openAIResponsesUsage,
	writeOpenAIChatStreamError,
	writeOpenAIChatUsageTokenChunk,
} from "./http/openai/format";
export {
	googleGenerateContentResponse,
	googleStreamDonePayload,
} from "./http/google/format";
export {
	openAIErrorResponse,
	openAIErrorType,
	openAIUpstreamErrorResponse,
} from "./http/openai/errors";
export { handleGoogleGenerate } from "./http/google/handlers";
export { streamGooglePlain, streamGoogleTools } from "./http/google/stream";
export { streamResponsesWithToolSieve } from "./http/openai/responses-stream";
export { streamGoogleToolCompletionEvents } from "./completion/google";
export {
	_joinByteChunks,
	_setConnectForTest,
	bytesFromBody,
	closeIdleSocketPool,
	closeSocketQuietly,
	createByteQueue,
	createSocketPool,
	parseHttpChunkSizeLine,
	putIdleSocket,
	SOCKET_KEEP_ALIVE_IDLE_MS,
	SOCKET_KEEP_ALIVE_MAX_IDLE_PER_ORIGIN,
	socketHttp,
	socketPoolKey,
	socketTimeoutError,
	takeIdleSocket,
	withSocketTimeout,
} from "./gemini/transport/socket";
