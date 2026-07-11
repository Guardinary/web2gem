import { uuid } from "../../shared/runtime";
import { parseCookieHeader } from "../cookies";
import {
	accountRowId,
	changedRows,
	geminiAccountCategory,
	hashNullable,
	normalizeGeminiCookieHeader,
	sanitizeGeminiAccount,
	sha256Hex,
} from "./normalize";
import {
	ADMIN_ACCOUNT_SELECT,
	adminWhere,
	type GeminiAccountPublicSqlRow,
	numberOrZero,
	publicRowFromSql,
} from "./store-d1-admin";
import type {
	D1DatabaseLike,
	D1Result,
	GeminiAccountCreateInput,
	GeminiAccountCategory,
	GeminiAccountAdminStats,
	GeminiAccountAdminFilter,
	GeminiAccountPublic,
	GeminiAccountPublicPage,
	GeminiAccountRow,
	GeminiAccountSecretRow,
	GeminiAccountSnapshotRow,
	GeminiAccountStore,
	GeminiAccountUpdate,
	GeminiCookieWriteback,
	GeminiCookieWritebackResult,
	GeminiAccountOutcome,
} from "./types";

const POOL_VERSION_KEY = "pool_version";
const SELECTABLE_STATUSES = [
	"active",
	"transient_failed",
	"rate_limited",
	"cooling_down",
] as const;
const NEEDS_ATTENTION_STATUSES = [
	"auth_failed",
	"needs_cookie_update",
	"rate_limited",
	"cooling_down",
	"hard_blocked",
	"needs_user_action",
	"missing_cookie",
	"capability_mismatch",
] as const;

export class D1GeminiAccountStore implements GeminiAccountStore {
	constructor(private readonly db: D1DatabaseLike) {}

	async getPoolVersion(): Promise<string> {
		const value = await this.db
			.prepare("SELECT value FROM gemini_pool_meta WHERE key = ?")
			.bind(POOL_VERSION_KEY)
			.first<string>("value");
		return value || "0";
	}

	async listSelectableAccounts(
		nowMs: number,
		limit: number,
	): Promise<GeminiAccountSnapshotRow[]> {
		const boundedLimit = boundedPageLimit(limit);
		const result = await this.db
			.prepare(`
      SELECT
        id, row_id, label, enabled, status, cookie_header, cookie_hash, sapisid, session_token,
        session_token_hash, user_agent, gemini_origin, cooldown_until_ms,
        last_used_at_ms, last_success_at_ms, last_failure_at_ms
      FROM gemini_accounts
      WHERE enabled = 1
        AND status IN (?, ?, ?, ?)
        AND (cooldown_until_ms IS NULL OR cooldown_until_ms <= ?)
      ORDER BY COALESCE(last_used_at_ms, 0) ASC
      LIMIT ?
    `)
			.bind(...SELECTABLE_STATUSES, nowMs, boundedLimit)
			.all<GeminiAccountSnapshotRow>();
		return result.results || [];
	}

	async listAdminAccounts(
		filter: GeminiAccountAdminFilter,
		nowMs: number,
	): Promise<GeminiAccountPublicPage> {
		const limit = boundedPageLimit(filter.limit);
		const { where, args } = adminWhere(filter, nowMs);
		args.push(limit + 1);
		const sql = `
      SELECT ${ADMIN_ACCOUNT_SELECT}
      FROM gemini_accounts
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY id ASC
      LIMIT ?
    `;
		const result = await this.db
			.prepare(sql)
			.bind(...args)
			.all<GeminiAccountPublicSqlRow>();
		const rows = result.results || [];
		const pageRows = rows.slice(0, limit);
		const nextCursor =
			rows.length > limit ? pageRows[pageRows.length - 1]?.id || null : null;
		return {
			items: pageRows.map(publicRowFromSql),
			nextCursor,
			limit,
		};
	}

