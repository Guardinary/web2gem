import { uuid } from "../../shared/crypto";
import {
	boundedGeminiAccountPageLimit,
	GEMINI_DURABLE_ACCOUNT_ISSUES,
} from "./domain";
import {
	changedRows,
	normalizeGeminiCookieHeader,
	sha256Hex,
} from "./normalize";
import {
	ADMIN_ACCOUNT_SELECT,
	adminWhere,
	type GeminiAccountSummarySqlRow,
	numberOrZero,
	summaryFromSql,
} from "./store-d1-admin";
import type {
	D1DatabaseLike,
	D1PreparedStatementLike,
	D1Result,
	GeminiAccountAdminFilter,
	GeminiAccountAdminOverview,
	GeminiAccountAdminStats,
	GeminiAccountBulkCreateEntry,
	GeminiAccountBulkCreateResult,
	GeminiAccountCreateInput,
	GeminiAccountOutcome,
	GeminiAccountRow,
	GeminiAccountSecretRow,
	GeminiAccountSnapshotRow,
	GeminiAccountStore,
	GeminiAccountSummary,
	GeminiAccountSummaryPage,
	GeminiAccountUpdate,
	GeminiAccountUpdateResult,
	GeminiRefreshedCookieWrite,
	GeminiRefreshedCookieWriteResult,
} from "./types";

