import {
	GEMINI_DURABLE_ACCOUNT_ISSUES,
	geminiAccountState,
	visibleGeminiAccountIssue,
} from "./domain";
import type {
	GeminiAccountAdminFilter,
	GeminiAccountIssue,
	GeminiAccountSummary,
} from "./types";

export const ADMIN_ACCOUNT_SELECT = `
  id, label, enabled, issue, cooldown_until_ms, last_issue_at_ms,
  last_used_at_ms, last_refresh_at_ms, created_at_ms, updated_at_ms
`;

export type GeminiAccountSummarySqlRow = {
	id: string;
	label: string | null;
	enabled: number;
	issue: GeminiAccountIssue | null;
	cooldown_until_ms: number | null;
	last_issue_at_ms: number | null;
	last_used_at_ms: number | null;
	last_refresh_at_ms: number | null;
	created_at_ms: number;
	updated_at_ms: number;
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
	if (filter.state === "disabled") {
		where.push("enabled != 1");
	} else if (filter.state === "cooling") {
		where.push("enabled = 1 AND cooldown_until_ms > ?");
		args.push(nowMs);
	} else if (filter.state === "attention") {
		where.push(
			`enabled = 1 AND (cooldown_until_ms IS NULL OR cooldown_until_ms <= ?) AND issue IN (${GEMINI_DURABLE_ACCOUNT_ISSUES.map(() => "?").join(", ")})`,
		);
		args.push(nowMs, ...GEMINI_DURABLE_ACCOUNT_ISSUES);
	} else if (filter.state === "available") {
		where.push(
			`enabled = 1 AND (cooldown_until_ms IS NULL OR cooldown_until_ms <= ?) AND (issue IS NULL OR issue NOT IN (${GEMINI_DURABLE_ACCOUNT_ISSUES.map(() => "?").join(", ")}))`,
		);
		args.push(nowMs, ...GEMINI_DURABLE_ACCOUNT_ISSUES);
	}
	if (filter.q) {
		const like = `%${escapeSqlLike(filter.q)}%`;
		where.push(
			"(id LIKE ? ESCAPE '\\' OR label LIKE ? ESCAPE '\\' OR issue LIKE ? ESCAPE '\\')",
		);
		args.push(like, like, like);
	}
	return { where, args };
}

export function summaryFromSql(
	row: GeminiAccountSummarySqlRow,
	nowMs: number,
): GeminiAccountSummary {
	return {
		id: row.id,
		label: row.label,
		enabled: row.enabled === 1,
		state: geminiAccountState(row, nowMs),
		issue: visibleGeminiAccountIssue(row, nowMs),
		cooldown_until_ms: row.cooldown_until_ms,
		last_issue_at_ms: row.last_issue_at_ms,
		last_used_at_ms: row.last_used_at_ms,
		last_refresh_at_ms: row.last_refresh_at_ms,
		created_at_ms: row.created_at_ms,
		updated_at_ms: row.updated_at_ms,
	};
}

export function numberOrZero(value: unknown): number {
	const n = Number(value);
	return Number.isFinite(n) ? n : 0;
}

function escapeSqlLike(value: string): string {
	return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
