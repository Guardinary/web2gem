import { uuid } from "../../shared/crypto";
import { parseCookieHeader } from "../cookies";
import { boundedGeminiAccountPageLimit } from "./domain";
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
	D1PreparedStatementLike,
	D1Result,
	GeminiAccountBulkCreateEntry,
	GeminiAccountBulkCreateResult,
	GeminiAccountCreateInput,
	GeminiAccountAdminStats,
	GeminiAccountAdminFilter,
	GeminiAccountAdminOverview,
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
const MAX_D1_BOUND_PARAMETERS = 100;
const MAX_TRANSACTIONAL_ACCOUNT_INSERTS = 40;
const ACCOUNT_INSERT_COLUMNS = [
	"id",
	"label",
	"enabled",
	"status",
	"state_reason",
	"row_id",
	"cookie_header",
	"cookie_hash",
	"sapisid",
	"session_token",
	"session_token_hash",
	"session_id",
	"language",
	"push_id",
	"last_token_bootstrap_at_ms",
	"secure_1psid_hash",
	"secure_1psidts_hash",
	"account_category",
	"account_status_code",
	"account_status_description",
	"user_agent",
	"gemini_origin",
	"source",
	"source_id",
	"source_name",
	"imported_at_ms",
	"cooldown_until_ms",
	"last_used_at_ms",
	"last_success_at_ms",
	"last_failure_at_ms",
	"last_refresh_at_ms",
	"last_refresh_attempt_at_ms",
	"last_error_code",
	"last_error_message_redacted",
	"last_upstream_status",
	"last_capability_probe_at_ms",
	"capability_summary_json",
	"success_count",
	"failure_count",
	"created_at_ms",
	"updated_at_ms",
] as const satisfies readonly (keyof GeminiAccountRow)[];
const ACCOUNT_INSERT_SQL = `
      INSERT INTO gemini_accounts (${ACCOUNT_INSERT_COLUMNS.join(", ")})
      VALUES (${ACCOUNT_INSERT_COLUMNS.map(() => "?").join(", ")})
`;
const ACCOUNT_INSERT_IGNORE_COOKIE_CONFLICT_SQL = `${ACCOUNT_INSERT_SQL}
      ON CONFLICT(cookie_hash) DO NOTHING
`;
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
		const boundedLimit = boundedGeminiAccountPageLimit(limit);
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
		const result = await this.adminPageStatement(
			filter,
			nowMs,
		).all<GeminiAccountPublicSqlRow>();
		return adminPageFromRows(result.results || [], filter.limit);
	}

	async getAdminStats(
		filter: Omit<GeminiAccountAdminFilter, "cursor" | "limit">,
		nowMs: number,
	): Promise<GeminiAccountAdminStats> {
		const row = await this.adminStatsStatement(filter, nowMs).first<
			Partial<GeminiAccountAdminStats>
		>();
		return adminStatsFromRow(row);
	}

	async getAdminOverview(
		filter: GeminiAccountAdminFilter,
		nowMs: number,
	): Promise<GeminiAccountAdminOverview> {
		const statsFilter = statsFilterFromAdminFilter(filter);
		if (!this.db.batch) {
			const [page, stats] = await Promise.all([
				this.listAdminAccounts(filter, nowMs),
				this.getAdminStats(statsFilter, nowMs),
			]);
			return { ...page, stats };
		}
		const [pageResult, statsResult] = await this.db.batch([
			this.adminPageStatement(filter, nowMs),
			this.adminStatsStatement(statsFilter, nowMs),
		]);
		if (!pageResult || !statsResult)
			throw new Error("D1 account overview batch returned incomplete results");
		return {
			...adminPageFromRows(
				(pageResult.results || []) as GeminiAccountPublicSqlRow[],
				filter.limit,
			),
			stats: adminStatsFromRow(
				(statsResult.results?.[0] ||
					null) as Partial<GeminiAccountAdminStats> | null,
			),
		};
	}

	private adminPageStatement(
		filter: GeminiAccountAdminFilter,
		nowMs: number,
	): D1PreparedStatementLike {
		const limit = boundedGeminiAccountPageLimit(filter.limit);
		const { where, args } = adminWhere(filter, nowMs);
		return this.db
			.prepare(`
      SELECT ${ADMIN_ACCOUNT_SELECT}
      FROM gemini_accounts
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY id ASC
      LIMIT ?
    `)
			.bind(...args, limit + 1);
	}

	private adminStatsStatement(
		filter: Omit<GeminiAccountAdminFilter, "cursor" | "limit">,
		nowMs: number,
	): D1PreparedStatementLike {
		const { where, args } = adminWhere(filter, nowMs);
		return this.db
			.prepare(`
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
		`)
			.bind(...NEEDS_ATTENTION_STATUSES, nowMs, ...args);
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
		await this.runMutationWithPoolVersion(
			this.db.prepare(ACCOUNT_INSERT_SQL).bind(...accountRowValues(row)),
			input.nowMs,
		);
		return sanitizeGeminiAccount(row);
	}

	async createAccountsBulk(
		entries: GeminiAccountBulkCreateEntry[],
	): Promise<GeminiAccountBulkCreateResult> {
		if (!entries.length)
			return {
				itemsByCookieHash: new Map(),
				addedCookieHashes: new Set(),
			};
		const rows = await Promise.all(
			entries.map((entry) =>
				buildAccountInsertRow(entry.input, entry.cookieHash),
			),
		);
		if (this.db.batch) {
			for (
				let offset = 0;
				offset < rows.length;
				offset += MAX_TRANSACTIONAL_ACCOUNT_INSERTS
			) {
				const group = rows.slice(
					offset,
					offset + MAX_TRANSACTIONAL_ACCOUNT_INSERTS,
				);
				const statements = group.map((row) =>
					this.db
						.prepare(ACCOUNT_INSERT_IGNORE_COOKIE_CONFLICT_SQL)
						.bind(...accountRowValues(row)),
				);
				statements.push(
					this.poolVersionIncrementForInsertedRows(
						entries[0]?.input.nowMs ?? Date.now(),
						group.map((row) => row.id),
					),
				);
				await this.db.batch(statements);
			}
		} else {
			for (const row of rows) {
				await this.db
					.prepare(ACCOUNT_INSERT_IGNORE_COOKIE_CONFLICT_SQL)
					.bind(...accountRowValues(row))
					.run();
			}
		}

		const itemsByCookieHash = await this.findAccountsByCookieHashes(
			entries.map((entry) => entry.cookieHash),
		);
		const addedCookieHashes = new Set<string>();
		for (const row of rows) {
			if (itemsByCookieHash.get(row.cookie_hash)?.id === row.id)
				addedCookieHashes.add(row.cookie_hash);
		}
		if (!this.db.batch && addedCookieHashes.size > 0)
			await this.bumpPoolVersion(entries[0]?.input.nowMs ?? Date.now());
		return { itemsByCookieHash, addedCookieHashes };
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
		await this.runMutationWithPoolVersion(
			this.db
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
				),
			update.nowMs,
		);
		return sanitizeGeminiAccount(next);
	}

	async deleteAccount(accountId: string): Promise<boolean> {
		const result = await this.runMutationWithPoolVersion(
			this.db
				.prepare("DELETE FROM gemini_accounts WHERE id = ?")
				.bind(accountId),
			Date.now(),
		);
		const removed = resultChanged(result) !== 0;
		return removed;
	}

	async setAccountsEnabledBulk(
		accountIds: readonly string[],
		enabled: boolean,
		nowMs: number,
	): Promise<GeminiAccountPublic[]> {
		if (!accountIds.length) return [];
		const placeholders = accountIds.map(() => "?").join(", ");
		await this.runMutationWithPoolVersion(
			this.db
				.prepare(`
        UPDATE gemini_accounts
        SET enabled = ?, status = CASE WHEN ? = 1 AND status = 'disabled' THEN 'active' WHEN ? = 0 THEN 'disabled' ELSE status END,
            updated_at_ms = ?
        WHERE id IN (${placeholders})
      `)
				.bind(
					enabled ? 1 : 0,
					enabled ? 1 : 0,
					enabled ? 1 : 0,
					nowMs,
					...accountIds,
				),
			nowMs,
		);
		return this.findAccountsByIds(accountIds);
	}

	async deleteAccountsBulk(
		accountIds: readonly string[],
		nowMs: number,
	): Promise<string[]> {
		if (!accountIds.length) return [];
		const existing = await this.findAccountsByIds(accountIds);
		const placeholders = accountIds.map(() => "?").join(", ");
		await this.runMutationWithPoolVersion(
			this.db
				.prepare(`DELETE FROM gemini_accounts WHERE id IN (${placeholders})`)
				.bind(...accountIds),
			nowMs,
		);
		return existing.map((item) => item.id);
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
			await this.runMutationWithPoolVersion(
				this.db
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
					),
				update.nowMs,
			);
		} catch (error) {
			if (!isD1UniqueConstraintError(error)) throw error;
			const duplicate = await this.findAccountByCookieHash(nextCookieHash);
			if (!duplicate || duplicate.id === accountId) throw error;
			return { changed: false, reason: "duplicate_cookie" };
		}
		return { changed: true };
	}

	async writeAccountOutcome(
		accountId: string,
		outcome: GeminiAccountOutcome,
	): Promise<void> {
		const isSuccess = outcome.kind === "success";
		const statement = this.db
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
			);
		if (outcome.status || outcome.cooldownUntilMs != null) {
			await this.runMutationWithPoolVersion(statement, outcome.nowMs);
			return;
		}
		await statement.run();
	}

	private async runMutationWithPoolVersion(
		mutation: D1PreparedStatementLike,
		nowMs: number,
	): Promise<D1Result> {
		if (!this.db.batch) {
			const result = await mutation.run();
			if (resultChanged(result) > 0) await this.bumpPoolVersion(nowMs);
			return result;
		}
		const [result] = await this.db.batch([
			mutation,
			this.poolVersionIncrementStatement(nowMs, "WHERE changes() > 0"),
		]);
		if (!result)
			throw new Error("D1 account mutation batch returned no result");
		return result;
	}

	private async bumpPoolVersion(nowMs: number): Promise<void> {
		await this.poolVersionIncrementStatement(nowMs).run();
	}

	private poolVersionIncrementStatement(
		nowMs: number,
		condition = "",
		conditionValues: readonly unknown[] = [],
	): D1PreparedStatementLike {
		return this.db
			.prepare(`
      INSERT INTO gemini_pool_meta (key, value, updated_at_ms)
      SELECT ?, '1', ?
      ${condition}
      ON CONFLICT(key) DO UPDATE SET
        value = CAST(CAST(gemini_pool_meta.value AS INTEGER) + 1 AS TEXT),
        updated_at_ms = MAX(gemini_pool_meta.updated_at_ms, excluded.updated_at_ms)
    `)
			.bind(POOL_VERSION_KEY, nowMs, ...conditionValues);
	}

	private poolVersionIncrementForInsertedRows(
		nowMs: number,
		accountIds: readonly string[],
	): D1PreparedStatementLike {
		const placeholders = accountIds.map(() => "?").join(", ");
		return this.poolVersionIncrementStatement(
			nowMs,
			`WHERE EXISTS (
        SELECT 1 FROM gemini_accounts WHERE id IN (${placeholders})
      )`,
			accountIds,
		);
	}

	private async findAccountsByCookieHashes(
		requestedCookieHashes: string[],
	): Promise<Map<string, GeminiAccountPublic>> {
		const items = new Map<string, GeminiAccountPublic>();
		for (
			let offset = 0;
			offset < requestedCookieHashes.length;
			offset += MAX_D1_BOUND_PARAMETERS
		) {
			const chunk = requestedCookieHashes.slice(
				offset,
				offset + MAX_D1_BOUND_PARAMETERS,
			);
			const placeholders = chunk.map(() => "?").join(", ");
			const result = await this.db
				.prepare(`
          SELECT ${ADMIN_ACCOUNT_SELECT}
          FROM gemini_accounts
          WHERE cookie_hash IN (${placeholders})
        `)
				.bind(...chunk)
				.all<GeminiAccountPublicSqlRow>();
			for (const row of result.results || []) {
				const item = publicRowFromSql(row);
				items.set(item.cookie_hash, item);
			}
		}
		return items;
	}

	private async findAccountsByIds(
		accountIds: readonly string[],
	): Promise<GeminiAccountPublic[]> {
		const placeholders = accountIds.map(() => "?").join(", ");
		const result = await this.db
			.prepare(`
      SELECT ${ADMIN_ACCOUNT_SELECT}
      FROM gemini_accounts
      WHERE id IN (${placeholders})
    `)
			.bind(...accountIds)
			.all<GeminiAccountPublicSqlRow>();
		const byId = new Map(
			(result.results || []).map((row) => {
				const item = publicRowFromSql(row);
				return [item.id, item] as const;
			}),
		);
		return accountIds.flatMap((id) => {
			const item = byId.get(id);
			return item ? [item] : [];
		});
	}
}

