// @ts-nocheck
import { describe, test } from "vitest";
import { sha256Hex } from "../../../../src/gemini/accounts/normalize";
import { D1GeminiAccountStore } from "../../../../src/gemini/accounts/store-d1";
import { assert } from "../../assertions.js";
import {
	accountSqlRow,
	durableIssues,
	mutationResult,
	poolVersionExpectation,
	RecordingD1,
} from "./_support/store-fixtures.js";

describe("D1 Gemini account runtime store", () => {
	test("clamps selectable-account limits and maps snapshot rows", async () => {
		const snapshot = {
			id: "account-a",
			enabled: 1,
			cookie_header: "__Secure-1PSID=p; __Secure-1PSIDTS=t",
			cookie_hash: "cookie-hash",
			issue: null,
			cooldown_until_ms: null,
			last_used_at_ms: 900,
			status_checked_at_ms: 800,
			last_refresh_success_at_ms: 700,
		};
		const db = new RecordingD1([
			{
				sql: /SELECT id, enabled, cookie_header, cookie_hash, issue, .* FROM gemini_accounts .*issue NOT IN \(\?, \?, \?\).*LIMIT \?/,
				binds: [1000, ...durableIssues, 200],
				operation: "all",
				result: { results: [snapshot] },
			},
		]);

		assert.deepEqual(
			await new D1GeminiAccountStore(db).listSelectableAccounts(1000, 999),
			[snapshot],
		);
		db.assertDrained();
	});

	test("maps refresh-lock changed-row results and records owner-scoped release", async () => {
		const lockSql =
			/INSERT INTO gemini_account_locks .*ON CONFLICT\(account_id\) DO UPDATE SET .*WHERE gemini_account_locks.expires_at_ms <= \?/;
		const db = new RecordingD1([
			{
				sql: lockSql,
				binds: ["first", "owner", 5000, 1000, 1000],
				operation: "run",
				result: mutationResult(1),
			},
			{
				sql: lockSql,
				binds: ["first", "other", 5000, 2000, 2000],
				operation: "run",
				result: mutationResult(0),
			},
			{
				sql: "DELETE FROM gemini_account_locks WHERE account_id = ? AND lock_owner = ?",
				binds: ["first", "owner"],
				operation: "run",
				result: mutationResult(),
			},
		]);
		const store = new D1GeminiAccountStore(db);

		assert.equal(
			await store.tryAcquireRefreshLock("first", "owner", 5000, 1000),
			true,
		);
		assert.equal(
			await store.tryAcquireRefreshLock("first", "other", 5000, 2000),
			false,
		);
		await store.releaseRefreshLock("first", "owner");
		db.assertDrained();
	});

	test("records refresh timestamps when normalized cookie bytes are unchanged", async () => {
		const cookieHeader = "__Secure-1PSID=p1; __Secure-1PSIDTS=t1";
		const current = accountSqlRow("first", {
			cookie_header: cookieHeader,
			cookie_hash: await sha256Hex(cookieHeader),
		});
		const db = new RecordingD1([
			{
				sql: "SELECT * FROM gemini_accounts WHERE id = ? LIMIT 1",
				binds: ["first"],
				operation: "first",
				result: current,
			},
			{
				sql: /UPDATE gemini_accounts SET last_refresh_at_ms = \?, last_refresh_attempt_at_ms = \?, last_refresh_success_at_ms = \?, updated_at_ms = \? WHERE id = \?/,
				binds: [2000, 2000, 2000, 2000, "first"],
				operation: "batch",
				result: mutationResult(),
			},
			poolVersionExpectation(2000),
		]);

		assert.deepEqual(
			await new D1GeminiAccountStore(db).writeRefreshedCookie("first", {
				cookieHeader,
				refreshedAtMs: 2000,
				nowMs: 2000,
			}),
			{ changed: false },
		);
		db.assertBatches([[1, 2]]);
		db.assertDrained();
	});

	test("binds a changed refreshed cookie after an explicit duplicate lookup", async () => {
		const nextCookie = "__Secure-1PSID=p1; __Secure-1PSIDTS=t1-next";
		const nextHash = await sha256Hex(nextCookie);
		const db = new RecordingD1([
			{
				sql: "SELECT * FROM gemini_accounts WHERE id = ? LIMIT 1",
				binds: ["first"],
				operation: "first",
				result: accountSqlRow("first", { cookie_hash: "old-hash" }),
			},
			{
				sql: "SELECT id FROM gemini_accounts WHERE cookie_hash = ? LIMIT 1",
				binds: [nextHash],
				operation: "first",
				columnName: "id",
				result: null,
			},
			{
				sql: /UPDATE gemini_accounts SET cookie_header = \?, cookie_hash = \?, last_refresh_at_ms = \?, last_refresh_attempt_at_ms = \?, last_refresh_success_at_ms = \?, updated_at_ms = \? WHERE id = \?/,
				binds: [nextCookie, nextHash, 3000, 3000, 3000, 3000, "first"],
				operation: "batch",
				result: mutationResult(),
			},
			poolVersionExpectation(3000),
		]);

		assert.deepEqual(
			await new D1GeminiAccountStore(db).writeRefreshedCookie("first", {
				cookieHeader: nextCookie,
				refreshedAtMs: 3000,
				nowMs: 3000,
			}),
			{ changed: true },
		);
		db.assertBatches([[2, 3]]);
		db.assertDrained();
	});

	test("binds a health-affecting failure and a conditional version increment", async () => {
		const db = new RecordingD1([
			{
				sql: /UPDATE gemini_accounts SET issue = \?, cooldown_until_ms = \?, last_issue_at_ms = \?, last_used_at_ms = \?, updated_at_ms = \? WHERE id = \?/,
				binds: ["transient", 9000, 4000, 4000, 4000, "first"],
				operation: "batch",
				result: mutationResult(),
			},
			poolVersionExpectation(4000),
		]);
		await new D1GeminiAccountStore(db).writeAccountOutcome("first", {
			kind: "failure",
			issue: "transient",
			cooldownUntilMs: 9000,
			nowMs: 4000,
		});
		db.assertBatches([[0, 1]]);
		db.assertDrained();
	});

	test("records use without changing health for a failure without an issue", async () => {
		const db = new RecordingD1([
			{
				sql: /UPDATE gemini_accounts SET last_used_at_ms = \?, updated_at_ms = \? WHERE id = \?/,
				binds: [4500, 4500, "first"],
				operation: "run",
				result: mutationResult(),
			},
		]);
		await new D1GeminiAccountStore(db).writeAccountOutcome("first", {
			kind: "failure",
			nowMs: 4500,
		});
		db.assertDrained();
	});

	test("batches success health clearing before version and last-use recording", async () => {
		const db = new RecordingD1([
			{
				sql: /UPDATE gemini_accounts SET issue = NULL, cooldown_until_ms = NULL, last_issue_at_ms = NULL, updated_at_ms = \? WHERE id = \? AND \(issue IS NOT NULL/,
				binds: [5000, "first"],
				operation: "batch",
				result: mutationResult(),
			},
			{
				sql: /UPDATE gemini_accounts SET last_used_at_ms = \?, updated_at_ms = \? WHERE id = \?/,
				binds: [5000, 5000, "first"],
				operation: "batch",
				result: mutationResult(),
			},
			poolVersionExpectation(5000),
		]);
		await new D1GeminiAccountStore(db).writeAccountOutcome("first", {
			kind: "success",
			nowMs: 5000,
		});
		db.assertBatches([[0, 2, 1]]);
		assert.match(db.batches[0][1].sql, /WHERE changes\(\) > 0/);
		db.assertDrained();
	});
});
