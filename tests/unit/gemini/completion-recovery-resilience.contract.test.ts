import { describe, test } from "vitest";
import type { RuntimeConfig } from "../../../src/config";
import type { GeminiAccountLease } from "../../../src/gemini/accounts/lease-types";
import { AccountPoolService } from "../../../src/gemini/accounts/pool";
import type { GeminiRouteTuple } from "../../../src/gemini/accounts/route-types";
import { basicRouteForFamily } from "../../../src/gemini/accounts/routes";
import { GeminiAccountRuntime } from "../../../src/gemini/accounts/runtime";
import type { GeminiAccountAcquireOptions } from "../../../src/gemini/accounts/runtime-types";
import {
	createGeminiCompletionProvider,
	type GeminiCompletionProviderOptions,
} from "../../../src/gemini/completion-provider";
import type { ResolvedModelOk } from "../../../src/models";
import { withConsoleLog } from "../_support/globals.js";
import { assert } from "../assertions.js";
import { baseGeminiClientConfig } from "./_support/client-fixtures.js";
import {
	accountConfig,
	failFastClient,
	failFastUploads,
	proModel,
	requireAccount,
	requireItem,
} from "./_support/completion-provider-fixtures.js";
import { createRuntimeStore } from "./accounts/_support/runtime-fixtures.js";

type LifecycleEvent = [string, ...unknown[]];
type LeaseOverrides = {
	refreshForRetry?: (reason?: string) => unknown;
	markFailure?: (error: unknown) => unknown;
};

function proRoutes(): [GeminiRouteTuple, GeminiRouteTuple] {
	return [
		basicRouteForFamily("pro"),
		{
			providerModelId: "e6fa609c3fa255c0",
			capacity: 4,
			capacityField: 12,
			modelNumber: 3,
		},
	];
}

function failoverLease(
	accountId: string,
	selectedRoute: GeminiRouteTuple,
	events: LifecycleEvent[],
	overrides: LeaseOverrides = {},
): GeminiAccountLease {
	const config = accountConfig(accountId);
	let released = false;
	const lease: GeminiAccountLease = {
		accountId,
		selectedRoute,
		modelCapability: null,
		config,
		async refreshForRetry() {
			throw new Error("unexpected lease.refreshForRetry call");
		},
		async markSuccess() {
			events.push(["markSuccess", accountId]);
		},
		async markFailure(error: unknown) {
			events.push(["markFailure", accountId, error]);
		},
		async flushObservedCookies() {
			events.push(["flushObservedCookies", accountId]);
		},
		async maintainSessionIfStale() {
			throw new Error("unexpected lease.maintainSessionIfStale call");
		},
		release() {
			if (released) throw new Error(`lease ${accountId} released twice`);
			released = true;
			events.push(["release", accountId]);
		},
	};
	if (overrides.refreshForRetry) {
		Reflect.set(lease, "refreshForRetry", overrides.refreshForRetry);
	}
	if (overrides.markFailure) {
		Reflect.set(lease, "markFailure", overrides.markFailure);
	}
	return lease;
}

type AcquisitionRecord = {
	base: RuntimeConfig;
	excludeAccountIds: string[];
	routeRequirement: GeminiAccountAcquireOptions["routeRequirement"];
	capabilityMode: GeminiAccountAcquireOptions["capabilityMode"];
	capabilityFreshAfterMs: GeminiAccountAcquireOptions["capabilityFreshAfterMs"];
};

