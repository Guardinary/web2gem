import {
	boundedGeminiAccountPageLimit,
	GEMINI_DURABLE_ACCOUNT_ISSUES,
} from "./domain";
import {
	ADMIN_ACCOUNT_SELECT,
	adminPageFromRows,
	adminStatsFromRow,
	adminWhere,
	type GeminiAccountSummarySqlRow,
	summaryFromSql,
} from "./store-d1-admin";
import {
	ACCOUNT_UPSERT_IDENTITY_SQL,
	accountRowValues,
	buildAccountInsertRow,
	resultChanged,
	valueOrCurrent,
} from "./store-d1-codec";
import { D1GeminiAccountRuntimeStore } from "./store-d1-runtime";
import type {
	D1DatabaseLike,
	D1PreparedStatementLike,
	GeminiAccountAdminFilter,
	GeminiAccountAdminOverview,
	GeminiAccountAdminStats,
	GeminiAccountBulkCreateEntry,
	GeminiAccountBulkCreateResult,
	GeminiAccountCreateInput,
	GeminiAccountRow,
	GeminiAccountStore,
	GeminiAccountSummary,
	GeminiAccountSummaryPage,
	GeminiAccountUpdate,
	GeminiAccountUpdateResult,
} from "./types";

export { isD1UniqueConstraintError } from "./store-d1-codec";

const MAX_D1_BOUND_PARAMETERS = 100;
const MAX_TRANSACTIONAL_ACCOUNT_INSERTS = 40;

export class D1GeminiAccountStore
	extends D1GeminiAccountRuntimeStore
	implements GeminiAccountStore
{
	constructor(db: D1DatabaseLike) {
		super(db);
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

	async findAccountByIdentityHash(
		identityHash: string,
		nowMs: number,
	): Promise<GeminiAccountSummary | null> {
		const row = await this.db
			.prepare(`
      SELECT ${ADMIN_ACCOUNT_SELECT}
      FROM gemini_accounts
      WHERE identity_hash = ?
      LIMIT 1
    `)
			.bind(identityHash)
			.first<GeminiAccountSummarySqlRow>();
		return row ? summaryFromSql(row, nowMs) : null;
	}

	async createAccount(
		input: GeminiAccountCreateInput,
	): Promise<GeminiAccountSummary> {
		const row = await buildAccountInsertRow(input);
		await this.runMutationWithPoolVersion(
			this.db
				.prepare(ACCOUNT_UPSERT_IDENTITY_SQL)
				.bind(...accountRowValues(row)),
			input.nowMs,
		);
		return (
			(await this.findAccountByIdentityHash(row.identity_hash, input.nowMs)) ||
			summaryFromSql(row, input.nowMs)
		);
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
		const previousCookieByIdentity = await this.findCookieHashesByIdentity(
			rows.map((row) => row.identity_hash),
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
					.prepare(ACCOUNT_UPSERT_IDENTITY_SQL)
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
			if (
				itemsByCookieHash.has(cookieHash) &&
				previousCookieByIdentity.get(row.identity_hash) !== cookieHash
			)
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

	private async findCookieHashesByIdentity(
		identityHashes: readonly string[],
	): Promise<Map<string, string>> {
		const unique = [...new Set(identityHashes)];
		const out = new Map<string, string>();
		for (
			let offset = 0;
			offset < unique.length;
			offset += MAX_D1_BOUND_PARAMETERS
		) {
			const chunk = unique.slice(offset, offset + MAX_D1_BOUND_PARAMETERS);
			if (!chunk.length) continue;
			const placeholders = chunk.map(() => "?").join(", ");
			const result = await this.db
				.prepare(`
          SELECT identity_hash, cookie_hash
          FROM gemini_accounts
          WHERE identity_hash IN (${placeholders})
        `)
				.bind(...chunk)
				.all<{ identity_hash: string; cookie_hash: string }>();
			for (const row of result.results || [])
				out.set(row.identity_hash, row.cookie_hash);
		}
		return out;
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
