import * as v from "valibot";
import type {
	AccountOverview,
	GeminiAccount,
	ModelRoutingOverview,
	MutationResult,
} from "./types";

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
	status_checked_at_ms: nullableNumber,
	last_refresh_success_at_ms: nullableNumber,
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

const modelFamilySchema = v.union([
	v.literal("pro"),
	v.literal("flash"),
	v.literal("flash_lite"),
]);
const modelRouteSchema = v.strictObject({
	providerModelId: v.string(),
	capacity: v.union([v.literal(1), v.literal(2), v.literal(3), v.literal(4)]),
	capacityField: v.union([v.literal(12), v.literal(13)]),
	modelNumber: v.number(),
	label: v.nullable(
		v.union([v.literal("Basic"), v.literal("Plus"), v.literal("Advanced")]),
	),
	available: v.boolean(),
	configured: v.boolean(),
	accountCount: v.number(),
});
const modelRoutingSchema = v.strictObject({
	version: v.string(),
	families: v.array(
		v.strictObject({
			family: modelFamilySchema,
			publicNames: v.tuple([v.string(), v.string()]),
			configured: v.boolean(),
			routes: v.array(modelRouteSchema),
		}),
	),
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

export function parseModelRoutingOverview(
	value: unknown,
): ModelRoutingOverview {
	const parsed = v.safeParse(modelRoutingSchema, value);
	if (!parsed.success)
		throw new Error("admin model routing response is invalid");
	return parsed.output as ModelRoutingOverview;
}
