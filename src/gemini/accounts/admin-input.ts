import { isRecord, type UnknownRecord } from "../../shared/types";
import type {
	GeminiAccountAdminFilter,
	GeminiAccountCategory,
	GeminiAccountCreateInput,
	GeminiAccountStatus,
	GeminiAccountUpdate,
} from "./types";

const SAFE_CREATE_KEYS = new Set([
	"provider",
	"__Secure-1PSID",
	"__Secure-1PSIDTS",
	"label",
	"user_agent",
	"gemini_origin",
	"source",
	"source_id",
	"source_name",
]);
const UNSAFE_CREATE_KEYS = new Set([
	"tokens",
	"access_token",
	"accessToken",
	"cookie",
	"cookies",
]);
const COOKIE_NAME_RE = /(?:^|[;\s])__Secure-1PSID(?:TS)?\s*=/i;
const SAFE_UPDATE_KEYS = new Set([
	"label",
	"enabled",
	"status",
	"state_reason",
	"cooldown_until_ms",
	"account_status_code",
	"account_status_description",
	"user_agent",
	"gemini_origin",
	"source",
	"source_id",
	"source_name",
]);
const LIST_QUERY_KEYS = new Set([
	"limit",
	"cursor",
	"status",
	"enabled",
	"q",
	"category",
	"cooldown",
	"source",
]);
const STATS_QUERY_KEYS = new Set([
	"status",
	"enabled",
	"q",
	"category",
	"cooldown",
	"source",
]);

export class GeminiAccountAdminError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "GeminiAccountAdminError";
	}
}

export function accountIdFromPathSegment(segment: string): string {
	let decoded: string;
	try {
		decoded = decodeURIComponent(segment);
	} catch {
		throw new GeminiAccountAdminError(
			400,
			"invalid_account_id",
			"invalid account id",
		);
	}
	const id = decoded.trim();
	if (!id || id.includes("/") || id.length > 200)
		throw new GeminiAccountAdminError(
			400,
			"invalid_account_id",
			"invalid account id",
		);
	return id;
}

export function listFilterFromSearchParams(
	params: URLSearchParams,
	options: { stats?: boolean } = {},
): GeminiAccountAdminFilterInput {
	const allowed = options.stats ? STATS_QUERY_KEYS : LIST_QUERY_KEYS;
	for (const key of new Set(params.keys())) {
		if (!allowed.has(key))
			throw new GeminiAccountAdminError(
				400,
				"unknown_admin_query_parameter",
				`unknown admin query parameter: ${key}`,
			);
		if (params.getAll(key).length !== 1)
			throw new GeminiAccountAdminError(
				400,
				"duplicate_admin_query_parameter",
				`duplicate admin query parameter: ${key}`,
			);
	}

	const filter: GeminiAccountAdminFilterInput = {};
	if (!options.stats && params.has("limit"))
		filter.limit = parsePageLimit(requiredQueryValue(params, "limit"));
	if (!options.stats && params.has("cursor"))
		filter.cursor = boundedQueryText(params, "cursor");
	if (params.has("status"))
		filter.status = normalizeStatus(requiredQueryValue(params, "status"));
	if (params.has("enabled"))
		filter.enabled = parseQueryBoolean(requiredQueryValue(params, "enabled"));
	if (params.has("q")) filter.q = boundedQueryText(params, "q");
	if (params.has("category"))
		filter.category = normalizeCategory(requiredQueryValue(params, "category"));
	if (params.has("cooldown"))
		filter.cooldown = normalizeCooldown(requiredQueryValue(params, "cooldown"));
	if (params.has("source")) filter.source = boundedQueryText(params, "source");
	return filter;
}

export function assertNoAdminQueryParams(params: URLSearchParams): void {
	const first = params.keys().next();
	if (!first.done)
		throw new GeminiAccountAdminError(
			400,
			"unknown_admin_query_parameter",
			`unknown admin query parameter: ${first.value}`,
		);
}

export type GeminiAccountAdminFilterInput = Partial<
	Omit<GeminiAccountAdminFilter, "status" | "category" | "cooldown">
> & {
	status?: unknown;
	category?: unknown;
	cooldown?: unknown;
};

