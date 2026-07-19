// @ts-nocheck
import { afterEach, describe, test, vi } from "vitest";
import { handleGeminiModelRoutingAdminRequest } from "../../../../src/http/admin/gemini-model-routing";
import { assert } from "../../assertions.js";
import { baseConfig } from "../../_support/runtime-config.js";
import { RecordingD1 } from "../../gemini/accounts/_support/store-fixtures.js";

const nowMs = 10_000;
const durableIssues = ["auth", "user_action", "location"];
const cfg = baseConfig({
	admin_key: "admin-secret",
	runtime_profile: "worker",
	gemini_account_capability_ttl_sec: 3600,
});
const discoveredCapabilities = [
	{
		account_id: "basic",
		model_id: "9d8ca3786ebdfbea",
		display_name: "Basic Pro",
		description: "Basic Pro route",
		available: 1,
		capacity: 3,
		capacity_field: 13,
		model_number: 3,
		discovery_order: 0,
		checked_at_ms: nowMs,
	},
	{
		account_id: "plus",
		model_id: "e6fa609c3fa255c0",
		display_name: "Plus Pro",
		description: "Plus Pro route",
		available: 1,
		capacity: 4,
		capacity_field: 12,
		model_number: 3,
		discovery_order: 0,
		checked_at_ms: nowMs,
	},
	{
		account_id: "flash",
		model_id: "fbb127bbb056c959",
		display_name: "Flash",
		description: "Flash route",
		available: 1,
		capacity: 2,
		capacity_field: 12,
		model_number: 1,
		discovery_order: 0,
		checked_at_ms: nowMs,
	},
	{
		account_id: "flash-lite",
		model_id: "cf41b0e0dd7d53e5",
		display_name: "Flash Lite",
		description: "Flash Lite route",
		available: 1,
		capacity: 1,
		capacity_field: 12,
		model_number: 6,
		discovery_order: 0,
		checked_at_ms: nowMs,
	},
];
const routesByFamily = {
	pro: [
		{
			providerModelId: "e6fa609c3fa255c0",
			capacity: 4,
			capacityField: 12,
			modelNumber: 3,
		},
		{
			providerModelId: "9d8ca3786ebdfbea",
			capacity: 3,
			capacityField: 13,
			modelNumber: 3,
		},
	],
	flash: [
		{
			providerModelId: "fbb127bbb056c959",
			capacity: 2,
			capacityField: 12,
			modelNumber: 1,
		},
	],
	flash_lite: [
		{
			providerModelId: "cf41b0e0dd7d53e5",
			capacity: 1,
			capacityField: 12,
			modelNumber: 6,
		},
	],
};

afterEach(() => {
	vi.restoreAllMocks();
});

function overviewExpectations(version, priorities = []) {
	return [
		{
			sql: "SELECT value FROM gemini_pool_meta WHERE key = ?",
			binds: ["pool_version"],
			operation: "first",
			columnName: "value",
			result: version,
		},
		{
			sql: /SELECT id, enabled, cookie_header, cookie_hash, issue, .* FROM gemini_accounts .*issue NOT IN \(\?, \?, \?\).*LIMIT \?/,
			binds: [nowMs, ...durableIssues, 200],
			operation: "all",
			result: { results: [] },
		},
		{
			sql: /SELECT account_id, model_id, display_name, description, available, capacity, capacity_field, model_number, discovery_order, checked_at_ms FROM gemini_account_models ORDER BY checked_at_ms DESC, account_id ASC, discovery_order ASC LIMIT \?/,
			binds: [12800],
			operation: "all",
			result: { results: discoveredCapabilities },
		},
		{
			sql: /SELECT family, provider_model_id, capacity, capacity_field, model_number, priority, updated_at_ms FROM gemini_model_route_priority ORDER BY family ASC, priority ASC/,
			binds: [],
			operation: "all",
			result: { results: priorities },
		},
	];
}

