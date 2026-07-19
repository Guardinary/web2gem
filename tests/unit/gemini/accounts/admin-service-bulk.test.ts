// @ts-nocheck
import { describe, test } from "vitest";
import { assert } from "../../assertions.js";
import { createService } from "./_support/admin-service-fixtures.js";
import {
	accountSqlRow,
	accountSummary,
	createAccountStoreDouble,
} from "./_support/store-fixtures.js";

describe("Gemini account admin service bulk and overview", () => {
	test("aggregates bulk disable and enable store outcomes", async () => {
		const store = createAccountStoreDouble({
			updateAccount: [
				{ result: { item: accountSummary("a"), changed: true } },
				{ result: { item: accountSummary("b"), changed: true } },
				{ result: { item: null, changed: false } },
				{ result: { item: accountSummary("a"), changed: true } },
				{ result: { item: accountSummary("b"), changed: true } },
			],
		});
		const service = createService(store);
		const disabled = await service.runBulkAction({
			action: "disable",
			ids: ["a", "b", "missing"],
		});
		assert.deepEqual(
			{ changed: disabled.changed, failed: disabled.failed },
			{ changed: 2, failed: 1 },
		);
		const enabled = await service.runBulkAction({
			action: "enable",
			ids: ["a", "b"],
		});
		assert.equal(enabled.changed, 2);
		assert.deepEqual(
			store.calls
				.filter((call) => call.method === "updateAccount")
				.map((call) => call.args),
			[
				["a", { enabled: false, nowMs: 1000 }],
				["b", { enabled: false, nowMs: 1000 }],
				["missing", { enabled: false, nowMs: 1000 }],
				["a", { enabled: true, nowMs: 1000 }],
				["b", { enabled: true, nowMs: 1000 }],
			],
		);
		store.assertDrained();
	});

	test("aggregates bulk refresh rotation rejections", async () => {
		const accounts = ["a", "b"].map((id) =>
			accountSqlRow(id, {
				cookie_header: `__Secure-1PSID=${id}; __Secure-1PSIDTS=t-${id}`,
			}),
		);
		const store = createAccountStoreDouble({
			getAccountForRefresh: [...accounts, ...accounts].map((account) => ({
				result: account,
			})),
			tryAcquireRefreshLock: [{ result: true }, { result: true }],
			writeAccountOutcome: [{}, {}],
			releaseRefreshLock: [{}, {}],
		});
		const result = await createService(store, {
			rotateCookie: async () => new Response(null, { status: 401 }),
		}).runBulkAction({ action: "refresh", ids: ["a", "b"] });

		assert.equal(result.failed, 2);
		assert.equal(result.errors[0].code, "rotation_rejected");
		assert.equal(result.errors[1].code, "rotation_rejected");
		store.assertDrained();
	});

	test("aggregates bulk delete changes and missing accounts", async () => {
		const store = createAccountStoreDouble({
			deleteAccount: [
				{ args: ["a", 1000], result: true },
				{ args: ["b", 1000], result: true },
				{ args: ["missing", 1000], result: false },
			],
		});
		const result = await createService(store).runBulkAction({
			action: "delete",
			ids: ["a", "b", "missing"],
		});

		assert.deepEqual(
			{
				processed: result.processed,
				changed: result.changed,
				failed: result.failed,
			},
			{ processed: 3, changed: 2, failed: 1 },
		);
		assert.equal(result.errors[0].code, "account_not_found");
		store.assertDrained();
	});

	test("forwards normalized overview filters and the current time", async () => {
		const overview = {
			items: [],
			nextCursor: null,
			limit: 10,
			stats: { total: 0, available: 0, cooling: 0, attention: 0, disabled: 0 },
		};
		const store = createAccountStoreDouble({
			getAdminOverview: {
				args: [{ limit: 10, state: "available" }, 1000],
				result: overview,
			},
		});
		assert.equal(
			await createService(store).overview({ limit: 10, state: "available" }),
			overview,
		);
		store.assertDrained();
	});
});
