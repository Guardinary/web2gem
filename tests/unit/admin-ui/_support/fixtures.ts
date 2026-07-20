import type {
	AccountOverview,
	AccountStats,
	GeminiAccount,
	ModelRoutingOverview,
	MutationResult,
} from "../../../../src/admin-ui/types";

export type RecordedRequest = {
	path: string;
	init: RequestInit;
};

export function recordedRequest(
	path: RequestInfo | URL,
	init: RequestInit = {},
): RecordedRequest {
	return { path: String(path), init };
}

export function requestBody(init: RequestInit): string {
	if (typeof init.body !== "string") {
		throw new TypeError("expected a string request body");
	}
	return init.body;
}

export function requestHeaders(init: RequestInit): Headers {
	return new Headers(init.headers);
}

export function requiredValue<T>(
	value: T | null | undefined,
	message = "expected a value",
): T {
	if (value === null || value === undefined) throw new Error(message);
	return value;
}

export function uiAccount(
	overrides: Partial<GeminiAccount> = {},
): GeminiAccount {
	return {
		id: "account-a",
		label: null,
		enabled: true,
		state: "available",
		issue: null,
		cooldown_until_ms: null,
		last_issue_at_ms: null,
		last_used_at_ms: null,
		last_refresh_at_ms: null,
		status_checked_at_ms: null,
		last_refresh_success_at_ms: null,
		created_at_ms: 1000,
		updated_at_ms: 1000,
		...overrides,
	};
}

export function emptyStats(
	overrides: Partial<AccountStats> = {},
): AccountStats {
	return {
		total: 0,
		available: 0,
		cooling: 0,
		attention: 0,
		disabled: 0,
		...overrides,
	};
}

export function uiModelRouting(): ModelRoutingOverview {
	return {
		version: "1",
		families: [
			{
				family: "pro",
				publicNames: ["gemini-3.1-pro", "gemini-3.1-pro-extended"],
				configured: false,
				routes: [
					{
						providerModelId: "9d8ca3786ebdfbea",
						capacity: 3,
						capacityField: 13,
						modelNumber: 3,
						label: null,
						available: true,
						configured: false,
						accountCount: 1,
					},
				],
			},
			{
				family: "flash",
				publicNames: ["gemini-3.5-flash", "gemini-3.5-flash-extended"],
				configured: false,
				routes: [],
			},
			{
				family: "flash_lite",
				publicNames: [
					"gemini-3.1-flash-lite",
					"gemini-3.1-flash-lite-extended",
				],
				configured: false,
				routes: [],
			},
		],
	};
}

export function uiAccountOverview(
	items: GeminiAccount[] = [],
	overrides: Partial<AccountOverview> = {},
): AccountOverview {
	return {
		items,
		nextCursor: null,
		limit: 200,
		stats: emptyStats({
			total: items.length,
			available: items.filter((account) => account.state === "available")
				.length,
			cooling: items.filter((account) => account.state === "cooling").length,
			attention: items.filter((account) => account.state === "attention")
				.length,
			disabled: items.filter((account) => account.state === "disabled").length,
		}),
		...overrides,
	};
}

export function uiMutation(
	overrides: Partial<MutationResult> = {},
): MutationResult {
	return {
		processed: 1,
		changed: 1,
		unchanged: 0,
		failed: 0,
		...overrides,
	};
}

export function uiImportBatch(count: number) {
	return Array.from({ length: count }, (_value, index) => ({
		psid: `psid-${index}`,
		psidts: `psidts-${index}`,
		label: `account-${index}`,
	}));
}

export function uiImportBatchText(count: number) {
	return uiImportBatch(count)
		.map((account) => `${account.psid} ${account.psidts} ${account.label}`)
		.join("\n");
}

export function uiAdminApiSession(sessionAdminKey = "admin-secret") {
	const controller = new AbortController();
	return { adminKey: sessionAdminKey, signal: controller.signal };
}