export function normalizeCreateAccounts(body: UnknownRecord): UnknownRecord[] {
	if (
		Array.isArray(body.tokens) &&
		body.tokens.some((token) => cleanOptionalString(token))
	) {
		throw new GeminiAccountAdminError(
			400,
			"gemini_import_dual_cookie_only",
			"Gemini import accepts only __Secure-1PSID and __Secure-1PSIDTS fields",
		);
	}
	const hasBatch = Object.hasOwn(body, "accounts");
	if (hasBatch) {
		for (const key of Object.keys(body)) {
			if (key !== "provider" && key !== "accounts")
				throw new GeminiAccountAdminError(
					400,
					"gemini_import_unknown_field",
					`unsupported Gemini import field: ${key}`,
				);
		}
		if (
			!Array.isArray(body.accounts) ||
			body.accounts.some((item) => !isRecord(item))
		)
			throw new GeminiAccountAdminError(
				400,
				"gemini_import_invalid_accounts",
				"accounts must be an array of JSON objects",
			);
	}
	const topProvider = optionalInputString(body.provider, "provider");
	const accountsRaw = hasBatch ? (body.accounts as UnknownRecord[]) : [body];
	const accounts = accountsRaw;
	if (!accounts.length)
		throw new GeminiAccountAdminError(
			400,
			"gemini_import_account_required",
			"Gemini account payload is required",
		);
	const topLevelGemini = !topProvider || topProvider === "gemini";
	if (topProvider && topProvider !== "gemini") {
		throw new GeminiAccountAdminError(
			400,
			"gemini_provider_mismatch",
			"Gemini admin endpoints accept only provider=gemini",
		);
	}
	for (const item of accounts) validateCreateAccount(item, topLevelGemini);
	return accounts;
}

export function createInputFromAccount(
	item: UnknownRecord,
	nowMs: number,
): GeminiAccountCreateInput {
	const psid = cleanRequiredString(item["__Secure-1PSID"], "__Secure-1PSID");
	const psidts = cleanRequiredString(
		item["__Secure-1PSIDTS"],
		"__Secure-1PSIDTS",
	);
	const input: GeminiAccountCreateInput = {
		cookieHeader: `__Secure-1PSID=${psid}; __Secure-1PSIDTS=${psidts}`,
		nowMs,
	};
	const label = cleanOptionalString(item.label);
	const userAgent = cleanOptionalString(item.user_agent);
	const geminiOrigin = cleanOptionalString(item.gemini_origin);
	const source = cleanOptionalString(item.source);
	const sourceId = cleanOptionalString(item.source_id);
	const sourceName = cleanOptionalString(item.source_name);
	if (label) input.label = label;
	if (userAgent) input.userAgent = userAgent;
	if (geminiOrigin) input.geminiOrigin = geminiOrigin;
	if (source) input.source = source;
	if (sourceId) input.sourceId = sourceId;
	if (sourceName) input.sourceName = sourceName;
	return input;
}

export function updateFromBody(
	body: UnknownRecord,
	nowMs: number,
): GeminiAccountUpdate {
	for (const key of Object.keys(body)) {
		if (!SAFE_UPDATE_KEYS.has(key))
			throw new GeminiAccountAdminError(
				400,
				"unknown_account_update_field",
				`unsupported account update field: ${key}`,
			);
	}
	const update: GeminiAccountUpdate = { nowMs };
	if ("label" in body) update.label = nullableInputString(body.label, "label");
	if ("enabled" in body) {
		if (typeof body.enabled !== "boolean")
			throw new GeminiAccountAdminError(
				400,
				"invalid_account_enabled",
				"enabled must be a boolean",
			);
		update.enabled = body.enabled;
	}
	if ("status" in body) {
		if (typeof body.status !== "string")
			throw new GeminiAccountAdminError(
				400,
				"invalid_account_status",
				"invalid account status",
			);
		const status = normalizeStatus(body.status);
		if (!status)
			throw new GeminiAccountAdminError(
				400,
				"invalid_account_status",
				"invalid account status",
			);
		update.status = status;
	}
	if ("state_reason" in body)
		update.stateReason = nullableInputString(body.state_reason, "state_reason");
	if ("cooldown_until_ms" in body)
		update.cooldownUntilMs = nullableInputNumber(
			body.cooldown_until_ms,
			"cooldown_until_ms",
		);
	if ("account_status_code" in body)
		update.accountStatusCode = nullableInputNumber(
			body.account_status_code,
			"account_status_code",
		);
	if ("account_status_description" in body)
		update.accountStatusDescription = nullableInputString(
			body.account_status_description,
			"account_status_description",
		);
	if ("user_agent" in body)
		update.userAgent = nullableInputString(body.user_agent, "user_agent");
	if ("gemini_origin" in body)
		update.geminiOrigin = nullableInputString(
			body.gemini_origin,
			"gemini_origin",
		);
	if ("source" in body)
		update.source = nullableInputString(body.source, "source");
	if ("source_id" in body)
		update.sourceId = nullableInputString(body.source_id, "source_id");
	if ("source_name" in body)
		update.sourceName = nullableInputString(body.source_name, "source_name");
	return update;
}

