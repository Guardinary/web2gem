import { describe, test } from "vitest";
import { D1GeminiAccountStore } from "../../../../src/gemini/accounts/store-d1";
import { assert } from "../../assertions.js";
import {
	mutationResult,
	poolVersionExpectation,
	RecordingD1,
} from "./_support/store-fixtures.js";

describe("D1 Gemini account capability store", () => {
	test("batches status, capability replacement, and version in fixed order", async () => {
		const db = new RecordingD1([
			{
				sql: /UPDATE gemini_accounts SET account_status_code = \?, status_checked_at_ms = \?, updated_at_ms = \? WHERE id = \?/,
				binds: [1000, 5600, 5600, "first"],
				operation: "batch",
				result: mutationResult(),
			},
			{
				sql: "DELETE FROM gemini_account_models WHERE account_id = ?",
				binds: ["first"],
				operation: "batch",
				result: mutationResult(),
			},
			{
				sql: /INSERT INTO gemini_account_models \( account_id, model_id, display_name, description, available, capacity, capacity_field, model_number, discovery_order, checked_at_ms \) VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, \?, \?\)/,
				binds: [
					"first",
					"model-pro",
					"Pro",
					"Stored Pro",
					1,
					3,
					13,
					7,
					0,
					5600,
				],
				operation: "batch",
				result: mutationResult(),
			},
			poolVersionExpectation(5600, "unconditional"),
		]);
		await new D1GeminiAccountStore(db).writeAccountProbe(
			"first",
			{
				statusCode: 1000,
				issue: null,
				selectable: true,
				models: [
					{
						modelId: "model-pro",
						displayName: "Pro",
						description: "Stored Pro",
						available: true,
						capacity: 3,
						capacityField: 13,
						modelNumber: 7,
						discoveryOrder: 0,
					},
				],
			},
			5600,
		);
		db.assertBatches([[0, 1, 2, 3]]);
		db.assertDrained();
	});

	test("updates only account status when a probe has no complete model snapshot", async () => {
		const db = new RecordingD1([
			{
				sql: /UPDATE gemini_accounts SET account_status_code = \?, status_checked_at_ms = \?, updated_at_ms = \? WHERE id = \?/,
				binds: [1016, 5650, 5650, "first"],
				operation: "run",
				result: mutationResult(),
			},
		]);
		await new D1GeminiAccountStore(db).writeAccountProbe(
			"first",
			{ statusCode: 1016, issue: "auth", selectable: false, models: [] },
			5650,
		);
		assert.doesNotMatch(db.records[0].sql, /gemini_account_models/);
		db.assertDrained();
	});

	test("deduplicates selected IDs and bounds global capability reads", async () => {
		const capability = {
			account_id: "first",
			model_id: "model-pro",
			display_name: "Pro",
			description: "Stored Pro",
			available: 1,
			capacity: 3,
			capacity_field: 13,
			model_number: 7,
			discovery_order: 0,
			checked_at_ms: 5600,
		};
		const db = new RecordingD1([
			{
				sql: /SELECT account_id, model_id, display_name, description, available, capacity, capacity_field, model_number, discovery_order, checked_at_ms FROM gemini_account_models WHERE account_id IN \(\?, \?\) ORDER BY account_id ASC, discovery_order ASC/,
				binds: ["first", "second"],
				operation: "all",
				result: { results: [capability] },
			},
			{
				sql: /SELECT account_id, model_id, display_name, description, available, capacity, capacity_field, model_number, discovery_order, checked_at_ms FROM gemini_account_models ORDER BY checked_at_ms DESC, account_id ASC, discovery_order ASC LIMIT \?/,
				binds: [12800],
				operation: "all",
				result: { results: [capability] },
			},
		]);
		const store = new D1GeminiAccountStore(db);
		assert.deepEqual(
			await store.listAccountCapabilities(["first", "first", "second"]),
			[capability],
		);
		assert.deepEqual(await store.listAllAccountCapabilities(99999), [
			capability,
		]);
		db.assertDrained();
	});

	test("records exact route-priority replacement order and maps list rows", async () => {
		const routes = [
			{
				providerModelId: "e6fa609c3fa255c0",
				capacity: 4,
				capacityField: 12,
				modelNumber: 3,
			},
			{
				providerModelId: "9d8ca3786ebdfbea",
				capacity: 1,
				capacityField: 12,
				modelNumber: 3,
			},
		];
		const rows = routes.map((route, priority) => ({
			family: "pro",
			provider_model_id: route.providerModelId,
			capacity: route.capacity,
			capacity_field: route.capacityField,
			model_number: route.modelNumber,
			priority,
			updated_at_ms: 5700,
		}));
		const expectations = [
			{
				sql: "DELETE FROM gemini_model_route_priority WHERE family = ?",
				binds: ["pro"],
				operation: "batch",
				result: mutationResult(),
			},
			...routes.map((route, priority) => ({
				sql: /INSERT INTO gemini_model_route_priority \( family, provider_model_id, capacity, capacity_field, model_number, priority, updated_at_ms \) VALUES \(\?, \?, \?, \?, \?, \?, \?\)/,
				binds: [
					"pro",
					route.providerModelId,
					route.capacity,
					route.capacityField,
					route.modelNumber,
					priority,
					5700,
				],
				operation: "batch",
				result: mutationResult(),
			})),
			poolVersionExpectation(5700, "unconditional"),
			{
				sql: /SELECT family, provider_model_id, capacity, capacity_field, model_number, priority, updated_at_ms FROM gemini_model_route_priority ORDER BY family ASC, priority ASC/,
				binds: [],
				operation: "all",
				result: { results: rows },
			},
		];
		const db = new RecordingD1(expectations);
		const store = new D1GeminiAccountStore(db);

		await store.replaceModelRoutePriority("pro", routes, 5700);
		assert.deepEqual(await store.listModelRoutePriorities(), rows);
		db.assertBatches([[0, 1, 2, 3]]);
		db.assertDrained();
	});

	test("rejects duplicate route tuples before D1 preparation and records reset", async () => {
		const route = {
			providerModelId: "e6fa609c3fa255c0",
			capacity: 4,
			capacityField: 12,
			modelNumber: 3,
		};
		const invalidDb = new RecordingD1();
		await assert.rejects(
			() =>
				new D1GeminiAccountStore(invalidDb).replaceModelRoutePriority(
					"pro",
					[route, route],
					5800,
				),
			/duplicate Gemini route tuple/,
		);
		invalidDb.assertDrained();

		const resetDb = new RecordingD1([
			{
				sql: "DELETE FROM gemini_model_route_priority WHERE family = ?",
				binds: ["pro"],
				operation: "batch",
				result: mutationResult(),
			},
			poolVersionExpectation(5900, "unconditional"),
		]);
		await new D1GeminiAccountStore(resetDb).clearModelRoutePriority(
			"pro",
			5900,
		);
		resetDb.assertBatches([[0, 1]]);
		resetDb.assertDrained();
	});
});
