import { describe, test } from "vitest";
import { assert } from "../../assertions.js";
import {
	createService,
	mutationCounts,
} from "./_support/admin-service-fixtures.js";
import {
	accountSqlRow,
	accountSummary,
	createAccountStoreDouble,
} from "./_support/store-fixtures.js";

describe("Gemini account admin service mutations", () => {
	test("reports changed and unchanged updates plus a missing delete", async () => {
		const item = accountSummary("account-a", { label: "Renamed" });
		const store = createAccountStoreDouble({
			updateAccount: [
				{
					args: ["account-a", { label: "Renamed", nowMs: 1000 }],
					result: { item, changed: true },
				},
				{
					args: ["account-a", { label: "Renamed", nowMs: 1000 }],
					result: { item, changed: false },
				},
			],
			deleteAccount: {
				args: ["missing", 1000],
				result: false,
			},
		});
		const service = createService(store);

		assert.deepEqual(
			mutationCounts(await service.update("account-a", { label: "Renamed" })),
			{
				processed: 1,
				changed: 1,
				unchanged: 0,
				failed: 0,
			},
		);
		assert.deepEqual(
			mutationCounts(await service.update("account-a", { label: "Renamed" })),
			{
				processed: 1,
				changed: 0,
				unchanged: 1,
				failed: 0,
			},
		);
		const missing = await service.delete("missing");
		assert.equal(missing.failed, 1);
		assert.equal(missing.errors[0].code, "account_not_found");
		assert.equal(typeof service.check, "undefined");
		store.assertDrained();
	});

	test("reports a successful credential rotation through runtime-store interactions", async () => {
		const account = accountSqlRow("account-a", {
			cookie_header: "__Secure-1PSID=p; __Secure-1PSIDTS=t",
		});
		const store = createAccountStoreDouble({
			getAccountForRefresh: [
				{ args: ["account-a"], result: account },
				{ args: ["account-a"], result: account },
			],
			tryAcquireRefreshLock: {
				check([id, owner, expiresAtMs, nowMs]) {
					assert.equal(id, "account-a");
					assert.match(owner, /^account-refresh:account-a:/);
					assert.equal(expiresAtMs, 121000);
					assert.equal(nowMs, 1000);
				},
				result: true,
			},
			writeRefreshedCookie: {
				check([id, update]) {
					assert.equal(id, "account-a");
					assert.match(update.cookieHeader, /PSIDTS=rotated/);
					assert.deepEqual(
						{ refreshedAtMs: update.refreshedAtMs, nowMs: update.nowMs },
						{ refreshedAtMs: 1000, nowMs: 1000 },
					);
				},
				result: { changed: true },
			},
			releaseRefreshLock: {
				check([id, owner]) {
					assert.equal(id, "account-a");
					assert.match(owner, /^account-refresh:account-a:/);
				},
			},
		});
		const result = await createService(store, {
			rotateCookie: async () =>
				new Response(null, {
					status: 200,
					headers: { "set-cookie": "__Secure-1PSIDTS=rotated" },
				}),
		}).refresh("account-a");

		assert.deepEqual(mutationCounts(result), {
			processed: 1,
			changed: 1,
			unchanged: 0,
			failed: 0,
		});
		store.assertDrained();
	});
});
