import { describe, test } from "vitest";
import type { CompletionProvider } from "../../../src/completion/ports";
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
import { assert } from "../assertions.js";
import { baseGeminiClientConfig } from "./_support/client-fixtures.js";
import {
	accountConfig,
	captureError,
	errorRecord,
	failFastClient,
	failFastUploads,
	flashModel,
	proModel,
	requireAccount,
	requireItem,
} from "./_support/completion-provider-fixtures.js";
import { createRuntimeStore } from "./accounts/_support/runtime-fixtures.js";

type LifecycleEvent = [string, ...unknown[]];
type TestProvider = CompletionProvider &
	Required<Pick<CompletionProvider, "generateRich">>;

function requireKey<T>(record: Readonly<Record<string, T>>, key: string): T {
	const value = record[key];
	if (value === undefined) throw new Error(`expected record key ${key}`);
	return value;
}

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
	selectedRoute: GeminiRouteTuple | null,
	events: LifecycleEvent[],
): GeminiAccountLease {
	const config = accountConfig(accountId);
	let released = false;
	return {
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
): TestProvider {
	const provider = createGeminiCompletionProvider(cfg, {
		...options,
		client: failFastClient(options.client),
		uploads: failFastUploads(),
	});
	const { generateRich } = provider;
	if (!generateRich) throw new Error("expected rich generation support");
	return Object.assign(provider, { generateRich });
}

function rateLimitError(accountId: string) {
	return Object.assign(new Error(`rate limited ${accountId}`), { status: 429 });
}

function semanticError(code: number) {
	return Object.assign(new Error(`Gemini semantic ${code}`), {
		code: "gemini_semantic_error",
		geminiSource: "stream_generate",
		geminiCode: String(code),
	});
}

function requestScopedError(message = "model invalid for this request") {
	return Object.assign(new Error(message), { code: "invalid_model" });
}

function modelHeaderProviderId(
	headers: Record<string, string> | null | undefined,
): string {
	if (!headers) throw new Error("expected Gemini model headers");
	const encoded = headers["x-goog-ext-525001261-jspb"];
	if (!encoded) throw new Error("expected Gemini model header");
	const payload: unknown = JSON.parse(encoded);
	if (!Array.isArray(payload) || typeof payload[4] !== "string") {
		throw new Error("expected provider model id in Gemini model header");
	}
	return payload[4];
}

describe("Gemini account failover", () => {
	test("treats a missing dynamic selected route as terminal", async () => {
		const cfg = baseGeminiClientConfig();
		const events: LifecycleEvent[] = [];
		const dynamicRoute: GeminiRouteTuple = {
			providerModelId: "abcdef0123456789",
			capacity: 3,
			capacityField: 13,
			modelNumber: 7,
		};
		const runtime = scriptedRuntime(
			[failoverLease("dynamic-missing", null, events)],
			[dynamicRoute],
		);
		const provider = createTestProvider(cfg, {
			accountRuntime: runtime,
			client: {},
		});
		const error = errorRecord(
			await captureError(() =>
				provider.generateText({
					prompt: "dynamic",
					rm: {
						name: "future-model",
						family: null,
						extended: false,
						dynamicProviderId: "abcdef0123456789",
					},
					fileRefs: null,
				}),
			),
		);
		assert.equal(error.code, "gemini_route_not_selected");
		assert.equal(error.status, 502);
		assert.match(error.message, /route was not selected/);
		assert.equal(runtime.records.acquire.length, 1);
		assert.deepEqual(
			events.map((event) => event[0]),
			["markFailure", "release"],
		);
		assert.equal(requireItem(events)[2], error);
	});
	test("fails over text to an excluded account and recomputes its selected route", async () => {
		const cfg = baseGeminiClientConfig();
		const routes = proRoutes();
		const events: LifecycleEvent[] = [];
		const runtime = scriptedRuntime(
			[
				failoverLease("a", routes[0], events),
				failoverLease("b", routes[1], events),
			],
			routes,
		);
		const firstError = rateLimitError("a");
		const calls: unknown[][] = [];
		const provider = createTestProvider(cfg, {
			accountRuntime: runtime,
			client: {
				async generate(
					activeCfg,
					_prompt,
					modelNumber,
					_extended,
					_refs,
					headers,
				) {
					const accountId = requireAccount(activeCfg).accountId;
					calls.push([accountId, modelNumber, modelHeaderProviderId(headers)]);
					if (accountId === "a") throw firstError;
					return "alternate result";
				},
			},
		});
		assert.equal(
			await provider.generateText({
				prompt: "prompt",
				rm: proModel(),
				fileRefs: null,
			}),
			"alternate result",
		);
		assert.deepEqual(calls, [
			["a", routes[0].modelNumber, routes[0].providerModelId],
			["b", routes[1].modelNumber, routes[1].providerModelId],
		]);
		assert.deepEqual(
			runtime.records.acquire.map((item) => item.excludeAccountIds),
			[[], ["a"]],
		);
		assert.equal(requireItem(events)[2], firstError);
		assert.deepEqual(
			events.map((event) => event.slice(0, 2)),
			[
				["markFailure", "a"],
				["release", "a"],
				["markSuccess", "b"],
				["release", "b"],
				["flushObservedCookies", "b"],
			],
		);
	});
	test("rejects a distinct lease that reuses an attempted account ID", async () => {
		const routes = proRoutes();
		const events: LifecycleEvent[] = [];
		const runtime = scriptedRuntime(
			[
				failoverLease("duplicate", routes[0], events),
				failoverLease("duplicate", routes[0], events),
			],
			routes,
		);
		const firstError = rateLimitError("duplicate");
		let clientCalls = 0;
		const provider = createTestProvider(baseGeminiClientConfig(), {
			accountRuntime: runtime,
			client: {
				async generate() {
					clientCalls += 1;
					throw firstError;
				},
			},
		});
		const error = await captureError(() =>
			provider.generateText({
				prompt: "prompt",
				rm: proModel(),
				fileRefs: null,
			}),
		);
		assert.equal(error, firstError);
		assert.equal(clientCalls, 1);
		assert.equal(runtime.records.acquire.length, 2);
		assert.deepEqual(
			requireItem(runtime.records.acquire, 1).excludeAccountIds,
			["duplicate"],
		);
		assert.equal(events.filter((event) => event[0] === "release").length, 2);
	});
	test("stops at the configured two-account budget", async () => {
		const cfg = baseGeminiClientConfig({ gemini_account_max_attempts: 2 });
		const routes = proRoutes();
		const events: LifecycleEvent[] = [];
		const runtime = scriptedRuntime(
			[
				failoverLease("a", routes[0], events),
				failoverLease("b", routes[1], events),
				failoverLease("c", routes[0], events),
			],
			routes,
		);
		const errors: Record<string, ReturnType<typeof rateLimitError>> = {
			a: rateLimitError("a"),
			b: rateLimitError("b"),
		};
		const provider = createTestProvider(cfg, {
			accountRuntime: runtime,
			client: {
				async generate(activeCfg) {
					const accountId = requireAccount(activeCfg).accountId;
					throw requireKey(errors, accountId);
				},
			},
		});
		const error = await captureError(() =>
			provider.generateText({
				prompt: "prompt",
				rm: proModel(),
				fileRefs: null,
			}),
		);
		assert.equal(error, errors.b);
		assert.equal(runtime.records.acquire.length, 2);
		assert.equal(
			events.some((event) => event[1] === "c"),
			false,
		);
	});
	test("returns the third account error at a three-account budget", async () => {
		const cfg = baseGeminiClientConfig({ gemini_account_max_attempts: 3 });
		const routes = proRoutes();
		const events: LifecycleEvent[] = [];
		const accounts = ["a", "b", "c"];
		const errors: Record<
			string,
			ReturnType<typeof rateLimitError>
		> = Object.fromEntries(
			accounts.map((accountId) => [accountId, rateLimitError(accountId)]),
		);
		const runtime = scriptedRuntime(
			accounts.map((accountId, index) =>
				failoverLease(
					accountId,
					requireItem(routes, index % routes.length),
					events,
				),
			),
			routes,
		);
		const provider = createTestProvider(cfg, {
			accountRuntime: runtime,
			client: {
				async generate(activeCfg) {
					const accountId = requireAccount(activeCfg).accountId;
					throw requireKey(errors, accountId);
				},
			},
		});
		const error = await captureError(() =>
			provider.generateText({
				prompt: "prompt",
				rm: proModel(),
				fileRefs: null,
			}),
		);
		assert.equal(error, errors.c);
		assert.equal(runtime.records.acquire.length, 3);
		assert.deepEqual(
			runtime.records.acquire.map((item) => item.excludeAccountIds),
			[[], ["a"], ["a", "b"]],
		);
	});
	test("switches accounts for semantic code 1050", async () => {
		const routes = proRoutes();
		const events: LifecycleEvent[] = [];
		const runtime = scriptedRuntime(
			[
				failoverLease("a", routes[0], events),
				failoverLease("b", routes[1], events),
			],
			routes,
		);
		const error1050 = semanticError(1050);
		const provider = createTestProvider(baseGeminiClientConfig(), {
			accountRuntime: runtime,
			client: {
				async generate(activeCfg) {
					if (requireAccount(activeCfg).accountId === "a") throw error1050;
					return "switched";
				},
			},
		});
		assert.equal(
			await provider.generateText({
				prompt: "prompt",
				rm: proModel(),
				fileRefs: null,
			}),
			"switched",
		);
		assert.equal(runtime.records.acquire.length, 2);
		assert.equal(requireItem(events)[2], error1050);
	});
	test("keeps semantic code 1052 on the selected account", async () => {
		const routes = proRoutes();
		const events: LifecycleEvent[] = [];
		const error1052 = semanticError(1052);
		const runtime = scriptedRuntime(
			[
				failoverLease("a", routes[0], events),
				failoverLease("b", routes[1], events),
			],
			routes,
		);
		const provider = createTestProvider(baseGeminiClientConfig(), {
			accountRuntime: runtime,
			client: {
				async generate() {
					throw error1052;
				},
			},
		});
		const error = await captureError(() =>
			provider.generateText({
				prompt: "prompt",
				rm: proModel(),
				fileRefs: null,
			}),
		);
		assert.equal(error, error1052);
		assert.equal(runtime.records.acquire.length, 1);
		assert.equal(
			events.some((event) => event[1] === "b"),
			false,
		);
	});
	test("keeps request-scoped model errors on one account", async () => {
		const routes = proRoutes();
		const events: LifecycleEvent[] = [];
		const modelError = requestScopedError();
		const runtime = scriptedRuntime(
			[
				failoverLease("a", routes[0], events),
				failoverLease("b", routes[1], events),
			],
			routes,
		);
		const provider = createTestProvider(baseGeminiClientConfig(), {
			accountRuntime: runtime,
			client: {
				async generate() {
					throw modelError;
				},
			},
		});
		const error = await captureError(() =>
			provider.generateText({
				prompt: "prompt",
				rm: proModel(),
				fileRefs: null,
			}),
		);
		assert.equal(error, modelError);
		assert.equal(runtime.records.acquire.length, 1);
		assert.equal(requireItem(events)[2], modelError);
	});
	test("keeps aborts on one account without marking failure", async () => {
		const routes = proRoutes();
		const events: LifecycleEvent[] = [];
		const abort = Object.assign(new Error("cancelled"), { name: "AbortError" });
		const runtime = scriptedRuntime(
			[
				failoverLease("a", routes[0], events),
				failoverLease("b", routes[1], events),
			],
			routes,
		);
		const provider = createTestProvider(baseGeminiClientConfig(), {
			accountRuntime: runtime,
			client: {
				async generate() {
					throw abort;
				},
			},
		});
		const error = await captureError(() =>
			provider.generateText({
				prompt: "prompt",
				rm: proModel(),
				fileRefs: null,
			}),
		);
		assert.equal(error, abort);
		assert.equal(runtime.records.acquire.length, 1);
		assert.deepEqual(events, [["release", "a"]]);
	});
	test("fails over rich generation and recomputes the selected route", async () => {
		const routes = proRoutes();
		const events: LifecycleEvent[] = [];
		const runtime = scriptedRuntime(
			[
				failoverLease("a", routes[0], events),
				failoverLease("b", routes[1], events),
			],
			routes,
		);
		const calls: unknown[][] = [];
		const provider = createTestProvider(baseGeminiClientConfig(), {
			accountRuntime: runtime,
			client: {
				async generateRich(
					activeCfg,
					_prompt,
					modelNumber,
					_extended,
					_refs,
					headers,
				) {
					const accountId = requireAccount(activeCfg).accountId;
					calls.push([accountId, modelNumber, modelHeaderProviderId(headers)]);
					if (accountId === "a") throw rateLimitError("a");
					return { text: "rich result", images: [] };
				},
			},
		});
		assert.deepEqual(
			await provider.generateRich({
				prompt: "draw",
				rm: proModel(),
				fileRefs: null,
			}),
			{ text: "rich result", images: [] },
		);
		assert.deepEqual(calls, [
			["a", routes[0].modelNumber, routes[0].providerModelId],
			["b", routes[1].modelNumber, routes[1].providerModelId],
		]);
	});
	test("supports the anonymous to A to B text chain", async () => {
		const routes: [GeminiRouteTuple] = [basicRouteForFamily("flash")];
		const events: LifecycleEvent[] = [];
		const runtime = scriptedRuntime(
			[
				failoverLease("a", routes[0], events),
				failoverLease("b", routes[0], events),
			],
			routes,
		);
		const calls: Array<string | null> = [];
		const provider = createTestProvider(baseGeminiClientConfig(), {
			accountRuntime: runtime,
			client: {
				async generate(activeCfg) {
					const accountId = activeCfg.gemini_account?.accountId || null;
					calls.push(accountId);
					if (accountId === null) throw new Error("anonymous failed");
					if (accountId === "a") throw rateLimitError("a");
					return "chain result";
				},
			},
		});
		assert.equal(
			await provider.generateText({
				prompt: "prompt",
				rm: flashModel(),
				fileRefs: null,
			}),
			"chain result",
		);
		assert.deepEqual(calls, [null, "a", "b"]);
		assert.deepEqual(
			runtime.records.acquire.map((item) => item.excludeAccountIds),
			[[], ["a"]],
		);
	});
});
