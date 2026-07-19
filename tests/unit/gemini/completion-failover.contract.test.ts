// @ts-nocheck
import { describe, test } from "vitest";
import { basicRouteForFamily } from "../../../src/gemini/accounts/routes";
import { createGeminiCompletionProvider } from "../../../src/gemini/completion-provider";
import { assert } from "../assertions.js";
import { baseGeminiClientConfig } from "./_support/client-fixtures.js";

function flashModel() {
	return {
		name: "gemini-3.5-flash",
		family: "flash",
		extended: false,
		dynamicProviderId: null,
	};
}

function proModel() {
	return {
		name: "gemini-3.1-pro",
		family: "pro",
		extended: false,
		dynamicProviderId: null,
	};
}

function accountConfig(accountId) {
	return baseGeminiClientConfig({
		cookie: `__Secure-1PSID=psid-${accountId}`,
		gemini_account: {
			accountId,
			rowId: `row-${accountId}`,
			cookieHash: `hash-${accountId}`,
		},
	});
}

function proRoutes() {
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

function failFastClient(overrides = {}) {
	return {
		async generate() {
			throw new Error("unexpected client.generate call");
		},
		async generateRich() {
			throw new Error("unexpected client.generateRich call");
		},
		generateStream() {
			throw new Error("unexpected client.generateStream call");
		},
		...overrides,
	};
}

function failFastUploads() {
	return {
		async resolveAttachments() {
			throw new Error("unexpected uploads.resolveAttachments call");
		},
		async uploadTextFile() {
			throw new Error("unexpected uploads.uploadTextFile call");
		},
	};
}

function failoverLease(accountId, selectedRoute, events, overrides = {}) {
	const config = accountConfig(accountId);
	let released = false;
	return {
		accountId,
		rowId: config.gemini_account.rowId,
		selectedCookieHash: config.gemini_account.cookieHash,
		selectedRoute,
		modelCapability: null,
		config,
		async recordPageState() {
			throw new Error("unexpected lease.recordPageState call");
		},
		async refreshForRetry() {
			throw new Error("unexpected lease.refreshForRetry call");
		},
		async markSuccess() {
			events.push(["markSuccess", accountId]);
		},
		async markFailure(error) {
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
		...overrides,
	};
}

function scriptedRuntime(leases, routes) {
	const pending = [...leases];
	const records = { route: [], acquire: [] };
	return {
		records,
		async resolveModel() {
			throw new Error("unexpected runtime.resolveModel call");
		},
		async routeCandidatesForModel(model, freshAfterMs) {
			records.route.push([model, freshAfterMs]);
			return routes;
		},
		async acquireLease(base, options) {
			records.acquire.push({
				base,
				excludeAccountIds: [...(options.excludeAccountIds || [])],
				routeRequirement: options.routeRequirement,
				capabilityMode: options.capabilityMode,
				capabilityFreshAfterMs: options.capabilityFreshAfterMs,
			});
			if (!pending.length)
				throw new Error("unexpected extra account acquisition");
			return pending.shift();
		},
	};
}

function createTestProvider(cfg, options) {
	return createGeminiCompletionProvider(cfg, {
		accountRuntime: options.accountRuntime,
		client: failFastClient(options.client),
		uploads: failFastUploads(),
	});
}

function rateLimitError(accountId) {
	return Object.assign(new Error(`rate limited ${accountId}`), { status: 429 });
}

function semanticError(code) {
	return Object.assign(new Error(`Gemini semantic ${code}`), {
		code: "gemini_semantic_error",
		geminiSource: "stream_generate",
		geminiCode: String(code),
	});
}

function requestScopedError(message = "model invalid for this request") {
	return Object.assign(new Error(message), { code: "invalid_model" });
}

async function captureError(run) {
	try {
		await run();
	} catch (error) {
		return error;
	}
	throw new Error("expected rejection");
}

function modelHeaderProviderId(headers) {
	return JSON.parse(headers["x-goog-ext-525001261-jspb"])[4];
}

describe("Gemini account failover", () => {
	test("treats a missing dynamic selected route as terminal", async () => {
		const cfg = baseGeminiClientConfig();
		const events = [];
		const dynamicRoute = {
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
		const error = await captureError(() =>
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
		);
		assert.equal(error.code, "gemini_route_not_selected");
		assert.equal(error.status, 502);
		assert.match(error.message, /route was not selected/);
		assert.equal(runtime.records.acquire.length, 1);
		assert.deepEqual(
			events.map((event) => event[0]),
			["markFailure", "release"],
		);
		assert.equal(events[0][2], error);
	});
	test("fails over text to an excluded account and recomputes its selected route", async () => {
		const cfg = baseGeminiClientConfig();
		const routes = proRoutes();
		const events = [];
		const runtime = scriptedRuntime(
			[
				failoverLease("a", routes[0], events),
				failoverLease("b", routes[1], events),
			],
			routes,
		);
		const firstError = rateLimitError("a");
		const calls = [];
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
					const accountId = activeCfg.gemini_account.accountId;
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
		assert.equal(events[0][2], firstError);
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
		const events = [];
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
		assert.deepEqual(runtime.records.acquire[1].excludeAccountIds, [
			"duplicate",
		]);
		assert.equal(events.filter((event) => event[0] === "release").length, 2);
	});
	test("stops at the configured two-account budget", async () => {
		const cfg = baseGeminiClientConfig({ gemini_account_max_attempts: 2 });
		const routes = proRoutes();
		const events = [];
		const runtime = scriptedRuntime(
			[
				failoverLease("a", routes[0], events),
				failoverLease("b", routes[1], events),
				failoverLease("c", routes[0], events),
			],
			routes,
		);
		const errors = { a: rateLimitError("a"), b: rateLimitError("b") };
		const provider = createTestProvider(cfg, {
			accountRuntime: runtime,
			client: {
				async generate(activeCfg) {
					throw errors[activeCfg.gemini_account.accountId];
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
		const events = [];
		const accounts = ["a", "b", "c"];
		const errors = Object.fromEntries(
			accounts.map((accountId) => [accountId, rateLimitError(accountId)]),
		);
		const runtime = scriptedRuntime(
			accounts.map((accountId, index) =>
				failoverLease(accountId, routes[index % routes.length], events),
			),
			routes,
		);
		const provider = createTestProvider(cfg, {
			accountRuntime: runtime,
			client: {
				async generate(activeCfg) {
					throw errors[activeCfg.gemini_account.accountId];
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
		const events = [];
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
					if (activeCfg.gemini_account.accountId === "a") throw error1050;
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
		assert.equal(events[0][2], error1050);
	});
	test("keeps semantic code 1052 on the selected account", async () => {
		const routes = proRoutes();
		const events = [];
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
		const events = [];
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
		assert.equal(events[0][2], modelError);
	});
	test("keeps aborts on one account without marking failure", async () => {
		const routes = proRoutes();
		const events = [];
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
		const events = [];
		const runtime = scriptedRuntime(
			[
				failoverLease("a", routes[0], events),
				failoverLease("b", routes[1], events),
			],
			routes,
		);
		const calls = [];
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
					const accountId = activeCfg.gemini_account.accountId;
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
		const routes = [basicRouteForFamily("flash")];
		const events = [];
		const runtime = scriptedRuntime(
			[
				failoverLease("a", routes[0], events),
				failoverLease("b", routes[0], events),
			],
			routes,
		);
		const calls = [];
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
