import { describe, test } from "vitest";
import { createAttachmentPlan } from "../../../src/attachments/plan";
import type {
	AttachmentFileRef,
	AttachmentUploadResult,
} from "../../../src/attachments/types";
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
import type { GeminiPublicFamily, ResolvedModelOk } from "../../../src/models";
import { withConsoleLog } from "../_support/globals.js";
import { assert } from "../assertions.js";
import { baseGeminiClientConfig } from "./_support/client-fixtures.js";
import { createRuntimeStore } from "./accounts/_support/runtime-fixtures.js";

type ClientOverrides = NonNullable<GeminiCompletionProviderOptions["client"]>;
type UploadOverrides = NonNullable<GeminiCompletionProviderOptions["uploads"]>;
type LifecycleEvent = [string, ...unknown[]];
type TestProvider = CompletionProvider &
	Required<
		Pick<CompletionProvider, "resolveModel" | "generateRich" | "dispose">
	>;

function requireAccount(config: RuntimeConfig) {
	const account = config.gemini_account;
	if (!account) throw new Error("expected Gemini account context");
	return account;
}

function requireItem<T>(items: readonly T[], index = 0): T {
	const item = items[index];
	if (item === undefined) throw new Error(`expected item at index ${index}`);
	return item;
}

function attachmentResult(
	fileRefs: AttachmentFileRef[] | null,
): AttachmentUploadResult {
	return {
		fileRefs,
		imageFileRefs: null,
		genericFileRefs: fileRefs,
		promptText: "",
		droppedNote: "",
		supportsFileRefs: true,
		usage: {
			uploadedFiles: 0,
			dedupedFiles: 0,
			uploadedBytes: 0,
			fileRefBytes: 0,
			inlinedFiles: 0,
			inlinedBytes: 0,
			droppedFiles: 0,
			multipartUploads: 0,
		},
	};
}

function flashModel(extended = false): ResolvedModelOk {
	return {
		name: extended ? "gemini-3.5-flash-extended" : "gemini-3.5-flash",
		family: "flash",
		extended,
		dynamicProviderId: null,
	};
}

function proModel(extended = false): ResolvedModelOk {
	return {
		name: extended ? "gemini-3.1-pro-extended" : "gemini-3.1-pro",
		family: "pro",
		extended,
		dynamicProviderId: null,
	};
}

function accountConfig(base: RuntimeConfig, accountId: string): RuntimeConfig {
	return {
		...base,
		cookie: `__Secure-1PSID=psid-${accountId}`,
		gemini_account: {
			accountId,
			cookieHash: `hash-${accountId}`,
		},
	};
}

function routeFor(
	family: GeminiPublicFamily,
	overrides: Partial<GeminiRouteTuple> = {},
): GeminiRouteTuple {
	return { ...basicRouteForFamily(family), ...overrides };
}

function unexpected(name: string) {
	return new Error(`unexpected ${name} call`);
}

