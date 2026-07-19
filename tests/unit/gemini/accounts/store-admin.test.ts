import { describe, test } from "vitest";
import { D1GeminiAccountStore } from "../../../../src/gemini/accounts/store-d1";
import { assert } from "../../assertions.js";
import {
	adminSqlRow,
	durableIssues,
	RecordingD1,
} from "./_support/store-fixtures.js";

describe("D1 Gemini account store admin projections", () => {
	test("maps a filtered admin overview without selecting credential columns", async () => {
		const row = adminSqlRow("account-a", {
			label: "Alpha",
			issue: "rate_limit",
			cooldown_until_ms: 5000,
		});
		const stats = {
			total: 1,
			available: 0,
			cooling: 1,
			attention: 0,
			disabled: 0,
		};
		const db = new RecordingD1([
			{
				sql: /SELECT id, label, enabled, issue, cooldown_until_ms, .* FROM gemini_accounts WHERE enabled = 1 AND cooldown_until_ms > \? ORDER BY id ASC LIMIT \?/,
				binds: [1000, 11],
				operation: "batch",
				result: { results: [row] },
			},
			{
				sql: /SELECT COUNT\(\*\) AS total, .* FROM gemini_accounts/,
				binds: [1000, ...durableIssues, 1000, 1000, ...durableIssues],
				operation: "batch",
				result: { results: [stats] },
			},
		]);

		const overview = await new D1GeminiAccountStore(db).getAdminOverview(
			{ limit: 10, state: "cooling" },
			1000,
		);
		assert.deepEqual(overview.stats, stats);
		const item = overview.items[0];
		if (!item) throw new Error("admin overview did not return an item");
		assert.equal(item.state, "cooling");
		assert.equal(item.issue, "rate_limit");
		assert.equal(Object.keys(item).length, 13);
		const pageRecord = db.records[0];
		if (!pageRecord) throw new Error("admin page statement was not recorded");
		assert.doesNotMatch(
			pageRecord.sql,
			/cookie_header|cookie_hash|identity_hash/,
		);
		assert.doesNotMatch(JSON.stringify(overview), /secret|cookie_hash/);
		db.assertBatches([[0, 1]]);
		db.assertDrained();
	});
});
