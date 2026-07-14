import { assert } from "./assertions.js";
import { baseConfig, mod } from "./helpers.js";

export const suiteName = "gemini account runtime";
export const cases = [
	[
		"leases the least-used selectable account and derives runtime auth from its cookie",
		async () => {
			const store = new FakeStore([
				account("later", { last_used_at_ms: 2000 }),
				account("first", {
					cookie_header:
						"__Secure-1PSID=p; __Secure-1PSIDTS=t; SAPISID=sapisid-value",
					last_used_at_ms: 1000,
				}),
			]);
			const pool = new mod.AccountPoolService(store, {
				nowMs: () => 3000,
				rotateCookie: async () => new Response(null, { status: 200 }),
			});
			const lease = await pool.acquireLease(baseConfig());
			assert.equal(lease.accountId, "first");
			assert.equal(lease.config.sapisid, "sapisid-value");
			assert.match(lease.config.cookie, /__Secure-1PSID=p/);
			assert.deepEqual(lease.config.gemini_account, {
				accountId: "first",
				cookieHash: "hash-first",
			});
			lease.release();
			assert.equal(pool.localInFlight("first"), 0);
		},
	],
	[
		"updates account health with one normalized issue model",
		async () => {
			const store = new FakeStore([account("a")]);
			const pool = new mod.AccountPoolService(store, {
				nowMs: () => 1000,
				rotateCookie: async () => new Response(null, { status: 200 }),
			});
			const lease = await pool.acquireLease(baseConfig());
			await lease.markFailure({ status: 429 }, 1000);
			assert.deepEqual(store.outcomes.at(-1), {
				kind: "failure",
				issue: "rate_limit",
				cooldownUntilMs: 301000,
				nowMs: 1000,
			});
			await lease.markFailure(new Error("invalid model"), 2000);
			assert.deepEqual(store.outcomes.at(-1), {
				kind: "failure",
				nowMs: 2000,
			});
			await lease.markSuccess(3000);
			assert.deepEqual(store.outcomes.at(-1), {
				kind: "success",
				nowMs: 3000,
			});
		},
	],
	[
		"deduplicates refreshes and updates the active lease config after rotation",
		async () => {
			const store = new FakeStore([account("a")]);
			let rotateCalls = 0;
			const pool = new mod.AccountPoolService(store, {
				nowMs: () => 120000,
				rotateCookie: async () => {
					rotateCalls++;
					await Promise.resolve();
					return new Response(null, {
						status: 200,
						headers: { "set-cookie": "__Secure-1PSIDTS=rotated" },
					});
				},
			});
			const lease = await pool.acquireLease(baseConfig());
			const [first, second] = await Promise.all([
				lease.refreshForRetry("auth"),
				lease.refreshForRetry("auth"),
			]);
			assert.deepEqual(first, second);
			assert.equal(first.changed, true);
			assert.equal(rotateCalls, 1);
			assert.equal(store.writes.length, 1);
			assert.match(lease.config.cookie, /__Secure-1PSIDTS=rotated/);
			assert.doesNotMatch(lease.config.cookie, /__Secure-1PSIDTS=t(?:;|$)/);
			assert.equal(lease.config.gemini_account.cookieHash, lease.cookieHash);
		},
	],
	[
		"keeps the lease unchanged when refreshed credentials duplicate another account",
		async () => {
			const store = new FakeStore([account("a")]);
			store.writeResult = { changed: false, reason: "duplicate_cookie" };
			const pool = new mod.AccountPoolService(store, {
				nowMs: () => 120000,
				rotateCookie: async () =>
					new Response(null, {
						status: 200,
						headers: { "set-cookie": "__Secure-1PSIDTS=duplicate" },
					}),
			});
			const lease = await pool.acquireLease(baseConfig());
			const originalCookie = lease.config.cookie;
			const originalHash = lease.cookieHash;
			assert.deepEqual(await lease.refreshForRetry("auth"), {
				changed: false,
				reason: "rotation_duplicate",
				upstreamStatus: 200,
			});
			assert.equal(lease.config.cookie, originalCookie);
			assert.equal(lease.cookieHash, originalHash);
		},
	],
	[
		"records rejected refreshes through the shared classifier",
		async () => {
			const store = new FakeStore([account("a")]);
			const pool = new mod.AccountPoolService(store, {
				nowMs: () => 120000,
				rotateCookie: async () => new Response(null, { status: 401 }),
			});
			const lease = await pool.acquireLease(baseConfig());
			assert.deepEqual(await lease.refreshForRetry("auth"), {
				changed: false,
				reason: "rotation_rejected",
				upstreamStatus: 401,
			});
			assert.deepEqual(store.outcomes.at(-1), {
				kind: "failure",
				issue: "auth",
				nowMs: 120000,
			});
		},
	],
	[
		"keeps page and push token cache scopes account-specific without D1 page state",
		() => {
			const first = mod.geminiAccountCacheScope({
				...baseConfig(),
				gemini_account: { accountId: "a", cookieHash: "ha" },
			});
			const second = mod.geminiAccountCacheScope({
				...baseConfig(),
				gemini_account: { accountId: "b", cookieHash: "hb" },
			});
			assert.match(first, /account:a.*cookie:ha/);
			assert.match(second, /account:b.*cookie:hb/);
			assert.equal(first === second, false);
		},
	],
];

function account(id, overrides = {}) {
	return {
		id,
		label: null,
		enabled: 1,
		cookie_header: `__Secure-1PSID=p-${id}; __Secure-1PSIDTS=t-${id}`,
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

class FakeStore {
	constructor(rows) {
		this.rows = new Map(rows.map((row) => [row.id, row]));
		this.outcomes = [];
		this.writes = [];
		this.writeResult = { changed: true };
	}
	async getPoolVersion() {
		return "1";
	}
	async listSelectableAccounts() {
		return [...this.rows.values()]
			.filter((row) => row.enabled === 1)
			.sort(
				(a, b) =>
					(a.last_used_at_ms || 0) - (b.last_used_at_ms || 0) ||
					a.id.localeCompare(b.id),
			)
			.map((row) => ({
				id: row.id,
				enabled: row.enabled,
				cookie_header: row.cookie_header,
				cookie_hash: row.cookie_hash,
				issue: row.issue,
				cooldown_until_ms: row.cooldown_until_ms,
				last_used_at_ms: row.last_used_at_ms,
			}));
	}
	async getAccountForRefresh(id) {
		return this.rows.get(id) || null;
	}
	async tryAcquireRefreshLock() {
		return true;
	}
	async releaseRefreshLock() {}
	async writeRefreshedCookie(id, update) {
		this.writes.push({ id, update });
		if (this.writeResult.changed) {
			const row = this.rows.get(id);
			row.cookie_header = update.cookieHeader;
			row.last_refresh_at_ms = update.refreshedAtMs;
		}
		return this.writeResult;
	}
	async writeAccountOutcome(id, outcome) {
		this.outcomes.push(outcome);
		const row = this.rows.get(id);
		row.last_used_at_ms = outcome.nowMs;
		if (outcome.kind === "success") {
			row.issue = null;
			row.cooldown_until_ms = null;
		} else if (outcome.issue) {
			row.issue = outcome.issue;
			row.cooldown_until_ms = outcome.cooldownUntilMs ?? null;
		}
	}
}
