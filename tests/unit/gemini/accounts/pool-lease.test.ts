// @ts-nocheck
import { describe, test } from "vitest";
import { AccountPoolService } from "../../../../src/gemini/accounts/pool";
import { assert } from "../../assertions.js";
import { baseConfig } from "../../_support/runtime-config.js";
import {
	account,
	createRuntimeStore,
	rejectUnexpectedCookieRotation,
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
		const lease = await pool.acquireLease(baseConfig());
		assert.equal(lease.accountId, "first");
		assert.equal(lease.config.sapisid, "sapisid-value");
		assert.match(lease.config.cookie, /__Secure-1PSID=p/);
		assert.equal(lease.config.gemini_account.accountId, "first");
		assert.equal(lease.config.gemini_account.cookieHash, "hash-first");
		assert.equal(
			typeof lease.config.gemini_account.observeSetCookie,
			"function",
		);
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

		const first = await pool.acquireLease(baseConfig());
		const second = await pool.acquireLease(baseConfig());
		assert.equal(first.accountId, "a");
		assert.equal(second.accountId, "b");

		second.release();
		const afterRelease = await pool.acquireLease(baseConfig());
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
		const lease = await pool.acquireLease(baseConfig());
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
		const outcome = {
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
		const lease = await pool.acquireLease(baseConfig());
		await lease.markFailure({ status: 429 }, 1000);
		lease.release();

		assert.equal(await pool.acquireLease(baseConfig()), null);
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
		const lease = await pool.acquireLease(baseConfig(), {
			excludeAccountIds: new Set(["a"]),
		});
		assert.equal(lease.accountId, "b");
		lease.release();
		store.assertExhausted();
	});
});
