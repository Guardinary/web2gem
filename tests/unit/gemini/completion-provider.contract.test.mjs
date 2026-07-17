import { describe, test } from "vitest";
import { createAttachmentPlan } from "../../../src/attachments/plan";
import { basicRouteForFamily } from "../../../src/gemini/accounts/routes";
import { createGeminiCompletionProvider } from "../../../src/gemini/completion-provider";
import { assert } from "../assertions.js";
import { withConsoleLog } from "../helpers.js";
import { baseGeminiClientConfig } from "./_support/client-fixtures.js";

function flashModel(extended = false) {
	return {
		name: extended ? "gemini-3.5-flash-extended" : "gemini-3.5-flash",
		family: "flash",
		extended,
		dynamicProviderId: null,
	};
}

function proModel(extended = false) {
	return {
		name: extended ? "gemini-3.1-pro-extended" : "gemini-3.1-pro",
		family: "pro",
		extended,
		dynamicProviderId: null,
	};
}

function accountConfig(base, accountId) {
	return {
		...base,
		cookie: `__Secure-1PSID=psid-${accountId}`,
		gemini_account: {
			accountId,
			rowId: `row-${accountId}`,
			cookieHash: `hash-${accountId}`,
		},
	};
}

function routeFor(family, overrides = {}) {
	return { ...basicRouteForFamily(family), ...overrides };
}

function unexpected(name) {
	return new Error(`unexpected ${name} call`);
}

function failFastClient(overrides = {}) {
	return {
		async generate() {
			throw unexpected("client.generate");
		},
		async generateRich() {
			throw unexpected("client.generateRich");
		},
		generateStream() {
			throw unexpected("client.generateStream");
		},
		...overrides,
	};
}

function failFastUploads(overrides = {}) {
	return {
		async resolveAttachments() {
			throw unexpected("uploads.resolveAttachments");
		},
		async uploadTextFile() {
			throw unexpected("uploads.uploadTextFile");
		},
		...overrides,
	};
}

function successfulLease(config, selectedRoute, events = []) {
	let released = false;
	return {
		accountId: config.gemini_account.accountId,
		rowId: config.gemini_account.rowId,
		selectedCookieHash: config.gemini_account.cookieHash,
		selectedRoute,
		modelCapability: null,
		config,
		async recordPageState() {
			throw unexpected("lease.recordPageState");
		},
		async refreshForRetry() {
			throw unexpected("lease.refreshForRetry");
		},
		async markSuccess() {
			events.push(["markSuccess", this.accountId]);
		},
		async markFailure(error) {
			throw new Error(`unexpected lease.markFailure: ${String(error)}`);
		},
		async flushObservedCookies() {
			events.push(["flushObservedCookies", this.accountId]);
		},
		async maintainSessionIfStale() {
			throw unexpected("lease.maintainSessionIfStale");
		},
		release() {
			if (released) throw new Error(`lease ${this.accountId} released twice`);
			released = true;
			events.push(["release", this.accountId]);
		},
	};
}

function strictRuntime({ leases = [], routes, resolveModel } = {}) {
	const records = { resolve: [], route: [], acquire: [] };
	let nextLease = 0;
	return {
		records,
		async resolveModel(...args) {
			records.resolve.push(args);
			if (!resolveModel) throw unexpected("runtime.resolveModel");
			return resolveModel(...args);
		},
		async routeCandidatesForModel(...args) {
			records.route.push(args);
			if (!routes) throw unexpected("runtime.routeCandidatesForModel");
			return routes;
		},
		async acquireLease(base, options) {
			records.acquire.push({
				base,
				options: {
					...options,
					excludeAccountIds: [...(options.excludeAccountIds || [])],
				},
			});
			if (nextLease >= leases.length) throw unexpected("runtime.acquireLease");
			return leases[nextLease++];
		},
	};
}