function failFastClient(
	overrides: Partial<ClientOverrides> = {},
): ClientOverrides {
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

function failFastUploads(
	overrides: Partial<UploadOverrides> = {},
): UploadOverrides {
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

function successfulLease(
	config: RuntimeConfig,
	selectedRoute: GeminiRouteTuple,
	events: LifecycleEvent[] = [],
): GeminiAccountLease {
	let released = false;
	const accountId = requireAccount(config).accountId;
	return {
		accountId,
		selectedRoute,
		modelCapability: null,
		config,
		async refreshForRetry() {
			throw unexpected("lease.refreshForRetry");
		},
		async markSuccess() {
			events.push(["markSuccess", accountId]);
		},
		async markFailure(error: unknown) {
			throw new Error(`unexpected lease.markFailure: ${String(error)}`);
		},
		async flushObservedCookies() {
			events.push(["flushObservedCookies", accountId]);
		},
		async maintainSessionIfStale() {
			throw unexpected("lease.maintainSessionIfStale");
		},
		release() {
			if (released) throw new Error(`lease ${accountId} released twice`);
			released = true;
			events.push(["release", accountId]);
		},
	};
}

type ResolveModelDelegate = GeminiAccountRuntime["resolveModel"];
type AcquireRecord = {
	base: RuntimeConfig;
	options: GeminiAccountAcquireOptions & { excludeAccountIds: string[] };
};
type StrictRuntime = GeminiAccountRuntime & {
	records: {
		resolve: [unknown, unknown, number][];
		route: [ResolvedModelOk, number][];
		acquire: AcquireRecord[];
	};
};

function strictRuntime({
	leases = [],
	routes,
	resolveModel,
}: {
	leases?: GeminiAccountLease[];
	routes?: GeminiRouteTuple[];
	resolveModel?: ResolveModelDelegate;
} = {}): StrictRuntime {
	const records: StrictRuntime["records"] = {
		resolve: [],
		route: [],
		acquire: [],
	};
	let nextLease = 0;
	const runtime = new GeminiAccountRuntime(
		new AccountPoolService(createRuntimeStore([]), {
			async rotateCookie() {
				throw unexpected("cookie rotation");
			},
		}),
	);
	runtime.resolveModel = async (...args) => {
		records.resolve.push(args);
		if (!resolveModel) throw unexpected("runtime.resolveModel");
		return resolveModel(...args);
	};
	runtime.routeCandidatesForModel = async (...args) => {
		records.route.push(args);
		if (!routes) throw unexpected("runtime.routeCandidatesForModel");
		return routes;
	};
	runtime.acquireLease = async (
		base: RuntimeConfig,
		options: GeminiAccountAcquireOptions = {},
	) => {
		records.acquire.push({
			base,
			options: {
				...options,
				excludeAccountIds: [...(options.excludeAccountIds || [])],
			},
		});
		if (nextLease >= leases.length) throw unexpected("runtime.acquireLease");
		return leases[nextLease++] ?? null;
	};
	return Object.assign(runtime, { records });
}

function assertAcquireContract(
	runtime: StrictRuntime,
	cfg: RuntimeConfig,
	model: ResolvedModelOk,
	routes: GeminiRouteTuple[],
	expectedFreshAfterMs: number,
) {
	assert.equal(runtime.records.route.length, 1);
	assert.equal(requireItem(runtime.records.route)[0], model);
	assert.equal(requireItem(runtime.records.route)[1], expectedFreshAfterMs);
	assert.equal(runtime.records.acquire.length, 1);
	const acquisition = requireItem(runtime.records.acquire);
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

function modelHeaderDetails(
	headers: unknown,
	route: GeminiRouteTuple,
	extended: boolean,
): string {
	if (!headers || typeof headers !== "object") {
		throw new Error("expected Gemini model headers");
	}
	const encoded = Reflect.get(headers, "x-goog-ext-525001261-jspb");
	if (typeof encoded !== "string") {
		throw new Error("expected encoded Gemini model header");
	}
	const payload: unknown = JSON.parse(encoded);
	if (!Array.isArray(payload)) throw new Error("expected model header array");
	assert.equal(payload[4], route.providerModelId);
	assert.equal(payload[route.capacityField - 1], route.capacity);
	assert.equal(payload[route.capacityField + 2], route.modelNumber);
	assert.equal(payload[route.capacityField + 3], extended ? 2 : 1);
	assert.match(payload[route.capacityField + 4], /^[0-9A-F-]+$/);
	const sessionId = payload[route.capacityField + 4];
	if (typeof sessionId !== "string") throw new Error("expected session id");
	return sessionId;
}

async function withFixedNow<T>(now: number, run: () => Promise<T>): Promise<T> {
	const original = Date.now;
	Date.now = () => now;
	try {
		return await run();
	} finally {
		Date.now = original;
	}
}

function completeProvider(
	cfg: RuntimeConfig,
	options: GeminiCompletionProviderOptions,
): TestProvider {
	const provider = createGeminiCompletionProvider(cfg, options);
	const { resolveModel, generateRich, dispose } = provider;
	if (!resolveModel || !generateRich || !dispose) {
		throw new Error("expected complete Gemini provider contract");
	}
	return Object.assign(provider, { resolveModel, generateRich, dispose });
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
		const events: LifecycleEvent[] = [];
		const runtime = strictRuntime({
			leases: [successfulLease(selectedCfg, route, events)],
			routes: [route],
		});
		const calls: unknown[][] = [];
		const provider = completeProvider(cfg, {
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
					rm: model,
					fileRefs,
				}),
				"text result",
			);
		});
		assert.equal(calls.length, 1);
		assert.deepEqual(requireItem(calls).slice(0, 5), [
			selectedCfg,
			"provider prompt",
			route.modelNumber,
			true,
			fileRefs,
		]);
		modelHeaderDetails(requireItem(calls)[5], route, true);
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
		const calls: unknown[][] = [];
		const provider = completeProvider(cfg, {
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
		assert.deepEqual(requireItem(calls).slice(0, 5), [
			selectedCfg,
			"draw",
			route.modelNumber,
			false,
			fileRefs,
		]);
		modelHeaderDetails(requireItem(calls)[5], route, false);
		assert.deepEqual(requireItem(calls)[6], {});
	});

	test("delegates rich options by identity", async () => {
		const cfg = baseGeminiClientConfig();
		const selectedCfg = accountConfig(cfg, "rich-options");
		const model = proModel();
		const route = routeFor("pro");
		const calls: unknown[][] = [];
		const provider = completeProvider(cfg, {
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
		assert.equal(requireItem(calls)[6], options);
	});

	test("delegates exact stream arguments and filters empty deltas", async () => {
		const cfg = baseGeminiClientConfig();
		const selectedCfg = accountConfig(cfg, "stream");
		const model = proModel(true);
		const route = routeFor("pro", { capacity: 3, capacityField: 13 });
		const calls: unknown[][] = [];
		const provider = completeProvider(cfg, {
			accountRuntime: strictRuntime({
				leases: [successfulLease(selectedCfg, route)],
				routes: [route],
			}),
			client: failFastClient({
				generateStream(...args) {
					async function* invalidDeltas(): AsyncGenerator<unknown> {
						calls.push(args);
						yield "";
						yield undefined;
						yield "visible";
						yield 7;
					}
					const iteratorFactory: unknown = invalidDeltas;
					if (typeof iteratorFactory !== "function") {
						throw new Error("expected invalid delta iterator factory");
					}
					return Reflect.apply(iteratorFactory, undefined, []);
				},
			}),
			uploads: failFastUploads(),
		});
		const fileRefs = [{ ref: "stream-ref", name: "stream.txt" }];
		const options = { signal: new AbortController().signal };
		const deltas: string[] = [];
		for await (const delta of provider.streamText(
			{ prompt: "stream prompt", rm: model, fileRefs },
			options,
		))
			deltas.push(delta);
		assert.deepEqual(deltas, ["visible", "7"]);
		assert.deepEqual(requireItem(calls).slice(0, 5), [
			selectedCfg,
			"stream prompt",
			route.modelNumber,
			true,
			fileRefs,
		]);
		assert.equal(requireItem(calls)[5], options);
		modelHeaderDetails(requireItem(calls)[6], route, true);
	});

	test("delegates an empty attachment plan anonymously without acquisition", async () => {
		const cfg = baseGeminiClientConfig({
			cookie: "SID=must-not-forward",
			sapisid: "sapisid-must-not-forward",
		});
		const runtime = strictRuntime();
		const calls: unknown[][] = [];
		const result = attachmentResult(null);
		const provider = completeProvider(cfg, {
			accountRuntime: runtime,
			client: failFastClient(),
			uploads: failFastUploads({
				async resolveAttachments(...args) {
					calls.push(args);
					return result;
				},
			}),
		});
		const plan = createAttachmentPlan();
		assert.equal(await provider.resolveAttachments(plan), result);
		assert.equal(calls.length, 1);
		const [anonymousConfig, delegatedPlan] = requireItem(calls);
		if (!anonymousConfig || typeof anonymousConfig !== "object") {
			throw new Error("expected anonymous runtime config");
		}
		assert.equal(Reflect.get(anonymousConfig, "cookie"), "");
		assert.equal(Reflect.get(anonymousConfig, "sapisid"), "");
		assert.equal(delegatedPlan, plan);
		assert.equal(runtime.records.acquire.length, 0);
	});

	test("delegates account attachment resolution after preparing its model route", async () => {
		const cfg = baseGeminiClientConfig();
		const selectedCfg = accountConfig(cfg, "attachments");
		const route = routeFor("pro");
		const lease = successfulLease(selectedCfg, route);
		const runtime = strictRuntime({ leases: [lease], routes: [route] });
		const calls: unknown[][] = [];
		const result = attachmentResult([
			{ ref: "selected-ref", name: "selected.txt" },
		]);
		const provider = completeProvider(cfg, {
			accountRuntime: runtime,
			client: failFastClient(),
			uploads: failFastUploads({
				async resolveAttachments(...args) {
					calls.push(args);
					return result;
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
		assert.deepEqual(requireItem(calls), [selectedCfg, plan]);
		if (model.name === undefined || !model.family) {
			throw new Error("expected resolved static model");
		}
		assert.deepEqual(
			requireItem(runtime.records.acquire).options.routeRequirement,
			{
				candidates: [route],
				fallbackRoute: basicRouteForFamily(model.family),
			},
		);
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
		const calls: unknown[][] = [];
		const provider = completeProvider(cfg, {
			accountRuntime: runtime,
			client: failFastClient(),
			uploads: failFastUploads({
				async uploadTextFile(...args) {
					calls.push(args);
					return { ref: "uploaded-ref", name: String(args[2]) };
				},
			}),
		});
		await provider.resolveModel("gemini-3.1-pro", "gemini-3.5-flash");
		assert.deepEqual(await provider.uploadTextFile("body", "context.txt"), {
			ref: "uploaded-ref",
			name: "context.txt",
		});
		assert.deepEqual(requireItem(calls), [selectedCfg, "body", "context.txt"]);
		await provider.dispose();
	});

	test("rejects unresolved text models before delegation", async () => {
		const provider = completeProvider(baseGeminiClientConfig(), {
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
		const provider = completeProvider(baseGeminiClientConfig(), {
			client: failFastClient(),
			uploads: failFastUploads(),
		});
		await assert.rejects(
			() =>
				Reflect.apply(provider.generateRich, provider, [
					{ prompt: "bad", rm: {}, fileRefs: null },
				]),
			/model is not resolved/,
		);
	});

	test("rejects unresolved stream models before delegation", async () => {
		const provider = completeProvider(baseGeminiClientConfig(), {
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
			gemini_account_capability_mode: "strict",
			gemini_account_capability_ttl_sec: 900,
		});
		const route: GeminiRouteTuple = {
			providerModelId: "future-model",
			capacity: 3,
			capacityField: 13,
			modelNumber: 7,
		};
		const resolved: ResolvedModelOk = {
			name: "future-model-extended",
			family: null,
			extended: true,
			dynamicProviderId: "future-model",
		};
		const selectedCfg = accountConfig(cfg, "dynamic");
		const runtime = strictRuntime({
			leases: [successfulLease(selectedCfg, route)],
			routes: [route],
			async resolveModel(name, defaultName, freshAfterMs) {
				assert.deepEqual(
					[name, defaultName, freshAfterMs],
					["future-model-extended", "gemini-3.5-flash", now - 900_000],
				);
				return resolved;
			},
		});
		const calls: unknown[][] = [];
		const provider = completeProvider(cfg, {
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
		assert.equal(requireItem(calls)[2], 7);
		modelHeaderDetails(requireItem(calls)[5], route, true);
	});

	test("keeps anonymous Flash standard and extended generation header-free", async () => {
		const calls: unknown[][] = [];
		const provider = completeProvider(
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
		const firstConfig = requireItem(calls)[0];
		if (!firstConfig || typeof firstConfig !== "object") {
			throw new Error("expected anonymous runtime config");
		}
		assert.equal(Reflect.get(firstConfig, "cookie"), "");
		assert.deepEqual(requireItem(calls).slice(2), [1, false, null, null]);
		assert.deepEqual(requireItem(calls, 1).slice(2), [1, true, null, null]);
	});

	test("logs route metadata without prompt content", async () => {
		const cfg = baseGeminiClientConfig({ log_requests: true });
		const selectedCfg = accountConfig(cfg, "logging");
		const model = proModel(true);
		const route = routeFor("pro");
		const provider = completeProvider(cfg, {
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
		const logs: string[] = [];
		await withConsoleLog(
			(line: unknown) => logs.push(String(line)),
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
		const sessionIds: string[] = [];
		const provider = completeProvider(cfg, {
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
