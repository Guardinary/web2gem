import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import { GeminiAccountAdminService } from "../../src/gemini/accounts/admin";
import {
	listFilterFromSearchParams as geminiAccountListFilterFromSearchParams,
	updateFromBody as geminiAccountUpdateFromAdminBody,
	normalizeCreateAccounts,
	normalizeBulkAction as normalizeGeminiAccountBulkAction,
	normalizeListFilter as normalizeGeminiAccountListFilter,
} from "../../src/gemini/accounts/admin-input";
import { classifyGeminiAccountOutcome } from "../../src/gemini/accounts/classify";
import {
	geminiAccountState,
	visibleGeminiAccountIssue,
} from "../../src/gemini/accounts/domain";
import {
	identityHashFromCookie,
	sha256Hex,
} from "../../src/gemini/accounts/normalize";
import { decodeGeminiAccountProbe } from "../../src/gemini/accounts/probe";
import { D1GeminiAccountStore } from "../../src/gemini/accounts/store-d1";
import { buildGeminiModelHeaders } from "../../src/gemini/client/model-headers";
import { handleGeminiAccountAdminRequest } from "../../src/http/admin/gemini-accounts";
import worker from "../../src/index";
import { assert } from "./assertions.js";
import { baseConfig } from "./helpers.js";

