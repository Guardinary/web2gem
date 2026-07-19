import { isRecord } from "../../shared/types";
import type {
	GeminiAccountAdminFilter,
	GeminiAccountAdminOverview,
	GeminiAccountAdminStats,
	GeminiAccountAdminStore,
	GeminiAccountBulkCreateEntry,
	GeminiAccountBulkCreateResult,
	GeminiAccountCreateInput,
	GeminiAccountIdentityImportResult,
	GeminiAccountSummary,
	GeminiAccountSummaryPage,
	GeminiAccountUpdate,
	GeminiAccountUpdateResult,
} from "./admin-types";
import {
	boundedGeminiAccountPageLimit,
	GEMINI_DURABLE_ACCOUNT_ISSUES,
} from "./domain";
import { changedRows } from "./normalize";
import type { GeminiAccountRuntimeStore } from "./runtime-types";
import type {
	D1DatabaseLike,
	D1PreparedStatementLike,
	D1Result,
	GeminiAccountRow,
} from "./storage-types";
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

export { isD1UniqueConstraintError } from "./store-d1-codec";

const MAX_D1_BOUND_PARAMETERS = 100;
const MAX_TRANSACTIONAL_ACCOUNT_IMPORTS = 40;

type AccountImportWriteFacts = {
	mutatedCookieHashes: ReadonlySet<string>;
	createdIdentityHashes: ReadonlySet<string>;
	preexistingIds: ReadonlyMap<string, string>;
	batched: boolean;
};

