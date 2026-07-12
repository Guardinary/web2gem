import {
	GEMINI_AUTHENTICATED_SESSION_REQUIRED_CODE,
	GEMINI_AUTHENTICATED_SESSION_REQUIRED_STATUS,
	geminiAuthenticatedSessionRequiredMessage,
} from "../../shared/errors";
import { contextFileThreshold } from "../../completion/context-files";
import { elapsedMs, logStage, nowMs } from "../../shared/logging";
import type { UnknownRecord } from "../../shared/types";
import { readJsonRequest, requestContentLength } from "./json";
import type { ReadJsonRequestOptions } from "./json";

const LARGE_CONTEXT_INLINE_UNSUPPORTED = "large_context_inline_unsupported";

type RouteJsonConfig = {
	current_input_file_enabled?: unknown;
	current_input_file_min_bytes?: unknown;
	generic_file_upload_max_bytes?: unknown;
	request_body_max_bytes?: unknown;
	supports_authenticated_session?: unknown;
	log_requests?: unknown;
};

const JSON_ATTACHMENT_OVERHEAD_BYTES = 1024 * 1024;

export type RouteJsonPostResult =
	| {
			value: UnknownRecord;
			error?: undefined;
			status?: undefined;
			code?: undefined;
			reason?: undefined;
	  }
	| {
			error: string;
			status: number;
			code?: string;
			reason?: string;
			value?: undefined;
	  };

export async function readRouteJsonPost(
	request: Request,
	cfg: RouteJsonConfig,
	path: string,
): Promise<RouteJsonPostResult> {
	const rejection = oversizedInlineBodyRejection(request, cfg, path);
	if (rejection) return rejection;
	const parsed = await readJsonForRoute(request, cfg, path);
	if (parsed.error !== undefined) {
		const errorResult: Extract<RouteJsonPostResult, { error: string }> = {
			error: parsed.error,
			status: parsed.status || 400,
		};
		if (parsed.code) errorResult.code = parsed.code;
		return errorResult;
	}
	return { value: parsed.value };
}

export function googleJsonError(
	message: string,
	code?: string,
	reason?: string,
): { error: { message: string; code?: string; reason?: string } } {
	const error: { message: string; code?: string; reason?: string } = {
		message,
	};
	if (code) error.code = code;
	if (reason) error.reason = reason;
	return { error };
}

function oversizedInlineBodyRejection(
	request: Request,
	cfg: RouteJsonConfig,
	path: string,
): {
	message: string;
	error: string;
	status: number;
	code: string;
	reason?: string;
} | null {
	const unavailable = inlineContextUnavailableReason(cfg);
	if (!unavailable) return null;
	const contentLength = requestContentLength(request);
	if (contentLength == null) return null;
	const threshold = contextFileThreshold(cfg);
	const bodyLimit = inlineContextBodyReadLimit(cfg, threshold);
	const requestBodyLimit = positiveIntegerOrNull(cfg.request_body_max_bytes);
	if (requestBodyLimit != null && requestBodyLimit < bodyLimit) return null;
	if (contentLength <= bodyLimit) return null;
	const missingSession = !cfg.supports_authenticated_session;
	const status = missingSession
		? GEMINI_AUTHENTICATED_SESSION_REQUIRED_STATUS
		: 422;
	const code = missingSession
		? GEMINI_AUTHENTICATED_SESSION_REQUIRED_CODE
		: LARGE_CONTEXT_INLINE_UNSUPPORTED;
	logStage(cfg, "request_json_reject", {
		path,
		status,
		code,
		bodyBytes: contentLength,
		threshold,
		bodyLimit,
	});
	const message = missingSession
		? `${geminiAuthenticatedSessionRequiredMessage("large_context")} (request body ${contentLength} bytes > inline read limit ${bodyLimit}; inline prompt threshold ${threshold})`
		: `request body is too large to parse without Gemini text attachments (${contentLength} bytes > ${bodyLimit}; inline prompt threshold ${threshold}) and ${unavailable}; enable Gemini text attachments or reduce the request size`;
	const rejection: {
		status: number;
		code: string;
		message: string;
		error: string;
		reason?: string;
	} = {
		status,
		code,
		message,
		error: message,
	};
	if (missingSession) rejection.reason = "large_context";
	return rejection;
}

