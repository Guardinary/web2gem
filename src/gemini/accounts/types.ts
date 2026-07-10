export type D1Result<T = unknown> = {
	results?: T[];
	success?: boolean;
	meta?: D1ResultMeta;
};

export type D1ResultMeta = {
	changes?: number;
	changedRows?: number;
	rows_written?: number;
	rowsWritten?: number;
	last_row_id?: number;
};

export type D1DatabaseLike = {
	prepare(sql: string): D1PreparedStatementLike;
	batch?<T = unknown>(
		statements: D1PreparedStatementLike[],
	): Promise<D1Result<T>[]>;
};

export type D1PreparedStatementLike = {
	bind(...values: unknown[]): D1PreparedStatementLike;
	first<T = unknown>(columnName?: string): Promise<T | null>;
	all<T = unknown>(): Promise<D1Result<T>>;
	run<T = unknown>(): Promise<D1Result<T>>;
};

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

export type GeminiAccountFailureKind =
	| "auth"
	| "rate_limit"
	| "usage_limit"
	| "hard_block"
	| "needs_user_action"
	| "location_or_ip_block"
	| "model_invalid"
	| "model_capability"
	| "temporary_model_error"
	| "empty_response"
	| "network"
	| "upstream_5xx"
	| "transient"
	| "capability_mismatch"
	| "unknown";

export type GeminiAccountCategory =
	| "full_session"
	| "psid_psidts"
	| "psid_only"
	| "session_token_only"
	| "missing_session";

export type GeminiAccountRow = {
	id: string;
	label: string | null;
	enabled: number;
	status: GeminiAccountStatus;
	state_reason: string | null;
	row_id: string;
	cookie_header: string;
	cookie_hash: string;
	sapisid: string | null;
	session_token: string | null;
	session_token_hash: string | null;
	session_id: string | null;
	language: string | null;
	push_id: string | null;
	last_token_bootstrap_at_ms: number | null;
	secure_1psid_hash: string;
	secure_1psidts_hash: string | null;
	account_category: GeminiAccountCategory | null;
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
};

export type GeminiAccountSnapshotRow = Pick<
	GeminiAccountRow,
	| "id"
	| "row_id"
	| "label"
	| "enabled"
	| "status"
	| "cookie_header"
	| "cookie_hash"
	| "sapisid"
	| "session_token"
	| "session_token_hash"
	| "user_agent"
	| "gemini_origin"
	| "cooldown_until_ms"
	| "last_used_at_ms"
	| "last_success_at_ms"
	| "last_failure_at_ms"
>;

export type GeminiAccountSecretRow = GeminiAccountRow;

export type GeminiAccountPublic = Omit<
	GeminiAccountRow,
	"cookie_header" | "sapisid" | "session_token"
> & {
	has_cookie: boolean;
	has_sapisid: boolean;
	has_session_token: boolean;
	cookie_preview: string;
};

export type GeminiAccountAdminFilter = {
	limit: number;
	cursor?: string;
	status?: GeminiAccountStatus;
	enabled?: boolean;
	q?: string;
	category?: GeminiAccountCategory;
	cooldown?: "active" | "cooling";
	source?: string;
};

export type GeminiAccountPublicPage = {
	items: GeminiAccountPublic[];
	nextCursor: string | null;
	limit: number;
};

