// Internal compatibility surface used by local unit and smoke tests.

export {
	loadAccounts,
	loadModelRouting,
	moveModelRoute,
	saveModelRoutePriority,
	submitImport,
	updateAdminKey,
} from "./admin-ui/actions";
export {
	createAccountsWithLimitFallback,
	getModelRoutingOverview,
	replaceModelRoutePriority,
	resetModelRoutePriority,
} from "./admin-ui/api";
export { detectLanguage, statusLabel } from "./admin-ui/i18n";
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
	isAccount,
	parseModelRoutingOverview,
	parseMutation,
	parseOverview,
} from "./admin-ui/schemas";
export {
	accountStats,
	accounts,
	adminKey,
	authExpanded,
	connectionVerified,
	importBatch,
	importPsid,
	importPsidts,
	modelRouting,
	modelRoutingDrafts,
} from "./admin-ui/state";
export { resolveTheme } from "./admin-ui/theme";
export { handleApplicationRequest } from "./app";
export {
	collectOpenAIInlineUploadImages,
	collectOpenAIRequestAttachmentPlan,
} from "./attachments/collect-openai";
export {
	base64ToBytes,
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
export { attachmentDrop, droppedAttachmentNote } from "./attachments/notes";
export { createAttachmentPlan } from "./attachments/plan";
export {
	createCompletionStreamLifecycle,
	EMPTY_UPSTREAM_MSG,
	finalizeOpenAICompletionResult,
	recordCompletionStreamEvent,
	streamBufferedToolTextCompletionEvents,
	streamPlainCompletionEvents,
	streamToolSieveCompletionEvents,
	upstreamEmptyWarning,
} from "./completion";
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
export { streamGoogleToolCompletionEvents } from "./completion/google";
export { finalizeGoogleCompletionResult } from "./completion/google-turn";
export { prepareOpenAIImageGenerationCompletion } from "./completion/image-generation";
export { ensureInlineToolPrompt } from "./completion/tool-prompt-guard";
export {
	CONFIG_ENV_KEYS,
	createRuntimeConfig,
	getConfig,
	RuntimeConfigError,
} from "./config";
export {
	createGeminiAccountAdminServiceFromD1,
	createGeminiAccountAdminServiceFromEnv,
	GeminiAccountAdminError,
	GeminiAccountAdminService,
} from "./gemini/accounts/admin";
export {
	createInputFromAccount as createGeminiAccountInputFromAdmin,
	hasAccountUpdate,
	listFilterFromSearchParams as geminiAccountListFilterFromSearchParams,
	normalizeBulkAction as normalizeGeminiAccountBulkAction,
	normalizeCreateAccounts,
	normalizeListFilter as normalizeGeminiAccountListFilter,
	updateFromBody as geminiAccountUpdateFromAdminBody,
} from "./gemini/accounts/admin-input";
export { classifyGeminiAccountOutcome } from "./gemini/accounts/classify";
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
	changedRows,
	cleanAccountString,
	identityHashFromCookie,
	normalizeGeminiCookieHeader,
	sha256Hex,
} from "./gemini/accounts/normalize";
export { AccountPoolService } from "./gemini/accounts/pool";
export {
	decodeGeminiAccountProbe,
	fetchGeminiAccountProbe,
	verifyGeminiAccount,
} from "./gemini/accounts/probe";
export {
	createGeminiAccountRuntimeFromEnv,
	d1BindingFromEnv,
	GeminiAccountRuntime,
	getGeminiAccountRuntimeFromEnv,
} from "./gemini/accounts/runtime";
export { D1GeminiAccountStore } from "./gemini/accounts/store-d1";
export {
	extractGeminiAppPageTokens,
	extractGeminiBuildLabel,
	extractGeminiPushId,
} from "./gemini/app-page";
export { _sapisidHashCache, makeSapisidHash } from "./gemini/auth";
export {
	createOriginScopedStringCache,
	geminiAccountCacheScope,
} from "./gemini/cache";
export {
	buildHeaders,
	buildPayload,
	cleanText,
	extractResponseFatalCode,
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
	invalidGeminiCookieError,
	isInvalidGeminiCookieError,
	unverifiedGeminiCookieError,
} from "./gemini/client/errors";
export {
	DEFAULT_GENERATED_IMAGE_HYDRATION_LIMITS,
	generatedImageFetchHeaders,
	generatedImagePreviewFetchUrls,
	hydrateGeneratedImages,
} from "./gemini/client/generated-images";
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
export { createGeminiCompletionProvider } from "./gemini/completion-provider";
export { mapWithConcurrencyAndWeight } from "./gemini/concurrency";
export {
	configWithActiveGeminiCookie,
	mergeSetCookieHeaders,
	observeGeminiAccountResponseCookies,
	parseCookieHeader,
	resetActiveGeminiCookieForTest,
	rotateGeminiCookieForRetry,
	rotateGeminiCookieForRetryWithReason,
	splitSetCookieHeader,
} from "./gemini/cookies";
export { httpFetch } from "./gemini/transport/http";
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
export {
	attachmentDedupeKeyForTest,
	resolveFiles,
	resolveImages,
	uploadImage,
	uploadTextFile,
} from "./gemini/uploads/execute";
export { buildMultipartFileBody } from "./gemini/uploads/multipart";
export {
	getCachedGeminiPushId,
	getFreshPageTokensForConfig,
	getGeminiPushId,
	getPageTokens,
	refreshGeminiPushId,
	resetGeminiUploadCachesForTest,
	setCachedGeminiPushId,
} from "./gemini/uploads/tokens";
export {
	handleGeminiAccountAdminUiRequest,
	isGeminiAccountAdminUiPath,
} from "./http/admin/gemini-account-webui";
export {
	adminAuthorized,
	handleGeminiAccountAdminRequest,
	isGeminiAccountAdminPath,
} from "./http/admin/gemini-accounts";
export { readJsonRequest } from "./http/core/json";
export { readRouteJsonPost } from "./http/core/route-json";
export { sseResponse } from "./http/core/sse";
export {
	streamErrorText,
	streamInterruptedWarningText,
	streamWarningObject,
	writeStreamWarningEvent,
} from "./http/core/stream-errors";
export {
	googleGenerateContentResponse,
	googleStreamDonePayload,
} from "./http/google/format";
export { handleGoogleGenerate } from "./http/google/handlers";
export { parseGoogleGenerationPath } from "./http/google/model-path";
export { streamGooglePlain, streamGoogleTools } from "./http/google/stream";
export { handleChat } from "./http/openai/chat";
export {
	streamOpenAIChatPlain,
	streamOpenAIChatWithToolSieve,
} from "./http/openai/chat-stream";
export {
	openAIErrorResponse,
	openAIErrorType,
	openAIUpstreamErrorResponse,
} from "./http/openai/errors";
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
	imageGenerationMode,
	isImageGenerationRequest,
} from "./http/openai/image-generation";
export {
	handleImageEdits,
	handleImageEditsMultipart,
	handleImageGenerations,
} from "./http/openai/images";
export { handleResponses } from "./http/openai/responses";
export { streamResponsesWithToolSieve } from "./http/openai/responses-stream";
export { createDeltaCoalescer } from "./http/stream/coalescer";
export {
	basicRouteForFamily,
	buildGeminiModelHeaders,
	dynamicProviderModelCandidates,
	familyForProviderModelId,
	geminiRouteKey,
	knownTierLabel,
	modelNumberForProviderModelId,
	parseGeminiRouteKey,
	resolveModel,
} from "./models";
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
export { messagesToPrompt } from "./promptcompat/messages";
export {
	appendStructuredOutputInstructionToPrepared,
	appendStructuredOutputInstructionWithTokens,
	appendTextToPreparedWithTokens,
	withGeminiNativeHiddenToolsPromptForPrepared,
	withGeminiNativeHiddenToolsPromptWithTokens,
} from "./promptcompat/prompt-build";
export { createPromptPartAccumulator } from "./promptcompat/prompt-text";
export {
	normalizeResponsesInputAsMessages,
	normalizeResponsesInputAsMessagesStrict,
	normalizeResponsesInputValueAsMessages,
	responsesMessagesFromRequest,
	stringifyToolCallArguments,
} from "./promptcompat/responses-input";
export {
	abortError,
	canFallbackAfterSocketError,
	errorLogSummary,
	isAbortError,
	log,
	logStage,
	randHex,
	randomBytes,
	sleep,
	throwIfAborted,
	timeoutSignal,
	upstreamErrorCode,
	upstreamErrorMessage,
	upstreamErrorStatus,
	uuid,
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
export {
	allowedToolNameFromItem,
	buildCorrectToolExamples,
	buildReadToolCacheGuard,
	buildToolCallInstructions,
	buildToolChoiceInstructionFromPolicy,
	buildToolSchemaIndex,
	contentTextForHistory,
	createToolBundle,
	ensureStreamToolCallID,
	exampleBasicParams,
	exampleNestedParams,
	exampleScriptParams,
	extractToolMeta,
	extractToolNames,
	filterGoogleToolsByConfig,
	filterToolBundleByPolicy,
	filterToolsByPolicy,
	findToolCallSyntaxCandidateStart,
	firstBasicExample,
	firstNBasicExamples,
	firstNestedExample,
	firstNonNil,
	firstScriptExample,
	formatOpenAIStreamToolCalls,
	formatOpenAIToolCalls,
	formatPromptParamValue,
	formatPromptToolCallBlock,
	hasReadLikeTool,
	hasToolCallMarkupSyntaxCandidate,
	isInsideMarkdownFence,
	isInsideSimpleMarkdownCodeSpan,
	isMarkdownProtectedPosition,
	isPartialToolCallSyntaxPrefix,
	isSafeXmlElementName,
	looksLikeArraySchema,
	looksLikeObjectSchema,
	markdownProtectedRanges,
	markdownProtectedSpanStartAtCut,
	markdownProtectedTailStart,
	maskMarkdownProtectedSpans,
	mergeFileRefs,
	messageContentToPrompt,
	namesToSet,
	normalizeParsedToolCallsForSchemas,
	normalizeToolsToOpenAIFunctionTools,
	normalizeToolValueWithSchema,
	nullableOpenAIFunctionTools,
	openAIToolDefs,
	openMarkdownCodeSpanStart,
	openMarkdownFenceStart,
	parseAllowedToolNames,
	parseForcedToolName,
	parseGoogleFunctionCalls,
	parseGoogleToolChoicePolicy,
	parseMarkdownFenceLine,
	parseOpenAIToolChoicePolicy,
	policyHasAllowed,
	reasoningTextForHistory,
	renderToolExampleBlock,
	responsesContentToText,
	shouldCoerceSchemaToString,
	stringifySchemaValue,
	toolCallInstructionsFor,
	toolDefsFromTools,
	toolFunctionDeclarations,
	toolItemsFromTools,
	toolMetasFromTools,
	toolNamesForPromptSource,
	toolPolicyAllows,
	toolPromptBlockFor,
	toolsContextTranscriptFor,
	uniqueToolNames,
	validateGoogleFunctionCalls,
	validateGoogleToolChoiceConfig,
	validateRequiredToolCalls,
	validateToolPolicyCalls,
} from "./toolcall";
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
	createToolSieveState,
	flushToolSieve,
	flushToolSievePlainPrefix,
	hasToolCallCloseSyntax,
	hasToolSieveSentinel,
	processToolSieveChunk,
	TOOL_SIEVE_PLAIN_TEXT_KEEP,
} from "./toolstream";
