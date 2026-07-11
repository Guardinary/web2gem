import type { GeminiAccountAdminFilter, GeminiAccountPublic } from "./types";

export const ADMIN_ACCOUNT_SELECT = `
  id, label, enabled, status, state_reason, row_id, cookie_hash,
  session_token_hash, session_id, language, push_id, last_token_bootstrap_at_ms,
  secure_1psid_hash, secure_1psidts_hash, account_category,
  account_status_code, account_status_description, user_agent, gemini_origin,
  source, source_id, source_name, imported_at_ms, cooldown_until_ms,
  last_used_at_ms, last_success_at_ms, last_failure_at_ms, last_refresh_at_ms,
  last_refresh_attempt_at_ms, last_error_code, last_error_message_redacted,
  last_upstream_status, last_capability_probe_at_ms, capability_summary_json,
  success_count, failure_count, created_at_ms, updated_at_ms,
  CASE WHEN cookie_header IS NOT NULL AND cookie_header != '' THEN 1 ELSE 0 END AS has_cookie,
  CASE WHEN sapisid IS NOT NULL AND sapisid != '' THEN 1 ELSE 0 END AS has_sapisid,
  CASE WHEN session_token IS NOT NULL AND session_token != '' THEN 1 ELSE 0 END AS has_session_token,
  CASE WHEN cookie_header IS NOT NULL AND cookie_header != '' THEN 'present' ELSE '' END AS cookie_preview
`;

export type GeminiAccountPublicSqlRow = Omit<
	GeminiAccountPublic,
	"has_cookie" | "has_sapisid" | "has_session_token"
> & {
	has_cookie: number | boolean;
	has_sapisid: number | boolean;
	has_session_token: number | boolean;
};

export function adminWhere(
	filter: Partial<GeminiAccountAdminFilter>,
	nowMs: number,
): { where: string[]; args: unknown[] } {
	const args: unknown[] = [];
	const where: string[] = [];
	if (filter.cursor) {
		where.push("id > ?");
		args.push(filter.cursor);
	}
	if (filter.status) {
		where.push("status = ?");
		args.push(filter.status);
	}
	if (filter.enabled !== undefined) {
		where.push("enabled = ?");
		args.push(filter.enabled ? 1 : 0);
	}
	if (filter.category) {
		where.push("account_category = ?");
		args.push(filter.category);
	}
	if (filter.cooldown === "cooling") {
		where.push("cooldown_until_ms IS NOT NULL AND cooldown_until_ms > ?");
		args.push(nowMs);
	} else if (filter.cooldown === "active") {
		where.push("(cooldown_until_ms IS NULL OR cooldown_until_ms <= ?)");
		args.push(nowMs);
	}
	if (filter.source) {
		where.push("(source = ? OR source_id = ? OR source_name = ?)");
		args.push(filter.source, filter.source, filter.source);
	}
	if (filter.q) {
		const like = `%${escapeSqlLike(filter.q)}%`;
		where.push(`(
      id LIKE ? ESCAPE '\\' OR row_id LIKE ? ESCAPE '\\' OR label LIKE ? ESCAPE '\\'
      OR status LIKE ? ESCAPE '\\' OR state_reason LIKE ? ESCAPE '\\'
      OR source LIKE ? ESCAPE '\\' OR source_id LIKE ? ESCAPE '\\' OR source_name LIKE ? ESCAPE '\\'
      OR account_category LIKE ? ESCAPE '\\' OR last_error_code LIKE ? ESCAPE '\\'
      OR last_error_message_redacted LIKE ? ESCAPE '\\'
    )`);
		args.push(like, like, like, like, like, like, like, like, like, like, like);
	}
	return { where, args };
}

export function publicRowFromSql(
	row: GeminiAccountPublicSqlRow,
): GeminiAccountPublic {
	return {
		...row,
		has_cookie: !!row.has_cookie,
		has_sapisid: !!row.has_sapisid,
		has_session_token: !!row.has_session_token,
	};
}

export function numberOrZero(value: unknown): number {
	const n = Number(value);
	return Number.isFinite(n) ? n : 0;
}

function escapeSqlLike(value: string): string {
	return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
