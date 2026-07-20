import { describe, test } from "vitest";
import type { RuntimeConfig } from "../../../src/config";
import type { GeminiAccountLease } from "../../../src/gemini/accounts/lease-types";
import { AccountPoolService } from "../../../src/gemini/accounts/pool";
import { basicRouteForFamily } from "../../../src/gemini/accounts/routes";
import type { GeminiAccountRuntime } from "../../../src/gemini/accounts/runtime";
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

function leaseFor(
	accountId: string,
	events: LifecycleEvent[] = [],
): GeminiAccountLease {
	const config = accountConfig(accountId);
	let released = false;
	return {
		accountId,
		selectedRoute: basicRouteForFamily("flash"),
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

type ScriptedRuntime = GeminiAccountRuntime & {
	records: {
		acquire: Array<{
			base: RuntimeConfig;
			excludeAccountIds: string[];
			reason: unknown;
		}>;
		route: unknown[][];
	};
};

function scriptedRuntime(
	script: Array<GeminiAccountLease | null>,
): ScriptedRuntime {
	const pending = [...script];
	const records: ScriptedRuntime["records"] = { acquire: [], route: [] };
	return {
		pool: new AccountPoolService(createRuntimeStore([]), {
			async rotateCookie() {
				throw new Error("unexpected cookie rotation");
			},
		}),
		records,
		async resolveModel(): Promise<never> {
			throw new Error("unexpected runtime.resolveModel call");
		},
		async modelCatalog(): Promise<never> {
			throw new Error("unexpected runtime.modelCatalog call");
		},
		async modelRoutingOverview(): Promise<never> {
			throw new Error("unexpected runtime.modelRoutingOverview call");
		},
		async routeCandidatesForModel(
			model: ResolvedModelOk,
			freshAfterMs: number,
		) {
			records.route.push([model, freshAfterMs]);
			if (!model.family) throw new Error("expected a static model family");
			return [basicRouteForFamily(model.family)];
		},
		async acquireLease(
			base: RuntimeConfig,
			options: GeminiAccountAcquireOptions = {},
		) {
			records.acquire.push({
				base,
				excludeAccountIds: [...(options.excludeAccountIds || [])],
				reason: options.routeRequirement,
			});
			if (!pending.length)
				throw new Error(
					"unexpected runtime.acquireLease call after script exhausted",
				);
			return pending.shift() ?? null;
		},
	};
}

function createTestProvider(
	cfg: RuntimeConfig,
	options: GeminiCompletionProviderOptions = {},
) {
	return createGeminiCompletionProvider(cfg, {
		...options,
		client: failFastClient(options.client),
		uploads: failFastUploads(),
	});
}

function requestScopedError(message = "model invalid for this request") {
	return Object.assign(new Error(message), { code: "invalid_model" });
}

describe("Gemini anonymous fallback", () => {
	test("keeps a prompt at the account threshold anonymous", async () => {
		const runtime = scriptedRuntime([]);
		const configs: RuntimeConfig[] = [];
		const provider = createTestProvider(
			baseGeminiClientConfig({ current_input_file_min_bytes: 4 }),
			{
				accountRuntime: runtime,
				client: {
					async generate(activeCfg) {
						configs.push(activeCfg);
						return "anonymous edge";
					},
				},
			},
		);
		assert.equal(
			await provider.generateText({
				prompt: "abcd",
				rm: flashModel(),
				fileRefs: null,
			}),
			"anonymous edge",
		);
		assert.equal(requireItem(configs).gemini_account, undefined);
		assert.equal(runtime.records.acquire.length, 0);
	});

	test("routes a prompt one byte above the threshold to an account", async () => {
		const events: LifecycleEvent[] = [];
		const runtime = scriptedRuntime([leaseFor("threshold", events)]);
		const provider = createTestProvider(
			baseGeminiClientConfig({ current_input_file_min_bytes: 4 }),
			{
				accountRuntime: runtime,
				client: {
					async generate(activeCfg) {
						assert.equal(requireAccount(activeCfg).accountId, "threshold");
						return "account edge";
					},
				},
			},
		);
		assert.equal(
			await provider.generateText({
				prompt: "abcde",
				rm: flashModel(),
				fileRefs: null,
			}),
			"account edge",
		);
		assert.equal(runtime.records.acquire.length, 1);
		assert.deepEqual(
			events.map((event) => event[0]),
			["markSuccess", "release", "flushObservedCookies"],
		);
	});

	test("falls back from an anonymous text error to one account", async () => {
		const runtime = scriptedRuntime([leaseFor("fallback")]);
		const seenAccounts: Array<string | null> = [];
		const provider = createTestProvider(baseGeminiClientConfig(), {
			accountRuntime: runtime,
			client: {
				async generate(activeCfg) {
					const accountId = activeCfg.gemini_account?.accountId || null;
					seenAccounts.push(accountId);
					if (!accountId) throw new Error("anonymous failed");
					return "fallback answer";
				},
			},
		});
		assert.equal(
			await provider.generateText({
				prompt: "prompt",
				rm: flashModel(),
				fileRefs: null,
			}),
			"fallback answer",
		);
		assert.deepEqual(seenAccounts, [null, "fallback"]);
		assert.equal(runtime.records.acquire.length, 1);
	});

	test("falls back when anonymous text is empty", async () => {
		const runtime = scriptedRuntime([leaseFor("empty-text")]);
		const seenAccounts: Array<string | null> = [];
		const provider = createTestProvider(baseGeminiClientConfig(), {
			accountRuntime: runtime,
			client: {
				async generate(activeCfg) {
					const accountId = activeCfg.gemini_account?.accountId || null;
					seenAccounts.push(accountId);
					return accountId ? "account output" : "";
				},
			},
		});
		assert.equal(
			await provider.generateText({
				prompt: "prompt",
				rm: flashModel(),
				fileRefs: null,
			}),
			"account output",
		);
		assert.deepEqual(seenAccounts, [null, "empty-text"]);
	});

	test("returns the account error when fallback generation fails", async () => {
		const anonymousError = new Error("anonymous failed");
		const accountError = requestScopedError("model invalid on account");
		const events: LifecycleEvent[] = [];
		const provider = createTestProvider(baseGeminiClientConfig(), {
			accountRuntime: scriptedRuntime([leaseFor("fallback-fail", events)]),
			client: {
				async generate(activeCfg) {
					if (!activeCfg.gemini_account) throw anonymousError;
					throw accountError;
				},
			},
		});
		const error = await captureError(() =>
			provider.generateText({
				prompt: "prompt",
				rm: flashModel(),
				fileRefs: null,
			}),
		);
		assert.equal(error, accountError);
		assert.equal(requireItem(events)[0], "markFailure");
		assert.equal(requireItem(events)[2], accountError);
	});

	test("preserves the anonymous error when fallback has no account", async () => {
		const anonymousError = new Error("anonymous unavailable");
		const runtime = scriptedRuntime([null]);
		const provider = createTestProvider(baseGeminiClientConfig(), {
			accountRuntime: runtime,
			client: {
				async generate() {
					throw anonymousError;
				},
			},
		});
		const error = await captureError(() =>
			provider.generateText({
				prompt: "prompt",
				rm: flashModel(),
				fileRefs: null,
			}),
		);
		assert.equal(error, anonymousError);
		assert.equal(runtime.records.acquire.length, 1);
	});

	test("does not acquire a fallback account for an anonymous text abort", async () => {
		const abort = Object.assign(new Error("cancelled"), { name: "AbortError" });
		const runtime = scriptedRuntime([]);
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
				rm: flashModel(),
				fileRefs: null,
			}),
		);
		assert.equal(error, abort);
		assert.equal(runtime.records.acquire.length, 0);
	});

	test("falls back only when an anonymous stream fails before output", async () => {
		const runtime = scriptedRuntime([leaseFor("stream-fallback")]);
		const provider = createTestProvider(baseGeminiClientConfig(), {
			accountRuntime: runtime,
			client: {
				async *generateStream(activeCfg) {
					if (!activeCfg.gemini_account)
						throw new Error("anonymous stream failed");
					yield "account stream";
				},
			},
		});
		const output = [];
		for await (const delta of provider.streamText({
			prompt: "prompt",
			rm: flashModel(),
			fileRefs: null,
		}))
			output.push(delta);
		assert.deepEqual(output, ["account stream"]);
		assert.equal(runtime.records.acquire.length, 1);
	});

	test("falls back when an anonymous stream ends without a non-empty delta", async () => {
		const runtime = scriptedRuntime([leaseFor("stream-empty")]);
		const seenAccounts: Array<string | null> = [];
		const provider = createTestProvider(baseGeminiClientConfig(), {
			accountRuntime: runtime,
			client: {
				async *generateStream(activeCfg) {
					const accountId = activeCfg.gemini_account?.accountId || null;
					seenAccounts.push(accountId);
					if (!accountId) {
						yield "";
						return;
					}
					yield "account stream";
				},
			},
		});
		const output = [];
		for await (const delta of provider.streamText({
			prompt: "prompt",
			rm: flashModel(),
			fileRefs: null,
		}))
			output.push(delta);
		assert.deepEqual(output, ["account stream"]);
		assert.deepEqual(seenAccounts, [null, "stream-empty"]);
	});

	test("preserves an anonymous stream error when fallback has no account", async () => {
		const anonymousError = new Error("anonymous stream unavailable");
		const runtime = scriptedRuntime([null]);
		const provider = createTestProvider(baseGeminiClientConfig(), {
			accountRuntime: runtime,
			client: {
				async *generateStream() {
					yield* [];
					throw anonymousError;
				},
			},
		});
		const error = await captureError(async () => {
			for await (const _delta of provider.streamText({
				prompt: "prompt",
				rm: flashModel(),
				fileRefs: null,
			})) {
				throw new Error("unexpected stream output");
			}
		});
		assert.equal(error, anonymousError);
		assert.equal(runtime.records.acquire.length, 1);
	});

	test("marks an account stream failure after anonymous fallback", async () => {
		const accountError = requestScopedError("model invalid in account stream");
		const events: LifecycleEvent[] = [];
		const provider = createTestProvider(baseGeminiClientConfig(), {
			accountRuntime: scriptedRuntime([leaseFor("stream-fail", events)]),
			client: {
				async *generateStream(activeCfg) {
					yield* [];
					if (!activeCfg.gemini_account)
						throw new Error("anonymous stream failed");
					throw accountError;
				},
			},
		});
		const error = await captureError(async () => {
			for await (const _delta of provider.streamText({
				prompt: "prompt",
				rm: flashModel(),
				fileRefs: null,
			})) {
				throw new Error("unexpected stream output");
			}
		});
		assert.equal(error, accountError);
		assert.equal(requireItem(events)[0], "markFailure");
		assert.equal(requireItem(events)[2], accountError);
	});

	test("does not fall back after anonymous stream output", async () => {
		const runtime = scriptedRuntime([]);
		const streamError = new Error("stream interrupted");
		const provider = createTestProvider(baseGeminiClientConfig(), {
			accountRuntime: runtime,
			client: {
				async *generateStream() {
					yield "partial";
					throw streamError;
				},
			},
		});
		const output: string[] = [];
		const error = await captureError(async () => {
			for await (const delta of provider.streamText({
				prompt: "prompt",
				rm: flashModel(),
				fileRefs: null,
			}))
				output.push(delta);
		});
		assert.equal(error, streamError);
		assert.deepEqual(output, ["partial"]);
		assert.equal(runtime.records.acquire.length, 0);
	});

	test("does not acquire a fallback account for an anonymous stream abort", async () => {
		const abort = Object.assign(new Error("stream cancelled"), {
			name: "AbortError",
		});
		const runtime = scriptedRuntime([]);
		const provider = createTestProvider(baseGeminiClientConfig(), {
			accountRuntime: runtime,
			client: {
				async *generateStream() {
					yield* [];
					throw abort;
				},
			},
		});
		const error = await captureError(async () => {
			for await (const _delta of provider.streamText({
				prompt: "prompt",
				rm: flashModel(),
				fileRefs: null,
			})) {
				throw new Error("unexpected stream output");
			}
		});
		assert.equal(error, abort);
		assert.equal(runtime.records.acquire.length, 0);
	});

	test("returns typed no-pool errors for each authenticated-session reason", async () => {
		const cfg = baseGeminiClientConfig({ current_input_file_min_bytes: 4 });
		const provider = createTestProvider(cfg);
		if (!provider.generateRich)
			throw new Error("expected rich generation support");
		const generateRich = provider.generateRich;
		const cases = [
			{
				reason: "pro_model",
				run: () =>
					provider.generateText({
						prompt: "x",
						rm: proModel(),
						fileRefs: null,
					}),
			},
			{
				reason: "attachment",
				run: () =>
					provider.generateText({
						prompt: "x",
						rm: flashModel(),
						fileRefs: [{ ref: "ref", name: "file.txt" }],
					}),
			},
			{
				reason: "large_context",
				run: () =>
					provider.generateText({
						prompt: "12345",
						rm: flashModel(),
						fileRefs: null,
					}),
			},
			{
				reason: "image",
				run: () =>
					generateRich({
						prompt: "x",
						rm: flashModel(),
						fileRefs: null,
					}),
			},
		];
		for (const item of cases) {
			const error = errorRecord(await captureError(item.run));
			assert.equal(error.status, 422);
			assert.equal(error.code, "gemini_authenticated_session_required");
			assert.equal(error.reason, item.reason);
			assert.match(error.message, /authenticated Gemini session/);
		}
	});

	test("returns a sanitized no-account error before client delegation", async () => {
		const runtime = scriptedRuntime([null]);
		const provider = createTestProvider(baseGeminiClientConfig(), {
			accountRuntime: runtime,
		});
		const error = errorRecord(
			await captureError(() =>
				provider.generateText({
					prompt: "prompt",
					rm: proModel(),
					fileRefs: null,
				}),
			),
		);
		assert.equal(error.status, 503);
		assert.equal(error.code, "no_available_gemini_account");
		assert.doesNotMatch(error.message, /psid|cookie|SNlM0e|SAPISID/i);
		assert.equal(runtime.records.acquire.length, 1);
	});
});
