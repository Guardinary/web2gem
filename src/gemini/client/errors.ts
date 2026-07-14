import type { ErrorWithMetadata } from "../../shared/types";
import { promptByteLength } from "../../shared/tokens";
import type { GeminiFatalCode } from "./parser";

export const LARGE_PROMPT_EMPTY_RESPONSE_MIN_BYTES = 95000;
export const LARGE_PROMPT_EMPTY_RESPONSE_CODE = "large_prompt_empty_response";
export const DATA_ANALYSIS_EMPTY_RESPONSE_CODE = "data_analysis_empty_response";
export const INVALID_GEMINI_COOKIE_CODE = "invalid_gemini_cookie";
export const UPSTREAM_EMPTY_RESPONSE_CODE = "upstream_empty_response";
export const UPSTREAM_IMAGE_GENERATION_EMPTY_CODE =
	"upstream_image_generation_empty";
export const UPSTREAM_IMAGE_FETCH_FAILED_CODE = "upstream_image_fetch_failed";
export const UPSTREAM_IMAGE_PROVIDER_ERROR_CODE =
	"upstream_image_provider_error";
export const GEMINI_SEMANTIC_ERROR_CODE = "gemini_semantic_error";

export type GeminiSemanticSource = "stream_generate" | "account_status";

type GeminiSemanticError = ErrorWithMetadata & {
	geminiSource: GeminiSemanticSource;
	geminiCode: GeminiFatalCode;
};

const GEMINI_FATAL_REASONS: Record<GeminiFatalCode, string> = {
	"1013": "temporary_model_error",
	"1037": "usage_limit_exceeded",
	"1050": "model_conversation_inconsistent",
	"1052": "model_header_invalid",
	"1060": "temporary_egress_block",
};

const GEMINI_FATAL_MESSAGES: Record<GeminiFatalCode, string> = {
	"1013": "Gemini returned a temporary model error.",
	"1037": "The selected Gemini account reached an upstream usage limit.",
	"1050":
		"The requested model is inconsistent with the current Gemini conversation context.",
	"1052": "Gemini rejected the selected model header or request shape.",
	"1060": "Gemini temporarily blocked the current network egress.",
};

export function geminiSemanticError(
	source: GeminiSemanticSource,
	code: GeminiFatalCode,
	publicCode = GEMINI_SEMANTIC_ERROR_CODE,
): GeminiSemanticError {
	const err = new Error(GEMINI_FATAL_MESSAGES[code]) as GeminiSemanticError;
	err.code = publicCode;
	err.status = code === "1037" ? 429 : 502;
	err.reason = GEMINI_FATAL_REASONS[code];
	err.geminiSource = source;
	err.geminiCode = code;
	return err;
}

export function isGeminiSemanticError(
	error: unknown,
): error is GeminiSemanticError {
	if (!error || typeof error !== "object") return false;
	const record = error as Partial<GeminiSemanticError>;
	return (
		(record.code === GEMINI_SEMANTIC_ERROR_CODE ||
			record.code === UPSTREAM_IMAGE_PROVIDER_ERROR_CODE) &&
		record.geminiSource !== undefined &&
		record.geminiCode !== undefined
	);
}

export function shouldRetryGeminiSemanticErrorOnSameAccount(
	error: unknown,
): boolean {
	return isGeminiSemanticError(error) && error.geminiCode === "1013";
}

const AUTH_FAILURE_STATUSES = new Set([401, 403]);

type LargePromptConfig =
	| { current_input_file_min_bytes?: unknown }
	| null
	| undefined;
type CookieConfig = { cookie?: unknown } | null | undefined;

const COOKIE_DIAGNOSTIC_MESSAGES: Record<string, string> = {
	missing_cookie: "no Gemini cookie is configured",
	missing_secure_1psid: "configured cookie is missing __Secure-1PSID",
	recent_rotation:
		"cookie rotation was skipped because a rotation ran recently",
	rotation_rejected: "Google rejected the RotateCookies request",
	rotation_failed: "RotateCookies returned a non-success status",
	rotation_no_update:
		"RotateCookies completed but did not return an updated cookie",
	rotation_error: "RotateCookies could not be completed",
	rotation_updated:
		"cookie rotation succeeded but Gemini still rejected the request",
	missing_page_at_token: "Gemini page did not return the required auth token",
};

export function largePromptEmptyResponseThreshold(
	cfg: LargePromptConfig,
): number {
	return Math.max(
		0,
		Number(cfg?.current_input_file_min_bytes) ||
			LARGE_PROMPT_EMPTY_RESPONSE_MIN_BYTES,
	);
}

export function largePromptEmptyResponseError(
	prompt: unknown,
	status: unknown,
	rawLength: number | null,
	thresholdBytes: unknown = LARGE_PROMPT_EMPTY_RESPONSE_MIN_BYTES,
): ErrorWithMetadata | null {
	const bytes = promptByteLength(prompt);
	const threshold = Math.max(
		0,
		Number(thresholdBytes) || LARGE_PROMPT_EMPTY_RESPONSE_MIN_BYTES,
	);
	if (bytes <= threshold) return null;
	const err: ErrorWithMetadata = new Error(
		`Context is too long and triggered Gemini Web risk controls, so Gemini returned an empty response ` +
			`(${bytes} UTF-8 bytes > ${threshold}). This is unrelated to GEMINI_BL; ` +
			"configure a Gemini account pool so this worker can route long context through txt attachments, or reduce the latest inline request size.",
	);
	err.code = LARGE_PROMPT_EMPTY_RESPONSE_CODE;
	err.promptBytes = bytes;
	err.thresholdBytes = threshold;
	err.upstreamStatus = Number(status);
	err.rawLength = rawLength;
	return err;
}

