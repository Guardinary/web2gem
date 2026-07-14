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

const REQUEST_SCOPED_MARKERS = [
	"model invalid",
	"invalid model",
	"capability",
	"model not available",
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
	const semanticSource = stringField(error, "geminiSource");
	const semanticCode = stringField(error, "geminiCode");
	if (semanticSource === "account_status") {
		if (semanticCode === "1014")
			return {
				kind: "failure",
				issue: "transient",
				cooldownUntilMs: nowMs + 60 * 1000,
				recoveryScope: "none",
				nowMs,
			};
		if (semanticCode === "1016")
			return {
				kind: "failure",
				issue: "auth",
				recoveryScope: "none",
				nowMs,
			};
		if (["1021", "1033", "1040", "1042", "1054", "1057"].includes(semanticCode))
			return {
				kind: "failure",
				issue: "user_action",
				recoveryScope: "none",
				nowMs,
			};
		if (semanticCode === "1060")
			return {
				kind: "failure",
				issue: "location",
				recoveryScope: "none",
				nowMs,
			};
	}

	if (semanticSource === "stream_generate") {
		switch (semanticCode) {
			case "1013":
				return {
					kind: "failure",
					issue: "transient",
					cooldownUntilMs: nowMs + 60 * 1000,
					recoveryScope: "try_next_account",
					nowMs,
				};
			case "1037":
				return {
					kind: "failure",
					issue: "rate_limit",
					cooldownUntilMs: nowMs + 5 * 60 * 1000,
					recoveryScope: "try_next_account",
					nowMs,
				};
			case "1050":
				return {
					kind: "failure",
					recoveryScope: "try_next_account",
					nowMs,
				};
			case "1052":
			case "1060":
				return { kind: "failure", recoveryScope: "none", nowMs };
		}
	}

	if (
		AUTH_STATUSES.has(Number(upstreamStatus)) ||
		code === "invalid_gemini_cookie" ||
		hasMarker(lower, AUTH_MARKERS)
	) {
		return {
			kind: "failure",
			issue: "auth",
			recoveryScope: "try_next_account",
			nowMs,
		};
	}

	if (
		RATE_LIMIT_STATUSES.has(Number(upstreamStatus)) ||
		/\b(429|quota|rate limit|usage limit|1037)\b/i.test(text)
	) {
		return {
			kind: "failure",
			issue: "rate_limit",
			cooldownUntilMs: nowMs + 5 * 60 * 1000,
			recoveryScope: "try_next_account",
			nowMs,
		};
	}

	if (hasMarker(lower, USER_ACTION_MARKERS)) {
		return {
			kind: "failure",
			issue: "user_action",
			recoveryScope: "try_next_account",
			nowMs,
		};
	}

	if (hasMarker(lower, LOCATION_BLOCK_MARKERS) || /\b1060\b/.test(text)) {
		return {
			kind: "failure",
			issue: "location",
			recoveryScope: "try_next_account",
			nowMs,
		};
	}

	if (
		/\b(1050|1052)\b/.test(text) ||
		hasMarker(lower, REQUEST_SCOPED_MARKERS)
	) {
		return { kind: "failure", recoveryScope: "none", nowMs };
	}

	return {
		kind: "failure",
		issue: "transient",
		cooldownUntilMs: nowMs + 60 * 1000,
		recoveryScope: "try_next_account",
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