function priorityMutationExpectations(family, routes) {
	return [
		{
			sql: "DELETE FROM gemini_model_route_priority WHERE family = ?",
			binds: [family],
			operation: "batch",
			result: { meta: { changes: 1 } },
		},
		...routes.map((route, priority) => ({
			sql: /INSERT INTO gemini_model_route_priority \( family, provider_model_id, capacity, capacity_field, model_number, priority, updated_at_ms \) VALUES \(\?, \?, \?, \?, \?, \?, \?\)/,
			binds: [
				family,
				route.providerModelId,
				route.capacity,
				route.capacityField,
				route.modelNumber,
				priority,
				nowMs,
			],
			operation: "batch",
			result: { meta: { changes: 1 } },
		})),
		{
			sql: /INSERT INTO gemini_pool_meta .*SELECT \?, '1', \? ON CONFLICT\(key\) DO UPDATE SET/,
			binds: ["pool_version", nowMs],
			operation: "batch",
			result: { meta: { changes: 1 } },
		},
	];
}

function priorityRows(family, routes) {
	return routes.map((route, priority) => ({
		family,
		provider_model_id: route.providerModelId,
		capacity: route.capacity,
		capacity_field: route.capacityField,
		model_number: route.modelNumber,
		priority,
		updated_at_ms: nowMs,
	}));
}

function request(db, path, init = {}) {
	const url = new URL(`https://worker.example${path}`);
	return handleGeminiModelRoutingAdminRequest(
		new Request(url, {
			...init,
			headers: {
				Authorization: "Bearer admin-secret",
				...(init.headers || {}),
			},
		}),
		{ GEMINI_DB: db },
		cfg,
		url,
	);
}

function proFamily(body) {
	return body.families.find((family) => family.family === "pro");
}

