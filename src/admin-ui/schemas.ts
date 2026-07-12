import * as v from "valibot";
import type {
	AccountPage,
	AccountOverview,
	AccountStats,
	GeminiAccount,
	MutationResult,
} from "./types";

const statusSchema = v.union([
	v.literal("active"),
	v.literal("disabled"),
	v.literal("auth_failed"),
	v.literal("needs_cookie_update"),
	v.literal("rate_limited"),
	v.literal("cooling_down"),
	v.literal("transient_failed"),
	v.literal("hard_blocked"),
	v.literal("needs_user_action"),
	v.literal("missing_cookie"),
	v.literal("capability_mismatch"),
]);

const nullableString = v.nullable(v.string());
const nullableNumber = v.nullable(v.number());

export const accountSchema = v.object({
	id: v.string(),
	row_id: v.string(),
	label: nullableString,
	enabled: v.number(),
	status: statusSchema,
	state_reason: nullableString,
	cookie_hash: v.string(),
	session_token_hash: nullableString,
	session_id: nullableString,
	language: nullableString,
	push_id: nullableString,
	last_token_bootstrap_at_ms: nullableNumber,
	secure_1psid_hash: v.string(),
	secure_1psidts_hash: nullableString,
	account_category: nullableString,
	account_status_code: nullableNumber,
	account_status_description: nullableString,
	user_agent: nullableString,
	gemini_origin: nullableString,
	source: nullableString,
	source_id: nullableString,
	source_name: nullableString,
	imported_at_ms: nullableNumber,
	cooldown_until_ms: nullableNumber,
	last_used_at_ms: nullableNumber,
	last_success_at_ms: nullableNumber,
	last_failure_at_ms: nullableNumber,
	last_refresh_at_ms: nullableNumber,
	last_refresh_attempt_at_ms: nullableNumber,
	last_error_code: nullableString,
	last_error_message_redacted: nullableString,
	last_upstream_status: nullableNumber,
	last_capability_probe_at_ms: nullableNumber,
	capability_summary_json: nullableString,
	success_count: v.number(),
	failure_count: v.number(),
	created_at_ms: v.number(),
	updated_at_ms: v.number(),
	has_cookie: v.boolean(),
	has_sapisid: v.boolean(),
	has_session_token: v.boolean(),
	cookie_preview: v.string(),
});

const mutationErrorSchema = v.object({
	error: v.optional(v.string()),
	message: v.optional(v.string()),
	id: v.optional(v.string()),
	row_id: v.optional(v.string()),
});

const diagnosticResultSchema = v.object({
	id: v.optional(v.string()),
	row_id: v.optional(v.string()),
	status: v.union([
		v.literal("refreshed"),
		v.literal("unchanged"),
		v.literal("failed"),
		v.literal("skipped"),
	]),
	reason: v.optional(v.string()),
	upstreamStatus: v.optional(v.number()),
});

export const pageSchema = v.object({
	items: v.array(accountSchema),
	nextCursor: v.nullable(v.string()),
	limit: v.number(),
});

export const statsSchema = v.object({
	total: v.number(),
	available: v.number(),
	needsAttention: v.number(),
	disabled: v.number(),
	refreshable: v.number(),
	cooling: v.number(),
	psidOnly: v.number(),
	successCount: v.number(),
	failureCount: v.number(),
});

export const overviewSchema = v.object({
	items: v.array(accountSchema),
	nextCursor: v.nullable(v.string()),
	limit: v.number(),
	stats: statsSchema,
});

export const mutationSchema = v.object({
	items: v.optional(v.array(accountSchema)),
	added: v.optional(v.number()),
	duplicates: v.optional(v.number()),
	skipped: v.optional(v.number()),
	updated: v.optional(v.number()),
	removed: v.optional(v.number()),
	checked: v.optional(v.number()),
	refreshed: v.optional(v.number()),
	unchanged: v.optional(v.number()),
	failed: v.optional(v.number()),
	errors: v.optional(v.array(mutationErrorSchema)),
	results: v.optional(v.array(diagnosticResultSchema)),
});

export function parsePage(value: unknown): AccountPage {
	const parsed = v.safeParse(pageSchema, value);
	if (!parsed.success)
		throw new Error("admin account list response is invalid");
	return parsed.output as AccountPage;
}

export function parseMutation(value: unknown): MutationResult {
	const parsed = v.safeParse(mutationSchema, value);
	if (!parsed.success) throw new Error("admin mutation response is invalid");
	return parsed.output as MutationResult;
}

export function parseOverview(value: unknown): AccountOverview {
	const parsed = v.safeParse(overviewSchema, value);
	if (!parsed.success)
		throw new Error("admin account overview response is invalid");
	return parsed.output as AccountOverview;
}

export function parseStats(value: unknown): AccountStats {
	const parsed = v.safeParse(statsSchema, value);
	if (!parsed.success) throw new Error("admin stats response is invalid");
	return parsed.output as AccountStats;
}

export function isAccount(value: unknown): value is GeminiAccount {
	return v.safeParse(accountSchema, value).success;
}
