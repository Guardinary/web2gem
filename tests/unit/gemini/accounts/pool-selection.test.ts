import { describe, test } from "vitest";
import { AccountPoolService } from "../../../../src/gemini/accounts/pool";
import { basicRouteForFamily } from "../../../../src/gemini/accounts/routes";
import type { GeminiRouteTuple } from "../../../../src/gemini/accounts/route-types";
import type { GeminiAccountAcquireOptions } from "../../../../src/gemini/accounts/runtime-types";
import { assert } from "../../assertions.js";
import {
	account,
	capabilityRow,
	createRuntimeStore,
	rejectUnexpectedCookieRotation,
	required,
	runtimeConfig,
	runtimeCall,
} from "./_support/runtime-fixtures.js";

describe("gemini account runtime", () => {
	test("prefers fresh known-capable accounts", async () => {
		const nowMs = 100000;
		const route = {
			providerModelId: "model-pro",
			capacity: 4,
			capacityField: 12,
			modelNumber: 1,
		} satisfies GeminiRouteTuple;
		const rows = [
			account("incapable", { status_checked_at_ms: nowMs }),
			account("unknown", { status_checked_at_ms: null }),
			account("capable", { status_checked_at_ms: nowMs }),
		];
		const capabilities = [
			capabilityRow("capable", "model-pro", 4, 12, 1, 0, nowMs, {
				display_name: "Pro",
				description: "Pro route",
			}),
		];
		const store = createRuntimeStore([
			runtimeCall("getPoolVersion", [], "1"),
			runtimeCall("listSelectableAccounts", [nowMs, 100], rows),
			runtimeCall(
				"listAccountCapabilities",
				[["incapable", "unknown", "capable"]],
				capabilities,
			),
		]);
		const pool = new AccountPoolService(store, {
			nowMs: () => nowMs,
			rotateCookie: rejectUnexpectedCookieRotation,
		});

		const lease = required(
			await pool.acquireLease(runtimeConfig(), {
				routeRequirement: {
					candidates: [route],
					fallbackRoute: basicRouteForFamily("pro"),
				},
				capabilityMode: "prefer",
				capabilityFreshAfterMs: nowMs - 1000,
			}),
			"capable lease",
		);
		assert.equal(lease.accountId, "capable");
		assert.deepEqual(lease.modelCapability, {
			modelId: "model-pro",
			displayName: "Pro",
			description: "Pro route",
			available: true,
			capacity: 4,
			capacityField: 12,
			modelNumber: 1,
			discoveryOrder: 0,
			checkedAtMs: nowMs,
		});
		assert.deepEqual(lease.selectedRoute, route);
		lease.release();
		store.assertExhausted();
	});

	test("uses unknown capability fallback in prefer mode but not strict mode", async () => {
		const nowMs = 100000;
		const route = {
			providerModelId: "model-pro",
			capacity: 4,
			capacityField: 12,
			modelNumber: 1,
		} satisfies GeminiRouteTuple;
		const rows = [
			account("known-no", { status_checked_at_ms: nowMs }),
			account("unknown-only", { status_checked_at_ms: null }),
		];
		const capabilities = [
			capabilityRow("known-no", "different-model", 1, 12, 1, 0, nowMs),
		];
		const store = createRuntimeStore([
			runtimeCall("getPoolVersion", [], "1"),
			runtimeCall("listSelectableAccounts", [nowMs, 100], rows),
			runtimeCall(
				"listAccountCapabilities",
				[["known-no", "unknown-only"]],
				capabilities,
			),
		]);
		const pool = new AccountPoolService(store, {
			nowMs: () => nowMs,
			rotateCookie: rejectUnexpectedCookieRotation,
		});
		const options = {
			routeRequirement: {
				candidates: [route],
				fallbackRoute: basicRouteForFamily("pro"),
			},
			capabilityFreshAfterMs: nowMs - 1000,
		};

		const preferred = required(
			await pool.acquireLease(runtimeConfig(), {
				...options,
				capabilityMode: "prefer",
			}),
			"preferred lease",
		);
		assert.equal(preferred.accountId, "unknown-only");
		assert.equal(preferred.modelCapability, null);
		assert.deepEqual(preferred.selectedRoute, basicRouteForFamily("pro"));
		preferred.release();
		assert.equal(
			await pool.acquireLease(runtimeConfig(), {
				...options,
				capabilityMode: "strict",
			}),
			null,
		);
		store.assertExhausted();
	});

	test("binds Basic for a stale known-family capability in prefer mode", async () => {
		const nowMs = 100000;
		const staleRoute = {
			providerModelId: "e6fa609c3fa255c0",
			capacity: 4,
			capacityField: 12,
			modelNumber: 3,
		} satisfies GeminiRouteTuple;
		const rows = [account("stale", { status_checked_at_ms: nowMs })];
		const capabilities = [
			capabilityRow(
				"stale",
				staleRoute.providerModelId,
				staleRoute.capacity,
				staleRoute.capacityField,
				staleRoute.modelNumber,
				0,
				nowMs - 5000,
			),
		];
		const store = createRuntimeStore([
			runtimeCall("getPoolVersion", [], "1"),
			runtimeCall("listSelectableAccounts", [nowMs, 100], rows),
			runtimeCall("listAccountCapabilities", [["stale"]], capabilities),
		]);
		const pool = new AccountPoolService(store, {
			nowMs: () => nowMs,
			rotateCookie: rejectUnexpectedCookieRotation,
		});

		const lease = required(
			await pool.acquireLease(runtimeConfig(), {
				routeRequirement: {
					candidates: [staleRoute],
					fallbackRoute: basicRouteForFamily("pro"),
				},
				capabilityMode: "prefer",
				capabilityFreshAfterMs: nowMs - 1000,
			}),
			"stale fallback lease",
		);
		assert.equal(lease.accountId, "stale");
		assert.equal(lease.modelCapability, null);
		assert.deepEqual(lease.selectedRoute, basicRouteForFamily("pro"));
		lease.release();
		store.assertExhausted();
	});

	test("requires a fresh exact capability for dynamic models in every mode", async () => {
		const nowMs = 100000;
		const staleRoute = {
			providerModelId: "future-model",
			capacity: 3,
			capacityField: 13,
			modelNumber: 7,
		} satisfies GeminiRouteTuple;
		const rows = [account("stale")];
		const capabilities = [
			capabilityRow(
				"stale",
				staleRoute.providerModelId,
				staleRoute.capacity,
				staleRoute.capacityField,
				staleRoute.modelNumber,
				0,
				nowMs - 5000,
			),
		];
		const store = createRuntimeStore([
			runtimeCall("getPoolVersion", [], "1"),
			runtimeCall("listSelectableAccounts", [nowMs, 100], rows),
			runtimeCall("listAccountCapabilities", [["stale"]], capabilities),
		]);
		const pool = new AccountPoolService(store, {
			nowMs: () => nowMs,
			rotateCookie: rejectUnexpectedCookieRotation,
		});

		const capabilityModes: readonly NonNullable<
			GeminiAccountAcquireOptions["capabilityMode"]
		>[] = ["off", "prefer", "strict"];
		for (const capabilityMode of capabilityModes) {
			assert.equal(
				await pool.acquireLease(runtimeConfig(), {
					routeRequirement: {
						candidates: [staleRoute],
						fallbackRoute: null,
					},
					capabilityMode,
					capabilityFreshAfterMs: nowMs - 1000,
				}),
				null,
			);
		}
		store.assertExhausted();
	});

	test("leases a fresh exact dynamic route in every capability mode", async () => {
		const nowMs = 100000;
		const route = {
			providerModelId: "future-model",
			capacity: 3,
			capacityField: 13,
			modelNumber: 7,
		} satisfies GeminiRouteTuple;
		const rows = [account("dynamic")];
		const capabilities = [
			capabilityRow(
				"dynamic",
				route.providerModelId,
				route.capacity,
				route.capacityField,
				route.modelNumber,
				0,
				nowMs,
			),
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

		const capabilityModes: readonly NonNullable<
			GeminiAccountAcquireOptions["capabilityMode"]
		>[] = ["off", "prefer", "strict"];
		for (const capabilityMode of capabilityModes) {
			const lease = required(
				await pool.acquireLease(runtimeConfig(), {
					routeRequirement: { candidates: [route], fallbackRoute: null },
					capabilityMode,
					capabilityFreshAfterMs: nowMs - 1000,
				}),
				"dynamic lease",
			);
			assert.equal(lease.accountId, "dynamic");
			assert.deepEqual(lease.selectedRoute, route);
			assert.equal(
				required(lease.modelCapability, "dynamic model capability").modelId,
				"future-model",
			);
			lease.release();
		}
		store.assertExhausted();
	});

	test("binds off-mode failover to the selected account's own exact route", async () => {
		const nowMs = 100000;
		const plusRoute = {
			providerModelId: "e6fa609c3fa255c0",
			capacity: 4,
			capacityField: 12,
			modelNumber: 3,
		} satisfies GeminiRouteTuple;
		const basicRoute = basicRouteForFamily("pro");
		const rows = [account("b-basic"), account("a-plus")];
		const capabilities = [
			capabilityRow("a-plus", plusRoute.providerModelId, 4, 12, 3, 0, nowMs),
			capabilityRow(
				"b-basic",
				basicRoute.providerModelId,
				basicRoute.capacity,
				basicRoute.capacityField,
				basicRoute.modelNumber,
				0,
				nowMs,
			),
		];
		const store = createRuntimeStore([
			runtimeCall("getPoolVersion", [], "1"),
			runtimeCall("listSelectableAccounts", [nowMs, 100], rows),
			runtimeCall(
				"listAccountCapabilities",
				[["b-basic", "a-plus"]],
				capabilities,
			),
		]);
		const pool = new AccountPoolService(store, {
			nowMs: () => nowMs,
			rotateCookie: rejectUnexpectedCookieRotation,
		});
		const options = {
			routeRequirement: {
				candidates: [plusRoute, basicRoute],
				fallbackRoute: basicRoute,
			},
			capabilityMode: "off",
			capabilityFreshAfterMs: nowMs - 1000,
		} satisfies GeminiAccountAcquireOptions;

		const first = required(
			await pool.acquireLease(runtimeConfig(), options),
			"first off-mode lease",
		);
		assert.equal(first.accountId, "b-basic");
		assert.deepEqual(first.selectedRoute, basicRoute);
		first.release();

		const second = required(
			await pool.acquireLease(runtimeConfig(), {
				...options,
				excludeAccountIds: new Set(["b-basic"]),
			}),
			"second off-mode lease",
		);
		assert.equal(second.accountId, "a-plus");
		assert.deepEqual(second.selectedRoute, plusRoute);
		assert.equal(
			required(second.modelCapability, "second model capability").modelId,
			plusRoute.providerModelId,
		);
		second.release();
		store.assertExhausted();
	});

	test("loads selected-account capabilities independently from the global catalog", async () => {
		const nowMs = 100000;
		const route = basicRouteForFamily("pro");
		const rows = [account("selected")];
		const selectedCapabilities = [
			capabilityRow(
				"selected",
				route.providerModelId,
				route.capacity,
				route.capacityField,
				route.modelNumber,
				0,
				nowMs,
			),
		];
		const globalCapabilities = [
			capabilityRow("not-selected", "future-model", 3, 13, 7, 0, nowMs),
		];
		const store = createRuntimeStore([
			runtimeCall("getPoolVersion", [], "1"),
			runtimeCall("listSelectableAccounts", [nowMs, 100], rows),
			runtimeCall("listAllAccountCapabilities", [12800], globalCapabilities),
			runtimeCall(
				"listAccountCapabilities",
				[["selected"]],
				selectedCapabilities,
			),
		]);
		const pool = new AccountPoolService(store, {
			nowMs: () => nowMs,
			rotateCookie: rejectUnexpectedCookieRotation,
		});

		const lease = required(
			await pool.acquireLease(runtimeConfig(), {
				routeRequirement: { candidates: [route], fallbackRoute: route },
				capabilityMode: "strict",
				capabilityFreshAfterMs: nowMs - 1000,
			}),
			"selected capability lease",
		);
		assert.deepEqual(store.callsFor("listAccountCapabilities"), [
			[["selected"]],
		]);
		assert.deepEqual(store.callsFor("listAllAccountCapabilities"), [[12800]]);
		assert.equal(lease.accountId, "selected");
		assert.deepEqual(lease.selectedRoute, route);
		lease.release();
		store.assertExhausted();
	});
});
