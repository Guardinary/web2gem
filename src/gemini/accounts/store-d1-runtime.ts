import type { GeminiPublicFamily } from "../../models";
import {
	boundedGeminiAccountPageLimit,
	GEMINI_DURABLE_ACCOUNT_ISSUES,
} from "./domain";
import { normalizeGeminiCookieHeader, sha256Hex } from "./normalize";
import type { GeminiAccountProbe } from "./probe-types";
import type {
	GeminiAccountCapabilityRow,
	GeminiModelRoutePriorityRow,
	GeminiRouteTuple,
} from "./route-types";
import { validateGeminiModelRoutePolicy } from "./routes";
import type {
	GeminiAccountOutcome,
	GeminiAccountSnapshotRow,
	GeminiRefreshedCookieWrite,
	GeminiRefreshedCookieWriteResult,
} from "./runtime-types";
import type {
	D1DatabaseLike,
	D1PreparedStatementLike,
	D1Result,
	GeminiAccountRow,
	GeminiAccountSecretRow,
} from "./storage-types";
import { isD1UniqueConstraintError, resultChanged } from "./store-d1-codec";

const POOL_VERSION_KEY = "pool_version";
const MAX_D1_BOUND_PARAMETERS = 100;
const ACCOUNT_CAPABILITY_SELECT = `
  account_id, model_id, display_name, description, available,
  capacity, capacity_field, model_number, discovery_order, checked_at_ms
`;
const ACCOUNT_SECRET_SELECT =
	"id, cookie_header, cookie_hash, identity_hash, last_refresh_success_at_ms";

export abstract class D1GeminiAccountRuntimeStore {
	constructor(protected readonly db: D1DatabaseLike) {}

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
				 cooldown_until_ms, last_used_at_ms,
				 last_refresh_success_at_ms
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

