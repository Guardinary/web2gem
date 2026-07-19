import { describe, test } from "vitest";
import { AccountPoolService } from "../../../../src/gemini/accounts/pool";
import type { GeminiAccountOutcome } from "../../../../src/gemini/accounts/runtime-types";
import { assert } from "../../assertions.js";
import {
	account,
	accountContext,
	createRuntimeStore,
	rejectUnexpectedCookieRotation,
	required,
	runtimeConfig,
	runtimeCall,
} from "./_support/runtime-fixtures.js";

describe("gemini account runtime", () => {
	test("leases the first store-ordered account and derives runtime auth from its cookie", async () => {
		const rows = [
			account("first", {
				cookie_header:
					"__Secure-1PSID=p; __Secure-1PSIDTS=t; SAPISID=sapisid-value",
			}),
			account("later"),
		];
		const store = createRuntimeStore([
			runtimeCall("getPoolVersion", [], "1"),
			runtimeCall("listSelectableAccounts", [3000, 100], rows),
		]);
		const pool = new AccountPoolService(store, {
			nowMs: () => 3000,
			rotateCookie: rejectUnexpectedCookieRotation,
		});
		const lease = required(
			await pool.acquireLease(runtimeConfig()),
			"first account lease",
		);
		const context = accountContext(lease.config);
		assert.equal(lease.accountId, "first");
		assert.equal(lease.config.sapisid, "sapisid-value");
		assert.match(lease.config.cookie, /__Secure-1PSID=p/);
		assert.equal(context.accountId, "first");
		assert.equal(context.cookieHash, "hash-first");
		assert.equal(typeof context.observeSetCookie, "function");
		lease.release();
		store.assertExhausted();
	});
	test("makes a released account selectable again through facade load balancing", async () => {
		const rows = [account("a"), account("b")];
		const store = createRuntimeStore([
			runtimeCall("getPoolVersion", [], "1"),
			runtimeCall("listSelectableAccounts", [1000, 100], rows),
		]);
		const pool = new AccountPoolService(store, {
			nowMs: () => 1000,
			rotateCookie: rejectUnexpectedCookieRotation,
		});

		const first = required(
			await pool.acquireLease(runtimeConfig()),
			"first lease",
		);
		const second = required(
			await pool.acquireLease(runtimeConfig()),
			"second lease",
		);
		assert.equal(first.accountId, "a");
		assert.equal(second.accountId, "b");

		second.release();
		const afterRelease = required(
			await pool.acquireLease(runtimeConfig()),
			"lease after release",
		);
		assert.equal(afterRelease.accountId, "b");
		first.release();
		afterRelease.release();
		store.assertExhausted();
	});
	test("updates account health with one normalized issue model", async () => {
		const row = account("a");
		const store = createRuntimeStore([
			runtimeCall("getPoolVersion", [], "1"),
			runtimeCall("listSelectableAccounts", [1000, 100], [row]),
			runtimeCall(
				"writeAccountOutcome",
				[
					"a",
					{
						kind: "failure",
						issue: "rate_limit",
						cooldownUntilMs: 301000,
						recoveryScope: "try_next_account",
						nowMs: 1000,
					},
				],
				undefined,
			),
			runtimeCall(
				"writeAccountOutcome",
				[
					"a",
					{
						kind: "failure",
						recoveryScope: "none",
						nowMs: 2000,
					},
				],
				undefined,
			),
			runtimeCall(
				"writeAccountOutcome",
				["a", { kind: "success", nowMs: 3000 }],
				undefined,
			),
		]);
		const pool = new AccountPoolService(store, {
			nowMs: () => 1000,
			rotateCookie: rejectUnexpectedCookieRotation,
		});
		const lease = required(
			await pool.acquireLease(runtimeConfig()),
			"health update lease",
		);
		await lease.markFailure({ status: 429 }, 1000);
		await lease.markFailure(new Error("invalid model"), 2000);
		await lease.markSuccess(3000);
		assert.deepEqual(store.callsFor("writeAccountOutcome"), [
			[
				"a",
				{
					kind: "failure",
					issue: "rate_limit",
					cooldownUntilMs: 301000,
					recoveryScope: "try_next_account",
					nowMs: 1000,
				},
			],
			[
				"a",
				{
					kind: "failure",
					recoveryScope: "none",
					nowMs: 2000,
				},
			],
			["a", { kind: "success", nowMs: 3000 }],
		]);
		lease.release();
		store.assertExhausted();
	});
	test("applies account outcomes to the cached facade snapshot", async () => {
		const row = account("cooling");
		const outcome: GeminiAccountOutcome = {
			kind: "failure",
			issue: "rate_limit",
			cooldownUntilMs: 301000,
			recoveryScope: "try_next_account",
			nowMs: 1000,
		};
		const store = createRuntimeStore([
			runtimeCall("getPoolVersion", [], "1"),
			runtimeCall("listSelectableAccounts", [1000, 100], [row]),
			runtimeCall("writeAccountOutcome", ["cooling", outcome], undefined),
		]);
		const pool = new AccountPoolService(store, {
			nowMs: () => 1000,
			rotateCookie: rejectUnexpectedCookieRotation,
		});
		const lease = required(
			await pool.acquireLease(runtimeConfig()),
			"cached snapshot lease",
		);
		await lease.markFailure({ status: 429 }, 1000);
		lease.release();

		assert.equal(await pool.acquireLease(runtimeConfig()), null);
		store.assertExhausted();
	});
	test("excludes request-attempted accounts before load balancing", async () => {
		const rows = [account("a"), account("b")];
		const store = createRuntimeStore([
			runtimeCall("getPoolVersion", [], "1"),
			runtimeCall("listSelectableAccounts", [1000, 100], rows),
		]);
		const pool = new AccountPoolService(store, {
			nowMs: () => 1000,
			rotateCookie: rejectUnexpectedCookieRotation,
		});
		const lease = required(
			await pool.acquireLease(runtimeConfig(), {
				excludeAccountIds: new Set(["a"]),
			}),
			"non-excluded lease",
		);
		assert.equal(lease.accountId, "b");
		lease.release();
		store.assertExhausted();
	});
});
