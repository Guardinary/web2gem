// Entry for the smoke/bench harness bundle (dist/harness.js).
// Exports only what scripts/smoke.mjs and scripts/bench.mjs consume;
// unit tests import src modules directly and must not use this surface.
export { default } from "./index";
export { base64ToBytes } from "./attachments/base64";
export { prepareOpenAIGeminiContext } from "./completion/context";
export { getConfig } from "./config";
export { GeminiAccountAdminService } from "./gemini/accounts/admin";
export { generateStream } from "./gemini/client";
export { createStreamTextExtractor } from "./gemini/client/parser";
export { buildPayload } from "./gemini/client/protocol";
export { getFreshGeminiBuildLabel } from "./gemini/client/retry";
export { createByteQueue } from "./gemini/transport/byte-queue";
export { socketHttp } from "./gemini/transport/socket";
export { attachmentDedupeKeyForTest } from "./gemini/uploads/execute";
export { buildMultipartFileBody } from "./gemini/uploads/multipart";
export {
	getPageTokens,
	resetGeminiUploadCachesForTest,
} from "./gemini/uploads/tokens";
export { readJsonRequest } from "./http/core/json";
export { sseResponse } from "./http/core/sse";
export { streamGooglePlain } from "./http/google/stream";
export { streamResponsesWithToolSieve } from "./http/openai/responses-stream";
export { messagesToPrompt } from "./promptcompat/messages";
export { normalizeResponsesInputAsMessages } from "./promptcompat/responses-input";
export { randHex } from "./shared/crypto";
export { parseToolCalls } from "./toolcall/dsml";
export { maskMarkdownProtectedSpans } from "./toolcall/markdown";
export { buildToolCallInstructions } from "./toolcall/prompt-format";
export {
	extractFirstJsonDocument,
	validateStructuredOutputValue,
} from "./toolcall/structured";
export { createToolBundle } from "./toolcall/tool-bundle";
export {
	createToolSieveState,
	flushToolSieve,
	processToolSieveChunk,
} from "./toolstream";