	async getAccountForRefresh(
		accountId: string,
	): Promise<GeminiAccountSecretRow | null> {
		return this.db
			.prepare(
				`SELECT ${ACCOUNT_SECRET_SELECT} FROM gemini_accounts WHERE id = ? LIMIT 1`,
			)
			.bind(accountId)
			.first<GeminiAccountSecretRow>();
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
					SET last_refresh_at_ms = ?, last_refresh_attempt_at_ms = ?,
						last_refresh_success_at_ms = ?, updated_at_ms = ?
					WHERE id = ?
				`)
					.bind(
						update.refreshedAtMs,
						update.nowMs,
						update.refreshedAtMs,
						update.nowMs,
						accountId,
					),
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
					SET cookie_header = ?, cookie_hash = ?,
						last_refresh_at_ms = ?, last_refresh_attempt_at_ms = ?,
						last_refresh_success_at_ms = ?, updated_at_ms = ?
          WHERE id = ?
        `)
					.bind(
						cookieHeader,
						cookieHash,
						update.refreshedAtMs,
						update.nowMs,
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

	async writeAccountProbe(
		accountId: string,
		probe: GeminiAccountProbe,
		checkedAtMs: number,
	): Promise<void> {
		const updateStatus = this.db
			.prepare(`
        UPDATE gemini_accounts
        SET account_status_code = ?, status_checked_at_ms = ?, updated_at_ms = ?
        WHERE id = ?
			`)
			.bind(probe.statusCode, checkedAtMs, checkedAtMs, accountId);
		if (!probe.models.length) {
			await updateStatus.run();
			return;
		}
		const deleteModels = this.db
			.prepare("DELETE FROM gemini_account_models WHERE account_id = ?")
			.bind(accountId);
		const insertModels = probe.models.map((model) =>
			this.db
				.prepare(`
          INSERT INTO gemini_account_models (
            account_id, model_id, display_name, description, available,
            capacity, capacity_field, model_number, discovery_order, checked_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
				.bind(
					accountId,
					model.modelId,
					model.displayName,
					model.description,
					model.available ? 1 : 0,
					model.capacity,
					model.capacityField,
					model.modelNumber,
					model.discoveryOrder,
					checkedAtMs,
				),
		);
		if (this.db.batch) {
			await this.db.batch([
				updateStatus,
				deleteModels,
				...insertModels,
				this.poolVersionIncrementStatement(checkedAtMs),
			]);
			return;
		}
		await updateStatus.run();
		await deleteModels.run();
		for (const statement of insertModels) await statement.run();
		await this.bumpPoolVersion(checkedAtMs);
	}

	async listAccountCapabilities(
		accountIds: readonly string[],
	): Promise<GeminiAccountCapabilityRow[]> {
		if (!accountIds.length) return [];
		const uniqueIds = [...new Set(accountIds)].slice(
			0,
			MAX_D1_BOUND_PARAMETERS,
		);
		const placeholders = uniqueIds.map(() => "?").join(", ");
		const result = await this.db
			.prepare(`
						SELECT ${ACCOUNT_CAPABILITY_SELECT}
						FROM gemini_account_models
        WHERE account_id IN (${placeholders})
				ORDER BY account_id ASC, discovery_order ASC
      `)
			.bind(...uniqueIds)
			.all<GeminiAccountCapabilityRow>();
		return result.results || [];
	}

	async listAllAccountCapabilities(
		limit: number,
	): Promise<GeminiAccountCapabilityRow[]> {
		const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 12800);
		const result = await this.db
			.prepare(`
						SELECT ${ACCOUNT_CAPABILITY_SELECT}
						FROM gemini_account_models
        ORDER BY checked_at_ms DESC, account_id ASC, discovery_order ASC
				LIMIT ?
      `)
			.bind(boundedLimit)
			.all<GeminiAccountCapabilityRow>();
		return result.results || [];
	}

	async listModelRoutePriorities(): Promise<GeminiModelRoutePriorityRow[]> {
		const result = await this.db
			.prepare(`
        SELECT family, provider_model_id, capacity, capacity_field,
               model_number, priority, updated_at_ms
        FROM gemini_model_route_priority
        ORDER BY family ASC, priority ASC
      `)
			.all<GeminiModelRoutePriorityRow>();
		return result.results || [];
	}

	async replaceModelRoutePriority(
		family: GeminiPublicFamily,
		routes: readonly GeminiRouteTuple[],
		nowMs: number,
	): Promise<void> {
		assertModelRoutePriority(family, routes);
		const statements = [
			this.db
				.prepare("DELETE FROM gemini_model_route_priority WHERE family = ?")
				.bind(family),
			...routes.map((route, priority) =>
				this.db
					.prepare(`
            INSERT INTO gemini_model_route_priority (
              family, provider_model_id, capacity, capacity_field,
              model_number, priority, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `)
					.bind(
						family,
						route.providerModelId,
						route.capacity,
						route.capacityField,
						route.modelNumber,
						priority,
						nowMs,
					),
			),
		];
		if (this.db.batch) {
			await this.db.batch([
				...statements,
				this.poolVersionIncrementStatement(nowMs),
			]);
			return;
		}
		for (const statement of statements) await statement.run();
		await this.bumpPoolVersion(nowMs);
	}

	async clearModelRoutePriority(
		family: GeminiPublicFamily,
		nowMs: number,
	): Promise<void> {
		await this.replaceModelRoutePriority(family, [], nowMs);
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

	protected async getAccountRow(
		accountId: string,
	): Promise<GeminiAccountRow | null> {
		return (await this.getAccountRowsByIds([accountId]))[0] || null;
	}

	protected async getAccountRowsByIds(
		accountIds: readonly string[],
	): Promise<GeminiAccountRow[]> {
		if (!accountIds.length) return [];
		if (accountIds.length === 1) {
			const row = await this.db
				.prepare("SELECT * FROM gemini_accounts WHERE id = ? LIMIT 1")
				.bind(accountIds[0])
				.first<GeminiAccountRow>();
			return row ? [row] : [];
		}
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

	protected async runMutationWithPoolVersion(
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

	protected async bumpPoolVersion(nowMs: number): Promise<void> {
		await this.poolVersionIncrementStatement(nowMs).run();
	}

	protected poolVersionIncrementStatement(
		nowMs: number,
		condition = "",
		conditionValues: readonly unknown[] = [],
		options: {
			prefix?: string;
			prefixValues?: readonly unknown[];
			returning?: string;
		} = {},
	): D1PreparedStatementLike {
		return this.db
			.prepare(`
			${options.prefix || ""}
      INSERT INTO gemini_pool_meta (key, value, updated_at_ms)
      SELECT ?, '1', ?
      ${condition}
      ON CONFLICT(key) DO UPDATE SET
        value = CAST(CAST(gemini_pool_meta.value AS INTEGER) + 1 AS TEXT),
        updated_at_ms = MAX(gemini_pool_meta.updated_at_ms, excluded.updated_at_ms)
      ${options.returning || ""}
    `)
			.bind(
				...(options.prefixValues || []),
				POOL_VERSION_KEY,
				nowMs,
				...conditionValues,
			);
	}

	private async findAccountIdByCookieHash(
		cookieHash: string,
	): Promise<string | null> {
		return this.db
			.prepare("SELECT id FROM gemini_accounts WHERE cookie_hash = ? LIMIT 1")
			.bind(cookieHash)
			.first<string>("id");
	}
}

function assertModelRoutePriority(
	family: unknown,
	routes: readonly GeminiRouteTuple[],
): void {
	const policy = validateGeminiModelRoutePolicy(family, routes);
	if (!policy.error) return;
	if (policy.error === "invalid_family")
		throw new Error("invalid Gemini model family");
	if (policy.error === "route_limit_exceeded")
		throw new Error("too many Gemini model routes");
	if (policy.error === "duplicate_route")
		throw new Error("duplicate Gemini route tuple");
	throw new Error("invalid Gemini route tuple");
}
