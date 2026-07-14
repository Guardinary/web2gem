export type GeminiAccountIssue =
	| "auth"
	| "rate_limit"
	| "user_action"
	| "location"
	| "transient";

export type GeminiAccountState =
	| "available"
	| "cooling"
	| "attention"
	| "disabled";

export type GeminiAccount = {
	id: string;
	label: string | null;
	enabled: boolean;
	state: GeminiAccountState;
	issue: GeminiAccountIssue | null;
	cooldown_until_ms: number | null;
	last_issue_at_ms: number | null;
	last_used_at_ms: number | null;
	last_refresh_at_ms: number | null;
	created_at_ms: number;
	updated_at_ms: number;
};

export type AccountOverview = {
	items: GeminiAccount[];
	nextCursor: string | null;
	limit: number;
	stats: AccountStats;
};

export type AccountStats = {
	total: number;
	available: number;
	cooling: number;
	attention: number;
	disabled: number;
};

export type AccountIdentifier = { id: string };

export type MutationError = {
	id?: string;
	code: string;
	message: string;
};

export type MutationResult = {
	processed: number;
	changed: number;
	unchanged: number;
	failed: number;
	errors?: MutationError[];
};

export type AccountAction = "enable" | "disable" | "delete" | "refresh";