async function expectRejectedBeforeD1({ path, body, status, code, message }) {
	const db = new RecordingD1();
	const response = await request(db, path, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	assert.equal(response.status, status);
	assert.deepEqual(await response.json(), {
		error: { code, message },
	});
	assert.equal(db.records.length, 0);
	db.assertBatches([]);
	db.assertDrained();
}

describe("Gemini model-routing admin HTTP contract", () => {
	test("rejects unauthorized access before D1 preparation", async () => {
		const db = new RecordingD1();
		const url = new URL("https://worker.example/admin/model-routing");
		const response = await handleGeminiModelRoutingAdminRequest(
			new Request(url),
			{ GEMINI_DB: db },
			cfg,
			url,
		);
		assert.equal(response.status, 401);
		assert.equal((await response.json()).error.code, "invalid_admin_key");
		db.assertBatches([]);
		db.assertDrained();
	});

	test("rejects invalid families and route payloads before D1 preparation", async () => {
		const route = routesByFamily.pro[0];
		for (const invalid of [
			{
				path: "/admin/model-routing/custom",
				body: { routes: [] },
				status: 400,
				code: "invalid_model_family",
				message: "model family must be pro, flash, or flash_lite",
			},
			{
				path: "/admin/model-routing/pro",
				body: { routes: [], extra: true },
				status: 400,
				code: "unknown_model_routing_field",
				message: "unsupported model routing field: extra",
			},
			{
				path: "/admin/model-routing/pro",
				body: { routes: [{ ...route, capacity: 5 }] },
				status: 400,
				code: "invalid_model_route",
				message: "each model route must be one valid exact route tuple",
			},
			{
				path: "/admin/model-routing/pro",
				body: { routes: [route, route] },
				status: 400,
				code: "duplicate_model_route",
				message: "model routing policy contains duplicate routes",
			},
			{
				path: "/admin/model-routing/pro",
				body: { routes: Array.from({ length: 129 }, () => route) },
				status: 413,
				code: "model_route_limit_exceeded",
				message: "model routing policy exceeds the limit of 128 routes",
			},
		])
			await expectRejectedBeforeD1(invalid);
	});

	test("maps discovered exact routes into an unconfigured overview", async () => {
		vi.spyOn(Date, "now").mockReturnValue(nowMs);
		const db = new RecordingD1(overviewExpectations("7"));
		const response = await request(db, "/admin/model-routing");
		assert.equal(response.status, 200);
		const pro = proFamily(await response.json());
		assert.equal(pro.configured, false);
		assert.deepEqual(
			pro.routes.map((route) => [
				route.providerModelId,
				route.capacity,
				route.capacityField,
			]),
			[
				["9d8ca3786ebdfbea", 3, 13],
				["e6fa609c3fa255c0", 4, 12],
			],
		);
		db.assertBatches([]);
		db.assertDrained();
	});

	test("rejects an undiscovered route without preparing a policy mutation", async () => {
		vi.spyOn(Date, "now").mockReturnValue(nowMs);
		const db = new RecordingD1(overviewExpectations("7"));
		const response = await request(db, "/admin/model-routing/pro", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				routes: [
					{
						providerModelId: "not-discovered",
						capacity: 1,
						capacityField: 12,
						modelNumber: 3,
					},
				],
			}),
		});
		assert.equal(response.status, 400);
		assert.equal((await response.json()).error.code, "unknown_model_route");
		assert.equal(
			db.records.some((record) =>
				record.sql.startsWith("DELETE FROM gemini_model_route_priority"),
			),
			false,
		);
		db.assertBatches([]);
		db.assertDrained();
	});

	test("records a policy replacement and returns the configured route order", async () => {
		vi.spyOn(Date, "now").mockReturnValue(nowMs);
		const routes = routesByFamily.pro;
		const db = new RecordingD1([
			...overviewExpectations("7"),
			...priorityMutationExpectations("pro", routes),
			...overviewExpectations("8", priorityRows("pro", routes)),
		]);
		const response = await request(db, "/admin/model-routing/pro", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ routes }),
		});
		assert.equal(response.status, 200);
		const body = await response.json();
		assert.equal(proFamily(body).configured, true);
		assert.deepEqual(
			proFamily(body).routes.map((route) => route.providerModelId),
			["e6fa609c3fa255c0", "9d8ca3786ebdfbea"],
		);
		assert.equal(
			body.families.find((family) => family.family === "flash").configured,
			false,
		);
		db.assertBatches([[4, 5, 6, 7]]);
		db.assertDrained();
	});

	test("keeps flash and flash-lite policy mutations independent from pro", async () => {
		vi.spyOn(Date, "now").mockReturnValue(nowMs);
		for (const family of ["flash", "flash_lite"]) {
			const routes = routesByFamily[family];
			const db = new RecordingD1([
				...overviewExpectations("7"),
				...priorityMutationExpectations(family, routes),
				...overviewExpectations("8", priorityRows(family, routes)),
			]);
			const response = await request(db, `/admin/model-routing/${family}`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ routes }),
			});
			assert.equal(response.status, 200);
			const body = await response.json();
			for (const item of body.families)
				assert.equal(item.configured, item.family === family);
			assert.deepEqual(
				body.families
					.find((item) => item.family === family)
					.routes.map((route) => route.providerModelId),
				routes.map((route) => route.providerModelId),
			);
			db.assertBatches([[4, 5, 6]]);
			db.assertDrained();
		}
	});

	test("records a family reset and returns an unconfigured overview", async () => {
		vi.spyOn(Date, "now").mockReturnValue(nowMs);
		const db = new RecordingD1([
			...priorityMutationExpectations("pro", []),
			...overviewExpectations("9"),
		]);
		const response = await request(db, "/admin/model-routing/pro", {
			method: "DELETE",
		});
		assert.equal(response.status, 200);
		assert.equal(proFamily(await response.json()).configured, false);
		assert.equal(
			db.records.filter((record) =>
				record.sql.startsWith("DELETE FROM gemini_model_route_priority"),
			).length,
			1,
		);
		db.assertBatches([[0, 1]]);
		db.assertDrained();
	});
});
