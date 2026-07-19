// @ts-nocheck
import { describe, test } from "vitest";
import { basicRouteForFamily } from "../../../src/gemini/accounts/routes";
import { createGeminiCompletionProvider } from "../../../src/gemini/completion-provider";
import { assert } from "../assertions.js";
import { withConsoleLog } from "../_support/globals.js";
import { baseGeminiClientConfig } from "./_support/client-fixtures.js";

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

function authError() {
	return Object.assign(new Error("invalid account cookie"), {
		code: "invalid_gemini_cookie",
		status: 401,
	});
}

describe("Gemini account recovery resilience", () => {
	test("retries one auth failure on the refreshed account", async () => {
		const routes = proRoutes();
		const events = [];
		let refreshCalls = 0;
		const lease = failoverLease("auth", routes[0], events, {
			async refreshForRetry(issue) {
				refreshCalls += 1;
				events.push(["refreshForRetry", "auth", issue]);
				return { changed: true };
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
		const events = [];
		let refreshCalls = 0;
		const first = failoverLease("a", routes[0], events, {
			async refreshForRetry() {
				refreshCalls += 1;
				return { changed: true };
			},
		});
		const second = failoverLease("b", routes[1], events);
		const runtime = scriptedRuntime([first, second], routes);
		const calls = [];
		const provider = createTestProvider(baseGeminiClientConfig(), {
			accountRuntime: runtime,
			client: {
				async generate(activeCfg) {
					const accountId = activeCfg.gemini_account.accountId;
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
		const events = [];
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
					if (activeCfg.gemini_account.accountId === "a") throw authError();
					return "alternate";
				},
			},
		});
		const logs = [];
		await withConsoleLog(
			(line) => logs.push(String(line)),
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
		const events = [];
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
					if (activeCfg.gemini_account.accountId === "a") throw firstError;
					return "recovered";
				},
			},
		});
		const logs = [];
		await withConsoleLog(
			(line) => logs.push(String(line)),
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
		assert.equal(events[0][2], firstError);
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
		const events = [];
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
					if (activeCfg.gemini_account.accountId === "a") throw firstError;
					return "recovered";
				},
			},
		});
		const logs = [];
		await withConsoleLog(
			(line) => logs.push(String(line)),
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
		assert.equal(events[0][2], firstError);
		assert.equal(runtime.records.acquire.length, 2);
		assert.match(
			logs.join("\n"),
			/account outcome persistence failed: type=Error/,
		);
		assert.doesNotMatch(logs.join("\n"), /synchronous outcome secret/);
	});
});