function assertAcquireContract(
	runtime,
	cfg,
	model,
	routes,
	expectedFreshAfterMs,
) {
	assert.equal(runtime.records.route.length, 1);
	assert.equal(runtime.records.route[0][0], model);
	assert.equal(runtime.records.route[0][1], expectedFreshAfterMs);
	assert.equal(runtime.records.acquire.length, 1);
	const acquisition = runtime.records.acquire[0];
	assert.equal(acquisition.base, cfg);
	assert.deepEqual(acquisition.options, {
		excludeAccountIds: [],
		routeRequirement: {
			candidates: routes,
			fallbackRoute: model.family ? basicRouteForFamily(model.family) : null,
		},
		capabilityMode: cfg.gemini_account_capability_mode || "prefer",
		capabilityFreshAfterMs: expectedFreshAfterMs,
	});
}

function modelHeaderDetails(headers, route, extended) {
	const payload = JSON.parse(headers["x-goog-ext-525001261-jspb"]);
	assert.equal(payload[4], route.providerModelId);
	assert.equal(payload[route.capacityField - 1], route.capacity);
	assert.equal(payload[route.capacityField + 2], route.modelNumber);
	assert.equal(payload[route.capacityField + 3], extended ? 2 : 1);
	assert.match(payload[route.capacityField + 4], /^[0-9A-F-]+$/);
	return payload[route.capacityField + 4];
}

async function withFixedNow(now, run) {
	const original = Date.now;
	Date.now = () => now;
	try {
		return await run();
	} finally {
		Date.now = original;
	}
}