export class D1GeminiAccountStore
	extends D1GeminiAccountRuntimeStore
	implements GeminiAccountAdminStore, GeminiAccountRuntimeStore
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
		return this.findAccountSummaryByHash("cookie", cookieHash, nowMs);
	}

	async findAccountByIdentityHash(
		identityHash: string,
		nowMs: number,
	): Promise<GeminiAccountSummary | null> {
		return this.findAccountSummaryByHash("identity", identityHash, nowMs);
	}

	private async findAccountSummaryByHash(
		kind: "cookie" | "identity",
		hash: string,
		nowMs: number,
	): Promise<GeminiAccountSummary | null> {
		const column = kind === "cookie" ? "cookie_hash" : "identity_hash";
		const row = await this.db
			.prepare(`
					SELECT ${ADMIN_ACCOUNT_SELECT}
					FROM gemini_accounts
					WHERE ${column} = ?
					LIMIT 1
				`)
			.bind(hash)
			.first<GeminiAccountSummarySqlRow>();
		return row ? summaryFromSql(row, nowMs) : null;
	}

	async createAccount(
		input: GeminiAccountCreateInput,
	): Promise<GeminiAccountSummary> {
		const row = await buildAccountInsertRow(input);
		await this.writeAccountImports([row]);
		const canonical = (
			await this.findAccountsByIdentityHashes([row.identity_hash], input.nowMs)
		).get(row.identity_hash);
		if (!canonical)
			throw new Error("D1 account import did not return a canonical identity");
		return canonical;
	}

	async importAccountByIdentity(
		entry: GeminiAccountBulkCreateEntry,
	): Promise<GeminiAccountIdentityImportResult> {
		const row = await buildAccountInsertRow(entry.input, entry.cookieHash);
		const facts = await this.writeAccountImports([row]);
		const canonical = (
			await this.findAccountsByIdentityHashes(
				[row.identity_hash],
				entry.input.nowMs,
			)
		).get(row.identity_hash);
		if (!canonical)
			throw new Error("D1 account import did not return a canonical identity");
		if (!facts.mutatedCookieHashes.has(row.cookie_hash))
			return { item: canonical, outcome: "unchanged" };
		const created = importWasCreated(facts, row, canonical.id);
		if (created) return { item: canonical, outcome: "created" };
		return {
			item: canonical,
			outcome: "credentials_changed",
		};
	}

	private async writeAccountImports(
		rows: readonly GeminiAccountRow[],
	): Promise<AccountImportWriteFacts> {
		const mutatedCookieHashes = new Set<string>();
		const batch = this.db.batch?.bind(this.db);
		const batched = batch !== undefined;
		const createdIdentityHashes = new Set<string>();
		const preexistingIds = new Map<string, string>();
		for (
			let offset = 0;
			offset < rows.length;
			offset += MAX_TRANSACTIONAL_ACCOUNT_IMPORTS
		) {
			const chunk = rows.slice(
				offset,
				offset + MAX_TRANSACTIONAL_ACCOUNT_IMPORTS,
			);
			const statements: D1PreparedStatementLike[] = [];
			const nowMs = chunk[0]?.updated_at_ms ?? Date.now();
			const fallbackPreexistingIds = batched
				? null
				: await this.findImportPreexistingIds(chunk);
			if (batched) {
				// The leading write owns the D1 batch transaction before it reads
				// pre-upsert pairs, so concurrent imports cannot share a stale view.
				statements.push(this.poolVersionIncrementBeforeImports(nowMs, chunk));
			}
			const resultIndexes: { row: GeminiAccountRow; statement: number }[] = [];
			for (const row of chunk) {
				const statement = statements.length;
				statements.push(
					this.db
						.prepare(ACCOUNT_UPSERT_IDENTITY_SQL)
						.bind(...accountRowValues(row)),
				);
				resultIndexes.push({ row, statement });
			}
			const results = batch
				? await batch(statements)
				: await this.runStatements(statements);
			if (results.length !== statements.length)
				throw new Error("D1 account import batch returned incomplete results");
			const preexistingIdsForChunk = batched
				? readImportPreexistingIds(results[0], chunk)
				: fallbackPreexistingIds;
			for (const [identityHash, id] of preexistingIdsForChunk || [])
				if (id !== null) preexistingIds.set(identityHash, id);
			let chunkChanged = false;
			for (const indexes of resultIndexes) {
				const result = results[indexes.statement];
				if (!result) throw new Error("D1 account import result was missing");
				if (importResultChanged(result) > 0) {
					chunkChanged = true;
					mutatedCookieHashes.add(indexes.row.cookie_hash);
					if (
						batched &&
						preexistingIdsForChunk?.get(indexes.row.identity_hash) === null
					)
						createdIdentityHashes.add(indexes.row.identity_hash);
				}
			}
			if (batched && chunkChanged && preexistingIdsForChunk?.size === 0)
				throw new Error("D1 account import prestate did not report a mutation");
			if (!batched && chunkChanged) await this.bumpPoolVersion(nowMs);
		}
		return {
			mutatedCookieHashes,
			createdIdentityHashes,
			preexistingIds,
			batched,
		};
	}

	private async runStatements(
		statements: readonly D1PreparedStatementLike[],
	): Promise<D1Result[]> {
		const results: D1Result[] = [];
		for (const statement of statements) results.push(await statement.run());
		return results;
	}

	private async findImportPreexistingIds(
		rows: readonly GeminiAccountRow[],
	): Promise<Map<string, string | null>> {
		const identityHashes = [...new Set(rows.map((row) => row.identity_hash))];
		const ids = new Map<string, string | null>(
			identityHashes.map((identityHash) => [identityHash, null]),
		);
		for (
			let offset = 0;
			offset < identityHashes.length;
			offset += MAX_D1_BOUND_PARAMETERS
		) {
			const chunk = identityHashes.slice(
				offset,
				offset + MAX_D1_BOUND_PARAMETERS,
			);
			const placeholders = chunk.map(() => "?").join(", ");
			const result = await this.db
				.prepare(`
					SELECT identity_hash, id FROM gemini_accounts
					WHERE identity_hash IN (${placeholders})
				`)
				.bind(...chunk)
				.all<{ identity_hash: string; id: string }>();
			for (const row of result.results || [])
				ids.set(row.identity_hash, row.id);
		}
		return ids;
	}

	private poolVersionIncrementBeforeImports(
		nowMs: number,
		rows: readonly GeminiAccountRow[],
	): D1PreparedStatementLike {
		const uniquePairs = new Map<
			string,
			{ identityHash: string; cookieHash: string }
		>();
		for (const row of rows) {
			uniquePairs.set(`${row.identity_hash}\0${row.cookie_hash}`, {
				identityHash: row.identity_hash,
				cookieHash: row.cookie_hash,
			});
		}
		const pairs = [...uniquePairs.values()];
		const requestedPairs = JSON.stringify(
			pairs.map((pair) => [pair.identityHash, pair.cookieHash]),
		);
		return this.poolVersionIncrementStatement(
			nowMs,
			`WHERE EXISTS (
				SELECT 1 FROM requested AS requested_pair
				LEFT JOIN gemini_accounts AS account
					ON account.identity_hash = requested_pair.identity_hash
					AND account.cookie_hash = requested_pair.cookie_hash
				WHERE account.id IS NULL
			)`,
			[],
			{
				prefix: `WITH requested(identity_hash, cookie_hash) AS (
					SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]')
					FROM json_each(?)
				)`,
				prefixValues: [requestedPairs],
				returning: `RETURNING (
					SELECT json_group_object(requested_pair.identity_hash, account.id)
					FROM requested AS requested_pair
					LEFT JOIN gemini_accounts AS account
						ON account.identity_hash = requested_pair.identity_hash
				) AS preexisting_ids`,
			},
		);
	}

	async createAccountsBulk(
		entries: GeminiAccountBulkCreateEntry[],
	): Promise<GeminiAccountBulkCreateResult> {
		if (!entries.length)
			return {
				createdAccountIds: new Set(),
				changedCredentialCount: 0,
			};
		const rows = await Promise.all(
			entries.map((entry) =>
				buildAccountInsertRow(entry.input, entry.cookieHash),
			),
		);
		const facts = await this.writeAccountImports(rows);
		const canonicalIdByIdentity = await this.findAccountIdsByIdentityHashes(
			rows.map((row) => row.identity_hash),
		);
		const createdAccountIds = new Set<string>();
		let changedCredentialCount = 0;
		for (const row of rows) {
			const canonicalId = canonicalIdByIdentity.get(row.identity_hash);
			if (!canonicalId)
				throw new Error(
					"D1 account import did not return a canonical identity",
				);
			if (!facts.mutatedCookieHashes.has(row.cookie_hash)) continue;
			const created = importWasCreated(facts, row, canonicalId);
			if (created) {
				createdAccountIds.add(canonicalId);
			} else {
				changedCredentialCount += 1;
			}
		}
		return {
			createdAccountIds,
			changedCredentialCount,
		};
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
		const rows = await this.getAccountRowsByIds(accountIds);
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
		const rows = await this.getAccountRowsByIds(accountIds);
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

	private async findAccountsByIdentityHashes(
		identityHashes: readonly string[],
		nowMs: number,
	): Promise<Map<string, GeminiAccountSummary>> {
		const unique = [...new Set(identityHashes)];
		const items = new Map<string, GeminiAccountSummary>();
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
						SELECT identity_hash, ${ADMIN_ACCOUNT_SELECT}
						FROM gemini_accounts
						WHERE identity_hash IN (${placeholders})
					`)
				.bind(...chunk)
				.all<GeminiAccountSummarySqlRow & { identity_hash: string }>();
			for (const row of result.results || [])
				items.set(row.identity_hash, summaryFromSql(row, nowMs));
		}
		return items;
	}

	private async findAccountIdsByIdentityHashes(
		identityHashes: readonly string[],
	): Promise<Map<string, string>> {
		const unique = [...new Set(identityHashes)];
		const ids = new Map<string, string>();
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
						SELECT identity_hash, id
						FROM gemini_accounts
						WHERE identity_hash IN (${placeholders})
					`)
				.bind(...chunk)
				.all<{ identity_hash: string; id: string }>();
			for (const row of result.results || [])
				ids.set(row.identity_hash, row.id);
		}
		return ids;
	}
}