	async getAdminStats(
		filter: Omit<GeminiAccountAdminFilter, "cursor" | "limit">,
		nowMs: number,
	): Promise<GeminiAccountAdminStats> {
		const { where, args } = adminWhere(filter, nowMs);
		const sql = `
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN enabled = 1 AND status = 'active' THEN 1 ELSE 0 END) AS available,
        SUM(CASE WHEN status IN (${NEEDS_ATTENTION_STATUSES.map(() => "?").join(", ")}) THEN 1 ELSE 0 END) AS needsAttention,
        SUM(CASE WHEN enabled != 1 OR status = 'disabled' THEN 1 ELSE 0 END) AS disabled,
        SUM(CASE WHEN enabled = 1 AND account_category IN ('full_session', 'psid_psidts') THEN 1 ELSE 0 END) AS refreshable,
        SUM(CASE WHEN cooldown_until_ms IS NOT NULL AND cooldown_until_ms > ? THEN 1 ELSE 0 END) AS cooling,
        SUM(CASE WHEN account_category IN ('psid_only', 'missing_session') THEN 1 ELSE 0 END) AS psidOnly,
        SUM(success_count) AS successCount,
        SUM(failure_count) AS failureCount
      FROM gemini_accounts
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    `;
		const row = await this.db
			.prepare(sql)
			.bind(...NEEDS_ATTENTION_STATUSES, nowMs, ...args)
			.first<Partial<GeminiAccountAdminStats>>();
		return {
			total: numberOrZero(row?.total),
			available: numberOrZero(row?.available),
			needsAttention: numberOrZero(row?.needsAttention),
			disabled: numberOrZero(row?.disabled),
			refreshable: numberOrZero(row?.refreshable),
			cooling: numberOrZero(row?.cooling),
			psidOnly: numberOrZero(row?.psidOnly),
			successCount: numberOrZero(row?.successCount),
			failureCount: numberOrZero(row?.failureCount),
		};
	}

	async findAccountByCookieHash(
		cookieHash: string,
	): Promise<GeminiAccountPublic | null> {
		const row = await this.db
			.prepare(`
      SELECT ${ADMIN_ACCOUNT_SELECT}
      FROM gemini_accounts
      WHERE cookie_hash = ?
      LIMIT 1
    `)
			.bind(cookieHash)
			.first<GeminiAccountPublicSqlRow>();
		return row ? publicRowFromSql(row) : null;
	}

	async getAccountForRefresh(
		accountId: string,
	): Promise<GeminiAccountSecretRow | null> {
		return this.db
			.prepare("SELECT * FROM gemini_accounts WHERE id = ? LIMIT 1")
			.bind(accountId)
			.first<GeminiAccountRow>();
	}

	async resolveAccountIdentifier(input: {
		id?: string;
		rowId?: string;
	}): Promise<string | null> {
		if (input.id) {
			const row = await this.db
				.prepare("SELECT id FROM gemini_accounts WHERE id = ? LIMIT 1")
				.bind(input.id)
				.first<{ id: string }>();
			if (row?.id) return row.id;
		}
		if (input.rowId) {
			const row = await this.db
				.prepare("SELECT id FROM gemini_accounts WHERE row_id = ? LIMIT 1")
				.bind(input.rowId)
				.first<{ id: string }>();
			if (row?.id) return row.id;
		}
		return null;
	}

	async createAccount(
		input: GeminiAccountCreateInput,
	): Promise<GeminiAccountPublic> {
		const row = await buildAccountInsertRow(input);
		await this.db
			.prepare(`
      INSERT INTO gemini_accounts (
        id, label, enabled, status, state_reason, row_id, cookie_header, cookie_hash,
        sapisid, session_token, session_token_hash, session_id, language, push_id,
        last_token_bootstrap_at_ms, secure_1psid_hash, secure_1psidts_hash,
        account_category, account_status_code, account_status_description, user_agent,
        gemini_origin, source, source_id, source_name, imported_at_ms, cooldown_until_ms,
        last_used_at_ms, last_success_at_ms, last_failure_at_ms, last_refresh_at_ms,
        last_refresh_attempt_at_ms, last_error_code, last_error_message_redacted,
        last_upstream_status, last_capability_probe_at_ms, capability_summary_json,
        success_count, failure_count, created_at_ms, updated_at_ms
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `)
			.bind(...accountRowValues(row))
			.run();
		await this.bumpPoolVersion(input.nowMs);
		return sanitizeGeminiAccount(row);
	}