export type GeminiAccountAdminStats = {
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

export type GeminiAccountCreateInput = {
	id?: string;
	label?: string;
	cookieHeader: string;
	sapisid?: string;
	sessionToken?: string;
	sessionId?: string;
	language?: string;
	pushId?: string;
	userAgent?: string;
	geminiOrigin?: string;
	source?: string;
	sourceId?: string;
	sourceName?: string;
	nowMs: number;
};

export type GeminiAccountUpdate = {
	label?: string | null;
	enabled?: boolean;
	status?: GeminiAccountStatus;
	stateReason?: string | null;
	cooldownUntilMs?: number | null;
	accountStatusCode?: number | null;
	accountStatusDescription?: string | null;
	userAgent?: string | null;
	geminiOrigin?: string | null;
	source?: string | null;
	sourceId?: string | null;
	sourceName?: string | null;
	nowMs: number;
};

export type GeminiCookieWriteback = {
	cookieHeader: string;
	sapisid?: string | null | undefined;
	sessionToken?: string | null | undefined;
	sessionId?: string | null | undefined;
	language?: string | null | undefined;
	pushId?: string | null | undefined;
	lastRefreshAtMs?: number | null | undefined;
	lastRefreshAttemptAtMs?: number | null | undefined;
	status?: GeminiAccountStatus;
	stateReason?: string | null;
	nowMs: number;
};

export type GeminiCookieWritebackResult = {
	changed: boolean;
	reason?: "duplicate_cookie";
};

export type GeminiAccountOutcome = {
	kind: "success" | "failure";
	failureKind?: GeminiAccountFailureKind | undefined;
	status?: GeminiAccountStatus | undefined;
	stateReason?: string | null | undefined;
	cooldownUntilMs?: number | null | undefined;
	upstreamStatus?: number | null | undefined;
	errorCode?: string | null | undefined;
	errorMessageRedacted?: string | null | undefined;
	nowMs: number;
};

export type GeminiAccountRuntimeStore = {
	getPoolVersion(): Promise<string>;
	listSelectableAccounts(
		nowMs: number,
		limit: number,
	): Promise<GeminiAccountSnapshotRow[]>;
	getAccountForRefresh(
		accountId: string,
	): Promise<GeminiAccountSecretRow | null>;
	tryAcquireRefreshLock(
		accountId: string,
		owner: string,
		expiresAtMs: number,
		nowMs: number,
	): Promise<boolean>;
	releaseRefreshLock(accountId: string, owner: string): Promise<void>;
	writeCookieState(
		accountId: string,
		update: GeminiCookieWriteback,
	): Promise<GeminiCookieWritebackResult>;
	writeAccountOutcome(
		accountId: string,
		outcome: GeminiAccountOutcome,
	): Promise<void>;
};

export type GeminiAccountAdminStore = {
	listAdminAccounts(
		filter: GeminiAccountAdminFilter,
		nowMs: number,
	): Promise<GeminiAccountPublicPage>;
	getAdminStats(
		filter: Omit<GeminiAccountAdminFilter, "cursor" | "limit">,
		nowMs: number,
	): Promise<GeminiAccountAdminStats>;
	findAccountByCookieHash(
		cookieHash: string,
	): Promise<GeminiAccountPublic | null>;
	resolveAccountIdentifier(input: {
		id?: string;
		rowId?: string;
	}): Promise<string | null>;
	createAccount(input: GeminiAccountCreateInput): Promise<GeminiAccountPublic>;
	updateAccount(
		accountId: string,
		update: GeminiAccountUpdate,
	): Promise<GeminiAccountPublic | null>;
	deleteAccount(accountId: string): Promise<boolean>;
};

export type GeminiAccountStore = GeminiAccountRuntimeStore &
	GeminiAccountAdminStore;

export type GeminiAccountRuntimeOptions = {
	nowMs?: () => number;
	snapshotTtlMs?: number;
	versionProbeTtlMs?: number;
	selectableLimit?: number;
	refreshLockTtlMs?: number;
	rotateCookie?: GeminiAccountCookieRotator;
};

export type GeminiAccountCookieRotator = (input: {
	config: import("../../config").RuntimeConfig;
	account: GeminiAccountSecretRow;
}) => Promise<GeminiAccountRotateResponse>;

export type GeminiAccountRotateResponse = {
	status: number;
	ok: boolean;
	headers: Headers;
};

export type GeminiAccountPageState = {
	cookieHeader?: string | undefined;
	sapisid?: string | null | undefined;
	sessionToken?: string | null | undefined;
	sessionId?: string | null | undefined;
	language?: string | null | undefined;
	pushId?: string | null | undefined;
	nowMs?: number;
};

export type GeminiAccountLease = {
	accountId: string;
	rowId?: string;
	selectedCookieHash: string;
	config: import("../../config").RuntimeConfig;
	recordPageState(
		update: GeminiAccountPageState,
	): Promise<GeminiCookieWritebackResult>;
	refreshForRetry(reason?: string): Promise<GeminiAccountRefreshResult>;
	markSuccess(nowMs?: number): Promise<void>;
	markFailure(error: unknown, nowMs?: number): Promise<void>;
	release(): void;
};

export type GeminiAccountRefreshReason =
	| "missing_cookie"
	| "missing_secure_1psid"
	| "recent_rotation"
	| "lock_conflict"
	| "account_missing"
	| "rotation_rejected"
	| "rotation_failed"
	| "rotation_no_update"
	| "rotation_duplicate"
	| "rotation_error"
	| "rotation_updated";

export type GeminiAccountRefreshResult = {
	changed: boolean;
	reason: GeminiAccountRefreshReason;
	upstreamStatus?: number;
};
