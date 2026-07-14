import { readFileSync } from "node:fs";
import { assert } from "./assertions.js";
import { baseConfig, mod } from "./helpers.js";

export const suiteName = "gemini accounts";
export const cases = [
	[
		"derives four account states and hides expired temporary issues",
		() => {
			assert.equal(
				mod.geminiAccountState(
					{ enabled: false, issue: "auth", cooldown_until_ms: 9000 },
					1000,
				),
				"disabled",
			);
			assert.equal(
				mod.geminiAccountState(
					{ enabled: true, issue: "rate_limit", cooldown_until_ms: 9000 },
					1000,
				),
				"cooling",
			);
			assert.equal(
				mod.geminiAccountState(
					{ enabled: true, issue: "auth", cooldown_until_ms: null },
					1000,
				),
				"attention",
			);
			assert.equal(
				mod.geminiAccountState(
					{ enabled: true, issue: "transient", cooldown_until_ms: 900 },
					1000,
				),
				"available",
			);
			assert.equal(
				mod.visibleGeminiAccountIssue(
					{ issue: "transient", cooldown_until_ms: 900 },
					1000,
				),
				null,
			);
			assert.equal(
				mod.visibleGeminiAccountIssue(
					{ issue: "auth", cooldown_until_ms: null },
					1000,
				),
				"auth",
			);
		},
	],
	[
		"classifies health-affecting outcomes without poisoning accounts for model errors",
		() => {
			assert.deepEqual(
				mod.classifyGeminiAccountOutcome({ status: 401 }, 1000),
				{
					kind: "failure",
					issue: "auth",
					nowMs: 1000,
				},
			);
			assert.deepEqual(
				mod.classifyGeminiAccountOutcome({ status: 429 }, 1000),
				{
					kind: "failure",
					issue: "rate_limit",
					cooldownUntilMs: 301000,
					nowMs: 1000,
				},
			);
			assert.deepEqual(
				mod.classifyGeminiAccountOutcome(new Error("invalid model"), 1000),
				{ kind: "failure", nowMs: 1000 },
			);
			assert.deepEqual(
				mod.classifyGeminiAccountOutcome(new Error("network reset"), 1000),
				{
					kind: "failure",
					issue: "transient",
					cooldownUntilMs: 61000,
					nowMs: 1000,
				},
			);
		},
	],
	[
		"accepts only the slim admin input and rejects legacy fields and actions",
		() => {
			assert.deepEqual(
				mod.geminiAccountListFilterFromSearchParams(
					new URLSearchParams("limit=200&q=alpha&state=attention"),
				),
				{ limit: 200, q: "alpha", state: "attention" },
			);
			assert.deepEqual(
				mod.normalizeGeminiAccountListFilter({ limit: 999, state: "cooling" }),
				{ limit: 200, state: "cooling" },
			);
			assert.deepEqual(
				mod.geminiAccountUpdateFromAdminBody(
					{ label: null, enabled: false },
					1000,
				),
				{ label: null, enabled: false, nowMs: 1000 },
			);
			assert.throws(
				() =>
					mod.geminiAccountListFilterFromSearchParams(
						new URLSearchParams("status=active"),
					),
				/unknown admin query parameter/,
			);
			assert.throws(
				() => mod.geminiAccountUpdateFromAdminBody({ status: "active" }, 1000),
				/unsupported account update field/,
			);
			assert.throws(
				() =>
					mod.normalizeCreateAccounts({
						provider: "gemini",
						"__Secure-1PSID": "p",
						"__Secure-1PSIDTS": "t",
						source: "legacy",
					}),
				/only __Secure-1PSID, __Secure-1PSIDTS, and label/,
			);
			assert.throws(
				() =>
					mod.normalizeGeminiAccountBulkAction({ action: "check", ids: ["a"] }),
				/action must be enable, disable, delete, or refresh/,
			);
		},
	],
	[
		"projects a slim overview and keeps cookie material behind the D1 boundary",
		async () => {
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
			const store = new mod.D1GeminiAccountStore(db);
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
			assert.equal(Object.keys(overview.items[0]).length, 11);
		},
	],
	[
		"returns one compact mutation shape for import, update, delete, and refresh",
		async () => {
			const store = new MemoryAccountStore();
			const service = new mod.GeminiAccountAdminService({
				store,
				cfg: baseConfig(),
				nowMs: () => 1000,
				rotateCookie: async () =>
					new Response(null, {
						status: 200,
						headers: { "set-cookie": "__Secure-1PSIDTS=rotated" },
					}),
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
		},
	],
	[
		"removes the stats and check routes while preserving sanitized admin errors",
		async () => {
			const cfg = { ...baseConfig(), admin_key: "admin-secret" };
			const unauthorized = await mod.handleGeminiAccountAdminRequest(
				new Request("https://worker.example/admin/accounts"),
				{},
				cfg,
				new URL("https://worker.example/admin/accounts"),
			);
			assert.equal(unauthorized.status, 401);

			for (const path of ["/admin/accounts/stats", "/admin/accounts/a/check"]) {
				const url = new URL(`https://worker.example${path}`);
				const response = await mod.handleGeminiAccountAdminRequest(
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
			const legacy = await mod.handleGeminiAccountAdminRequest(
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
		},
	],
	[
		"keeps the initial migration minimal and compatibility free",
		() => {
			const sql = readFileSync("migrations/0001_gemini_accounts.sql", "utf8");
			for (const column of [
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
			])
				assert.match(sql, new RegExp(`\\b${column}\\b`));
			assert.doesNotMatch(
				sql,
				/row_id|account_category|account_status_code|session_token|success_count|failure_count|source_id/,
			);
		},
	],
	[
		"covers strict admin validation edge cases",
		() => {
			assert.throws(
				() =>
					mod.geminiAccountListFilterFromSearchParams(
						new URLSearchParams("q=a&q=b"),
					),
				/duplicate admin query parameter/,
			);
			assert.throws(
				() =>
					mod.geminiAccountListFilterFromSearchParams(
						new URLSearchParams("limit=0"),
					),
				/limit must be an integer/,
			);
			assert.throws(
				() =>
					mod.geminiAccountListFilterFromSearchParams(
						new URLSearchParams("state=active"),
					),
				/state must be available/,
			);
			assert.throws(
				() =>
					mod.geminiAccountListFilterFromSearchParams(
						new URLSearchParams("q="),
					),
				/must not be empty/,
			);
			assert.throws(
				() => mod.geminiAccountUpdateFromAdminBody({ enabled: 1 }, 1),
				/enabled must be a boolean/,
			);
			assert.throws(
				() => mod.geminiAccountUpdateFromAdminBody({ label: 1 }, 1),
				/label must be a string or null/,
			);
			assert.throws(
				() =>
					mod.normalizeGeminiAccountBulkAction({
						action: "enable",
						ids: ["a", "a"],
					}),
				/bulk action ids must be unique/,
			);
			assert.throws(
				() =>
					mod.normalizeGeminiAccountBulkAction({ action: "enable", ids: [] }),
				/non-empty array/,
			);
			assert.throws(
				() =>
					mod.normalizeGeminiAccountBulkAction({ action: "enable", ids: [1] }),
				/each account id must be a string/,
			);
			assert.throws(
				() => mod.normalizeCreateAccounts({ provider: "other" }),
				/only provider=gemini/,
			);
			assert.throws(
				() => mod.normalizeCreateAccounts({ provider: "gemini", accounts: [] }),
				/account payload is required/,
			);
			assert.throws(
				() =>
					mod.normalizeCreateAccounts({
						"__Secure-1PSID": "__Secure-1PSID=p",
						"__Secure-1PSIDTS": "t",
					}),
				/value, not cookie names/,
			);
		},
	],
	[
		"aggregates bulk enable, disable, delete, and refresh failures",
		async () => {
			const store = new MemoryAccountStore();
			const service = new mod.GeminiAccountAdminService({
				store,
				cfg: baseConfig(),
				nowMs: () => 1000,
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
			const refresh = await service.runBulkAction({ action: "refresh", ids });
			assert.equal(refresh.failed, 2);
			assert.equal(refresh.errors[0].code, "rotation_rejected");
			const removed = await service.runBulkAction({ action: "delete", ids });
			assert.equal(removed.changed, 2);
			assert.equal((await service.overview({ limit: 10 })).stats.total, 0);
		},
	],
	[
		"routes every admin mutation boundary and rejects bodies or malformed JSON early",
		async () => {
			const cfg = { ...baseConfig(), admin_key: "admin-secret" };
			const request = async (path, init = {}) => {
				const url = new URL(`https://worker.example${path}`);
				return mod.handleGeminiAccountAdminRequest(
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
		},
	],
	[
		"persists minimal D1 rows, health transitions, locks, and bulk mutations",
		async () => {
			const db = new MutableD1();
			const store = new mod.D1GeminiAccountStore(db);
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

			const entries = [];
			for (const [id, cookie] of [
				["second", "p2"],
				["third", "p3"],
			]) {
				const cookieHeader = `__Secure-1PSID=${cookie}; __Secure-1PSIDTS=t`;
				entries.push({
					cookieHash: await mod.sha256Hex(cookieHeader),
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
		},
	],
];

function accountRow(id, overrides = {}) {
	return {
		id,
		label: null,
		enabled: 1,
		cookie_header: `__Secure-1PSID=secret-p-${id}; __Secure-1PSIDTS=secret-t-${id}`,
		cookie_hash: `hash-${id}`,
		issue: null,
		cooldown_until_ms: null,
		last_issue_at_ms: null,
		last_used_at_ms: null,
		last_refresh_at_ms: null,
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
		}
		return columnName && value ? value[columnName] : value;
	}
	async all() {
		let results = [];
		if (this.sql.includes("WHERE cookie_hash IN")) {
			results = [...this.db.rows.values()].filter((row) =>
				this.values.includes(row.cookie_hash),
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
					"issue",
					"cooldown_until_ms",
					"last_issue_at_ms",
					"last_used_at_ms",
					"last_refresh_at_ms",
					"created_at_ms",
					"updated_at_ms",
				].map((key, index) => [key, this.values[index]]),
			);
			const duplicate = [...this.db.rows.values()].some(
				(existing) => existing.cookie_hash === row.cookie_hash,
			);
			if (!duplicate) {
				this.db.rows.set(row.id, row);
				changes = 1;
			} else if (!this.sql.includes("DO NOTHING")) {
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
			const [cookie, hash, refreshed, updated, id] = this.values;
			const row = this.db.rows.get(id);
			if (!row) return 0;
			Object.assign(row, {
				cookie_header: cookie,
				cookie_hash: hash,
				issue: null,
				cooldown_until_ms: null,
				last_issue_at_ms: null,
				last_refresh_at_ms: refreshed,
				updated_at_ms: updated,
			});
			return 1;
		}
		if (this.sql.includes("last_refresh_at_ms = ?")) {
			const [refreshed, updated, id] = this.values;
			const row = this.db.rows.get(id);
			if (!row) return 0;
			Object.assign(row, {
				issue: null,
				cooldown_until_ms: null,
				last_issue_at_ms: null,
				last_refresh_at_ms: refreshed,
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
		created_at_ms: row.created_at_ms,
		updated_at_ms: row.updated_at_ms,
	};
}