	async updateAccount(
		accountId: string,
		update: GeminiAccountUpdate,
	): Promise<GeminiAccountPublic | null> {
		const current = await this.getAccountForRefresh(accountId);
		if (!current) return null;
		const enabled =
			update.enabled === undefined ? current.enabled : Number(update.enabled);
		const next: GeminiAccountRow = {
			...current,
			label: valueOrCurrent(update.label, current.label),
			enabled,
			status: update.status || current.status,
			state_reason: valueOrCurrent(update.stateReason, current.state_reason),
			cooldown_until_ms: valueOrCurrent(
				update.cooldownUntilMs,
				current.cooldown_until_ms,
			),
			account_status_code: valueOrCurrent(
				update.accountStatusCode,
				current.account_status_code,
			),
			account_status_description: valueOrCurrent(
				update.accountStatusDescription,
				current.account_status_description,
			),
			user_agent: valueOrCurrent(update.userAgent, current.user_agent),
			gemini_origin: valueOrCurrent(update.geminiOrigin, current.gemini_origin),
			source: valueOrCurrent(update.source, current.source),
			source_id: valueOrCurrent(update.sourceId, current.source_id),
			source_name: valueOrCurrent(update.sourceName, current.source_name),
			updated_at_ms: update.nowMs,
		};
		await this.db
			.prepare(`
      UPDATE gemini_accounts
      SET label = ?, enabled = ?, status = ?, state_reason = ?, cooldown_until_ms = ?,
          account_status_code = ?, account_status_description = ?, user_agent = ?,
          gemini_origin = ?, source = ?, source_id = ?, source_name = ?, updated_at_ms = ?
      WHERE id = ?
    `)
			.bind(
				next.label,
				next.enabled,
				next.status,
				next.state_reason,
				next.cooldown_until_ms,
				next.account_status_code,
				next.account_status_description,
				next.user_agent,
				next.gemini_origin,
				next.source,
				next.source_id,
				next.source_name,
				next.updated_at_ms,
				accountId,
			)
			.run();
		await this.bumpPoolVersion(update.nowMs);
		return sanitizeGeminiAccount(next);
	}

	async deleteAccount(accountId: string): Promise<boolean> {
		const result = await this.db
			.prepare("DELETE FROM gemini_accounts WHERE id = ?")
			.bind(accountId)
			.run();
		const removed = resultChanged(result) !== 0;
		if (removed) await this.bumpPoolVersion(Date.now());
		return removed;
	}

	async tryAcquireRefreshLock(
		accountId: string,
		owner: string,
		expiresAtMs: number,
		nowMs: number,
	): Promise<boolean> {
		const result = await this.db
			.prepare(`
      INSERT INTO gemini_account_locks (account_id, lock_owner, expires_at_ms, created_at_ms)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        lock_owner = excluded.lock_owner,
        expires_at_ms = excluded.expires_at_ms,
        created_at_ms = excluded.created_at_ms
      WHERE gemini_account_locks.expires_at_ms < ?
    `)
			.bind(accountId, owner, expiresAtMs, nowMs, nowMs)
			.run();
		return resultChanged(result) > 0;
	}

	async releaseRefreshLock(accountId: string, owner: string): Promise<void> {
		await this.db
			.prepare(
				"DELETE FROM gemini_account_locks WHERE account_id = ? AND lock_owner = ?",
			)
			.bind(accountId, owner)
			.run();
	}