function scriptedRuntime(
	leases: GeminiAccountLease[],
	routes: GeminiRouteTuple[],
): GeminiAccountRuntime & {
	records: {
		route: [ResolvedModelOk, number][];
		acquire: AcquisitionRecord[];
	};
} {
	const pending = [...leases];
	const records: {
		route: [ResolvedModelOk, number][];
		acquire: AcquisitionRecord[];
	} = { route: [], acquire: [] };
	const runtime = new GeminiAccountRuntime(
		new AccountPoolService(createRuntimeStore([]), {
			async rotateCookie() {
				throw new Error("unexpected cookie rotation");
			},
		}),
	);
	runtime.routeCandidatesForModel = async (
		model: ResolvedModelOk,
		freshAfterMs: number,
	) => {
		records.route.push([model, freshAfterMs]);
		return routes;
	};
	runtime.acquireLease = async (
		base: RuntimeConfig,
		options: GeminiAccountAcquireOptions = {},
	) => {
		records.acquire.push({
			base,
			excludeAccountIds: [...(options.excludeAccountIds || [])],
			routeRequirement: options.routeRequirement,
			capabilityMode: options.capabilityMode,
			capabilityFreshAfterMs: options.capabilityFreshAfterMs,
		});
		if (!pending.length)
			throw new Error("unexpected extra account acquisition");
		return pending.shift() ?? null;
	};
	return Object.assign(runtime, { records });
}

function createTestProvider(
	cfg: RuntimeConfig,
	options: GeminiCompletionProviderOptions,
) {
	return createGeminiCompletionProvider(cfg, {
		...options,
		client: failFastClient(options.client),
		uploads: failFastUploads(),
	});
}

function rateLimitError(accountId: string) {
	return Object.assign(new Error(`rate limited ${accountId}`), { status: 429 });
}

function authError() {
	return Object.assign(new Error("invalid account cookie"), {
		code: "invalid_gemini_cookie",
		status: 401,
	});
}