function adminPageFromRows(
	rows: GeminiAccountPublicSqlRow[],
	requestedLimit: number,
): GeminiAccountPublicPage {
	const limit = boundedGeminiAccountPageLimit(requestedLimit);
	const pageRows = rows.slice(0, limit);
	return {
		items: pageRows.map(publicRowFromSql),
		nextCursor:
			rows.length > limit ? pageRows[pageRows.length - 1]?.id || null : null,
		limit,
	};
}

function adminStatsFromRow(
	row: Partial<GeminiAccountAdminStats> | null | undefined,
): GeminiAccountAdminStats {
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

function statsFilterFromAdminFilter(
	filter: GeminiAccountAdminFilter,
): Omit<GeminiAccountAdminFilter, "cursor" | "limit"> {
	const { cursor: _cursor, limit: _limit, ...statsFilter } = filter;
	return statsFilter;
}

async function buildAccountInsertRow(
	input: GeminiAccountCreateInput,
	cookieHash?: string,
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
		cookie_hash: cookieHash || (await sha256Hex(cookieHeader)),
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
	return ACCOUNT_INSERT_COLUMNS.map((column) => row[column]);
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

export { isGeminiAccountCategory } from "./domain";

export function isD1UniqueConstraintError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error ?? "");
	return /unique constraint failed|constraint.*unique|SQLITE_CONSTRAINT/i.test(
		message,
	);
}