function importWasCreated(
	facts: AccountImportWriteFacts,
	row: GeminiAccountRow,
	canonicalId: string,
): boolean {
	if (facts.createdIdentityHashes.has(row.identity_hash)) return true;
	if (facts.batched) return false;
	const preexistingId = facts.preexistingIds.get(row.identity_hash);
	if (preexistingId === undefined) return canonicalId === row.id;
	return canonicalId === row.id && canonicalId !== preexistingId;
}

function readImportPreexistingIds(
	result: D1Result | undefined,
	rows: readonly GeminiAccountRow[],
): Map<string, string | null> {
	if (!result) throw new Error("D1 account import version result was missing");
	if (importResultChanged(result) === 0) return new Map();
	const returned = result.results?.[0];
	if (!isRecord(returned) || typeof returned.preexisting_ids !== "string")
		throw new Error("D1 account import prestate result was missing");
	let parsed: unknown;
	try {
		parsed = JSON.parse(returned.preexisting_ids);
	} catch {
		throw new Error("D1 account import prestate result was invalid");
	}
	if (!isRecord(parsed))
		throw new Error("D1 account import prestate result was invalid");
	const ids = new Map<string, string | null>();
	for (const row of rows) {
		if (!Object.hasOwn(parsed, row.identity_hash))
			throw new Error("D1 account import prestate identity was missing");
		const id = parsed[row.identity_hash];
		if (id !== null && typeof id !== "string")
			throw new Error("D1 account import prestate identity was invalid");
		ids.set(row.identity_hash, id);
	}
	return ids;
}

function importResultChanged(result: D1Result): number {
	const changed = changedRows(result.meta);
	if (changed === null)
		throw new Error("D1 account import result did not report changed rows");
	return changed;
}