describe("Gemini completion provider delegation", () => {
	test("delegates exact text arguments through the selected account route", async () => {
		const now = 1_800_000_000_000;
		const cfg = baseGeminiClientConfig({
			gemini_account_capability_ttl_sec: 600,
		});
		const selectedCfg = accountConfig(cfg, "text");
		const model = proModel(true);
		const route = routeFor("pro", { capacity: 4, capacityField: 12 });
		const events = [];
		const runtime = strictRuntime({
			leases: [successfulLease(selectedCfg, route, events)],
			routes: [route],
		});
		const calls = [];
		const provider = createGeminiCompletionProvider(cfg, {
			accountRuntime: runtime,
			client: failFastClient({
				async generate(...args) {
					calls.push(args);
					return "text result";
				},
			}),
			uploads: failFastUploads(),
		});
		const fileRefs = [{ ref: "file-ref", name: "doc.txt" }];
		await withFixedNow(now, async () => {
			assert.equal(
				await provider.generateText({
					prompt: "provider prompt",
					model,
					rm: model,
					fileRefs,
				}),
				"text result",
			);
		});
		assert.equal(calls.length, 1);
		assert.deepEqual(calls[0].slice(0, 5), [
			selectedCfg,
			"provider prompt",
			route.modelNumber,
			true,
			fileRefs,
		]);
		modelHeaderDetails(calls[0][5], route, true);
		assertAcquireContract(runtime, cfg, model, [route], now - 600_000);
		assert.deepEqual(events, [
			["markSuccess", "text"],
			["release", "text"],
			["flushObservedCookies", "text"],
		]);
	});

	test("delegates rich arguments with default options", async () => {
		const cfg = baseGeminiClientConfig();
		const selectedCfg = accountConfig(cfg, "rich-default");
		const model = proModel();
		const route = routeFor("pro");
		const calls = [];
		const provider = createGeminiCompletionProvider(cfg, {
			accountRuntime: strictRuntime({
				leases: [successfulLease(selectedCfg, route)],
				routes: [route],
			}),
			client: failFastClient({
				async generateRich(...args) {
					calls.push(args);
					return { text: "rich", images: [] };
				},
			}),
			uploads: failFastUploads(),
		});
		const fileRefs = [{ ref: "image-ref", name: "image.png" }];
		assert.deepEqual(
			await provider.generateRich({ prompt: "draw", rm: model, fileRefs }),
			{ text: "rich", images: [] },
		);
		assert.deepEqual(calls[0].slice(0, 5), [
			selectedCfg,
			"draw",
			route.modelNumber,
			false,
			fileRefs,
		]);
		modelHeaderDetails(calls[0][5], route, false);
		assert.deepEqual(calls[0][6], {});
	});

	test("delegates rich options by identity", async () => {
		const cfg = baseGeminiClientConfig();
		const selectedCfg = accountConfig(cfg, "rich-options");
		const model = proModel();
		const route = routeFor("pro");
		const calls = [];
		const provider = createGeminiCompletionProvider(cfg, {
			accountRuntime: strictRuntime({
				leases: [successfulLease(selectedCfg, route)],
				routes: [route],
			}),
			client: failFastClient({
				async generateRich(...args) {
					calls.push(args);
					return { text: "rich", images: [] };
				},
			}),
			uploads: failFastUploads(),
		});
		const options = { hydrateGeneratedImageBytes: false };
		await provider.generateRich(
			{ prompt: "draw", rm: model, fileRefs: null },
			options,
		);
		assert.equal(calls[0][6], options);
	});

	test("delegates exact stream arguments and filters empty deltas", async () => {
		const cfg = baseGeminiClientConfig();
		const selectedCfg = accountConfig(cfg, "stream");
		const model = proModel(true);
		const route = routeFor("pro", { capacity: 3, capacityField: 13 });
		const calls = [];
		const provider = createGeminiCompletionProvider(cfg, {
			accountRuntime: strictRuntime({
				leases: [successfulLease(selectedCfg, route)],
				routes: [route],
			}),
			client: failFastClient({
				async *generateStream(...args) {
					calls.push(args);
					yield "";
					yield undefined;
					yield "visible";
					yield 7;
				},
			}),
			uploads: failFastUploads(),
		});
		const fileRefs = [{ ref: "stream-ref", name: "stream.txt" }];
		const options = { signal: new AbortController().signal };
		const deltas = [];
		for await (const delta of provider.streamText(
			{ prompt: "stream prompt", rm: model, fileRefs },
			options,
		))
			deltas.push(delta);
		assert.deepEqual(deltas, ["visible", "7"]);
		assert.deepEqual(calls[0].slice(0, 5), [
			selectedCfg,
			"stream prompt",
			route.modelNumber,
			true,
			fileRefs,
		]);
		assert.equal(calls[0][5], options);
		modelHeaderDetails(calls[0][6], route, true);
	});

	test("delegates an empty attachment plan anonymously without acquisition", async () => {
		const cfg = baseGeminiClientConfig({
			cookie: "SID=must-not-forward",
			sapisid: "sapisid-must-not-forward",
		});
		const runtime = strictRuntime();
		const calls = [];
		const provider = createGeminiCompletionProvider(cfg, {
			accountRuntime: runtime,
			client: failFastClient(),
			uploads: failFastUploads({
				async resolveAttachments(...args) {
					calls.push(args);
					return { fileRefs: null };
				},
			}),
		});
		const plan = createAttachmentPlan();
		assert.deepEqual(await provider.resolveAttachments(plan), {
			fileRefs: null,
		});
		assert.equal(calls.length, 1);
		assert.equal(calls[0][0].cookie, "");
		assert.equal(calls[0][0].sapisid, "");
		assert.equal(calls[0][1], plan);
		assert.equal(runtime.records.acquire.length, 0);
	});

	test("delegates account attachment resolution after preparing its model route", async () => {
		const cfg = baseGeminiClientConfig();
		const selectedCfg = accountConfig(cfg, "attachments");
		const route = routeFor("pro");
		const lease = successfulLease(selectedCfg, route);
		const runtime = strictRuntime({ leases: [lease], routes: [route] });
		const calls = [];
		const provider = createGeminiCompletionProvider(cfg, {
			accountRuntime: runtime,
			client: failFastClient(),
			uploads: failFastUploads({
				async resolveAttachments(...args) {
					calls.push(args);
					return { fileRefs: [{ ref: "selected-ref", name: "selected.txt" }] };
				},
			}),
		});
		const model = await provider.resolveModel(
			"gemini-3.1-pro",
			"gemini-3.5-flash",
		);
		const plan = createAttachmentPlan({
			existingFileRefs: [{ ref: "existing-ref", name: "existing.txt" }],
		});
		await provider.resolveAttachments(plan);
		assert.deepEqual(calls[0], [selectedCfg, plan]);
		assert.deepEqual(runtime.records.acquire[0].options.routeRequirement, {
			candidates: [route],
			fallbackRoute: basicRouteForFamily(model.family),
		});
		await provider.dispose();
	});

	test("delegates account text uploads with exact arguments", async () => {
		const cfg = baseGeminiClientConfig();
		const selectedCfg = accountConfig(cfg, "text-upload");
		const route = routeFor("pro");
		const runtime = strictRuntime({
			leases: [successfulLease(selectedCfg, route)],
			routes: [route],
		});
		const calls = [];
		const provider = createGeminiCompletionProvider(cfg, {
			accountRuntime: runtime,
			client: failFastClient(),
			uploads: failFastUploads({
				async uploadTextFile(...args) {
					calls.push(args);
					return { ref: "uploaded-ref", name: args[2] };
				},
			}),
		});
		await provider.resolveModel("gemini-3.1-pro", "gemini-3.5-flash");
		assert.deepEqual(await provider.uploadTextFile("body", "context.txt"), {
			ref: "uploaded-ref",
			name: "context.txt",
		});
		assert.deepEqual(calls[0], [selectedCfg, "body", "context.txt"]);
		await provider.dispose();
	});

	test("rejects unresolved text models before delegation", async () => {
		const provider = createGeminiCompletionProvider(baseGeminiClientConfig(), {
			client: failFastClient(),
			uploads: failFastUploads(),
		});
		await assert.rejects(
			() =>
				provider.generateText({
					prompt: "bad",
					rm: { error: "text_missing" },
					fileRefs: null,
				}),
			/text_missing/,
		);
	});

	test("rejects unresolved rich models with the default error before delegation", async () => {
		const provider = createGeminiCompletionProvider(baseGeminiClientConfig(), {
			client: failFastClient(),
			uploads: failFastUploads(),
		});
		await assert.rejects(
			() => provider.generateRich({ prompt: "bad", rm: {}, fileRefs: null }),
			/model is not resolved/,
		);
	});

	test("rejects unresolved stream models before delegation", async () => {
		const provider = createGeminiCompletionProvider(baseGeminiClientConfig(), {
			client: failFastClient(),
			uploads: failFastUploads(),
		});
		await assert.rejects(async () => {
			for await (const _delta of provider.streamText({
				prompt: "bad",
				rm: { error: "stream_missing" },
				fileRefs: null,
			})) {
				throw new Error("unresolved stream must not emit");
			}
		}, /stream_missing/);
	});

	test("resolves a dynamic model through one exact route tuple", async () => {
		const now = 1_900_000_000_000;
		const cfg = baseGeminiClientConfig({
			gemini_account_capability_mode: "require",
			gemini_account_capability_ttl_sec: 900,
		});
		const route = {
			providerModelId: "future-model",
			capacity: 3,
			capacityField: 13,
			modelNumber: 7,
		};
		const resolved = {
			name: "future-model-extended",
			family: null,
			extended: true,
			dynamicProviderId: "future-model",
		};
		const selectedCfg = accountConfig(cfg, "dynamic");
		const runtime = strictRuntime({
			leases: [successfulLease(selectedCfg, route)],
			routes: [route],
			resolveModel(name, defaultName, freshAfterMs) {
				assert.deepEqual(
					[name, defaultName, freshAfterMs],
					["future-model-extended", "gemini-3.5-flash", now - 900_000],
				);
				return resolved;
			},
		});
		const calls = [];
		const provider = createGeminiCompletionProvider(cfg, {
			accountRuntime: runtime,
			client: failFastClient({
				async generate(...args) {
					calls.push(args);
					return "dynamic result";
				},
			}),
			uploads: failFastUploads(),
		});
		await withFixedNow(now, async () => {
			assert.equal(
				await provider.resolveModel(
					"future-model-extended",
					"gemini-3.5-flash",
				),
				resolved,
			);
			assert.equal(
				await provider.generateText({
					prompt: "dynamic",
					rm: resolved,
					fileRefs: null,
				}),
				"dynamic result",
			);
		});
		assert.equal(runtime.records.resolve.length, 1);
		assertAcquireContract(runtime, cfg, resolved, [route], now - 900_000);
		assert.equal(calls[0][2], 7);
		modelHeaderDetails(calls[0][5], route, true);
	});

	test("keeps anonymous Flash standard and extended generation header-free", async () => {
		const calls = [];
		const provider = createGeminiCompletionProvider(
			baseGeminiClientConfig({ cookie: "SID=must-not-forward" }),
			{
				client: failFastClient({
					async generate(...args) {
						calls.push(args);
						return "anonymous";
					},
				}),
				uploads: failFastUploads(),
			},
		);
		for (const model of [flashModel(false), flashModel(true)]) {
			assert.equal(
				await provider.generateText({
					prompt: "prompt",
					rm: model,
					fileRefs: null,
				}),
				"anonymous",
			);
		}
		assert.equal(calls[0][0].cookie, "");
		assert.deepEqual(calls[0].slice(2), [1, false, null, null]);
		assert.deepEqual(calls[1].slice(2), [1, true, null, null]);
	});

	test("logs route metadata without prompt content", async () => {
		const cfg = baseGeminiClientConfig({ log_requests: true });
		const selectedCfg = accountConfig(cfg, "logging");
		const model = proModel(true);
		const route = routeFor("pro");
		const provider = createGeminiCompletionProvider(cfg, {
			accountRuntime: strictRuntime({
				leases: [successfulLease(selectedCfg, route)],
				routes: [route],
			}),
			client: failFastClient({
				async generate() {
					return "logged";
				},
			}),
			uploads: failFastUploads(),
		});
		const logs = [];
		await withConsoleLog(
			(line) => logs.push(String(line)),
			async () => {
				await provider.generateText({
					prompt: "secret prompt",
					rm: model,
					fileRefs: null,
				});
			},
		);
		const routeLog = logs.find((line) => line.includes("stage=gemini_route"));
		assert.match(routeLog, /model=gemini-3\.1-pro-extended/);
		assert.match(routeLog, /modelFamily=pro/);
		assert.match(routeLog, /extendedThinking=true/);
		assert.match(routeLog, /dynamicProvider=false/);
		assert.doesNotMatch(logs.join("\n"), /secret prompt/);
	});

	test("reuses one provider session ID across text rich and stream headers", async () => {
		const cfg = baseGeminiClientConfig();
		const model = proModel();
		const route = routeFor("pro");
		const leases = ["text", "rich", "stream"].map((id) =>
			successfulLease(accountConfig(cfg, `session-${id}`), route),
		);
		const sessionIds = [];
		const provider = createGeminiCompletionProvider(cfg, {
			accountRuntime: strictRuntime({ leases, routes: [route] }),
			client: failFastClient({
				async generate(...args) {
					sessionIds.push(modelHeaderDetails(args[5], route, false));
					return "text";
				},
				async generateRich(...args) {
					sessionIds.push(modelHeaderDetails(args[5], route, false));
					return { text: "rich", images: [] };
				},
				async *generateStream(...args) {
					sessionIds.push(modelHeaderDetails(args[6], route, false));
					yield "stream";
				},
			}),
			uploads: failFastUploads(),
		});
		const input = { prompt: "prompt", rm: model, fileRefs: null };
		await provider.generateText(input);
		await provider.generateRich(input);
		for await (const _delta of provider.streamText(input)) {
			// Consume the stream so the selected lease is finalized.
		}
		assert.equal(new Set(sessionIds).size, 1);
	});
});