async function readJsonForRoute(
	request: Request,
	cfg: RouteJsonConfig,
	path: string,
) {
	const options = oversizedInlineBodyReadOptions(cfg);
	const start = cfg.log_requests ? nowMs() : 0;
	const parsed = await readJsonRequest(request, options);
	if (cfg.log_requests) {
		logStage(cfg, "request_json", {
			path,
			ms: elapsedMs(start),
			status: parsed.error !== undefined ? parsed.status : 200,
			code: parsed.code,
			bodyBytes: parsed.bytes ?? requestContentLength(request) ?? "unknown",
			bodyLimit: options?.maxBodyBytes,
		});
	}
	return parsed;
}

function oversizedInlineBodyReadOptions(
	cfg: RouteJsonConfig,
): ReadJsonRequestOptions | undefined {
	const requestBodyLimit = positiveIntegerOrNull(cfg.request_body_max_bytes);
	const unavailable = inlineContextUnavailableReason(cfg);
	if (!unavailable) return requestBodyReadOptions(requestBodyLimit);
	const threshold = contextFileThreshold(cfg);
	const bodyLimit = inlineContextBodyReadLimit(cfg, threshold);
	if (requestBodyLimit != null && requestBodyLimit < bodyLimit)
		return requestBodyReadOptions(requestBodyLimit);
	const missingSession = !cfg.supports_authenticated_session;
	return {
		maxBodyBytes: bodyLimit,
		oversizedError: {
			status: missingSession
				? GEMINI_AUTHENTICATED_SESSION_REQUIRED_STATUS
				: 422,
			code: missingSession
				? GEMINI_AUTHENTICATED_SESSION_REQUIRED_CODE
				: LARGE_CONTEXT_INLINE_UNSUPPORTED,
			message: missingSession
				? `${geminiAuthenticatedSessionRequiredMessage("large_context")} (request body exceeds inline read limit ${bodyLimit}; inline prompt threshold ${threshold})`
				: `request body is too large to parse without Gemini text attachments (at least ${bodyLimit + 1} UTF-8 bytes > ${bodyLimit}; inline prompt threshold ${threshold}) and ${unavailable}; enable Gemini text attachments or reduce the request size`,
			...(missingSession ? { reason: "large_context" } : {}),
		},
	};
}

function requestBodyReadOptions(
	requestBodyLimit: number | null,
): ReadJsonRequestOptions | undefined {
	if (requestBodyLimit == null) return undefined;
	return {
		maxBodyBytes: requestBodyLimit,
		oversizedError: {
			status: 413,
			code: "request_body_too_large",
			message: `request body exceeds configured JSON limit (${requestBodyLimit} bytes)`,
		},
	};
}

function positiveIntegerOrNull(value: unknown): number | null {
	const numberValue = Number(value);
	if (!Number.isSafeInteger(numberValue) || numberValue <= 0) return null;
	return numberValue;
}

export function inlineContextBodyReadLimit(
	cfg: RouteJsonConfig,
	threshold: number = contextFileThreshold(cfg),
): number {
	const attachmentMaxBytes = Number(cfg.generic_file_upload_max_bytes);
	if (!Number.isFinite(attachmentMaxBytes) || attachmentMaxBytes <= 0)
		return threshold;
	const encodedAttachmentBytes = Math.ceil(
		(Math.floor(attachmentMaxBytes) * 4) / 3,
	);
	return threshold + encodedAttachmentBytes + JSON_ATTACHMENT_OVERHEAD_BYTES;
}

function inlineContextUnavailableReason(cfg: RouteJsonConfig): string {
	if (!cfg.current_input_file_enabled)
		return "CURRENT_INPUT_FILE_ENABLED is disabled";
	if (!cfg.supports_authenticated_session)
		return "Gemini account pool is not configured";
	return "";
}