	async writeCookieState(
		accountId: string,
		update: GeminiCookieWriteback,
	): Promise<GeminiCookieWritebackResult> {
		const current = await this.getAccountForRefresh(accountId);
		if (!current) return { changed: false };
		const nextCookieHeader = normalizeGeminiCookieHeader(update.cookieHeader);
		const nextCookieHash = await sha256Hex(nextCookieHeader);
		const sessionToken =
			update.sessionToken === undefined
				? current.session_token
				: update.sessionToken;
		const nextSessionTokenHash =
			update.sessionToken === undefined
				? current.session_token_hash
				: await hashNullable(update.sessionToken);
		const cookiesChanged =
			nextCookieHash !== current.cookie_hash ||
			nextSessionTokenHash !== current.session_token_hash ||
			valueChanged(update.sapisid, current.sapisid) ||
			valueChanged(update.sessionId, current.session_id) ||
			valueChanged(update.language, current.language) ||
			valueChanged(update.pushId, current.push_id) ||
			valueChanged(update.status, current.status) ||
			valueChanged(update.stateReason, current.state_reason);
		if (!cookiesChanged) return { changed: false };

		if (nextCookieHash !== current.cookie_hash) {
			const duplicate = await this.findAccountByCookieHash(nextCookieHash);
			if (duplicate && duplicate.id !== accountId)
				return { changed: false, reason: "duplicate_cookie" };
		}

		const hashes = await cookieHashes(nextCookieHeader);
		try {
			await this.db
				.prepare(`
        UPDATE gemini_accounts
        SET cookie_header = ?, cookie_hash = ?, sapisid = ?, session_token = ?,
            session_token_hash = ?, session_id = ?, language = ?, push_id = ?,
            secure_1psid_hash = ?, secure_1psidts_hash = ?, account_category = ?,
            status = ?, state_reason = ?, last_refresh_at_ms = ?,
            last_refresh_attempt_at_ms = ?, updated_at_ms = ?
        WHERE id = ?
      `)
				.bind(
					nextCookieHeader,
					nextCookieHash,
					valueOrCurrent(update.sapisid, current.sapisid),
					sessionToken,
					nextSessionTokenHash,
					valueOrCurrent(update.sessionId, current.session_id),
					valueOrCurrent(update.language, current.language),
					valueOrCurrent(update.pushId, current.push_id),
					hashes.secure1psidHash,
					hashes.secure1psidtsHash,
					geminiAccountCategory({
						cookieHeader: nextCookieHeader,
						sessionToken: sessionToken ?? null,
					}),
					update.status || current.status,
					valueOrCurrent(update.stateReason, current.state_reason),
					valueOrCurrent(update.lastRefreshAtMs, current.last_refresh_at_ms),
					valueOrCurrent(
						update.lastRefreshAttemptAtMs,
						current.last_refresh_attempt_at_ms,
					),
					update.nowMs,
					accountId,
				)
				.run();
		} catch (error) {
			if (!isD1UniqueConstraintError(error)) throw error;
			const duplicate = await this.findAccountByCookieHash(nextCookieHash);
			if (!duplicate || duplicate.id === accountId) throw error;
			return { changed: false, reason: "duplicate_cookie" };
		}
		await this.bumpPoolVersion(update.nowMs);
		return { changed: true };
	}

	async writeAccountOutcome(
		accountId: string,
		outcome: GeminiAccountOutcome,
	): Promise<void> {
		const isSuccess = outcome.kind === "success";
		await this.db
			.prepare(`
      UPDATE gemini_accounts
      SET status = COALESCE(?, status),
          state_reason = ?,
          cooldown_until_ms = ?,
          last_success_at_ms = CASE WHEN ? THEN ? ELSE last_success_at_ms END,
          last_failure_at_ms = CASE WHEN ? THEN ? ELSE last_failure_at_ms END,
          last_error_code = ?,
          last_error_message_redacted = ?,
          last_upstream_status = ?,
          last_used_at_ms = ?,
          success_count = success_count + ?,
          failure_count = failure_count + ?,
          updated_at_ms = ?
      WHERE id = ?
    `)
			.bind(
				outcome.status || null,
				outcome.stateReason ?? null,
				outcome.cooldownUntilMs ?? null,
				isSuccess ? 1 : 0,
				outcome.nowMs,
				isSuccess ? 0 : 1,
				outcome.nowMs,
				outcome.errorCode ?? outcome.failureKind ?? null,
				outcome.errorMessageRedacted ?? null,
				outcome.upstreamStatus ?? null,
				outcome.nowMs,
				isSuccess ? 1 : 0,
				isSuccess ? 0 : 1,
				outcome.nowMs,
				accountId,
			)
			.run();
		if (outcome.status || outcome.cooldownUntilMs != null)
			await this.bumpPoolVersion(outcome.nowMs);
	}

	private async bumpPoolVersion(nowMs: number): Promise<void> {
		await this.db
			.prepare(`
      INSERT INTO gemini_pool_meta (key, value, updated_at_ms)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at_ms = excluded.updated_at_ms
    `)
			.bind(POOL_VERSION_KEY, String(nowMs), nowMs)
			.run();
	}
}