export function hasAccountUpdate(update: GeminiAccountUpdate): boolean {
	return Object.keys(update).some((key) => key !== "nowMs");
}

export function normalizeListFilter(
	filter: GeminiAccountAdminFilterInput,
): GeminiAccountAdminFilter {
	const normalized: GeminiAccountAdminFilter = {
		limit: boundedPageLimit(filter.limit),
	};
	const cursor = cleanOptionalString(filter.cursor);
	if (cursor) normalized.cursor = cursor;
	const status = normalizeStatus(filter.status);
	if (status) normalized.status = status;
	if (typeof filter.enabled === "boolean") normalized.enabled = filter.enabled;
	const q = cleanOptionalString(filter.q);
	if (q) normalized.q = q.slice(0, 200);
	const category = normalizeCategory(filter.category);
	if (category) normalized.category = category;
	const cooldown = normalizeCooldown(filter.cooldown);
	if (cooldown) normalized.cooldown = cooldown;
	const source = cleanOptionalString(filter.source);
	if (source) normalized.source = source.slice(0, 200);
	return normalized;
}

function validateCreateAccount(
	item: UnknownRecord,
	topLevelGemini: boolean,
): void {
	const provider = optionalInputString(item.provider, "provider");
	if (provider && provider !== "gemini") {
		throw new GeminiAccountAdminError(
			400,
			"gemini_provider_mismatch",
			"Gemini import cannot mix other providers",
		);
	}
	if (topLevelGemini && provider && provider !== "gemini") {
		throw new GeminiAccountAdminError(
			400,
			"gemini_provider_mismatch",
			"Gemini import cannot mix other providers",
		);
	}
	for (const key of Object.keys(item)) {
		const value = item[key];
		if (value == null) continue;
		if (UNSAFE_CREATE_KEYS.has(key) || !SAFE_CREATE_KEYS.has(key)) {
			throw new GeminiAccountAdminError(
				400,
				"gemini_import_dual_cookie_only",
				"Gemini import accepts only safe dual cookie fields and metadata",
			);
		}
		if (typeof value !== "string")
			throw new GeminiAccountAdminError(
				400,
				"gemini_import_invalid_field_type",
				`${key} must be a string`,
			);
	}
	const psid = cleanRequiredString(item["__Secure-1PSID"], "__Secure-1PSID");
	const psidts = cleanRequiredString(
		item["__Secure-1PSIDTS"],
		"__Secure-1PSIDTS",
	);
	validateBareCookieValue(psid);
	validateBareCookieValue(psidts);
}

function cleanRequiredString(value: unknown, name: string): string {
	if (typeof value !== "string")
		throw new GeminiAccountAdminError(
			400,
			"gemini_import_invalid_field_type",
			`${name} must be a string`,
		);
	const text = cleanOptionalString(value);
	if (!text)
		throw new GeminiAccountAdminError(
			400,
			"gemini_import_missing_cookie_field",
			`${name} is required`,
		);
	return text;
}

