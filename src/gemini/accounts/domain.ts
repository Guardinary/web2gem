export const GEMINI_ACCOUNT_CATEGORIES = [
	"full_session",
	"psid_psidts",
	"psid_only",
	"session_token_only",
	"missing_session",
] as const;

export type GeminiAccountCategory = (typeof GEMINI_ACCOUNT_CATEGORIES)[number];

const GEMINI_ACCOUNT_CATEGORY_SET = new Set<string>(GEMINI_ACCOUNT_CATEGORIES);

export function isGeminiAccountCategory(
	value: string,
): value is GeminiAccountCategory {
	return GEMINI_ACCOUNT_CATEGORY_SET.has(value);
}

export function boundedGeminiAccountPageLimit(value: unknown): number {
	const limit = Number(value);
	if (!Number.isInteger(limit)) return 50;
	return Math.min(Math.max(limit, 1), 200);
}