async function buildAccountInsertRow(
	input: GeminiAccountCreateInput,
): Promise<GeminiAccountRow> {
	const cookieHeader = normalizeGeminiCookieHeader(input.cookieHeader);
	const hashes = await cookieHashes(cookieHeader);
	const sessionTokenHash = await hashNullable(input.sessionToken);
	const id = input.id || uuid();
	return {
		id,
		label: input.label || null,
		enabled: 1,
		status: "active",
		state_reason: null,
		row_id: await accountRowId({ cookieHeader, accountId: id }),
		cookie_header: cookieHeader,
		cookie_hash: await sha256Hex(cookieHeader),
		sapisid: input.sapisid || null,
		session_token: input.sessionToken || null,
		session_token_hash: sessionTokenHash,
		session_id: input.sessionId || null,
		language: input.language || null,
		push_id: input.pushId || null,
		last_token_bootstrap_at_ms: null,
		secure_1psid_hash: hashes.secure1psidHash,
		secure_1psidts_hash: hashes.secure1psidtsHash,
		account_category: geminiAccountCategory({
			cookieHeader,
			sessionToken: input.sessionToken ?? null,
		}),
		account_status_code: null,
		account_status_description: null,
		user_agent: input.userAgent || null,
		gemini_origin: input.geminiOrigin || null,
		source: input.source || null,
		source_id: input.sourceId || null,
		source_name: input.sourceName || null,
		imported_at_ms: input.nowMs,
		cooldown_until_ms: null,
		last_used_at_ms: null,
		last_success_at_ms: null,
		last_failure_at_ms: null,
		last_refresh_at_ms: null,
		last_refresh_attempt_at_ms: null,
		last_error_code: null,
		last_error_message_redacted: null,
		last_upstream_status: null,
		last_capability_probe_at_ms: null,
		capability_summary_json: null,
		success_count: 0,
		failure_count: 0,
		created_at_ms: input.nowMs,
		updated_at_ms: input.nowMs,
	};
}

function accountRowValues(row: GeminiAccountRow): unknown[] {
	return [
		row.id,
		row.label,
		row.enabled,
		row.status,
		row.state_reason,
		row.row_id,
		row.cookie_header,
		row.cookie_hash,
		row.sapisid,
		row.session_token,
		row.session_token_hash,
		row.session_id,
		row.language,
		row.push_id,
		row.last_token_bootstrap_at_ms,
		row.secure_1psid_hash,
		row.secure_1psidts_hash,
		row.account_category,
		row.account_status_code,
		row.account_status_description,
		row.user_agent,
		row.gemini_origin,
		row.source,
		row.source_id,
		row.source_name,
		row.imported_at_ms,
		row.cooldown_until_ms,
		row.last_used_at_ms,
		row.last_success_at_ms,
		row.last_failure_at_ms,
		row.last_refresh_at_ms,
		row.last_refresh_attempt_at_ms,
		row.last_error_code,
		row.last_error_message_redacted,
		row.last_upstream_status,
		row.last_capability_probe_at_ms,
		row.capability_summary_json,
		row.success_count,
		row.failure_count,
		row.created_at_ms,
		row.updated_at_ms,
	];
}

async function cookieHashes(
	cookieHeader: string,
): Promise<{ secure1psidHash: string; secure1psidtsHash: string | null }> {
	const cookies = parseCookieHeader(cookieHeader);
	return {
		secure1psidHash: await sha256Hex(cookies.get("__Secure-1PSID") || ""),
		secure1psidtsHash: await hashNullable(cookies.get("__Secure-1PSIDTS")),
	};
}

function boundedPageLimit(limit: number): number {
	const n = Number.isInteger(limit) ? limit : 50;
	return Math.min(Math.max(n, 1), 200);
}

function resultChanged(result: D1Result): number {
	const rows = changedRows(result.meta);
	return rows == null ? 1 : rows;
}

function valueOrCurrent<T>(next: T | undefined, current: T): T {
	return next === undefined ? current : next;
}

function valueChanged(next: unknown, current: unknown): boolean {
	return next !== undefined && next !== current;
}

export function isGeminiAccountCategory(
	value: string,
): value is GeminiAccountCategory {
	return [
		"full_session",
		"psid_psidts",
		"psid_only",
		"session_token_only",
		"missing_session",
	].includes(value);
}

export function isD1UniqueConstraintError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error ?? "");
	return /unique constraint failed|constraint.*unique|SQLITE_CONSTRAINT/i.test(
		message,
	);
}
