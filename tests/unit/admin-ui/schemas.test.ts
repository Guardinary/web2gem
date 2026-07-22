import { describe, test } from "vitest";
import {
	parseModelRoutingOverview,
	parseMutation,
	parseOverview,
} from "../../../src/admin-ui/schemas";
import { assert } from "../assertions.js";
import {
	emptyStats,
	requiredValue,
	uiAccount,
	uiModelRouting,
} from "./_support/fixtures.js";

describe("admin UI response schemas", () => {
	test("accepts only slim account DTOs", () => {
		const account = uiAccount();
		const overview = {
			items: [account],
			nextCursor: null,
			limit: 200,
			stats: emptyStats({ total: 1, available: 1 }),
		};
		assert.deepEqual(parseOverview(overview).items, [account]);
		assert.throws(
			() =>
				parseOverview({
					...overview,
					items: [{ ...account, cookie_hash: "secret" }],
				}),
			/admin account overview response is invalid/,
		);
		assert.throws(
			() =>
				parseOverview({
					...overview,
					items: [
						{
							id: "legacy",
							row_id: "legacy-row",
							status: "active",
							enabled: 1,
						},
					],
				}),
			/admin account overview response is invalid/,
		);
	});

	test("parses strict account overviews", () => {
		const account = uiAccount();
		assert.deepEqual(
			parseOverview({
				items: [account],
				nextCursor: null,
				limit: 200,
				stats: emptyStats({ total: 1, available: 1 }),
			}),
			{
				items: [account],
				nextCursor: null,
				limit: 200,
				stats: emptyStats({ total: 1, available: 1 }),
			},
		);
	});

	test("parses compact mutation results and rejects legacy summaries", () => {
		assert.throws(
			() => parseMutation({ added: 1, skipped: 0 }),
			/admin mutation response is invalid/,
		);
		assert.deepEqual(
			parseMutation({
				processed: 2,
				changed: 1,
				unchanged: 1,
				failed: 0,
			}),
			{ processed: 2, changed: 1, unchanged: 1, failed: 0 },
		);
	});

	test("accepts exact model-routing DTOs and rejects secret fields", () => {
		const overview = uiModelRouting();
		assert.deepEqual(parseModelRoutingOverview(overview), overview);
		assert.throws(
			() =>
				parseModelRoutingOverview({
					...overview,
					families: [
						{
							...requiredValue(overview.families[0]),
							routes: [
								{
									...requiredValue(
										requiredValue(overview.families[0]).routes[0],
									),
									cookie_hash: "secret",
								},
							],
						},
					],
				}),
			/admin model routing response is invalid/,
		);
	});

	test("rejects non-decimal model-routing versions", () => {
		const overview = uiModelRouting();
		assert.throws(
			() =>
				parseModelRoutingOverview({
					...overview,
					version: "not-a-pool-version",
				}),
			/admin model routing response is invalid/,
		);
	});
});
