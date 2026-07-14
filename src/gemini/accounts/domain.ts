export const GEMINI_ACCOUNT_ISSUES = [
	"auth",
	"rate_limit",
	"user_action",
	"location",
	"transient",
] as const;

export type GeminiAccountIssue = (typeof GEMINI_ACCOUNT_ISSUES)[number];

export const GEMINI_ACCOUNT_STATES = [
	"available",
	"cooling",
	"attention",
	"disabled",
] as const;

export type GeminiAccountState = (typeof GEMINI_ACCOUNT_STATES)[number];

const ISSUE_SET = new Set<string>(GEMINI_ACCOUNT_ISSUES);
const STATE_SET = new Set<string>(GEMINI_ACCOUNT_STATES);
export const GEMINI_DURABLE_ACCOUNT_ISSUES = [
	"auth",
	"user_action",
	"location",
] as const satisfies readonly GeminiAccountIssue[];
export const GEMINI_TEMPORARY_ACCOUNT_ISSUES = [
	"rate_limit",
	"transient",
] as const satisfies readonly GeminiAccountIssue[];

const DURABLE_BLOCKING_ISSUES = new Set<GeminiAccountIssue>(
	GEMINI_DURABLE_ACCOUNT_ISSUES,
);
const TEMPORARY_ISSUES = new Set<GeminiAccountIssue>(
	GEMINI_TEMPORARY_ACCOUNT_ISSUES,
);

export function isGeminiAccountIssue(
	value: string,
): value is GeminiAccountIssue {
	return ISSUE_SET.has(value);
}

export function isGeminiAccountState(
	value: string,
): value is GeminiAccountState {
	return STATE_SET.has(value);
}

export function isDurableGeminiAccountIssue(
	issue: GeminiAccountIssue | null | undefined,
): boolean {
	return issue != null && DURABLE_BLOCKING_ISSUES.has(issue);
}

export function isTemporaryGeminiAccountIssue(
	issue: GeminiAccountIssue | null | undefined,
): boolean {
	return issue != null && TEMPORARY_ISSUES.has(issue);
}

export function geminiAccountState(
	account: {
		enabled: number | boolean;
		issue: GeminiAccountIssue | null;
		cooldown_until_ms: number | null;
	},
	nowMs: number,
): GeminiAccountState {
	if (account.enabled === false || Number(account.enabled) !== 1)
		return "disabled";
	if (account.cooldown_until_ms != null && account.cooldown_until_ms > nowMs)
		return "cooling";
	if (isDurableGeminiAccountIssue(account.issue)) return "attention";
	return "available";
}

export function visibleGeminiAccountIssue(
	account: {
		issue: GeminiAccountIssue | null;
		cooldown_until_ms: number | null;
	},
	nowMs: number,
): GeminiAccountIssue | null {
	if (
		isTemporaryGeminiAccountIssue(account.issue) &&
		(account.cooldown_until_ms == null || account.cooldown_until_ms <= nowMs)
	)
		return null;
	return account.issue;
}

export function boundedGeminiAccountPageLimit(value: unknown): number {
	const limit = Number(value);
	if (!Number.isInteger(limit)) return 50;
	return Math.min(Math.max(limit, 1), 200);
}
