import type { GeminiAccountIssue, GeminiAccountState } from "./domain";

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

export type { GeminiAccountIssue, GeminiAccountState } from "./domain";

export type GeminiAccountRow = {
	id: string;
	label: string | null;
	enabled: number;
	cookie_header: string;
	cookie_hash: string;
	issue: GeminiAccountIssue | null;
	cooldown_until_ms: number | null;
	last_issue_at_ms: number | null;
	last_used_at_ms: number | null;
	last_refresh_at_ms: number | null;
	created_at_ms: number;
	updated_at_ms: number;
};

export type GeminiAccountSnapshotRow = Pick<
	GeminiAccountRow,
	| "id"
	| "enabled"
	| "cookie_header"
	| "cookie_hash"
	| "issue"
	| "cooldown_until_ms"
	| "last_used_at_ms"
>;

export type GeminiAccountSecretRow = GeminiAccountRow;

export type GeminiAccountSummary = {
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

export type GeminiAccountAdminFilter = {
	limit: number;
	cursor?: string;
	q?: string;
	state?: GeminiAccountState;
};

export type GeminiAccountSummaryPage = {
	items: GeminiAccountSummary[];
	nextCursor: string | null;
	limit: number;
};

export type GeminiAccountAdminStats = {
	total: number;
	available: number;
	cooling: number;
	attention: number;
	disabled: number;
};

export type GeminiAccountAdminOverview = GeminiAccountSummaryPage & {
	stats: GeminiAccountAdminStats;
};

export type GeminiAccountBulkAction =
	| "enable"
	| "disable"
	| "delete"
	| "refresh";

export type GeminiAccountCreateInput = {
	id?: string;
	label?: string;
	cookieHeader: string;
	nowMs: number;
};

export type GeminiAccountBulkCreateEntry = {
	cookieHash: string;
	input: GeminiAccountCreateInput;
};

export type GeminiAccountBulkCreateResult = {
	itemsByCookieHash: ReadonlyMap<string, GeminiAccountSummary>;
	addedCookieHashes: ReadonlySet<string>;
};

export type GeminiAccountUpdate = {
	label?: string | null;
	enabled?: boolean;
	nowMs: number;
};

export type GeminiAccountUpdateResult = {
	item: GeminiAccountSummary | null;
	changed: boolean;
};

export type GeminiRefreshedCookieWrite = {
	cookieHeader: string;
	refreshedAtMs: number;
	nowMs: number;
};

export type GeminiRefreshedCookieWriteResult = {
	changed: boolean;
	reason?: "duplicate_cookie";
};

export type GeminiAccountOutcome = {
	kind: "success" | "failure";
	issue?: GeminiAccountIssue;
	cooldownUntilMs?: number;
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
	writeRefreshedCookie(
		accountId: string,
		update: GeminiRefreshedCookieWrite,
	): Promise<GeminiRefreshedCookieWriteResult>;
	writeAccountOutcome(
		accountId: string,
		outcome: GeminiAccountOutcome,
	): Promise<void>;
};

export type GeminiAccountAdminStore = {
	getAdminOverview(
		filter: GeminiAccountAdminFilter,
		nowMs: number,
	): Promise<GeminiAccountAdminOverview>;
	findAccountByCookieHash(
		cookieHash: string,
		nowMs: number,
	): Promise<GeminiAccountSummary | null>;
	createAccount(input: GeminiAccountCreateInput): Promise<GeminiAccountSummary>;
	createAccountsBulk?(
		entries: GeminiAccountBulkCreateEntry[],
	): Promise<GeminiAccountBulkCreateResult>;
	updateAccount(
		accountId: string,
		update: GeminiAccountUpdate,
	): Promise<GeminiAccountUpdateResult>;
	deleteAccount(accountId: string, nowMs: number): Promise<boolean>;
	setAccountsEnabledBulk?(
		accountIds: readonly string[],
		enabled: boolean,
		nowMs: number,
	): Promise<string[]>;
	deleteAccountsBulk?(
		accountIds: readonly string[],
		nowMs: number,
	): Promise<string[]>;
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

export type GeminiAccountLease = {
	accountId: string;
	selectedCookieHash: string;
	config: import("../../config").RuntimeConfig;
	refreshForRetry(reason?: string): Promise<GeminiAccountRefreshResult>;
	markSuccess(nowMs?: number): Promise<void>;
	markFailure(error: unknown, nowMs?: number): Promise<void>;
	release(): void;
};

export type GeminiAccountRefreshReason =
	| "missing_secure_1psid"
	| "recent_rotation"
	| "lock_conflict"
	| "account_missing"
	| "rotation_rejected"
	| "rotation_failed"
	| "rotation_no_update"
	| "rotation_duplicate"
	| "rotation_updated";

export type GeminiAccountRefreshResult = {
	changed: boolean;
	reason: GeminiAccountRefreshReason;
	upstreamStatus?: number;
};

export type GeminiAccountMutationError = {
	id?: string;
	code: string;
	message: string;
};

export type GeminiAccountMutationResult = {
	processed: number;
	changed: number;
	unchanged: number;
	failed: number;
	errors?: GeminiAccountMutationError[];
};