export function isLargePromptEmptyResponseError(e: unknown): boolean {
	return (
		!!e &&
		typeof e === "object" &&
		(e as Partial<ErrorWithMetadata>).code === LARGE_PROMPT_EMPTY_RESPONSE_CODE
	);
}

export function dataAnalysisEmptyResponseError(
	rawSnippet: unknown,
	fileRefs: unknown,
): ErrorWithMetadata | null {
	if (!fileRefs || !String(rawSnippet || "").includes("data_analysis_tool"))
		return null;
	const err: ErrorWithMetadata = new Error(
		"Gemini accepted the uploaded context file but routed it into the internal data_analysis_tool and returned no final text. " +
			"This Worker does not implement Gemini Web's follow-up data-analysis tool loop. Try the markdown context-file defaults, lower CURRENT_INPUT_FILE_MIN_BYTES, or disable CURRENT_INPUT_FILE_ENABLED for this request.",
	);
	err.code = DATA_ANALYSIS_EMPTY_RESPONSE_CODE;
	return err;
}

export function isDataAnalysisEmptyResponseError(e: unknown): boolean {
	return (
		!!e &&
		typeof e === "object" &&
		(e as Partial<ErrorWithMetadata>).code === DATA_ANALYSIS_EMPTY_RESPONSE_CODE
	);
}

export function upstreamEmptyResponseError(
	status: unknown,
	rawLength: number | null,
	context = "",
): ErrorWithMetadata {
	const httpStatus = Number(status);
	const err: ErrorWithMetadata = new Error(
		`Gemini upstream HTTP ${Number.isFinite(httpStatus) ? httpStatus : String(status)} returned no parseable text` +
			(context ? ` (${context})` : "") +
			". The upstream request completed but the Worker could not extract a final model response.",
	);
	err.code = UPSTREAM_EMPTY_RESPONSE_CODE;
	err.status = 502;
	err.upstreamStatus = httpStatus;
	err.rawLength = rawLength;
	return err;
}

export function upstreamImageGenerationEmptyError(
	status: unknown,
	rawLength: number | null,
	context = "",
): ErrorWithMetadata {
	const httpStatus = Number(status);
	const err: ErrorWithMetadata = new Error(
		`Gemini upstream HTTP ${Number.isFinite(httpStatus) ? httpStatus : String(status)} returned no usable generated image` +
			(context ? ` (${context})` : "") +
			". The upstream request completed but the Worker could not extract generated image output.",
	);
	err.code = UPSTREAM_IMAGE_GENERATION_EMPTY_CODE;
	err.status = 502;
	err.upstreamStatus = httpStatus;
	err.rawLength = rawLength;
	return err;
}

export function upstreamImageFetchFailedError(
	message: unknown,
	status: unknown = 502,
): ErrorWithMetadata {
	const err: ErrorWithMetadata = new Error(
		`failed to fetch generated image bytes: ${String(message || "unknown error")}`,
	);
	err.code = UPSTREAM_IMAGE_FETCH_FAILED_CODE;
	err.status = 502;
	const upstreamStatus = Number(status);
	if (Number.isFinite(upstreamStatus)) err.upstreamStatus = upstreamStatus;
	return err;
}

export function upstreamImageProviderError(code: unknown): ErrorWithMetadata {
	const normalized = String(code || "") as GeminiFatalCode;
	if (
		normalized === "1013" ||
		normalized === "1037" ||
		normalized === "1050" ||
		normalized === "1052" ||
		normalized === "1060"
	)
		return geminiSemanticError(
			"stream_generate",
			normalized,
			UPSTREAM_IMAGE_PROVIDER_ERROR_CODE,
		);
	const err: ErrorWithMetadata = new Error(
		"Gemini returned an unknown image generation provider error.",
	);
	err.code = UPSTREAM_IMAGE_PROVIDER_ERROR_CODE;
	err.status = 502;
	return err;
}

export function invalidGeminiCookieError(
	cfg: CookieConfig,
	status: unknown,
	rawLength: number | null = null,
	diagnosticReason: unknown = "",
): ErrorWithMetadata | null {
	if (!cfg?.cookie || !AUTH_FAILURE_STATUSES.has(Number(status))) return null;
	const reason = cookieDiagnosticMessage(diagnosticReason);
	const err: ErrorWithMetadata = new Error(
		`Gemini rejected the selected account credentials (upstream HTTP ${status}). ` +
			(reason ? `Diagnostic: ${reason}. ` : "") +
			"Update the Gemini account pool with valid, unexpired Gemini web session credentials.",
	);
	err.code = INVALID_GEMINI_COOKIE_CODE;
	err.status = 401;
	err.upstreamStatus = Number(status);
	err.rawLength = rawLength;
	if (reason) err.reason = reason;
	return err;
}

export function unverifiedGeminiCookieError(
	reason = "missing Gemini page auth token",
) {
	const messageReason = cookieDiagnosticMessage(reason) || reason;
	const err: ErrorWithMetadata = new Error(
		`Could not verify the selected Gemini account credentials (${messageReason}). ` +
			"Update the Gemini account pool with valid, unexpired Gemini web session credentials.",
	);
	err.code = INVALID_GEMINI_COOKIE_CODE;
	err.status = 401;
	return err;
}

export function isInvalidGeminiCookieError(e: unknown): boolean {
	return (
		!!e &&
		typeof e === "object" &&
		(e as Partial<ErrorWithMetadata>).code === INVALID_GEMINI_COOKIE_CODE
	);
}

function cookieDiagnosticMessage(reason: unknown): string {
	const key = String(reason || "").trim();
	return COOKIE_DIAGNOSTIC_MESSAGES[key] || "";
}