function cleanOptionalString(value: unknown): string {
	return String(value ?? "")
		.trim()
		.replace(/^['"]|['"]$/g, "")
		.replace(/;+$/g, "")
		.trim();
}

function optionalInputString(value: unknown, name: string): string {
	if (value == null) return "";
	if (typeof value !== "string")
		throw new GeminiAccountAdminError(
			400,
			"invalid_admin_field_type",
			`${name} must be a string`,
		);
	return cleanOptionalString(value);
}

function nullableInputString(value: unknown, name: string): string | null {
	if (value == null) return null;
	if (typeof value !== "string")
		throw new GeminiAccountAdminError(
			400,
			"invalid_admin_field_type",
			`${name} must be a string or null`,
		);
	const text = value.trim();
	return text || null;
}

function nullableInputNumber(value: unknown, name: string): number | null {
	if (value == null) return null;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new GeminiAccountAdminError(
			400,
			"invalid_admin_field_type",
			`${name} must be a non-negative safe integer or null`,
		);
	return value;
}

function validateBareCookieValue(value: string): void {
	const lowered = value.toLowerCase();
	if (
		value.includes("=") ||
		value.includes(";") ||
		value.startsWith("{") ||
		value.startsWith("[") ||
		lowered.includes("__secure-1psid") ||
		COOKIE_NAME_RE.test(value)
	) {
		throw new GeminiAccountAdminError(
			400,
			"gemini_import_bare_cookie_value_required",
			"Gemini cookie fields must contain only the value, not cookie names, equals signs, or semicolons",
		);
	}
}

function normalizeStatus(value: unknown): GeminiAccountStatus | undefined {
	const text = cleanOptionalString(value);
	if (!text) return undefined;
	if (!isGeminiAccountStatus(text))
		throw new GeminiAccountAdminError(
			400,
			"invalid_account_status",
			"invalid account status",
		);
	return text;
}

function isGeminiAccountStatus(value: string): value is GeminiAccountStatus {
	return [
		"active",
		"disabled",
		"auth_failed",
		"needs_cookie_update",
		"rate_limited",
		"cooling_down",
		"transient_failed",
		"hard_blocked",
		"needs_user_action",
		"missing_cookie",
		"capability_mismatch",
	].includes(value);
}

function normalizeCategory(value: unknown): GeminiAccountCategory | undefined {
	const text = cleanOptionalString(value);
	if (!text) return undefined;
	if (!isGeminiAccountCategory(text))
		throw new GeminiAccountAdminError(
			400,
			"invalid_account_category",
			"invalid account category",
		);
	return text;
}

function isGeminiAccountCategory(
	value: string,
): value is GeminiAccountCategory {
	return [
		"full_session",
		"psid_psidts",
		"psid_only",
		"session_token_only",
		"missing_session",
	].includes(value);
}

function normalizeCooldown(value: unknown): "active" | "cooling" | undefined {
	const text = cleanOptionalString(value);
	if (!text) return undefined;
	if (text === "active" || text === "cooling") return text;
	throw new GeminiAccountAdminError(
		400,
		"invalid_cooldown_filter",
		"invalid cooldown filter",
	);
}

function boundedPageLimit(limit: unknown): number {
	const n = Number(limit);
	if (!Number.isInteger(n)) return 50;
	return Math.min(Math.max(n, 1), 200);
}

function requiredQueryValue(params: URLSearchParams, name: string): string {
	const value = params.get(name);
	if (value == null || value.trim() === "")
		throw new GeminiAccountAdminError(
			400,
			"invalid_admin_query_parameter",
			`${name} query parameter must not be empty`,
		);
	return value.trim();
}

function boundedQueryText(params: URLSearchParams, name: string): string {
	const value = requiredQueryValue(params, name);
	if (value.length > 200)
		throw new GeminiAccountAdminError(
			400,
			"invalid_admin_query_parameter",
			`${name} query parameter is too long`,
		);
	return value;
}

function parsePageLimit(value: string): number {
	if (!/^(?:[1-9]|[1-9]\d|1\d\d|200)$/.test(value))
		throw new GeminiAccountAdminError(
			400,
			"invalid_admin_limit",
			"limit must be an integer between 1 and 200",
		);
	return Number(value);
}

function parseQueryBoolean(value: string): boolean {
	if (value === "true" || value === "1") return true;
	if (value === "false" || value === "0") return false;
	throw new GeminiAccountAdminError(
		400,
		"invalid_admin_enabled_filter",
		"enabled must be true, false, 1, or 0",
	);
}