const POOL_VERSION_KEY = "pool_version";
const MAX_D1_BOUND_PARAMETERS = 100;
const MAX_TRANSACTIONAL_ACCOUNT_INSERTS = 40;
const ACCOUNT_INSERT_COLUMNS = [
	"id",
	"label",
	"enabled",
	"cookie_header",
	"cookie_hash",
	"issue",
	"cooldown_until_ms",
	"last_issue_at_ms",
	"last_used_at_ms",
	"last_refresh_at_ms",
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
      SELECT id, enabled, cookie_header, cookie_hash, issue,
             cooldown_until_ms, last_used_at_ms
      FROM gemini_accounts
      WHERE enabled = 1
        AND (cooldown_until_ms IS NULL OR cooldown_until_ms <= ?)
        AND (issue IS NULL OR issue NOT IN (${GEMINI_DURABLE_ACCOUNT_ISSUES.map(() => "?").join(", ")}))
      ORDER BY COALESCE(last_used_at_ms, 0) ASC
      LIMIT ?
    `)
			.bind(nowMs, ...GEMINI_DURABLE_ACCOUNT_ISSUES, boundedLimit)
			.all<GeminiAccountSnapshotRow>();
		return result.results || [];
	}

	async getAdminOverview(
		filter: GeminiAccountAdminFilter,
		nowMs: number,
	): Promise<GeminiAccountAdminOverview> {
		if (!this.db.batch) {
			const [page, stats] = await Promise.all([
				this.listAdminAccounts(filter, nowMs),
				this.getAdminStats(nowMs),
			]);
			return { ...page, stats };
		}
		const [pageResult, statsResult] = await this.db.batch([
			this.adminPageStatement(filter, nowMs),
			this.adminStatsStatement(nowMs),
		]);
		if (!pageResult || !statsResult)
			throw new Error("D1 account overview batch returned incomplete results");
		return {
			...adminPageFromRows(
				(pageResult.results || []) as GeminiAccountSummarySqlRow[],
				filter.limit,
				nowMs,
			),
			stats: adminStatsFromRow(
				(statsResult.results?.[0] ||
					null) as Partial<GeminiAccountAdminStats> | null,
			),
		};
	}

	async findAccountByCookieHash(
		cookieHash: string,
		nowMs: number,
	): Promise<GeminiAccountSummary | null> {
		const row = await this.db
			.prepare(`
      SELECT ${ADMIN_ACCOUNT_SELECT}
      FROM gemini_accounts
      WHERE cookie_hash = ?
      LIMIT 1
    `)
			.bind(cookieHash)
			.first<GeminiAccountSummarySqlRow>();
		return row ? summaryFromSql(row, nowMs) : null;
	}

	async createAccount(
		input: GeminiAccountCreateInput,
	): Promise<GeminiAccountSummary> {
		const row = await buildAccountInsertRow(input);
		await this.runMutationWithPoolVersion(
			this.db.prepare(ACCOUNT_INSERT_SQL).bind(...accountRowValues(row)),
			input.nowMs,
		);
		return summaryFromSql(row, input.nowMs);
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
		for (
			let offset = 0;
			offset < rows.length;
			offset += MAX_TRANSACTIONAL_ACCOUNT_INSERTS
		) {
			const chunk = rows.slice(
				offset,
				offset + MAX_TRANSACTIONAL_ACCOUNT_INSERTS,
			);
			const statements = chunk.map((row) =>
				this.db
					.prepare(ACCOUNT_INSERT_IGNORE_COOKIE_CONFLICT_SQL)
					.bind(...accountRowValues(row)),
			);
			statements.push(
				this.poolVersionIncrementForInsertedRows(
					chunk[0]?.updated_at_ms || Date.now(),
					chunk.map((row) => row.id),
				),
			);
			if (this.db.batch) await this.db.batch(statements);
			else {
				let added = false;
				for (const statement of statements.slice(0, -1)) {
					const result = await statement.run();
					added ||= resultChanged(result) > 0;
				}
				if (added)
					await this.bumpPoolVersion(chunk[0]?.updated_at_ms || Date.now());
			}
		}
		const nowMs = entries[0]?.input.nowMs || Date.now();
		const itemsByCookieHash = await this.findAccountsByCookieHashes(
			entries.map((entry) => entry.cookieHash),
			nowMs,
		);
		const requestedRows = new Map(rows.map((row) => [row.cookie_hash, row]));
		const addedCookieHashes = new Set<string>();
		for (const [cookieHash, row] of requestedRows) {
			if (itemsByCookieHash.get(cookieHash)?.id === row.id)
				addedCookieHashes.add(cookieHash);
		}
		return { itemsByCookieHash, addedCookieHashes };
	}

	async updateAccount(
		accountId: string,
		update: GeminiAccountUpdate,
	): Promise<GeminiAccountUpdateResult> {
		const current = await this.getAccountRow(accountId);
		if (!current) return { item: null, changed: false };
		const label = valueOrCurrent(update.label, current.label);
		let enabled = current.enabled;
		if (update.enabled !== undefined) enabled = update.enabled ? 1 : 0;
		const changed = label !== current.label || enabled !== current.enabled;
		if (!changed)
			return { item: summaryFromSql(current, update.nowMs), changed: false };
		const statement = this.db
			.prepare(`
      UPDATE gemini_accounts
      SET label = ?, enabled = ?, updated_at_ms = ?
      WHERE id = ?
    `)
			.bind(label, enabled, update.nowMs, accountId);
		if (enabled !== current.enabled)
			await this.runMutationWithPoolVersion(statement, update.nowMs);
		else await statement.run();
		return {
			item: summaryFromSql(
				{ ...current, label, enabled, updated_at_ms: update.nowMs },
				update.nowMs,
			),
			changed: true,
		};
	}

	async deleteAccount(accountId: string, nowMs: number): Promise<boolean> {
		const result = await this.runMutationWithPoolVersion(
			this.db
				.prepare("DELETE FROM gemini_accounts WHERE id = ?")
				.bind(accountId),
			nowMs,
		);
		return resultChanged(result) > 0;
	}

	async setAccountsEnabledBulk(
		accountIds: readonly string[],
		enabled: boolean,
		nowMs: number,
	): Promise<string[]> {
		const rows = await this.findAccountRowsByIds(accountIds);
		const changedIds = rows
			.filter((row) => row.enabled !== (enabled ? 1 : 0))
			.map((row) => row.id);
		if (!changedIds.length) return [];
		const placeholders = changedIds.map(() => "?").join(", ");
		await this.runMutationWithPoolVersion(
			this.db
				.prepare(`
        UPDATE gemini_accounts
        SET enabled = ?, updated_at_ms = ?
        WHERE id IN (${placeholders})
      `)
				.bind(enabled ? 1 : 0, nowMs, ...changedIds),
			nowMs,
		);
		return changedIds;
	}

	async deleteAccountsBulk(
		accountIds: readonly string[],
		nowMs: number,
	): Promise<string[]> {
		const rows = await this.findAccountRowsByIds(accountIds);
		const existingIds = rows.map((row) => row.id);
		if (!existingIds.length) return [];
		const placeholders = existingIds.map(() => "?").join(", ");
		await this.runMutationWithPoolVersion(
			this.db
				.prepare(`DELETE FROM gemini_accounts WHERE id IN (${placeholders})`)
				.bind(...existingIds),
			nowMs,
		);
		return existingIds;
	}

	async getAccountForRefresh(
		accountId: string,
	): Promise<GeminiAccountSecretRow | null> {
		return this.getAccountRow(accountId);
	}

	async tryAcquireRefreshLock(
		accountId: string,
		owner: string,
		expiresAtMs: number,
		nowMs: number,
	): Promise<boolean> {
		const result = await this.db
			.prepare(`
      INSERT INTO gemini_account_locks (
        account_id, lock_owner, expires_at_ms, created_at_ms
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        lock_owner = excluded.lock_owner,
        expires_at_ms = excluded.expires_at_ms,
        created_at_ms = excluded.created_at_ms
      WHERE gemini_account_locks.expires_at_ms <= ?
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

	async writeRefreshedCookie(
		accountId: string,
		update: GeminiRefreshedCookieWrite,
	): Promise<GeminiRefreshedCookieWriteResult> {
		const current = await this.getAccountRow(accountId);
		if (!current) return { changed: false };
		const cookieHeader = normalizeGeminiCookieHeader(update.cookieHeader);
		const cookieHash = await sha256Hex(cookieHeader);
		if (cookieHash === current.cookie_hash) {
			await this.runMutationWithPoolVersion(
				this.db
					.prepare(`
          UPDATE gemini_accounts
          SET issue = NULL, cooldown_until_ms = NULL, last_issue_at_ms = NULL,
              last_refresh_at_ms = ?, updated_at_ms = ?
          WHERE id = ?
        `)
					.bind(update.refreshedAtMs, update.nowMs, accountId),
				update.nowMs,
			);
			return { changed: false };
		}
		const duplicateId = await this.findAccountIdByCookieHash(cookieHash);
		if (duplicateId && duplicateId !== accountId)
			return { changed: false, reason: "duplicate_cookie" };
		try {
			await this.runMutationWithPoolVersion(
				this.db
					.prepare(`
          UPDATE gemini_accounts
          SET cookie_header = ?, cookie_hash = ?, issue = NULL,
              cooldown_until_ms = NULL, last_issue_at_ms = NULL,
              last_refresh_at_ms = ?, updated_at_ms = ?
          WHERE id = ?
        `)
					.bind(
						cookieHeader,
						cookieHash,
						update.refreshedAtMs,
						update.nowMs,
						accountId,
					),
				update.nowMs,
			);
		} catch (error) {
			if (!isD1UniqueConstraintError(error)) throw error;
			const duplicate = await this.findAccountIdByCookieHash(cookieHash);
			if (!duplicate || duplicate === accountId) throw error;
			return { changed: false, reason: "duplicate_cookie" };
		}
		return { changed: true };
	}

	async writeAccountOutcome(
		accountId: string,
		outcome: GeminiAccountOutcome,
	): Promise<void> {
		if (outcome.kind === "success") {
			const clearHealth = this.db
				.prepare(`
          UPDATE gemini_accounts
          SET issue = NULL, cooldown_until_ms = NULL, last_issue_at_ms = NULL,
              updated_at_ms = ?
          WHERE id = ?
            AND (issue IS NOT NULL OR cooldown_until_ms IS NOT NULL OR last_issue_at_ms IS NOT NULL)
        `)
				.bind(outcome.nowMs, accountId);
			const recordUse = this.db
				.prepare(`
          UPDATE gemini_accounts
          SET last_used_at_ms = ?, updated_at_ms = ?
          WHERE id = ?
        `)
				.bind(outcome.nowMs, outcome.nowMs, accountId);
			if (this.db.batch) {
				await this.db.batch([
					clearHealth,
					this.poolVersionIncrementStatement(
						outcome.nowMs,
						"WHERE changes() > 0",
					),
					recordUse,
				]);
			} else {
				const result = await clearHealth.run();
				if (resultChanged(result) > 0)
					await this.bumpPoolVersion(outcome.nowMs);
				await recordUse.run();
			}
			return;
		}
		if (!outcome.issue) {
			await this.db
				.prepare(`
          UPDATE gemini_accounts
          SET last_used_at_ms = ?, updated_at_ms = ?
          WHERE id = ?
        `)
				.bind(outcome.nowMs, outcome.nowMs, accountId)
				.run();
			return;
		}
		await this.runMutationWithPoolVersion(
			this.db
				.prepare(`
        UPDATE gemini_accounts
        SET issue = ?, cooldown_until_ms = ?, last_issue_at_ms = ?,
            last_used_at_ms = ?, updated_at_ms = ?
        WHERE id = ?
      `)
				.bind(
					outcome.issue,
					outcome.cooldownUntilMs ?? null,
					outcome.nowMs,
					outcome.nowMs,
					outcome.nowMs,
					accountId,
				),
			outcome.nowMs,
		);
	}

	private async listAdminAccounts(
		filter: GeminiAccountAdminFilter,
		nowMs: number,
	): Promise<GeminiAccountSummaryPage> {
		const result = await this.adminPageStatement(
			filter,
			nowMs,
		).all<GeminiAccountSummarySqlRow>();
		return adminPageFromRows(result.results || [], filter.limit, nowMs);
	}

	private async getAdminStats(nowMs: number): Promise<GeminiAccountAdminStats> {
		const row =
			await this.adminStatsStatement(nowMs).first<
				Partial<GeminiAccountAdminStats>
			>();
		return adminStatsFromRow(row);
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

	private adminStatsStatement(nowMs: number): D1PreparedStatementLike {
		const durable = GEMINI_DURABLE_ACCOUNT_ISSUES.map(() => "?").join(", ");
		return this.db
			.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN enabled = 1
          AND (cooldown_until_ms IS NULL OR cooldown_until_ms <= ?)
          AND (issue IS NULL OR issue NOT IN (${durable})) THEN 1 ELSE 0 END) AS available,
        SUM(CASE WHEN enabled = 1 AND cooldown_until_ms > ? THEN 1 ELSE 0 END) AS cooling,
        SUM(CASE WHEN enabled = 1
          AND (cooldown_until_ms IS NULL OR cooldown_until_ms <= ?)
          AND issue IN (${durable}) THEN 1 ELSE 0 END) AS attention,
        SUM(CASE WHEN enabled != 1 THEN 1 ELSE 0 END) AS disabled
      FROM gemini_accounts
    `)
			.bind(
				nowMs,
				...GEMINI_DURABLE_ACCOUNT_ISSUES,
				nowMs,
				nowMs,
				...GEMINI_DURABLE_ACCOUNT_ISSUES,
			);
	}

	private async getAccountRow(
		accountId: string,
	): Promise<GeminiAccountRow | null> {
		return this.db
			.prepare("SELECT * FROM gemini_accounts WHERE id = ? LIMIT 1")
			.bind(accountId)
			.first<GeminiAccountRow>();
	}

	private async findAccountIdByCookieHash(
		cookieHash: string,
	): Promise<string | null> {
		return this.db
			.prepare("SELECT id FROM gemini_accounts WHERE cookie_hash = ? LIMIT 1")
			.bind(cookieHash)
			.first<string>("id");
	}

	private async findAccountsByCookieHashes(
		requestedCookieHashes: string[],
		nowMs: number,
	): Promise<Map<string, GeminiAccountSummary>> {
		const items = new Map<string, GeminiAccountSummary>();
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
          SELECT cookie_hash, ${ADMIN_ACCOUNT_SELECT}
          FROM gemini_accounts
          WHERE cookie_hash IN (${placeholders})
        `)
				.bind(...chunk)
				.all<GeminiAccountSummarySqlRow & { cookie_hash: string }>();
			for (const row of result.results || [])
				items.set(row.cookie_hash, summaryFromSql(row, nowMs));
		}
		return items;
	}

	private async findAccountRowsByIds(
		accountIds: readonly string[],
	): Promise<GeminiAccountRow[]> {
		if (!accountIds.length) return [];
		const placeholders = accountIds.map(() => "?").join(", ");
		const result = await this.db
			.prepare(`SELECT * FROM gemini_accounts WHERE id IN (${placeholders})`)
			.bind(...accountIds)
			.all<GeminiAccountRow>();
		const byId = new Map((result.results || []).map((row) => [row.id, row]));
		return accountIds.flatMap((id) => {
			const row = byId.get(id);
			return row ? [row] : [];
		});
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
}

