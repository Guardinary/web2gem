import { describe, test } from "vitest";
import { AccountPoolService } from "../../../../src/gemini/accounts/pool";
import { basicRouteForFamily } from "../../../../src/gemini/accounts/routes";
import { assert } from "../../assertions.js";
import { baseConfig } from "../../helpers.js";
import {
	account,
	capabilityRow,
	createRuntimeStore,
	rejectUnexpectedCookieRotation,
	runtimeCall,
} from "./_support/runtime-fixtures.js";

function savedProPriorities(nowMs) {
	return [
		{
			family: "pro",
			provider_model_id: "invalid model id",
			capacity: 9,
			capacity_field: 99,
			model_number: 0,
			priority: 0,
			updated_at_ms: nowMs,
		},
		{
			family: "pro",
			provider_model_id: "9d8ca3786ebdfbea",
			capacity: 1,
			capacity_field: 12,
			model_number: 3,
			priority: 1,
			updated_at_ms: nowMs,
		},
		{
			family: "pro",
			provider_model_id: "e6fa609c3fa255c0",
			capacity: 2,
			capacity_field: 12,
			model_number: 3,
			priority: 2,
			updated_at_ms: nowMs,
		},
	];
}

describe("gemini account runtime", () => {
	test("honors saved exact-route priority during account acquisition", async () => {
		const nowMs = 100000;
		const rows = [
			account("first", { status_checked_at_ms: nowMs }),
			account("second", { status_checked_at_ms: nowMs }),
		];
		const capabilities = [
			capabilityRow("first", "e6fa609c3fa255c0", 4, 12, 3, 0, nowMs),
			capabilityRow("second", "9d8ca3786ebdfbea", 1, 12, 3, 0, nowMs),
		];
		const store = createRuntimeStore([
			runtimeCall("getPoolVersion", [], "1"),
			runtimeCall("listSelectableAccounts", [nowMs, 100], rows),
			runtimeCall(
				"listAccountCapabilities",
				[["first", "second"]],
				capabilities,
			),
			runtimeCall("listModelRoutePriorities", [], savedProPriorities(nowMs)),
		]);
		const pool = new AccountPoolService(store, {
			nowMs: () => nowMs,
			rotateCookie: rejectUnexpectedCookieRotation,
		});
		const resolved = await pool.resolveModel(
			"gemini-3.1-pro",
			"gemini-3.5-flash",
			nowMs - 1000,
		);
		const candidates = await pool.routeCandidatesForModel(
			resolved,
			nowMs - 1000,
		);
		assert.deepEqual(
			candidates.map((route) => route.providerModelId),
			["9d8ca3786ebdfbea", "e6fa609c3fa255c0"],
		);

		const lease = await pool.acquireLease(baseConfig(), {
			routeRequirement: {
				candidates,
				fallbackRoute: basicRouteForFamily("pro"),
			},
			capabilityMode: "prefer",
			capabilityFreshAfterMs: nowMs - 1000,
		});
		assert.equal(lease.accountId, "second");
		assert.equal(lease.selectedRoute.providerModelId, "9d8ca3786ebdfbea");
		lease.release();
		store.assertExhausted();
	});

	test("projects configured and discovered routes in the admin overview", async () => {
		const nowMs = 100000;
		const rows = [
			account("first", { status_checked_at_ms: nowMs }),
			account("second", { status_checked_at_ms: nowMs }),
		];
		const capabilities = [
			capabilityRow("first", "e6fa609c3fa255c0", 4, 12, 3, 0, nowMs),
			capabilityRow("second", "9d8ca3786ebdfbea", 1, 12, 3, 0, nowMs),
		];
		const store = createRuntimeStore([
			runtimeCall("getPoolVersion", [], "1"),
			runtimeCall("listSelectableAccounts", [nowMs, 100], rows),
			runtimeCall(
				"listAccountCapabilities",
				[["first", "second"]],
				capabilities,
			),
			runtimeCall("listModelRoutePriorities", [], savedProPriorities(nowMs)),
		]);
		const pool = new AccountPoolService(store, {
			nowMs: () => nowMs,
			rotateCookie: rejectUnexpectedCookieRotation,
		});

		const overview = await pool.modelRoutingOverview(nowMs - 1000);
		assert.equal(overview.version, "1");
		assert.deepEqual(
			overview.families.map((family) => family.family),
			["pro", "flash", "flash_lite"],
		);
		const proOverview = overview.families[0];
		assert.deepEqual(proOverview.publicNames, [
			"gemini-3.1-pro",
			"gemini-3.1-pro-extended",
		]);
		assert.equal(proOverview.configured, true);
		assert.deepEqual(
			proOverview.routes.map((route) => ({
				providerModelId: route.providerModelId,
				capacity: route.capacity,
				label: route.label,
				available: route.available,
				configured: route.configured,
				accountCount: route.accountCount,
			})),
			[
				{
					providerModelId: "9d8ca3786ebdfbea",
					capacity: 1,
					label: "Basic",
					available: true,
					configured: true,
					accountCount: 1,
				},
				{
					providerModelId: "e6fa609c3fa255c0",
					capacity: 2,
					label: "Advanced",
					available: false,
					configured: true,
					accountCount: 0,
				},
				{
					providerModelId: "e6fa609c3fa255c0",
					capacity: 4,
					label: "Plus",
					available: true,
					configured: false,
					accountCount: 1,
				},
			],
		);
		store.assertExhausted();
	});

	test("appends rediscovered exact routes after saved priorities", async () => {
		const nowMs = 100000;
		const rows = [account("first"), account("second")];
		const capabilities = [
			capabilityRow("second", "9d8ca3786ebdfbea", 1, 12, 3, 0, nowMs),
			capabilityRow("first", "e6fa609c3fa255c0", 2, 12, 3, 0, nowMs),
			capabilityRow("second", "e6fa609c3fa255c0", 4, 12, 3, 1, nowMs),
		];
		const store = createRuntimeStore([
			runtimeCall("getPoolVersion", [], "1"),
			runtimeCall("listSelectableAccounts", [nowMs, 100], rows),
			runtimeCall(
				"listAccountCapabilities",
				[["first", "second"]],
				capabilities,
			),
			runtimeCall("listModelRoutePriorities", [], savedProPriorities(nowMs)),
		]);
		const pool = new AccountPoolService(store, {
			nowMs: () => nowMs,
			rotateCookie: rejectUnexpectedCookieRotation,
		});
		const resolved = await pool.resolveModel(
			"gemini-3.1-pro",
			"gemini-3.5-flash",
			nowMs - 1000,
		);
		assert.deepEqual(
			(await pool.routeCandidatesForModel(resolved, nowMs - 1000)).map(
				(route) => [route.providerModelId, route.capacity],
			),
			[
				["9d8ca3786ebdfbea", 1],
				["e6fa609c3fa255c0", 2],
				["e6fa609c3fa255c0", 4],
			],
		);
		store.assertExhausted();
	});

	test("falls back to the persisted catalog when no selectable snapshot is fresh", async () => {
		const nowMs = 100000;
		const persistedCapabilities = [
			capabilityRow("disabled", "persisted-model", 2, 12, 1, 0, nowMs - 5000),
		];
		const store = createRuntimeStore([
			runtimeCall("getPoolVersion", [], "1"),
			runtimeCall("listSelectableAccounts", [nowMs, 100], []),
			runtimeCall("listAllAccountCapabilities", [12800], persistedCapabilities),
		]);
		const pool = new AccountPoolService(store, {
			nowMs: () => nowMs,
			rotateCookie: rejectUnexpectedCookieRotation,
		});
		assert.deepEqual(
			(await pool.modelCatalog(nowMs - 1000)).entries.map((entry) => entry.id),
			[
				"gemini-3.5-flash",
				"gemini-3.5-flash-extended",
				"persisted-model",
				"persisted-model-extended",
			],
		);
		assert.deepEqual(store.callsFor("listAllAccountCapabilities"), [[12800]]);
		store.assertExhausted();
	});

	test("keeps exact dynamic provider IDs ahead of synthesized extended aliases", async () => {
		const nowMs = 100000;
		const rows = [account("dynamic")];
		const capabilities = [
			capabilityRow("dynamic", "future-model", 3, 13, 7, 0, nowMs),
			capabilityRow("dynamic", "future-model-extended", 3, 13, 8, 1, nowMs),
		];
		const store = createRuntimeStore([
			runtimeCall("getPoolVersion", [], "1"),
			runtimeCall("listSelectableAccounts", [nowMs, 100], rows),
			runtimeCall("listAccountCapabilities", [["dynamic"]], capabilities),
		]);
		const pool = new AccountPoolService(store, {
			nowMs: () => nowMs,
			rotateCookie: rejectUnexpectedCookieRotation,
		});

		const catalog = await pool.modelCatalog(nowMs - 1000);
		assert.deepEqual(
			catalog.entries.map((entry) => entry.id),
			[
				"gemini-3.5-flash",
				"gemini-3.5-flash-extended",
				"future-model",
				"future-model-extended",
				"future-model-extended-extended",
			],
		);
		assert.deepEqual(
			await pool.resolveModel(
				"future-model-extended",
				"gemini-3.5-flash",
				nowMs - 1000,
			),
			{
				name: "future-model-extended",
				family: null,
				extended: false,
				dynamicProviderId: "future-model-extended",
			},
		);
		assert.deepEqual(
			await pool.resolveModel(
				"future-model-extended-extended",
				"gemini-3.5-flash",
				nowMs - 1000,
			),
			{
				name: "future-model-extended-extended",
				family: null,
				extended: true,
				dynamicProviderId: "future-model-extended",
			},
		);
		store.assertExhausted();
	});

	test("reserves known public names for their static model families", async () => {
		const nowMs = 100000;
		const rows = [account("collision"), account("known-pro")];
		const capabilities = [
			capabilityRow("collision", "gemini-3.1-pro", 3, 13, 7, 0, nowMs),
			capabilityRow("known-pro", "9d8ca3786ebdfbea", 1, 12, 3, 0, nowMs),
		];
		const store = createRuntimeStore([
			runtimeCall("getPoolVersion", [], "1"),
			runtimeCall("listSelectableAccounts", [nowMs, 100], rows),
			runtimeCall(
				"listAccountCapabilities",
				[["collision", "known-pro"]],
				capabilities,
			),
		]);
		const pool = new AccountPoolService(store, {
			nowMs: () => nowMs,
			rotateCookie: rejectUnexpectedCookieRotation,
		});

		const catalog = await pool.modelCatalog(nowMs - 1000);
		const proEntry = catalog.entries.find(
			(entry) => entry.id === "gemini-3.1-pro",
		);
		assert.deepEqual(proEntry, {
			id: "gemini-3.1-pro",
			family: "pro",
			providerModelId: "9d8ca3786ebdfbea",
			displayName: "9d8ca3786ebdfbea",
			description: "9d8ca3786ebdfbea description",
			extended: false,
		});

		const resolved = await pool.resolveModel(
			"gemini-3.1-pro",
			"gemini-3.5-flash",
			nowMs - 1000,
		);
		const candidates = await pool.routeCandidatesForModel(
			resolved,
			nowMs - 1000,
		);
		assert.deepEqual(
			candidates.map((route) => route.providerModelId),
			["9d8ca3786ebdfbea"],
		);
		const lease = await pool.acquireLease(baseConfig(), {
			routeRequirement: {
				candidates,
				fallbackRoute: basicRouteForFamily("pro"),
			},
			capabilityMode: "prefer",
			capabilityFreshAfterMs: nowMs - 1000,
		});
		assert.equal(lease.accountId, "known-pro");
		lease.release();
		store.assertExhausted();
	});
});
