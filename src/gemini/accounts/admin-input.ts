import { isRecord, type UnknownRecord } from "../../shared/types";
import type {
	GeminiAccountAdminFilter,
	GeminiAccountCategory,
	GeminiAccountCreateInput,
	GeminiAccountStatus,
	GeminiAccountUpdate,
} from "./types";

const DEFAULT_REFRESH_CONCURRENCY = 4;
const MAX_REFRESH_CONCURRENCY = 10;
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

export type GeminiAccountIdentifier = {
	id?: string;
	account_id?: string;
	row_id?: string;
};

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
	const topProvider = cleanOptionalString(body.provider);
	const accountsRaw = Array.isArray(body.accounts) ? body.accounts : [body];
	const accounts = accountsRaw.filter(isRecord);
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
	const update: GeminiAccountUpdate = { nowMs };
	if ("label" in body) update.label = nullableString(body.label);
	if ("enabled" in body) update.enabled = Boolean(body.enabled);
	if ("status" in body) {
		const status = normalizeStatus(body.status);
		if (status) update.status = status;
	}
	if ("state_reason" in body)
		update.stateReason = nullableString(body.state_reason);
	if ("cooldown_until_ms" in body)
		update.cooldownUntilMs = nullableNumber(body.cooldown_until_ms);
	if ("account_status_code" in body)
		update.accountStatusCode = nullableNumber(body.account_status_code);
	if ("account_status_description" in body)
		update.accountStatusDescription = nullableString(
			body.account_status_description,
		);
	if ("user_agent" in body) update.userAgent = nullableString(body.user_agent);
	if ("gemini_origin" in body)
		update.geminiOrigin = nullableString(body.gemini_origin);
	if ("source" in body) update.source = nullableString(body.source);
	if ("source_id" in body) update.sourceId = nullableString(body.source_id);
	if ("source_name" in body)
		update.sourceName = nullableString(body.source_name);
	return update;
}

export function hasAccountUpdate(update: GeminiAccountUpdate): boolean {
	return Object.keys(update).some((key) => key !== "nowMs");
}

export function normalizeIdentifiers(
	body: UnknownRecord,
): GeminiAccountIdentifier[] {
	const rawItems = Array.isArray(body.identifiers) ? body.identifiers : [body];
	const out: GeminiAccountIdentifier[] = [];
	const seen = new Set<string>();
	for (const raw of rawItems) {
		if (!isRecord(raw)) continue;
		const id =
			cleanOptionalString(raw.id) || cleanOptionalString(raw.account_id);
		const rowId = cleanOptionalString(raw.row_id);
		if (!id && !rowId) continue;
		const key = `${id}\0${rowId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const identifier: GeminiAccountIdentifier = {};
		if (id) {
			identifier.id = id;
			identifier.account_id = id;
		}
		if (rowId) identifier.row_id = rowId;
		out.push(identifier);
	}
	return out;
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

export function boundedConcurrency(value: unknown): number {
	const n = Number(value);
	if (!Number.isInteger(n)) return DEFAULT_REFRESH_CONCURRENCY;
	return Math.min(Math.max(n, 1), MAX_REFRESH_CONCURRENCY);
}

function validateCreateAccount(
	item: UnknownRecord,
	topLevelGemini: boolean,
): void {
	const provider = cleanOptionalString(item.provider);
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

function nullableString(value: unknown): string | null {
	const text = cleanOptionalString(value);
	return text || null;
}

function nullableNumber(value: unknown): number | null {
	if (value == null || value === "") return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
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
