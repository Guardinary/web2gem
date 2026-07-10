import type { GeminiAccountOutcome } from "./types";

const AUTH_STATUSES = new Set([401, 403]);
const RATE_LIMIT_STATUSES = new Set([402, 429]);

const AUTH_MARKERS = [
	"invalid_gemini_cookie",
	"missing_page_at_token",
	"missing gemini page auth token",
	"login required",
	"sign in",
	"unauthorized",
	"forbidden",
];

const USER_ACTION_MARKERS = [
	"terms of service",
	"guardian",
	"parent approval",
	"verify your age",
	"needs user action",
];

const LOCATION_BLOCK_MARKERS = [
	"not available in your country",
	"location",
	"ip block",
	"unsupported region",
];

export function classifyGeminiAccountOutcome(
	error: unknown,
	nowMs: number,
): GeminiAccountOutcome {
	const upstreamStatus =
		numericField(error, "upstreamStatus") ?? numericField(error, "status");
	const code = stringField(error, "code");
	const text = safeErrorText(error);
	const lower = text.toLowerCase();

	if (
		AUTH_STATUSES.has(Number(upstreamStatus)) ||
		code === "invalid_gemini_cookie" ||
		hasMarker(lower, AUTH_MARKERS)
	) {
		return {
			kind: "failure",
			failureKind: "auth",
			status: "needs_cookie_update",
			stateReason: "auth",
			upstreamStatus,
			errorCode: code || "auth",
			errorMessageRedacted: "Gemini account authentication failed",
			nowMs,
		};
	}

	if (
		RATE_LIMIT_STATUSES.has(Number(upstreamStatus)) ||
		/\b(429|quota|rate limit|usage limit|1037)\b/i.test(text)
	) {
		return {
			kind: "failure",
			failureKind: "rate_limit",
			status: "rate_limited",
			stateReason: "rate_limit",
			cooldownUntilMs: nowMs + 5 * 60 * 1000,
			upstreamStatus,
			errorCode: code || "rate_limit",
			errorMessageRedacted: "Gemini account is rate limited",
			nowMs,
		};
	}

	if (hasMarker(lower, USER_ACTION_MARKERS)) {
		return durableFailure(
			"needs_user_action",
			"needs_user_action",
			"Gemini account needs user action",
			upstreamStatus,
			code,
			nowMs,
		);
	}

	if (hasMarker(lower, LOCATION_BLOCK_MARKERS) || /\b1060\b/.test(text)) {
		return durableFailure(
			"location_or_ip_block",
			"hard_blocked",
			"Gemini account is blocked by location or IP",
			upstreamStatus,
			code,
			nowMs,
		);
	}

	if (/\b(1050|1052|model invalid|capability)\b/i.test(text)) {
		return durableFailure(
			"model_capability",
			"capability_mismatch",
			"Gemini account lacks requested capability",
			upstreamStatus,
			code,
			nowMs,
		);
	}

	if (
		Number(upstreamStatus) >= 500 ||
		/\b(5\d\d|network|timeout|empty response|1013)\b/i.test(text)
	) {
		return {
			kind: "failure",
			failureKind: Number(upstreamStatus) >= 500 ? "upstream_5xx" : "transient",
			status: "transient_failed",
			stateReason: "transient",
			cooldownUntilMs: nowMs + 60 * 1000,
			upstreamStatus,
			errorCode: code || "transient",
			errorMessageRedacted: "Gemini account hit a transient upstream failure",
			nowMs,
		};
	}

	return {
		kind: "failure",
		failureKind: "unknown",
		status: "transient_failed",
		stateReason: "unknown",
		cooldownUntilMs: nowMs + 60 * 1000,
		upstreamStatus,
		errorCode: code || "unknown",
		errorMessageRedacted: "Gemini account hit an unknown runtime failure",
		nowMs,
	};
}

function durableFailure(
	failureKind: GeminiAccountOutcome["failureKind"],
	status: NonNullable<GeminiAccountOutcome["status"]>,
	message: string,
	upstreamStatus: number | undefined,
	code: string,
	nowMs: number,
): GeminiAccountOutcome {
	return {
		kind: "failure",
		failureKind,
		status,
		stateReason: failureKind || "failure",
		upstreamStatus,
		errorCode: code || failureKind || "failure",
		errorMessageRedacted: message,
		nowMs,
	};
}

function hasMarker(text: string, markers: readonly string[]): boolean {
	return markers.some((marker) => text.includes(marker));
}

function numericField(value: unknown, field: string): number | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = (value as Record<string, unknown>)[field];
	const n = Number(raw);
	return Number.isFinite(n) ? n : undefined;
}

function stringField(value: unknown, field: string): string {
	if (!value || typeof value !== "object") return "";
	const raw = (value as Record<string, unknown>)[field];
	return raw == null ? "" : String(raw);
}

function safeErrorText(error: unknown): string {
	if (!error) return "";
	if (typeof error === "string") return error;
	if (typeof error === "object") {
		const record = error as Record<string, unknown>;
		return [
			record.code,
			record.reason,
			record.message,
			record.status,
			record.upstreamStatus,
		]
			.filter((value) => value !== undefined && value !== null)
			.map(String)
			.join(" ");
	}
	return String(error);
}
