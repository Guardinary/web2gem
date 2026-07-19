import { describe, test } from "vitest";
import { D1GeminiAccountStore } from "../../../../src/gemini/accounts/store-d1";
import { assert } from "../../assertions.js";
import {
	accountSqlRow,
	mutationResult,
	poolVersionExpectation,
	RecordingD1,
} from "./_support/store-fixtures.js";

describe("D1 Gemini account store mutations", () => {
	test("returns an unchanged update without preparing a mutation", async () => {
		const current = accountSqlRow("first", { label: "First" });
		const db = new RecordingD1([
			{
				sql: "SELECT * FROM gemini_accounts WHERE id = ? LIMIT 1",
				binds: ["first"],
				operation: "first",
				result: current,
			},
		]);

		const result = await new D1GeminiAccountStore(db).updateAccount("first", {
			label: "First",
			nowMs: 1100,
		});
		assert.equal(result.changed, false);
		if (!result.item) throw new Error("unchanged account was not returned");
		assert.equal(result.item.label, "First");
		db.assertDrained();
	});

	test("records an enabled-state update and its conditional pool-version batch", async () => {
		const current = accountSqlRow("first", { label: "First" });
		const db = new RecordingD1([
			{
				sql: "SELECT * FROM gemini_accounts WHERE id = ? LIMIT 1",
				binds: ["first"],
				operation: "first",
				result: current,
			},
			{
				sql: /UPDATE gemini_accounts SET label = \?, enabled = \?, updated_at_ms = \? WHERE id = \?/,
				binds: ["First", 0, 1200, "first"],
				operation: "batch",
				result: mutationResult(),
			},
			poolVersionExpectation(1200),
		]);

		const result = await new D1GeminiAccountStore(db).updateAccount("first", {
			enabled: false,
			nowMs: 1200,
		});
		assert.equal(result.changed, true);
		if (!result.item) throw new Error("updated account was not returned");
		assert.equal(result.item.enabled, false);
		db.assertBatches([[1, 2]]);
		db.assertDrained();
	});

	test("binds only changed IDs for bulk enablement and returns requested order", async () => {
		const db = new RecordingD1([
			{
				sql: "SELECT * FROM gemini_accounts WHERE id IN (?, ?, ?)",
				binds: ["first", "second", "third"],
				operation: "all",
				result: {
					results: [
						accountSqlRow("third", { enabled: 0 }),
						accountSqlRow("first", { enabled: 1 }),
						accountSqlRow("second", { enabled: 1 }),
					],
				},
			},
			{
				sql: /UPDATE gemini_accounts SET enabled = \?, updated_at_ms = \? WHERE id IN \(\?, \?\)/,
				binds: [0, 7000, "first", "second"],
				operation: "batch",
				result: mutationResult(2),
			},
			poolVersionExpectation(7000),
		]);

		assert.deepEqual(
			await new D1GeminiAccountStore(db).setAccountsEnabledBulk(
				["first", "second", "third"],
				false,
				7000,
			),
			["first", "second"],
		);
		db.assertBatches([[1, 2]]);
		db.assertDrained();
	});

	test("binds only existing IDs for bulk deletion and maps single-delete changes", async () => {
		const db = new RecordingD1([
			{
				sql: "SELECT * FROM gemini_accounts WHERE id IN (?, ?)",
				binds: ["second", "missing"],
				operation: "all",
				result: { results: [accountSqlRow("second")] },
			},
			{
				sql: "DELETE FROM gemini_accounts WHERE id IN (?)",
				binds: ["second"],
				operation: "batch",
				result: mutationResult(),
			},
			poolVersionExpectation(8000),
			{
				sql: "DELETE FROM gemini_accounts WHERE id = ?",
				binds: ["first"],
				operation: "batch",
				result: mutationResult(1),
			},
			poolVersionExpectation(9000),
			{
				sql: "DELETE FROM gemini_accounts WHERE id = ?",
				binds: ["missing"],
				operation: "batch",
				result: mutationResult(0),
			},
			poolVersionExpectation(9000),
		]);
		const store = new D1GeminiAccountStore(db);

		assert.deepEqual(
			await store.deleteAccountsBulk(["second", "missing"], 8000),
			["second"],
		);
		assert.equal(await store.deleteAccount("first", 9000), true);
		assert.equal(await store.deleteAccount("missing", 9000), false);
		db.assertBatches([
			[1, 2],
			[3, 4],
			[5, 6],
		]);
		db.assertDrained();
	});
});
