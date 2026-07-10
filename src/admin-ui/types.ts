export type GeminiAccountStatus =
	| "active"
	| "disabled"
	| "auth_failed"
	| "needs_cookie_update"
	| "rate_limited"
	| "cooling_down"
	| "transient_failed"
	| "hard_blocked"
	| "needs_user_action"
	| "missing_cookie"
	| "capability_mismatch";

export type GeminiAccount = {
	id: string;
	row_id: string;
	label: string | null;
	enabled: number;
	status: GeminiAccountStatus;
	state_reason: string | null;
	cookie_hash: string;
	session_token_hash: string | null;
	session_id: string | null;
	language: string | null;
	push_id: string | null;
	last_token_bootstrap_at_ms: number | null;
	secure_1psid_hash: string;
	secure_1psidts_hash: string | null;
	account_category: string | null;
	account_status_code: number | null;
	account_status_description: string | null;
	user_agent: string | null;
	gemini_origin: string | null;
	source: string | null;
	source_id: string | null;
	source_name: string | null;
	imported_at_ms: number | null;
	cooldown_until_ms: number | null;
	last_used_at_ms: number | null;
	last_success_at_ms: number | null;
	last_failure_at_ms: number | null;
	last_refresh_at_ms: number | null;
	last_refresh_attempt_at_ms: number | null;
	last_error_code: string | null;
	last_error_message_redacted: string | null;
	last_upstream_status: number | null;
	last_capability_probe_at_ms: number | null;
	capability_summary_json: string | null;
	success_count: number;
	failure_count: number;
	created_at_ms: number;
	updated_at_ms: number;
	has_cookie: boolean;
	has_sapisid: boolean;
	has_session_token: boolean;
	cookie_preview: string;
};

export type AccountPage = {
	items: GeminiAccount[];
	nextCursor: string | null;
	limit: number;
};

export type AccountStats = {
	total: number;
	available: number;
	needsAttention: number;
	disabled: number;
	refreshable: number;
	cooling: number;
	psidOnly: number;
	successCount: number;
	failureCount: number;
};

export type AccountIdentifier = {
	id?: string;
	row_id?: string;
};

export type MutationResult = {
	items?: GeminiAccount[];
	added?: number;
	duplicates?: number;
	skipped?: number;
	updated?: number;
	removed?: number;
	checked?: number;
	refreshed?: number;
	unchanged?: number;
	failed?: number;
	errors?: Array<{
		error?: string;
		message?: string;
		id?: string;
		row_id?: string;
	}>;
};
