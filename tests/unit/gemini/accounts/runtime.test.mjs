import { describe, test } from "vitest";
import { AccountPoolService } from "../../../../src/gemini/accounts/pool";
import {
	d1BindingFromEnv,
	GeminiAccountRuntime,
	getGeminiAccountRuntimeFromEnv,
} from "../../../../src/gemini/accounts/runtime";
import { assert } from "../../assertions.js";
import {
	account,
	capabilityRow,
	createRuntimeStore,
	rejectUnexpectedCookieRotation,
	runtimeCall,
} from "./_support/runtime-fixtures.js";
import { baseConfig } from "../../_support/runtime-config.js";

describe("gemini account public runtime facade", () => {
	test("exposes an ordered catalog and dynamic resolution through the runtime facade", async () => {
		const nowMs = 100000;
		const rows = [
			account("first", { status_checked_at_ms: nowMs }),
			account("second", { status_checked_at_ms: nowMs }),
		];
		const capabilities = [
			capabilityRow("first", "e6fa609c3fa255c0", 4, 12, 3, 0, nowMs, {
				display_name: "First Pro",
			}),
			capabilityRow("first", "future-model", 3, 13, 7, 1, nowMs),
			capabilityRow("first", "invalid model id", 3, 13, 7, 2, nowMs),
			capabilityRow("first", "cf41b0e0dd7d53e5", 1, 12, 6, 3, nowMs, {
				available: 0,
			}),
			capabilityRow("second", "9d8ca3786ebdfbea", 1, 12, 3, 0, nowMs, {
				display_name: "Second Pro",
			}),
		];
		const store = createRuntimeStore([
			runtimeCall("getPoolVersion", [], "1"),
			runtimeCall("listSelectableAccounts", [nowMs, 100], rows),
			runtimeCall(
				"listAccountCapabilities",
				[["first", "second"]],
				capabilities,
			),
		]);
		const runtime = new GeminiAccountRuntime(
			new AccountPoolService(store, {
				nowMs: () => nowMs,
				rotateCookie: rejectUnexpectedCookieRotation,
			}),
		);

		assert.deepEqual(
			(await runtime.modelCatalog(nowMs - 1000)).entries.map(
				(entry) => entry.id,
			),
			[
				"gemini-3.5-flash",
				"gemini-3.5-flash-extended",
				"gemini-3.1-pro",
				"gemini-3.1-pro-extended",
				"future-model",
				"future-model-extended",
			],
		);
		assert.equal(
			(
				await runtime.resolveModel(
					"future-model-extended",
					"gemini-3.5-flash",
					nowMs - 1000,
				)
			).dynamicProviderId,
			"future-model",
		);
		store.assertExhausted();
	});

	test("delegates lease and routing operations through the public runtime facade", async () => {
		const cfg = baseConfig();
		const options = {
			excludeAccountIds: new Set(["attempted"]),
			capabilityMode: "strict",
		};
		const model = {
			name: "gemini-3.1-pro",
			family: "pro",
			extended: false,
		};
		const route = {
			providerModelId: "9d8ca3786ebdfbea",
			capacity: 1,
			capacityField: 12,
			modelNumber: 3,
		};
		const lease = { accountId: "selected" };
		const overview = { version: "7", families: [] };
		const calls = [];
		const runtime = new GeminiAccountRuntime({
			async acquireLease(...args) {
				calls.push(["acquireLease", ...args]);
				return lease;
			},
			async modelRoutingOverview(...args) {
				calls.push(["modelRoutingOverview", ...args]);
				return overview;
			},
			async routeCandidatesForModel(...args) {
				calls.push(["routeCandidatesForModel", ...args]);
				return [route];
			},
		});

		assert.equal(await runtime.acquireLease(cfg, options), lease);
		assert.equal(await runtime.modelRoutingOverview(99000), overview);
		assert.deepEqual(await runtime.routeCandidatesForModel(model, 99000), [
			route,
		]);
		assert.deepEqual(calls, [
			["acquireLease", cfg, options],
			["modelRoutingOverview", 99000],
			["routeCandidatesForModel", model, 99000],
		]);
	});

	test("reuses one runtime per D1 binding while isolating distinct bindings", () => {
		const firstDb = {
			prepare() {
				throw new Error("Unexpected D1 access");
			},
		};
		const secondDb = {
			prepare() {
				throw new Error("Unexpected D1 access");
			},
		};
		const first = getGeminiAccountRuntimeFromEnv({ GEMINI_DB: firstDb });
		assert.equal(getGeminiAccountRuntimeFromEnv({ GEMINI_DB: firstDb }), first);
		assert.equal(
			getGeminiAccountRuntimeFromEnv({ GEMINI_DB: secondDb }) === first,
			false,
		);
		assert.equal(d1BindingFromEnv({ GEMINI_DB: firstDb }), firstDb);
		for (const env of [undefined, null, {}, { GEMINI_DB: {} }]) {
			assert.equal(d1BindingFromEnv(env), null);
			assert.equal(getGeminiAccountRuntimeFromEnv(env), null);
		}
	});
});