function adminPageFromRows(
	rows: GeminiAccountSummarySqlRow[],
	requestedLimit: number,
	nowMs: number,
): GeminiAccountSummaryPage {
	const limit = boundedGeminiAccountPageLimit(requestedLimit);
	const pageRows = rows.slice(0, limit);
	return {
		items: pageRows.map((row) => summaryFromSql(row, nowMs)),
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
		cooling: numberOrZero(row?.cooling),
		attention: numberOrZero(row?.attention),
		disabled: numberOrZero(row?.disabled),
	};
}

async function buildAccountInsertRow(
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
		issue: null,
		cooldown_until_ms: null,
		last_issue_at_ms: null,
		last_used_at_ms: null,
		last_refresh_at_ms: null,
		created_at_ms: input.nowMs,
		updated_at_ms: input.nowMs,
	};
}

function accountRowValues(row: GeminiAccountRow): unknown[] {
	return ACCOUNT_INSERT_COLUMNS.map((column) => row[column]);
}

function resultChanged(result: D1Result): number {
	const rows = changedRows(result.meta);
	return rows == null ? 1 : rows;
}

function valueOrCurrent<T>(next: T | undefined, current: T): T {
	return next === undefined ? current : next;
}

export function isD1UniqueConstraintError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error ?? "");
	return /unique constraint failed|constraint.*unique|SQLITE_CONSTRAINT/i.test(
		message,
	);
}
