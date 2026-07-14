import { isRecord, type UnknownRecord } from "../../shared/types";
import { boundedGeminiAccountPageLimit, isGeminiAccountState } from "./domain";
import type {
	GeminiAccountAdminFilter,
	GeminiAccountBulkAction,
	GeminiAccountCreateInput,
	GeminiAccountState,
	GeminiAccountUpdate,
} from "./types";

const SAFE_CREATE_KEYS = new Set([
	"provider",
	"__Secure-1PSID",
	"__Secure-1PSIDTS",
	"label",
]);
const UNSAFE_CREATE_KEYS = new Set([
	"tokens",
	"access_token",
	"accessToken",
	"cookie",
	"cookies",
]);
const COOKIE_NAME_RE = /(?:^|[;\s])__Secure-1PSID(?:TS)?\s*=/i;
const SAFE_UPDATE_KEYS = new Set(["label", "enabled"]);
const LIST_QUERY_KEYS = new Set(["limit", "cursor", "q", "state"]);

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

export type GeminiAccountAdminFilterInput = {
	limit?: unknown;
	cursor?: unknown;
	q?: unknown;
	state?: unknown;
};

export function listFilterFromSearchParams(
	params: URLSearchParams,
): GeminiAccountAdminFilterInput {
	for (const key of new Set(params.keys())) {
		if (!LIST_QUERY_KEYS.has(key))
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
	if (params.has("limit"))
		filter.limit = parsePageLimit(requiredQueryValue(params, "limit"));
	if (params.has("cursor")) filter.cursor = boundedQueryText(params, "cursor");
	if (params.has("q")) filter.q = boundedQueryText(params, "q");
	if (params.has("state"))
		filter.state = normalizeState(requiredQueryValue(params, "state"));
	return filter;
}

export const ADMIN_BULK_ACTION_MAX_IDS = 100;

export function normalizeBulkAction(body: UnknownRecord): {
	action: GeminiAccountBulkAction;
	ids: string[];
} {
	for (const key of Object.keys(body)) {
		if (key !== "action" && key !== "ids")
			throw new GeminiAccountAdminError(
				400,
				"unknown_bulk_action_field",
				`unsupported bulk action field: ${key}`,
			);
	}
	const action = body.action;
	if (
		action !== "enable" &&
		action !== "disable" &&
		action !== "delete" &&
		action !== "refresh"
	)
		throw new GeminiAccountAdminError(
			400,
			"invalid_bulk_action",
			"action must be enable, disable, delete, or refresh",
		);
	if (!Array.isArray(body.ids) || body.ids.length === 0)
		throw new GeminiAccountAdminError(
			400,
			"bulk_action_ids_required",
			"ids must be a non-empty array",
		);
	if (body.ids.length > ADMIN_BULK_ACTION_MAX_IDS)
		throw new GeminiAccountAdminError(
			413,
			"admin_bulk_action_limit_exceeded",
			`bulk action exceeds the limit of ${ADMIN_BULK_ACTION_MAX_IDS} accounts`,
		);
	const ids = body.ids.map((id) => {
		if (typeof id !== "string")
			throw new GeminiAccountAdminError(
				400,
				"invalid_account_id",
				"each account id must be a string",
			);
		return accountIdFromPathSegment(id);
	});
	if (new Set(ids).size !== ids.length)
		throw new GeminiAccountAdminError(
			400,
			"duplicate_bulk_action_id",
			"bulk action ids must be unique",
		);
	return { action, ids };
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

export const WORKER_ACCOUNT_IMPORT_MAX_ACCOUNTS = 40;

export function normalizeCreateAccounts(
	body: UnknownRecord,
	maxAccounts: number | null = WORKER_ACCOUNT_IMPORT_MAX_ACCOUNTS,
): UnknownRecord[] {
	if (
		Array.isArray(body.tokens) &&
		body.tokens.some((token) => cleanOptionalString(token))
	) {
		throw dualCookieOnlyError();
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
	if (topProvider && topProvider !== "gemini")
		throw new GeminiAccountAdminError(
			400,
			"gemini_provider_mismatch",
			"Gemini admin endpoints accept only provider=gemini",
		);
	const accounts = hasBatch ? (body.accounts as UnknownRecord[]) : [body];
	if (!accounts.length)
		throw new GeminiAccountAdminError(
			400,
			"gemini_import_account_required",
			"Gemini account payload is required",
		);
	if (maxAccounts != null && accounts.length > maxAccounts)
		throw new GeminiAccountAdminError(
			413,
			"gemini_import_account_limit_exceeded",
			`Gemini account import exceeds the Worker limit of ${maxAccounts} accounts`,
		);
	for (const item of accounts) validateCreateAccount(item);
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
	if (label) input.label = label;
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
	return update;
}

export function hasAccountUpdate(update: GeminiAccountUpdate): boolean {
	return Object.keys(update).some((key) => key !== "nowMs");
}

export function normalizeListFilter(
	filter: GeminiAccountAdminFilterInput,
): GeminiAccountAdminFilter {
	const normalized: GeminiAccountAdminFilter = {
		limit: boundedGeminiAccountPageLimit(filter.limit),
	};
	const cursor = cleanOptionalString(filter.cursor);
	if (cursor) normalized.cursor = cursor.slice(0, 200);
	const q = cleanOptionalString(filter.q);
	if (q) normalized.q = q.slice(0, 200);
	const state = normalizeState(filter.state);
	if (state) normalized.state = state;
	return normalized;
}

function validateCreateAccount(item: UnknownRecord): void {
	const provider = optionalInputString(item.provider, "provider");
	if (provider && provider !== "gemini")
		throw new GeminiAccountAdminError(
			400,
			"gemini_provider_mismatch",
			"Gemini import cannot mix other providers",
		);
	for (const key of Object.keys(item)) {
		const value = item[key];
		if (value == null) continue;
		if (UNSAFE_CREATE_KEYS.has(key) || !SAFE_CREATE_KEYS.has(key))
			throw dualCookieOnlyError();
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

function dualCookieOnlyError(): GeminiAccountAdminError {
	return new GeminiAccountAdminError(
		400,
		"gemini_import_dual_cookie_only",
		"Gemini import accepts only __Secure-1PSID, __Secure-1PSIDTS, and label",
	);
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

function normalizeState(value: unknown): GeminiAccountState | undefined {
	const text = cleanOptionalString(value);
	if (!text) return undefined;
	if (!isGeminiAccountState(text))
		throw new GeminiAccountAdminError(
			400,
			"invalid_account_state",
			"state must be available, cooling, attention, or disabled",
		);
	return text;
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
