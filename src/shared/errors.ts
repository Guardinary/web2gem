import type { ErrorWithMetadata } from "./types";

export const GEMINI_AUTHENTICATED_SESSION_REQUIRED_CODE =
	"gemini_authenticated_session_required";
export const GEMINI_AUTHENTICATED_SESSION_REQUIRED_STATUS = 422;

export type GeminiAuthenticatedSessionReason =
	| "attachment"
	| "image"
	| "large_context"
	| "pro_model";

export function geminiAuthenticatedSessionRequiredMessage(
	reason: GeminiAuthenticatedSessionReason,
): string {
	switch (reason) {
		case "attachment":
			return "This request requires an authenticated Gemini session to upload or reuse attachments";
		case "image":
			return "This request requires an authenticated Gemini session for image generation or editing";
		case "large_context":
			return "This request requires an authenticated Gemini session with context-file uploads enabled because the rendered context exceeds the inline limit";
		case "pro_model":
			return "This model requires an authenticated Gemini session";
	}
}

export function geminiAuthenticatedSessionRequiredError(
	reason: GeminiAuthenticatedSessionReason,
	message = geminiAuthenticatedSessionRequiredMessage(reason),
): ErrorWithMetadata {
	const error: ErrorWithMetadata = new Error(message);
	error.code = GEMINI_AUTHENTICATED_SESSION_REQUIRED_CODE;
	error.status = GEMINI_AUTHENTICATED_SESSION_REQUIRED_STATUS;
	error.reason = reason;
	return error;
}

export function upstreamErrorMessage(error: unknown): string {
	const candidate = error as { message?: unknown } | null | undefined;
	return String(candidate?.message || error);
}

export function upstreamErrorCode(error: unknown): string | undefined {
	const candidate = error as Partial<ErrorWithMetadata> | null | undefined;
	return candidate && typeof candidate.code === "string"
		? candidate.code
		: undefined;
}

export function upstreamErrorStatus(error: unknown): number | undefined {
	const candidate = error as Partial<ErrorWithMetadata> | null | undefined;
	const status = Number(candidate?.status);
	return Number.isInteger(status) && status >= 400 && status <= 599
		? status
		: undefined;
}

export function upstreamErrorReason(error: unknown): string | undefined {
	const candidate = error as Partial<ErrorWithMetadata> | null | undefined;
	return candidate && typeof candidate.reason === "string"
		? candidate.reason
		: undefined;
}

export function errorLogSummary(error: unknown): string {
	const candidate = error as Partial<ErrorWithMetadata> | null | undefined;
	const parts = [
		`type=${candidate && typeof candidate.name === "string" && candidate.name ? candidate.name : typeof error}`,
	];
	const code = upstreamErrorCode(error);
	if (code) parts.push(`code=${code}`);
	const reason = upstreamErrorReason(error);
	if (reason) parts.push(`reason=${reason}`);
	const status = upstreamErrorStatus(error);
	if (status) parts.push(`status=${status}`);
	const upstreamStatus = Number(candidate?.upstreamStatus);
	if (
		Number.isInteger(upstreamStatus) &&
		upstreamStatus >= 100 &&
		upstreamStatus <= 599
	)
		parts.push(`upstreamStatus=${upstreamStatus}`);
	const rawLength = Number(candidate?.rawLength);
	if (Number.isInteger(rawLength) && rawLength >= 0)
		parts.push(`rawLength=${rawLength}`);
	return parts.join(" ");
}

export function canFallbackAfterSocketError(
	_method: string,
	error: unknown,
): boolean {
	return !(
		error &&
		typeof error === "object" &&
		(error as Partial<ErrorWithMetadata>).upstreamStatus
	);
}
