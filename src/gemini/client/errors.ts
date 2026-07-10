import type { ErrorWithMetadata } from "../../shared/types";
import { promptByteLength } from "../../shared/tokens";

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
	const err: ErrorWithMetadata = new Error(
		`Gemini returned image generation provider error code ${String(code || "unknown")}`,
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
