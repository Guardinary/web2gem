import { uuid } from "../../shared/crypto";
import {
	changedRows,
	identityHashFromCookie,
	normalizeGeminiCookieHeader,
	sha256Hex,
} from "./normalize";
import type {
	D1Result,
	GeminiAccountCreateInput,
	GeminiAccountRow,
} from "./types";

export const ACCOUNT_INSERT_COLUMNS = [
	"id",
	"label",
	"enabled",
	"cookie_header",
	"cookie_hash",
	"identity_hash",
	"issue",
	"cooldown_until_ms",
	"last_issue_at_ms",
	"last_used_at_ms",
	"last_refresh_at_ms",
	"account_status_code",
	"status_checked_at_ms",
	"last_refresh_attempt_at_ms",
	"last_refresh_success_at_ms",
	"created_at_ms",
	"updated_at_ms",
] as const satisfies readonly (keyof GeminiAccountRow)[];

export const ACCOUNT_INSERT_SQL = `
  INSERT INTO gemini_accounts (${ACCOUNT_INSERT_COLUMNS.join(", ")})
  VALUES (${ACCOUNT_INSERT_COLUMNS.map(() => "?").join(", ")})
`;

export const ACCOUNT_UPSERT_IDENTITY_SQL = `${ACCOUNT_INSERT_SQL}
	ON CONFLICT(identity_hash) DO UPDATE SET
		label = excluded.label,
		cookie_header = excluded.cookie_header,
		cookie_hash = excluded.cookie_hash,
		updated_at_ms = excluded.updated_at_ms
`;

export async function buildAccountInsertRow(
	input: GeminiAccountCreateInput,
	cookieHash?: string,
): Promise<GeminiAccountRow> {
	const cookieHeader = normalizeGeminiCookieHeader(input.cookieHeader);
	return {
		id: input.id || uuid(),
		label: input.label || null,
		enabled: 1,
		cookie_header: cookieHeader,
		cookie_hash: cookieHash || (await sha256Hex(cookieHeader)),
		identity_hash:
			input.identityHash || (await identityHashFromCookie(cookieHeader)),
		issue: null,
		cooldown_until_ms: null,
		last_issue_at_ms: null,
		last_used_at_ms: null,
		last_refresh_at_ms: null,
		account_status_code: null,
		status_checked_at_ms: null,
		last_refresh_attempt_at_ms: null,
		last_refresh_success_at_ms: null,
		created_at_ms: input.nowMs,
		updated_at_ms: input.nowMs,
	};
}

export function accountRowValues(row: GeminiAccountRow): unknown[] {
	return ACCOUNT_INSERT_COLUMNS.map((column) => row[column]);
}

export function resultChanged(result: D1Result): number {
	const rows = changedRows(result.meta);
	return rows == null ? 1 : rows;
}

export function valueOrCurrent<T>(next: T | undefined, current: T): T {
	return next === undefined ? current : next;
}

export function isD1UniqueConstraintError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error ?? "");
	return /unique constraint failed|constraint.*unique|SQLITE_CONSTRAINT/i.test(
		message,
	);
}