function accountProbeWrb(
	statusCode,
	models = [],
	tierFlags = [],
	capabilityFlags = [],
) {
	const payload = [];
	payload[14] = statusCode;
	payload[15] = models;
	payload[16] = tierFlags;
	payload[17] = capabilityFlags;
	return JSON.stringify([["wrb.fr", "otAQ7b", JSON.stringify(payload)]]);
}
function accountRow(id, overrides = {}) {
	return {
		id,
		label: null,
		enabled: 1,
		cookie_header: `__Secure-1PSID=secret-p-${id}; __Secure-1PSIDTS=secret-t-${id}`,
		cookie_hash: `hash-${id}`,
		identity_hash: `identity-${id}`,
		issue: null,
		cooldown_until_ms: null,
		last_issue_at_ms: null,
		last_used_at_ms: null,
		last_refresh_at_ms: null,
		account_status_code: null,
		status_checked_at_ms: null,
		last_refresh_attempt_at_ms: null,
		last_refresh_success_at_ms: null,
		created_at_ms: 1000,
		updated_at_ms: 1000,
		...overrides,
	};
}
function publicSqlRow(row) {
	const { cookie_header: _cookie, cookie_hash: _hash, ...publicRow } = row;
	return publicRow;
}
class QueryD1 {
	constructor(data) {
		this.data = data;
		this.statements = [];
	}
	prepare(sql) {
		const statement = new QueryStatement(this, sql);
		this.statements.push(statement);
		return statement;
	}
	async batch(statements) {
		return statements.map((statement) => {
			if (/COUNT\(\*\) AS total/.test(statement.sql))
				return { results: [this.data.stats] };
			return { results: this.data.page };
		});
	}
	get lastStatement() {
		return this.statements.at(-1);
	}
}
class QueryStatement {
	constructor(db, sql) {
		this.db = db;
		this.sql = sql;
		this.binds = [];
	}
	bind(...values) {
		this.binds = values;
		return this;
	}
	async all() {
		return { results: this.db.data.selectable };
	}
	async first() {
		return null;
	}
	async run() {
		return { meta: { changes: 0 } };
	}
}
class MemoryAccountStore {
	constructor() {
		this.rows = new Map();
		this.hashes = new Map();
		this.version = 0;
	}
	async getPoolVersion() {
		return String(this.version);
	}
	async listSelectableAccounts() {
		return [...this.rows.values()].map((row) => ({
			id: row.id,
			enabled: row.enabled,
			cookie_header: row.cookie_header,
			cookie_hash: row.cookie_hash,
			issue: row.issue,
			cooldown_until_ms: row.cooldown_until_ms,
			last_used_at_ms: row.last_used_at_ms,
		}));
	}
	async getAdminOverview(filter) {
		const items = [...this.rows.values()].map((row) => summary(row));
		return {
			items,
			nextCursor: null,
			limit: filter.limit,
			stats: {
				total: items.length,
				available: items.filter((item) => item.state === "available").length,
				cooling: 0,
				attention: 0,
				disabled: 0,
			},
		};
	}
	async findAccountByCookieHash(hash) {
		const id = this.hashes.get(hash);
		return id ? summary(this.rows.get(id)) : null;
	}
	async createAccountsBulk(entries) {
		const itemsByCookieHash = new Map();
		const addedCookieHashes = new Set();
		for (const entry of entries) {
			let id = this.hashes.get(entry.cookieHash);
			if (!id) {
				id = `account-${this.rows.size + 1}`;
				const row = accountRow(id, {
					label: entry.input.label || null,
					cookie_header: entry.input.cookieHeader,
					cookie_hash: entry.cookieHash,
				});
				this.rows.set(id, row);
				this.hashes.set(entry.cookieHash, id);
				addedCookieHashes.add(entry.cookieHash);
				this.version++;
			}
			itemsByCookieHash.set(entry.cookieHash, summary(this.rows.get(id)));
		}
		return { itemsByCookieHash, addedCookieHashes };
	}
	async createAccount(input) {
		const row = accountRow(input.id || `account-${this.rows.size + 1}`, {
			label: input.label || null,
			cookie_header: input.cookieHeader,
		});
		this.rows.set(row.id, row);
		return summary(row);
	}
	async updateAccount(id, update) {
		const row = this.rows.get(id);
		if (!row) return { item: null, changed: false };
		const label = update.label === undefined ? row.label : update.label;
		let enabled = row.enabled;
		if (update.enabled !== undefined) enabled = update.enabled ? 1 : 0;
		const changed = label !== row.label || enabled !== row.enabled;
		Object.assign(row, { label, enabled, updated_at_ms: update.nowMs });
		return { item: summary(row), changed };
	}
	async deleteAccount(id) {
		return this.rows.delete(id);
	}
	async getAccountForRefresh(id) {
		return this.rows.get(id) || null;
	}
	async tryAcquireRefreshLock() {
		return true;
	}
	async releaseRefreshLock() {}
	async writeRefreshedCookie(id, update) {
		const row = this.rows.get(id);
		row.cookie_header = update.cookieHeader;
		row.last_refresh_at_ms = update.refreshedAtMs;
		row.issue = null;
		row.cooldown_until_ms = null;
		return { changed: true };
	}
	async writeAccountOutcome() {}
}
class MutableD1 {
	constructor() {
		this.rows = new Map();
		this.meta = new Map([["pool_version", "0"]]);
		this.locks = new Map();
		this.models = new Map();
		this.priorities = new Map();
		this.lastChanges = 0;
	}
	prepare(sql) {
		return new MutableStatement(this, sql);
	}
	async batch(statements) {
		const results = [];
		for (const statement of statements) results.push(await statement.run());
		return results;
	}
}
class MutableStatement {
	constructor(db, sql) {
		this.db = db;
		this.sql = sql.replace(/\s+/g, " ").trim();
		this.values = [];
	}
	bind(...values) {
		this.values = values;
		return this;
	}
	async first(columnName) {
		let value = null;
		if (this.sql.startsWith("SELECT value FROM gemini_pool_meta")) {
			value = { value: this.db.meta.get(this.values[0]) || null };
		} else if (this.sql.includes("WHERE id = ? LIMIT 1")) {
			value = this.db.rows.get(this.values[0]) || null;
		} else if (this.sql.includes("WHERE cookie_hash = ?")) {
			value =
				[...this.db.rows.values()].find(
					(row) => row.cookie_hash === this.values[0],
				) || null;
		} else if (this.sql.includes("WHERE identity_hash = ?")) {
			value =
				[...this.db.rows.values()].find(
					(row) => row.identity_hash === this.values[0],
				) || null;
		}
		return columnName && value ? value[columnName] : value;
	}
	async all() {
		let results = [];
		if (this.sql.includes("WHERE cookie_hash IN")) {
			results = [...this.db.rows.values()].filter((row) =>
				this.values.includes(row.cookie_hash),
			);
		} else if (this.sql.includes("WHERE identity_hash IN")) {
			results = [...this.db.rows.values()].filter((row) =>
				this.values.includes(row.identity_hash),
			);
		} else if (this.sql.includes("FROM gemini_account_models")) {
			results = [...this.db.models.values()]
				.filter(
					(row) =>
						!this.sql.includes("WHERE account_id IN") ||
						this.values.includes(row.account_id),
				)
				.sort(
					(a, b) =>
						b.checked_at_ms - a.checked_at_ms ||
						a.account_id.localeCompare(b.account_id) ||
						a.discovery_order - b.discovery_order,
				);
		} else if (this.sql.includes("FROM gemini_model_route_priority")) {
			results = [...this.db.priorities.values()].sort(
				(a, b) => a.family.localeCompare(b.family) || a.priority - b.priority,
			);
		} else if (this.sql.includes("SELECT * FROM gemini_accounts WHERE id IN")) {
			results = this.values.flatMap((id) => {
				const row = this.db.rows.get(id);
				return row ? [row] : [];
			});
		} else if (this.sql.includes("SELECT id, enabled, cookie_header")) {
			results = [...this.db.rows.values()].filter(
				(row) =>
					row.enabled === 1 &&
					!["auth", "user_action", "location"].includes(row.issue),
			);
		}
		return { results };
	}
	async run() {
		let changes = 0;
		if (this.sql.startsWith("INSERT INTO gemini_accounts")) {
			const row = Object.fromEntries(
				[
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
				].map((key, index) => [key, this.values[index]]),
			);
			const identityMatch = [...this.db.rows.values()].find(
				(existing) => existing.identity_hash === row.identity_hash,
			);
			const cookieMatch = [...this.db.rows.values()].find(
				(existing) => existing.cookie_hash === row.cookie_hash,
			);
			if (identityMatch && this.sql.includes("ON CONFLICT(identity_hash)")) {
				Object.assign(identityMatch, {
					label: row.label,
					cookie_header: row.cookie_header,
					cookie_hash: row.cookie_hash,
					updated_at_ms: row.updated_at_ms,
				});
				changes = 1;
			} else if (!cookieMatch) {
				this.db.rows.set(row.id, row);
				changes = 1;
			} else {
				throw new Error(
					"UNIQUE constraint failed: gemini_accounts.cookie_hash",
				);
			}
		} else if (this.sql.startsWith("INSERT INTO gemini_pool_meta")) {
			const key = this.values[0];
			let allowed = true;
			if (this.sql.includes("changes() > 0")) allowed = this.db.lastChanges > 0;
			if (this.sql.includes("WHERE EXISTS"))
				allowed = this.values.slice(2).some((id) => this.db.rows.has(id));
			if (allowed) {
				this.db.meta.set(key, String(Number(this.db.meta.get(key) || 0) + 1));
				changes = 1;
			}
		} else if (this.sql.startsWith("INSERT INTO gemini_account_locks")) {
			const [id, owner, expiresAt, createdAt, now] = this.values;
			const current = this.db.locks.get(id);
			if (!current || current.expiresAt <= now) {
				this.db.locks.set(id, { owner, expiresAt, createdAt });
				changes = 1;
			}
		} else if (this.sql.startsWith("DELETE FROM gemini_account_locks")) {
			const current = this.db.locks.get(this.values[0]);
			if (current?.owner === this.values[1]) {
				this.db.locks.delete(this.values[0]);
				changes = 1;
			}
		} else if (this.sql.startsWith("DELETE FROM gemini_account_models")) {
			for (const [key, row] of this.db.models)
				if (row.account_id === this.values[0]) this.db.models.delete(key);
			changes = 1;
		} else if (this.sql.startsWith("INSERT INTO gemini_account_models")) {
			const [
				account_id,
				model_id,
				display_name,
				description,
				available,
				capacity,
				capacity_field,
				model_number,
				discovery_order,
				checked_at_ms,
			] = this.values;
			this.db.models.set(`${account_id}\0${model_id}`, {
				account_id,
				model_id,
				display_name,
				description,
				available,
				capacity,
				capacity_field,
				model_number,
				discovery_order,
				checked_at_ms,
			});
			changes = 1;
		} else if (this.sql.startsWith("DELETE FROM gemini_model_route_priority")) {
			for (const [key, row] of this.db.priorities)
				if (row.family === this.values[0]) this.db.priorities.delete(key);
			changes = 1;
		} else if (this.sql.startsWith("INSERT INTO gemini_model_route_priority")) {
			const [
				family,
				provider_model_id,
				capacity,
				capacity_field,
				model_number,
				priority,
				updated_at_ms,
			] = this.values;
			this.db.priorities.set(`${family}\0${priority}`, {
				family,
				provider_model_id,
				capacity,
				capacity_field,
				model_number,
				priority,
				updated_at_ms,
			});
			changes = 1;
		} else if (this.sql.startsWith("DELETE FROM gemini_accounts")) {
			const ids = this.sql.includes(" IN ") ? this.values : [this.values[0]];
			for (const id of ids) if (this.db.rows.delete(id)) changes++;
		} else if (this.sql.startsWith("UPDATE gemini_accounts")) {
			changes = this.updateRows();
		}
		this.db.lastChanges = changes;
		return { meta: { changes } };
	}
	updateRows() {
		if (this.sql.includes("SET label = ?, enabled = ?")) {
			const [label, enabled, updated, id] = this.values;
			const row = this.db.rows.get(id);
			if (!row) return 0;
			Object.assign(row, { label, enabled, updated_at_ms: updated });
			return 1;
		}
		if (this.sql.includes("SET enabled = ?, updated_at_ms = ?")) {
			const [enabled, updated, ...ids] = this.values;
			let changes = 0;
			for (const id of ids) {
				const row = this.db.rows.get(id);
				if (!row) continue;
				Object.assign(row, { enabled, updated_at_ms: updated });
				changes++;
			}
			return changes;
		}
		if (this.sql.includes("SET cookie_header = ?, cookie_hash = ?")) {
			const [cookie, hash, refreshed, attempted, succeeded, updated, id] =
				this.values;
			const row = this.db.rows.get(id);
			if (!row) return 0;
			Object.assign(row, {
				cookie_header: cookie,
				cookie_hash: hash,
				last_refresh_at_ms: refreshed,
				last_refresh_attempt_at_ms: attempted,
				last_refresh_success_at_ms: succeeded,
				updated_at_ms: updated,
			});
			return 1;
		}
		if (this.sql.includes("last_refresh_at_ms = ?")) {
			const [refreshed, attempted, succeeded, updated, id] = this.values;
			const row = this.db.rows.get(id);
			if (!row) return 0;
			Object.assign(row, {
				last_refresh_at_ms: refreshed,
				last_refresh_attempt_at_ms: attempted,
				last_refresh_success_at_ms: succeeded,
				updated_at_ms: updated,
			});
			return 1;
		}
		if (this.sql.includes("SET account_status_code = ?")) {
			const [status, checked, updated, id] = this.values;
			const row = this.db.rows.get(id);
			if (!row) return 0;
			Object.assign(row, {
				account_status_code: status,
				status_checked_at_ms: checked,
				updated_at_ms: updated,
			});
			return 1;
		}
		if (this.sql.includes("SET issue = ?, cooldown_until_ms = ?")) {
			const [issue, cooldown, issueAt, used, updated, id] = this.values;
			const row = this.db.rows.get(id);
			if (!row) return 0;
			Object.assign(row, {
				issue,
				cooldown_until_ms: cooldown,
				last_issue_at_ms: issueAt,
				last_used_at_ms: used,
				updated_at_ms: updated,
			});
			return 1;
		}
		if (
			this.sql.includes("SET issue = NULL") &&
			this.sql.includes("AND (issue IS NOT NULL")
		) {
			const [updated, id] = this.values;
			const row = this.db.rows.get(id);
			if (
				!row ||
				(!row.issue && !row.cooldown_until_ms && !row.last_issue_at_ms)
			)
				return 0;
			Object.assign(row, {
				issue: null,
				cooldown_until_ms: null,
				last_issue_at_ms: null,
				updated_at_ms: updated,
			});
			return 1;
		}
		if (this.sql.includes("SET last_used_at_ms = ?")) {
			const [used, updated, id] = this.values;
			const row = this.db.rows.get(id);
			if (!row) return 0;
			Object.assign(row, { last_used_at_ms: used, updated_at_ms: updated });
			return 1;
		}
		return 0;
	}
}
function summary(row) {
	return {
		id: row.id,
		label: row.label,
		enabled: row.enabled === 1,
		state: row.enabled === 1 ? "available" : "disabled",
		issue: row.issue,
		cooldown_until_ms: row.cooldown_until_ms,
		last_issue_at_ms: row.last_issue_at_ms,
		last_used_at_ms: row.last_used_at_ms,
		last_refresh_at_ms: row.last_refresh_at_ms,
		status_checked_at_ms: row.status_checked_at_ms,
		last_refresh_success_at_ms: row.last_refresh_success_at_ms,
		created_at_ms: row.created_at_ms,
		updated_at_ms: row.updated_at_ms,
	};
}

