import type { GeminiAccountIssue } from "./domain";

type D1ResultMeta = {
	changes?: number;
	changedRows?: number;
	rows_written?: number;
	rowsWritten?: number;
	last_row_id?: number;
};

export type D1Result<T = unknown> = {
	results?: T[];
	success?: boolean;
	meta?: D1ResultMeta;
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

export type GeminiAccountRow = {
	id: string;
	label: string | null;
	enabled: number;
	cookie_header: string;
	cookie_hash: string;
	identity_hash: string;
	issue: GeminiAccountIssue | null;
	cooldown_until_ms: number | null;
	last_issue_at_ms: number | null;
	last_used_at_ms: number | null;
	last_refresh_at_ms: number | null;
	account_status_code: number | null;
	status_checked_at_ms: number | null;
	last_refresh_attempt_at_ms: number | null;
	last_refresh_success_at_ms: number | null;
	created_at_ms: number;
	updated_at_ms: number;
};

export type GeminiAccountSecretRow = GeminiAccountRow;
