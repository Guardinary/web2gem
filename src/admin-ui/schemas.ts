import * as v from "valibot";
import type { AccountOverview, GeminiAccount, MutationResult } from "./types";

const issueSchema = v.union([
	v.literal("auth"),
	v.literal("rate_limit"),
	v.literal("user_action"),
	v.literal("location"),
	v.literal("transient"),
]);

const stateSchema = v.union([
	v.literal("available"),
	v.literal("cooling"),
	v.literal("attention"),
	v.literal("disabled"),
]);

const nullableNumber = v.nullable(v.number());

export const accountSchema = v.strictObject({
	id: v.string(),
	label: v.nullable(v.string()),
	enabled: v.boolean(),
	state: stateSchema,
	issue: v.nullable(issueSchema),
	cooldown_until_ms: nullableNumber,
	last_issue_at_ms: nullableNumber,
	last_used_at_ms: nullableNumber,
	last_refresh_at_ms: nullableNumber,
	created_at_ms: v.number(),
	updated_at_ms: v.number(),
});

const statsSchema = v.strictObject({
	total: v.number(),
	available: v.number(),
	cooling: v.number(),
	attention: v.number(),
	disabled: v.number(),
});

const mutationErrorSchema = v.strictObject({
	id: v.optional(v.string()),
	code: v.string(),
	message: v.string(),
});

const mutationSchema = v.strictObject({
	processed: v.number(),
	changed: v.number(),
	unchanged: v.number(),
	failed: v.number(),
	errors: v.optional(v.array(mutationErrorSchema)),
});

const overviewSchema = v.strictObject({
	items: v.array(accountSchema),
	nextCursor: v.nullable(v.string()),
	limit: v.number(),
	stats: statsSchema,
});

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

export function isAccount(value: unknown): value is GeminiAccount {
	return v.safeParse(accountSchema, value).success;
}