describe("Gemini account recovery resilience", () => {
	test("retries one auth failure on the refreshed account", async () => {
		const routes = proRoutes();
		const events: LifecycleEvent[] = [];
		let refreshCalls = 0;
		const lease = failoverLease("auth", routes[0], events, {
			async refreshForRetry(issue) {
				refreshCalls += 1;
				events.push(["refreshForRetry", "auth", issue]);
				return { changed: true, reason: "rotation_updated" };
			},
		});
		const runtime = scriptedRuntime([lease], routes);
		let clientCalls = 0;
		const provider = createTestProvider(baseGeminiClientConfig(), {
			accountRuntime: runtime,
			client: {
				async generate() {
					clientCalls += 1;
					if (clientCalls === 1) throw authError();
					return "refreshed";
				},
			},
		});
		assert.equal(
			await provider.generateText({
				prompt: "prompt",
				rm: proModel(),
				fileRefs: null,
			}),
			"refreshed",
		);
		assert.equal(clientCalls, 2);
		assert.equal(refreshCalls, 1);
		assert.equal(runtime.records.acquire.length, 1);
	});
	test("refreshes one account at most once before switching", async () => {
		const routes = proRoutes();
		const events: LifecycleEvent[] = [];
		let refreshCalls = 0;
		const first = failoverLease("a", routes[0], events, {
			async refreshForRetry() {
				refreshCalls += 1;
				return { changed: true, reason: "rotation_updated" };
			},
		});
		const second = failoverLease("b", routes[1], events);
		const runtime = scriptedRuntime([first, second], routes);
		const calls: string[] = [];
		const provider = createTestProvider(baseGeminiClientConfig(), {
			accountRuntime: runtime,
			client: {
				async generate(activeCfg) {
					const accountId = requireAccount(activeCfg).accountId;
					calls.push(accountId);
					if (accountId === "a") throw authError();
					return "second account";
				},
			},
		});
		assert.equal(
			await provider.generateText({
				prompt: "prompt",
				rm: proModel(),
				fileRefs: null,
			}),
			"second account",
		);
		assert.deepEqual(calls, ["a", "a", "b"]);
		assert.equal(refreshCalls, 1);
		assert.equal(runtime.records.acquire.length, 2);
	});
	test("continues to an alternate account when auth refresh rejects", async () => {
		const cfg = baseGeminiClientConfig({ log_requests: true });
		const routes = proRoutes();
		const events: LifecycleEvent[] = [];
		const first = failoverLease("a", routes[0], events, {
			async refreshForRetry() {
				throw new Error("refresh secret");
			},
		});
		const runtime = scriptedRuntime(
			[first, failoverLease("b", routes[1], events)],
			routes,
		);
		const provider = createTestProvider(cfg, {
			accountRuntime: runtime,
			client: {
				async generate(activeCfg) {
					if (requireAccount(activeCfg).accountId === "a") throw authError();
					return "alternate";
				},
			},
		});
		const logs: string[] = [];
		await withConsoleLog(
			(line: unknown) => logs.push(String(line)),
			async () => {
				assert.equal(
					await provider.generateText({
						prompt: "prompt",
						rm: proModel(),
						fileRefs: null,
					}),
					"alternate",
				);
			},
		);
		assert.equal(runtime.records.acquire.length, 2);
		assert.match(
			logs.join("\n"),
			/account credential refresh failed: type=Error/,
		);
		assert.doesNotMatch(logs.join("\n"), /refresh secret/);
	});
	test("continues failover when intermediate failure persistence rejects", async () => {
		const cfg = baseGeminiClientConfig({ log_requests: true });
		const routes = proRoutes();
		const events: LifecycleEvent[] = [];
		const firstError = rateLimitError("a");
		const first = failoverLease("a", routes[0], events, {
			async markFailure(error) {
				events.push(["markFailure", "a", error]);
				throw new Error("outcome secret");
			},
		});
		const runtime = scriptedRuntime(
			[first, failoverLease("b", routes[1], events)],
			routes,
		);
		const provider = createTestProvider(cfg, {
			accountRuntime: runtime,
			client: {
				async generate(activeCfg) {
					if (requireAccount(activeCfg).accountId === "a") throw firstError;
					return "recovered";
				},
			},
		});
		const logs: string[] = [];
		await withConsoleLog(
			(line: unknown) => logs.push(String(line)),
			async () => {
				assert.equal(
					await provider.generateText({
						prompt: "prompt",
						rm: proModel(),
						fileRefs: null,
					}),
					"recovered",
				);
			},
		);
		assert.equal(requireItem(events)[2], firstError);
		assert.equal(runtime.records.acquire.length, 2);
		assert.match(
			logs.join("\n"),
			/account outcome persistence failed: type=Error/,
		);
		assert.doesNotMatch(logs.join("\n"), /outcome secret/);
	});
	test("continues failover when markFailure throws synchronously", async () => {
		const cfg = baseGeminiClientConfig({ log_requests: true });
		const routes = proRoutes();
		const events: LifecycleEvent[] = [];
		const firstError = rateLimitError("a");
		const first = failoverLease("a", routes[0], events, {
			markFailure(error) {
				events.push(["markFailure", "a", error]);
				throw new Error("synchronous outcome secret");
			},
		});
		const runtime = scriptedRuntime(
			[first, failoverLease("b", routes[1], events)],
			routes,
		);
		const provider = createTestProvider(cfg, {
			accountRuntime: runtime,
			client: {
				async generate(activeCfg) {
					if (requireAccount(activeCfg).accountId === "a") throw firstError;
					return "recovered";
				},
			},
		});
		const logs: string[] = [];
		await withConsoleLog(
			(line: unknown) => logs.push(String(line)),
			async () => {
				assert.equal(
					await provider.generateText({
						prompt: "prompt",
						rm: proModel(),
						fileRefs: null,
					}),
					"recovered",
				);
			},
		);
		assert.equal(requireItem(events)[2], firstError);
		assert.equal(runtime.records.acquire.length, 2);
		assert.match(
			logs.join("\n"),
			/account outcome persistence failed: type=Error/,
		);
		assert.doesNotMatch(logs.join("\n"), /synchronous outcome secret/);
	});
});