describe("gemini accounts", () => {
	test("derives four account states and hides expired temporary issues", () => {
		assert.equal(
			geminiAccountState(
				{ enabled: false, issue: "auth", cooldown_until_ms: 9000 },
				1000,
			),
			"disabled",
		);
		assert.equal(
			geminiAccountState(
				{ enabled: true, issue: "rate_limit", cooldown_until_ms: 9000 },
				1000,
			),
			"cooling",
		);
		assert.equal(
			geminiAccountState(
				{ enabled: true, issue: "auth", cooldown_until_ms: null },
				1000,
			),
			"attention",
		);
		assert.equal(
			geminiAccountState(
				{ enabled: true, issue: "transient", cooldown_until_ms: 900 },
				1000,
			),
			"available",
		);
		assert.equal(
			visibleGeminiAccountIssue(
				{ issue: "transient", cooldown_until_ms: 900 },
				1000,
			),
			null,
		);
		assert.equal(
			visibleGeminiAccountIssue(
				{ issue: "auth", cooldown_until_ms: null },
				1000,
			),
			"auth",
		);
	});
	test("classifies health-affecting outcomes without poisoning accounts for model errors", () => {
		assert.deepEqual(classifyGeminiAccountOutcome({ status: 401 }, 1000), {
			kind: "failure",
			issue: "auth",
			recoveryScope: "try_next_account",
			nowMs: 1000,
		});
		assert.deepEqual(classifyGeminiAccountOutcome({ status: 429 }, 1000), {
			kind: "failure",
			issue: "rate_limit",
			cooldownUntilMs: 301000,
			recoveryScope: "try_next_account",
			nowMs: 1000,
		});
		assert.deepEqual(
			classifyGeminiAccountOutcome(new Error("invalid model"), 1000),
			{ kind: "failure", recoveryScope: "none", nowMs: 1000 },
		);
		assert.deepEqual(
			classifyGeminiAccountOutcome(new Error("network reset"), 1000),
			{
				kind: "failure",
				issue: "transient",
				cooldownUntilMs: 61000,
				recoveryScope: "try_next_account",
				nowMs: 1000,
			},
		);
		assert.deepEqual(
			classifyGeminiAccountOutcome(
				{
					code: "gemini_semantic_error",
					geminiSource: "stream_generate",
					geminiCode: "1050",
				},
				1000,
			),
			{
				kind: "failure",
				recoveryScope: "try_next_account",
				nowMs: 1000,
			},
		);
		assert.deepEqual(
			classifyGeminiAccountOutcome(
				{
					code: "gemini_semantic_error",
					geminiSource: "stream_generate",
					geminiCode: "1060",
				},
				1000,
			),
			{ kind: "failure", recoveryScope: "none", nowMs: 1000 },
		);
		assert.deepEqual(
			classifyGeminiAccountOutcome(
				{ geminiSource: "account_status", geminiCode: "1060" },
				1000,
			),
			{
				kind: "failure",
				issue: "location",
				recoveryScope: "none",
				nowMs: 1000,
			},
		);
	});
	test("decodes bounded GetUserStatus account and model capability data", () => {
		assert.deepEqual(
			decodeGeminiAccountProbe(
				accountProbeWrb(
					1000,
					[["model-pro", "Pro", "description"]],
					[[21]],
					[],
				),
			),
			{
				statusCode: 1000,
				issue: null,
				selectable: true,
				models: [
					{
						modelId: "model-pro",
						displayName: "Pro",
						description: "description",
						available: true,
						capacity: 1,
						capacityField: 13,
						modelNumber: 1,
						discoveryOrder: 0,
					},
				],
			},
		);
		assert.throws(
			() => decodeGeminiAccountProbe(accountProbeWrb(9999)),
			/unknown Gemini account status/,
		);
		assert.deepEqual(decodeGeminiAccountProbe(accountProbeWrb(1016)), {
			statusCode: 1016,
			issue: "auth",
			selectable: false,
			models: [],
		});
		for (const [tierFlags, capabilityFlags, expected] of [
			[[22], [], [2, 13]],
			[[], [115], [4, 12]],
			[[16], [], [3, 12]],
			[[], [106], [3, 12]],
			[[8], [], [2, 12]],
			[[], [19], [2, 12]],
			[[], [], [1, 12]],
		]) {
			const decoded = decodeGeminiAccountProbe(
				accountProbeWrb(
					1000,
					[["model", "Model", ""]],
					tierFlags,
					capabilityFlags,
				),
			);
			assert.deepEqual(
				[decoded.models[0].capacity, decoded.models[0].capacityField],
				expected,
			);
		}
		const unauthenticated = decodeGeminiAccountProbe(
			accountProbeWrb(1016, [
				["fbb127bbb056c959", "Flash", "Guest Flash"],
				["9d8ca3786ebdfbea", "Pro", "Authenticated Pro"],
			]),
		);
		assert.equal(unauthenticated.models[0].available, true);
		assert.equal(unauthenticated.models[0].modelNumber, 1);
		assert.equal(unauthenticated.models[1].available, false);
		assert.equal(unauthenticated.models[1].modelNumber, 3);
		assert.deepEqual(
			decodeGeminiAccountProbe(
				accountProbeWrb(1000, [
					["valid-id", "x".repeat(257), "description"],
					["missing-display", "", "description"],
				]),
			).models,
			[],
		);
	});
	test("builds exact model headers for capacity fields 12 and 13", () => {
		const field12 = buildGeminiModelHeaders(
			{
				providerModelId: "e6fa609c3fa255c0",
				capacity: 4,
				capacityField: 12,
				modelNumber: 3,
			},
			false,
			"session-id",
		);
		assert.deepEqual(JSON.parse(field12["x-goog-ext-525001261-jspb"]), [
			1,
			null,
			null,
			null,
			"e6fa609c3fa255c0",
			null,
			null,
			0,
			[4, 5, 6, 8],
			null,
			null,
			4,
			null,
			null,
			3,
			1,
			"SESSION-ID",
		]);
		const field13 = buildGeminiModelHeaders(
			{
				providerModelId: "e6fa609c3fa255c0",
				capacity: 2,
				capacityField: 13,
				modelNumber: 3,
			},
			true,
			"session-id",
		);
		assert.deepEqual(JSON.parse(field13["x-goog-ext-525001261-jspb"]), [
			1,
			null,
			null,
			null,
			"e6fa609c3fa255c0",
			null,
			null,
			0,
			[4, 5, 6, 8],
			null,
			null,
			null,
			2,
			null,
			null,
			3,
			2,
			"SESSION-ID",
		]);
		assert.equal(field13["x-goog-ext-73010990-jspb"], "[0,0,0]");
	});
	test("accepts only the slim admin input and rejects legacy fields and actions", () => {
		assert.deepEqual(
			geminiAccountListFilterFromSearchParams(
				new URLSearchParams("limit=200&q=alpha&state=attention"),
			),
			{ limit: 200, q: "alpha", state: "attention" },
		);
		assert.deepEqual(
			normalizeGeminiAccountListFilter({ limit: 999, state: "cooling" }),
			{ limit: 200, state: "cooling" },
		);
		assert.deepEqual(
			geminiAccountUpdateFromAdminBody({ label: null, enabled: false }, 1000),
			{ label: null, enabled: false, nowMs: 1000 },
		);
		assert.throws(
			() =>
				geminiAccountListFilterFromSearchParams(
					new URLSearchParams("status=active"),
				),
			/unknown admin query parameter/,
		);
		assert.throws(
			() => geminiAccountUpdateFromAdminBody({ status: "active" }, 1000),
			/unsupported account update field/,
		);
		assert.throws(
			() =>
				normalizeCreateAccounts({
					provider: "gemini",
					"__Secure-1PSID": "p",
					"__Secure-1PSIDTS": "t",
					source: "legacy",
				}),
			/only __Secure-1PSID, __Secure-1PSIDTS, and label/,
		);
		assert.throws(
			() => normalizeGeminiAccountBulkAction({ action: "check", ids: ["a"] }),
			/action must be enable, disable, delete, or refresh/,
		);
	});
	test("projects a slim overview and keeps cookie material behind the D1 boundary", async () => {
		const row = accountRow("a", {
			label: "Alpha",
			issue: "rate_limit",
			cooldown_until_ms: 5000,
		});
		const db = new QueryD1({
			selectable: [
				{
					id: row.id,
					enabled: row.enabled,
					cookie_header: row.cookie_header,
					cookie_hash: row.cookie_hash,
					issue: row.issue,
					cooldown_until_ms: row.cooldown_until_ms,
					last_used_at_ms: row.last_used_at_ms,
				},
			],
			page: [publicSqlRow(row)],
			stats: {
				total: 1,
				available: 0,
				cooling: 1,
				attention: 0,
				disabled: 0,
			},
		});
		const store = new D1GeminiAccountStore(db);
		const selectable = await store.listSelectableAccounts(1000, 999);
		assert.equal(selectable.length, 1);
		assert.equal(db.lastStatement.binds.at(-1), 200);
		assert.match(db.lastStatement.sql, /issue NOT IN/);

		const overview = await store.getAdminOverview(
			{ limit: 10, state: "cooling" },
			1000,
		);
		assert.deepEqual(overview.stats, db.data.stats);
		assert.equal(overview.items[0].state, "cooling");
		assert.equal(overview.items[0].issue, "rate_limit");
		assert.equal(Object.hasOwn(overview.items[0], "cookie_header"), false);
		assert.doesNotMatch(
			JSON.stringify(overview),
			/secret-p|secret-t|cookie_hash/,
		);
		assert.equal(Object.keys(overview.items[0]).length, 13);
	});
	test("returns one compact mutation shape for import, update, delete, and refresh", async () => {
		const store = new MemoryAccountStore();
		let nowMs = 1000;
		let verifyCalls = 0;
		const service = new GeminiAccountAdminService({
			store,
			cfg: baseConfig(),
			nowMs: () => nowMs,
			rotateCookie: async () =>
				new Response(null, {
					status: 200,
					headers: { "set-cookie": "__Secure-1PSIDTS=rotated" },
				}),
			verifyAccount: async () => {
				verifyCalls += 1;
				return {
					ok: true,
					at: "fresh-at",
					probe: {
						statusCode: 1000,
						issue: null,
						selectable: true,
						models: [],
					},
				};
			},
		});

		const imported = await service.create({
			provider: "gemini",
			accounts: [
				{
					"__Secure-1PSID": "p",
					"__Secure-1PSIDTS": "t",
					label: "Alpha",
				},
				{ "__Secure-1PSID": "p", "__Secure-1PSIDTS": "t" },
			],
		});
		assert.deepEqual(imported, {
			processed: 2,
			changed: 1,
			unchanged: 1,
			failed: 0,
		});
		assert.equal(Object.hasOwn(imported, "items"), false);
		assert.equal(verifyCalls, 1);
		const id = [...store.rows.keys()][0];
		assert.deepEqual(await service.update(id, { label: "Renamed" }), {
			processed: 1,
			changed: 1,
			unchanged: 0,
			failed: 0,
		});
		assert.deepEqual(await service.update(id, { label: "Renamed" }), {
			processed: 1,
			changed: 0,
			unchanged: 1,
			failed: 0,
		});
		nowMs = 121000;
		assert.deepEqual(await service.refresh(id), {
			processed: 1,
			changed: 1,
			unchanged: 0,
			failed: 0,
		});
		const missing = await service.delete("missing");
		assert.equal(missing.failed, 1);
		assert.equal(missing.errors[0].code, "account_not_found");
		assert.equal(typeof service.check, "undefined");
	});
	test("probes new imports with Worker waitUntil and skips unchanged identities", async () => {
		const store = new MemoryAccountStore();
		const pending = [];
		let verifyCalls = 0;
		const service = new GeminiAccountAdminService({
			store,
			cfg: baseConfig({
				runtime_profile: "worker",
				execution_ctx: {
					waitUntil(promise) {
						pending.push(promise);
					},
				},
			}),
			nowMs: () => 1000,
			rotateCookie: async () => new Response(null, { status: 200 }),
			verifyAccount: async () => {
				verifyCalls += 1;
				return {
					ok: true,
					at: "fresh-at",
					probe: {
						statusCode: 1000,
						issue: null,
						selectable: true,
						models: [],
					},
				};
			},
		});
		const body = {
			provider: "gemini",
			accounts: [{ "__Secure-1PSID": "worker", "__Secure-1PSIDTS": "t" }],
		};
		await service.create(body);
		assert.equal(pending.length, 1);
		await Promise.all(pending);
		assert.equal(verifyCalls, 1);
		await service.create(body);
		assert.equal(pending.length, 1);
		assert.equal(verifyCalls, 1);
	});
	test("awaits Docker import probes with concurrency bounded to four", async () => {
		const store = new MemoryAccountStore();
		let active = 0;
		let maxActive = 0;
		let verifyCalls = 0;
		const service = new GeminiAccountAdminService({
			store,
			cfg: baseConfig({ runtime_profile: "docker" }),
			nowMs: () => 1000,
			rotateCookie: async () => {
				active += 1;
				maxActive = Math.max(maxActive, active);
				await new Promise((resolve) => setTimeout(resolve, 0));
				active -= 1;
				return new Response(null, { status: 200 });
			},
			verifyAccount: async () => {
				verifyCalls += 1;
				return {
					ok: true,
					at: "fresh-at",
					probe: {
						statusCode: 1000,
						issue: null,
						selectable: true,
						models: [],
					},
				};
			},
		});
		await service.create({
			provider: "gemini",
			accounts: Array.from({ length: 6 }, (_, index) => ({
				"__Secure-1PSID": `docker-${index}`,
				"__Secure-1PSIDTS": `t-${index}`,
			})),
		});
		assert.equal(maxActive, 4);
		assert.equal(verifyCalls, 6);
	});
	test("removes the stats and check routes while preserving sanitized admin errors", async () => {
		const cfg = { ...baseConfig(), admin_key: "admin-secret" };
		const unauthorized = await handleGeminiAccountAdminRequest(
			new Request("https://worker.example/admin/accounts"),
			{},
			cfg,
			new URL("https://worker.example/admin/accounts"),
		);
		assert.equal(unauthorized.status, 401);

		for (const path of ["/admin/accounts/stats", "/admin/accounts/a/check"]) {
			const url = new URL(`https://worker.example${path}`);
			const response = await handleGeminiAccountAdminRequest(
				new Request(url, {
					headers: { Authorization: "Bearer admin-secret" },
				}),
				{},
				cfg,
				url,
			);
			assert.equal(response.status, 404);
		}
		const legacyUrl = new URL(
			"https://worker.example/admin/accounts?status=active",
		);
		const legacy = await handleGeminiAccountAdminRequest(
			new Request(legacyUrl, {
				headers: { Authorization: "Bearer admin-secret" },
			}),
			{},
			cfg,
			legacyUrl,
		);
		assert.equal(legacy.status, 400);
		assert.equal(
			(await legacy.json()).error.code,
			"unknown_admin_query_parameter",
		);
	});
	test("keeps the initial migration minimal and compatibility free", () => {
		const sql = readFileSync("migrations/0001_gemini_accounts.sql", "utf8");
		for (const column of [
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
		])
			assert.match(sql, new RegExp(`\\b${column}\\b`));
		assert.doesNotMatch(
			sql,
			/row_id|account_category|session_token|success_count|failure_count|source_id/,
		);
		assert.match(sql, /CREATE TABLE IF NOT EXISTS gemini_account_models/);
		assert.match(sql, /CREATE TABLE IF NOT EXISTS gemini_model_route_priority/);
		assert.match(sql, /display_name TEXT NOT NULL/);
		assert.match(sql, /model_number INTEGER NOT NULL/);
		assert.match(sql, /discovery_order INTEGER NOT NULL/);
		assert.match(sql, /VALUES \('schema_version', '3'/);
	});
	test("covers strict admin validation edge cases", () => {
		assert.throws(
			() =>
				geminiAccountListFilterFromSearchParams(new URLSearchParams("q=a&q=b")),
			/duplicate admin query parameter/,
		);
		assert.throws(
			() =>
				geminiAccountListFilterFromSearchParams(new URLSearchParams("limit=0")),
			/limit must be an integer/,
		);
		assert.throws(
			() =>
				geminiAccountListFilterFromSearchParams(
					new URLSearchParams("state=active"),
				),
			/state must be available/,
		);
		assert.throws(
			() => geminiAccountListFilterFromSearchParams(new URLSearchParams("q=")),
			/must not be empty/,
		);
		assert.throws(
			() => geminiAccountUpdateFromAdminBody({ enabled: 1 }, 1),
			/enabled must be a boolean/,
		);
		assert.throws(
			() => geminiAccountUpdateFromAdminBody({ label: 1 }, 1),
			/label must be a string or null/,
		);
		assert.throws(
			() =>
				normalizeGeminiAccountBulkAction({
					action: "enable",
					ids: ["a", "a"],
				}),
			/bulk action ids must be unique/,
		);
		assert.throws(
			() => normalizeGeminiAccountBulkAction({ action: "enable", ids: [] }),
			/non-empty array/,
		);
		assert.throws(
			() => normalizeGeminiAccountBulkAction({ action: "enable", ids: [1] }),
			/each account id must be a string/,
		);
		assert.throws(
			() => normalizeCreateAccounts({ provider: "other" }),
			/only provider=gemini/,
		);
		assert.throws(
			() => normalizeCreateAccounts({ provider: "gemini", accounts: [] }),
			/account payload is required/,
		);
		assert.throws(
			() =>
				normalizeCreateAccounts({
					"__Secure-1PSID": "__Secure-1PSID=p",
					"__Secure-1PSIDTS": "t",
				}),
			/value, not cookie names/,
		);
	});
	test("aggregates bulk enable, disable, delete, and refresh failures", async () => {
		const store = new MemoryAccountStore();
		let nowMs = 1000;
		const service = new GeminiAccountAdminService({
			store,
			cfg: baseConfig(),
			nowMs: () => nowMs,
			rotateCookie: async () => new Response(null, { status: 401 }),
		});
		await service.create({
			provider: "gemini",
			accounts: [
				{ "__Secure-1PSID": "p1", "__Secure-1PSIDTS": "t1" },
				{ "__Secure-1PSID": "p2", "__Secure-1PSIDTS": "t2" },
			],
		});
		const ids = [...store.rows.keys()];
		const disabled = await service.runBulkAction({
			action: "disable",
			ids: [...ids, "missing"],
		});
		assert.deepEqual(
			{ changed: disabled.changed, failed: disabled.failed },
			{ changed: 2, failed: 1 },
		);
		const enabled = await service.runBulkAction({ action: "enable", ids });
		assert.equal(enabled.changed, 2);
		nowMs = 121000;
		const refresh = await service.runBulkAction({ action: "refresh", ids });
		assert.equal(refresh.failed, 2);
		assert.equal(refresh.errors[0].code, "rotation_rejected");
		const removed = await service.runBulkAction({ action: "delete", ids });
		assert.equal(removed.changed, 2);
		assert.equal((await service.overview({ limit: 10 })).stats.total, 0);
	});
	test("routes every admin mutation boundary and rejects bodies or malformed JSON early", async () => {
		const cfg = { ...baseConfig(), admin_key: "admin-secret" };
		const request = async (path, init = {}) => {
			const url = new URL(`https://worker.example${path}`);
			return handleGeminiAccountAdminRequest(
				new Request(url, {
					...init,
					headers: {
						Authorization: "Bearer admin-secret",
						...(init.headers || {}),
					},
				}),
				{},
				cfg,
				url,
			);
		};
		for (const [path, init] of [
			["/admin/accounts", {}],
			[
				"/admin/accounts",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						"__Secure-1PSID": "p",
						"__Secure-1PSIDTS": "t",
					}),
				},
			],
			[
				"/admin/accounts/actions",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ action: "enable", ids: ["a"] }),
				},
			],
			[
				"/admin/accounts/a",
				{
					method: "PATCH",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ label: "A" }),
				},
			],
			["/admin/accounts/a", { method: "DELETE" }],
			["/admin/accounts/a/refresh", { method: "POST" }],
		]) {
			const response = await request(path, init);
			assert.equal(response.status, 503);
		}
		const invalidJson = await request("/admin/accounts", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{",
		});
		assert.equal(invalidJson.status, 400);
		const deleteBody = await request("/admin/accounts/a", {
			method: "DELETE",
			body: "unexpected",
		});
		assert.equal(deleteBody.status, 400);
		const unknown = await request("/admin/accounts/a/unknown", {
			method: "POST",
		});
		assert.equal(unknown.status, 404);
	});
	test("persists minimal D1 rows, health transitions, locks, and bulk mutations", async () => {
		const db = new MutableD1();
		const store = new D1GeminiAccountStore(db);
		const first = await store.createAccount({
			id: "first",
			label: "First",
			cookieHeader: "__Secure-1PSID=p1; __Secure-1PSIDTS=t1",
			nowMs: 1000,
		});
		assert.equal(first.state, "available");
		assert.equal(await store.getPoolVersion(), "1");
		const firstHash = db.rows.get("first").cookie_hash;
		assert.equal(
			(await store.findAccountByCookieHash(firstHash, 1000)).id,
			"first",
		);
		assert.equal(
			(await store.updateAccount("first", { label: "First", nowMs: 1100 }))
				.changed,
			false,
		);
		assert.equal(
			(await store.updateAccount("first", { enabled: false, nowMs: 1200 }))
				.changed,
			true,
		);
		assert.equal((await store.getAccountForRefresh("first")).enabled, 0);

		assert.equal(
			await store.tryAcquireRefreshLock("first", "owner", 5000, 1000),
			true,
		);
		assert.equal(
			await store.tryAcquireRefreshLock("first", "other", 5000, 2000),
			false,
		);
		await store.releaseRefreshLock("first", "owner");

		const sameCookie = await store.writeRefreshedCookie("first", {
			cookieHeader: "__Secure-1PSID=p1; __Secure-1PSIDTS=t1",
			refreshedAtMs: 2000,
			nowMs: 2000,
		});
		assert.equal(sameCookie.changed, false);
		const changedCookie = await store.writeRefreshedCookie("first", {
			cookieHeader: "__Secure-1PSID=p1; __Secure-1PSIDTS=t1-next",
			refreshedAtMs: 3000,
			nowMs: 3000,
		});
		assert.equal(changedCookie.changed, true);

		await store.writeAccountOutcome("first", {
			kind: "failure",
			issue: "transient",
			cooldownUntilMs: 9000,
			nowMs: 4000,
		});
		assert.equal(db.rows.get("first").issue, "transient");
		await store.writeAccountOutcome("first", {
			kind: "failure",
			nowMs: 4500,
		});
		assert.equal(db.rows.get("first").last_used_at_ms, 4500);
		await store.writeAccountOutcome("first", {
			kind: "success",
			nowMs: 5000,
		});
		assert.equal(db.rows.get("first").issue, null);

		const stableIdentity = await identityHashFromCookie(
			"__Secure-1PSID=p1; __Secure-1PSIDTS=another",
		);
		assert.equal(db.rows.get("first").identity_hash, stableIdentity);
		const reimported = await store.createAccount({
			id: "duplicate-id",
			label: "Updated identity",
			cookieHeader: "__Secure-1PSID=p1; __Secure-1PSIDTS=reimported",
			nowMs: 5500,
		});
		assert.equal(reimported.id, "first");
		assert.equal(db.rows.size, 1);
		assert.match(db.rows.get("first").cookie_header, /PSIDTS=reimported/);

		await store.writeAccountProbe(
			"first",
			{
				statusCode: 1000,
				issue: null,
				selectable: true,
				models: [
					{
						modelId: "model-pro",
						displayName: "Pro",
						description: "Stored Pro",
						available: true,
						capacity: 3,
						capacityField: 13,
						modelNumber: 7,
						discoveryOrder: 0,
					},
				],
			},
			5600,
		);
		assert.equal(db.rows.get("first").account_status_code, 1000);
		assert.deepEqual(await store.listAccountCapabilities(["first"]), [
			{
				account_id: "first",
				model_id: "model-pro",
				display_name: "Pro",
				description: "Stored Pro",
				available: 1,
				capacity: 3,
				capacity_field: 13,
				model_number: 7,
				discovery_order: 0,
				checked_at_ms: 5600,
			},
		]);
		await store.writeAccountProbe(
			"first",
			{
				statusCode: 1016,
				issue: "auth",
				selectable: false,
				models: [],
			},
			5650,
		);
		assert.equal(db.rows.get("first").account_status_code, 1016);
		assert.equal((await store.listAllAccountCapabilities(12800)).length, 1);

		const routeOrder = [
			{
				providerModelId: "e6fa609c3fa255c0",
				capacity: 4,
				capacityField: 12,
				modelNumber: 3,
			},
			{
				providerModelId: "9d8ca3786ebdfbea",
				capacity: 1,
				capacityField: 12,
				modelNumber: 3,
			},
		];
		await store.replaceModelRoutePriority("pro", routeOrder, 5700);
		assert.deepEqual(await store.listModelRoutePriorities(), [
			{
				family: "pro",
				provider_model_id: "e6fa609c3fa255c0",
				capacity: 4,
				capacity_field: 12,
				model_number: 3,
				priority: 0,
				updated_at_ms: 5700,
			},
			{
				family: "pro",
				provider_model_id: "9d8ca3786ebdfbea",
				capacity: 1,
				capacity_field: 12,
				model_number: 3,
				priority: 1,
				updated_at_ms: 5700,
			},
		]);
		const versionBeforeInvalidPriority = await store.getPoolVersion();
		await assert.rejects(
			() =>
				store.replaceModelRoutePriority(
					"pro",
					[routeOrder[0], routeOrder[0]],
					5800,
				),
			/duplicate Gemini route tuple/,
		);
		assert.equal(await store.getPoolVersion(), versionBeforeInvalidPriority);
		await store.clearModelRoutePriority("pro", 5900);
		assert.deepEqual(await store.listModelRoutePriorities(), []);

		const entries = [];
		for (const [id, cookie] of [
			["second", "p2"],
			["third", "p3"],
		]) {
			const cookieHeader = `__Secure-1PSID=${cookie}; __Secure-1PSIDTS=t`;
			entries.push({
				cookieHash: await sha256Hex(cookieHeader),
				identityHash: await identityHashFromCookie(cookieHeader),
				input: { id, cookieHeader, nowMs: 6000 },
			});
		}
		const bulk = await store.createAccountsBulk(entries);
		assert.equal(bulk.addedCookieHashes.size, 2);
		assert.equal(
			(await store.setAccountsEnabledBulk(["second", "third"], false, 7000))
				.length,
			2,
		);
		assert.deepEqual(
			await store.deleteAccountsBulk(["second", "missing"], 8000),
			["second"],
		);
		assert.equal(await store.deleteAccount("first", 9000), true);
		assert.equal(await store.deleteAccount("missing", 9000), false);
	});
	test("round-trips exact model routing policies through the admin API", async () => {
		const db = new MutableD1();
		const store = new D1GeminiAccountStore(db);
		const checkedAtMs = Date.now();
		for (const [id, model] of [
			[
				"basic",
				{
					modelId: "9d8ca3786ebdfbea",
					displayName: "Basic Pro",
					description: "Basic Pro route",
					available: true,
					capacity: 3,
					capacityField: 13,
					modelNumber: 3,
					discoveryOrder: 0,
				},
			],
			[
				"plus",
				{
					modelId: "e6fa609c3fa255c0",
					displayName: "Plus Pro",
					description: "Plus Pro route",
					available: true,
					capacity: 4,
					capacityField: 12,
					modelNumber: 3,
					discoveryOrder: 0,
				},
			],
		]) {
			await store.createAccount({
				id,
				cookieHeader: `__Secure-1PSID=${id}; __Secure-1PSIDTS=ts`,
				nowMs: checkedAtMs,
			});
			await store.writeAccountProbe(
				id,
				{ statusCode: 1000, issue: null, selectable: true, models: [model] },
				checkedAtMs,
			);
		}
		const env = { GEMINI_DB: db, ADMIN_KEY: "admin-secret" };
		const request = (path, init = {}) =>
			worker.fetch(
				new Request(`https://worker.example${path}`, {
					...init,
					headers: {
						Authorization: "Bearer admin-secret",
						...(init.headers || {}),
					},
				}),
				env,
				{},
			);

		const unauthorized = await worker.fetch(
			new Request("https://worker.example/admin/model-routing"),
			env,
			{},
		);
		assert.equal(unauthorized.status, 401);
		const initial = await request("/admin/model-routing");
		assert.equal(initial.status, 200);
		const initialPro = (await initial.json()).families.find(
			(family) => family.family === "pro",
		);
		assert.equal(initialPro.configured, false);
		assert.deepEqual(
			initialPro.routes.map((route) => [
				route.providerModelId,
				route.capacity,
				route.capacityField,
			]),
			[
				["9d8ca3786ebdfbea", 3, 13],
				["e6fa609c3fa255c0", 4, 12],
			],
		);

		const versionBeforeInvalid = await store.getPoolVersion();
		const invalid = await request("/admin/model-routing/pro", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				routes: [
					{
						providerModelId: "not-discovered",
						capacity: 1,
						capacityField: 12,
						modelNumber: 3,
					},
				],
			}),
		});
		assert.equal(invalid.status, 400);
		assert.equal((await invalid.json()).error.code, "unknown_model_route");
		assert.equal(await store.getPoolVersion(), versionBeforeInvalid);

		const routes = [...initialPro.routes]
			.reverse()
			.map(({ providerModelId, capacity, capacityField, modelNumber }) => ({
				providerModelId,
				capacity,
				capacityField,
				modelNumber,
			}));
		const saved = await request("/admin/model-routing/pro", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ routes }),
		});
		assert.equal(saved.status, 200);
		const savedBody = await saved.json();
		const savedPro = savedBody.families.find(
			(family) => family.family === "pro",
		);
		assert.equal(savedPro.configured, true);
		assert.deepEqual(
			savedPro.routes.map((route) => route.providerModelId),
			["e6fa609c3fa255c0", "9d8ca3786ebdfbea"],
		);
		assert.equal(
			savedBody.families.find((family) => family.family === "flash").configured,
			false,
		);

		const reset = await request("/admin/model-routing/pro", {
			method: "DELETE",
		});
		assert.equal(reset.status, 200);
		assert.equal(
			(await reset.json()).families.find((family) => family.family === "pro")
				.configured,
			false,
		);
		assert.equal(db.priorities.size, 0);
	});
});
