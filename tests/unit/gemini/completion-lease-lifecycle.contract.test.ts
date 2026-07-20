import { describe, test } from "vitest";
import { createAttachmentPlan } from "../../../src/attachments/plan";
import type { AttachmentUploadResult } from "../../../src/attachments/types";
import type { CompletionProvider } from "../../../src/completion/ports";
import type { RuntimeConfig } from "../../../src/config";
import type { GeminiAccountLease } from "../../../src/gemini/accounts/lease-types";
import { AccountPoolService } from "../../../src/gemini/accounts/pool";
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
import { createRuntimeStore } from "./accounts/_support/runtime-fixtures.js";

type ClientOverrides = NonNullable<GeminiCompletionProviderOptions["client"]>;
type UploadOverrides = NonNullable<GeminiCompletionProviderOptions["uploads"]>;
type LifecycleEvent = [string, ...unknown[]];
type LeaseOverrides = {
	markSuccess?: () => unknown;
	markFailure?: (error: unknown) => unknown;
	maintainSessionIfStale?: (intervalMs: number) => unknown;
};
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

function errorRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object") {
		throw new Error("expected an error object");
	}
	return value as Record<string, unknown>;
}

function proModel(): ResolvedModelOk {
	return {
		name: "gemini-3.1-pro",
		family: "pro",
		extended: false,
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

function failFastClient(
	overrides: Partial<ClientOverrides> = {},
): ClientOverrides {
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

function failFastUploads(
	overrides: Partial<UploadOverrides> = {},
): UploadOverrides {
	return {
		async resolveAttachments() {
			throw new Error("unexpected uploads.resolveAttachments call");
		},
		async uploadTextFile() {
			throw new Error("unexpected uploads.uploadTextFile call");
		},
		...overrides,
	};
}

function lifecycleLease(
	config: RuntimeConfig,
	events: LifecycleEvent[],
	overrides: LeaseOverrides = {},
): GeminiAccountLease {
	let released = false;
	const accountId = requireAccount(config).accountId;
	const lease: GeminiAccountLease = {
		accountId,
		selectedRoute: basicRouteForFamily("pro"),
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
		async maintainSessionIfStale(intervalMs: number) {
			events.push(["maintainSessionIfStale", accountId, intervalMs]);
		},
		release() {
			if (released) throw new Error(`lease ${accountId} released twice`);
			released = true;
			events.push(["release", accountId]);
		},
	};
	for (const name of [
		"markSuccess",
		"markFailure",
		"maintainSessionIfStale",
	] as const) {
		const replacement = overrides[name];
		if (replacement) Reflect.set(lease, name, replacement);
	}
	return lease;
}

type AcquireRecord = {
	base: RuntimeConfig;
	options: GeminiAccountAcquireOptions & { excludeAccountIds: string[] };
};

function singleLeaseRuntime(lease: GeminiAccountLease): GeminiAccountRuntime & {
	records: {
		route: [ResolvedModelOk, number][];
		acquire: AcquireRecord[];
	};
} {
	const records: {
		route: [ResolvedModelOk, number][];
		acquire: AcquireRecord[];
	} = { route: [], acquire: [] };
	let acquired = false;
	const runtime = new GeminiAccountRuntime(
		new AccountPoolService(createRuntimeStore([]), {
			async rotateCookie() {
				throw new Error("unexpected cookie rotation");
			},
		}),
	);
	runtime.routeCandidatesForModel = async (model, freshAfterMs) => {
		records.route.push([model, freshAfterMs]);
		if (!model.family) throw new Error("expected static model family");
		return [basicRouteForFamily(model.family)];
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
		if (acquired) throw new Error("unexpected second account acquisition");
		acquired = true;
		return lease;
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
		uploads: failFastUploads(options.uploads),
	});
	const { resolveModel, generateRich, dispose } = provider;
	if (!resolveModel || !generateRich || !dispose) {
		throw new Error("expected complete Gemini provider contract");
	}
	return Object.assign(provider, { resolveModel, generateRich, dispose });
}

function attachmentResult(ref: string): AttachmentUploadResult {
	const fileRef = { ref, name: "file.txt" };
	return {
		fileRefs: [fileRef],
		imageFileRefs: null,
		genericFileRefs: [fileRef],
		promptText: "",
		droppedNote: "",
		supportsFileRefs: true,
		usage: {
			uploadedFiles: 1,
			dedupedFiles: 0,
			uploadedBytes: 1,
			fileRefBytes: 1,
			inlinedFiles: 0,
			inlinedBytes: 0,
			droppedFiles: 0,
			multipartUploads: 1,
		},
	};
}

function requestScopedError(message: string) {
	return Object.assign(new Error(message), { code: "invalid_model" });
}

async function captureError(
	run: () => unknown | PromiseLike<unknown>,
): Promise<unknown> {
	try {
		await run();
	} catch (error) {
		return error;
	}
	throw new Error("expected rejection");
}

describe("Gemini account lease lifecycle", () => {
	test("reuses one routed lease across attachment upload and text generation", async () => {
		const cfg = baseGeminiClientConfig();
		const events: LifecycleEvent[] = [];
		const selectedCfg = accountConfig(cfg, "reuse");
		const runtime = singleLeaseRuntime(lifecycleLease(selectedCfg, events));
		const seenConfigs: RuntimeConfig[] = [];
		const provider = createTestProvider(cfg, {
			accountRuntime: runtime,
			uploads: {
				async resolveAttachments(activeCfg) {
					seenConfigs.push(activeCfg);
					return attachmentResult("/uploaded/reuse");
				},
			},
			client: {
				async generate(activeCfg, prompt, _modelNumber, _extended, fileRefs) {
					seenConfigs.push(activeCfg);
					assert.equal(prompt, "provider prompt");
					assert.deepEqual(fileRefs, [
						{ ref: "/uploaded/reuse", name: "file.txt" },
					]);
					return "provider answer";
				},
			},
		});
		const model = await provider.resolveModel(
			"gemini-3.1-pro",
			"gemini-3.5-flash",
		);
		const plan = createAttachmentPlan({
			files: [{ b64: "ZmlsZQ==", name: "file.txt" }],
		});
		const uploaded = await provider.resolveAttachments(plan);
		assert.equal(
			await provider.generateText({
				prompt: "provider prompt",
				rm: model,
				fileRefs: uploaded.fileRefs,
			}),
			"provider answer",
		);
		assert.deepEqual(seenConfigs, [selectedCfg, selectedCfg]);
		assert.equal(runtime.records.acquire.length, 1);
		assert.deepEqual(
			requireItem(runtime.records.acquire).options.routeRequirement,
			{
				candidates: [basicRouteForFamily("pro")],
				fallbackRoute: basicRouteForFamily("pro"),
			},
		);
		assert.deepEqual(
			events.map((event) => event[0]),
			[
				"markSuccess",
				"release",
				"flushObservedCookies",
				"maintainSessionIfStale",
			],
		);
	});

	test("marks an upload failure with the original error and releases the lease", async () => {
		const cfg = baseGeminiClientConfig();
		const events: LifecycleEvent[] = [];
		const uploadError = requestScopedError("model invalid upload");
		const provider = createTestProvider(cfg, {
			accountRuntime: singleLeaseRuntime(
				lifecycleLease(accountConfig(cfg, "upload-failure"), events),
			),
			uploads: {
				async uploadTextFile() {
					throw uploadError;
				},
			},
			client: {},
		});
		await provider.resolveModel("gemini-3.1-pro", "gemini-3.5-flash");
		const error = await captureError(() =>
			provider.uploadTextFile("body", "context.txt"),
		);
		assert.equal(error, uploadError);
		assert.equal(requireItem(events)[0], "markFailure");
		assert.equal(requireItem(events)[2], uploadError);
		assert.deepEqual(
			events.map((event) => event[0]),
			["markFailure", "release"],
		);
	});

	test("finalizes an account stream only after iterator completion", async () => {
		const cfg = baseGeminiClientConfig();
		const events: LifecycleEvent[] = [];
		const provider = createTestProvider(cfg, {
			accountRuntime: singleLeaseRuntime(
				lifecycleLease(accountConfig(cfg, "stream-success"), events),
			),
			client: {
				async *generateStream() {
					yield "chunk";
				},
			},
			uploads: {},
		});
		const iterator = provider
			.streamText({
				prompt: "prompt",
				rm: proModel(),
				fileRefs: null,
			})
			[Symbol.asyncIterator]();
		assert.deepEqual(await iterator.next(), { value: "chunk", done: false });
		assert.deepEqual(events, []);
		assert.deepEqual(await iterator.next(), { value: undefined, done: true });
		assert.deepEqual(
			events.map((event) => event[0]),
			[
				"markSuccess",
				"release",
				"flushObservedCookies",
				"maintainSessionIfStale",
			],
		);
	});

	test("marks a post-output stream failure and releases the selected lease", async () => {
		const cfg = baseGeminiClientConfig();
		const events: LifecycleEvent[] = [];
		const streamError = new Error("account stream broke");
		const provider = createTestProvider(cfg, {
			accountRuntime: singleLeaseRuntime(
				lifecycleLease(accountConfig(cfg, "stream-failure"), events),
			),
			client: {
				async *generateStream() {
					yield "partial";
					throw streamError;
				},
			},
			uploads: {},
		});
		const output: string[] = [];
		const error = await captureError(async () => {
			for await (const delta of provider.streamText({
				prompt: "prompt",
				rm: proModel(),
				fileRefs: null,
			}))
				output.push(delta);
		});
		assert.equal(error, streamError);
		assert.deepEqual(output, ["partial"]);
		assert.equal(requireItem(events)[2], streamError);
		assert.deepEqual(
			events.map((event) => event[0]),
			["markFailure", "release"],
		);
	});

	test("keeps a successful result when markSuccess persistence rejects", async () => {
		const cfg = baseGeminiClientConfig({ log_requests: true });
		const events: LifecycleEvent[] = [];
		const lease = lifecycleLease(accountConfig(cfg, "success-reject"), events, {
			async markSuccess() {
				events.push(["markSuccess", "success-reject"]);
				throw new Error("persistence secret");
			},
		});
		const provider = createTestProvider(cfg, {
			accountRuntime: singleLeaseRuntime(lease),
			client: {
				async generate() {
					return "stable result";
				},
			},
			uploads: {},
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
					"stable result",
				);
			},
		);
		assert.deepEqual(
			events.map((event) => event[0]),
			[
				"markSuccess",
				"release",
				"flushObservedCookies",
				"maintainSessionIfStale",
			],
		);
		assert.match(
			logs.join("\n"),
			/account outcome persistence failed: type=Error/,
		);
		assert.doesNotMatch(logs.join("\n"), /persistence secret/);
	});

	test("keeps a successful result when markSuccess throws synchronously", async () => {
		const cfg = baseGeminiClientConfig({ log_requests: true });
		const events: LifecycleEvent[] = [];
		const lease = lifecycleLease(accountConfig(cfg, "success-sync"), events, {
			markSuccess() {
				events.push(["markSuccess", "success-sync"]);
				throw new Error("synchronous persistence secret");
			},
		});
		const provider = createTestProvider(cfg, {
			accountRuntime: singleLeaseRuntime(lease),
			client: {
				async generate() {
					return "stable result";
				},
			},
			uploads: {},
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
					"stable result",
				);
			},
		);
		assert.deepEqual(
			events.map((event) => event[0]),
			[
				"markSuccess",
				"release",
				"flushObservedCookies",
				"maintainSessionIfStale",
			],
		);
		assert.match(
			logs.join("\n"),
			/account outcome persistence failed: type=Error/,
		);
		assert.doesNotMatch(logs.join("\n"), /synchronous persistence secret/);
	});

	test("orders markSuccess release and scheduled session maintenance", async () => {
		let releasePersistence: (() => void) | undefined;
		const persistenceGate = new Promise<void>((resolve) => {
			releasePersistence = () => resolve();
		});
		const pending: Promise<unknown>[] = [];
		const cfg = baseGeminiClientConfig({
			gemini_account_refresh_interval_sec: 60,
			execution_ctx: {
				waitUntil(promise) {
					pending.push(promise);
				},
			},
		});
		const events: LifecycleEvent[] = [];
		const lease = lifecycleLease(accountConfig(cfg, "maintenance"), events, {
			async markSuccess() {
				events.push(["markSuccess", "maintenance"]);
				await persistenceGate;
			},
		});
		const provider = createTestProvider(cfg, {
			accountRuntime: singleLeaseRuntime(lease),
			client: {
				async generate() {
					return "scheduled";
				},
			},
			uploads: {},
		});
		assert.equal(
			await provider.generateText({
				prompt: "prompt",
				rm: proModel(),
				fileRefs: null,
			}),
			"scheduled",
		);
		assert.deepEqual(
			events.map((event) => event[0]),
			["markSuccess", "release"],
		);
		assert.equal(pending.length, 1);
		const release = releasePersistence;
		if (!release) throw new Error("persistence release was not initialized");
		release();
		await requireItem(pending);
		assert.deepEqual(
			events.map((event) => event[0]),
			[
				"markSuccess",
				"release",
				"flushObservedCookies",
				"maintainSessionIfStale",
			],
		);
		assert.equal(requireItem(events, 3)[2], 60_000);
	});

	test("isolates opportunistic session maintenance failures", async () => {
		const cfg = baseGeminiClientConfig({
			gemini_account_refresh_interval_sec: 60,
			log_requests: true,
		});
		const events: LifecycleEvent[] = [];
		const lease = lifecycleLease(
			accountConfig(cfg, "maintenance-fail"),
			events,
			{
				async maintainSessionIfStale(intervalMs) {
					events.push([
						"maintainSessionIfStale",
						"maintenance-fail",
						intervalMs,
					]);
					throw new Error("maintenance secret");
				},
			},
		);
		const provider = createTestProvider(cfg, {
			accountRuntime: singleLeaseRuntime(lease),
			client: {
				async generate() {
					return "stable";
				},
			},
			uploads: {},
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
					"stable",
				);
			},
		);
		assert.match(
			logs.join("\n"),
			/opportunistic account refresh failed: type=Error/,
		);
		assert.doesNotMatch(logs.join("\n"), /maintenance secret/);
	});

	test("keeps results when waitUntil registration throws", async () => {
		const cfg = baseGeminiClientConfig({
			log_requests: true,
			execution_ctx: {
				waitUntil() {
					throw new Error("registration secret");
				},
			},
		});
		const events: LifecycleEvent[] = [];
		const provider = createTestProvider(cfg, {
			accountRuntime: singleLeaseRuntime(
				lifecycleLease(accountConfig(cfg, "waituntil"), events),
			),
			client: {
				async generate() {
					return "stable";
				},
			},
			uploads: {},
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
					"stable",
				);
			},
		);
		assert.match(
			logs.join("\n"),
			/account maintenance waitUntil registration failed: type=Error/,
		);
		assert.doesNotMatch(logs.join("\n"), /registration secret/);
		assert.equal(events.filter((event) => event[0] === "release").length, 1);
	});

	test("preserves the original error when markFailure persistence rejects", async () => {
		const cfg = baseGeminiClientConfig({ log_requests: true });
		const originalError = requestScopedError("model invalid original");
		const events: LifecycleEvent[] = [];
		const lease = lifecycleLease(accountConfig(cfg, "failure-reject"), events, {
			async markFailure(failureError) {
				events.push(["markFailure", "failure-reject", failureError]);
				throw new Error("failure persistence secret");
			},
		});
		const provider = createTestProvider(cfg, {
			accountRuntime: singleLeaseRuntime(lease),
			client: {
				async generate() {
					throw originalError;
				},
			},
			uploads: {},
		});
		const logs: string[] = [];
		let error;
		await withConsoleLog(
			(line: unknown) => logs.push(String(line)),
			async () => {
				error = await captureError(() =>
					provider.generateText({
						prompt: "prompt",
						rm: proModel(),
						fileRefs: null,
					}),
				);
			},
		);
		assert.equal(error, originalError);
		assert.equal(requireItem(events)[2], originalError);
		assert.deepEqual(
			events.map((event) => event[0]),
			["markFailure", "release"],
		);
		assert.match(
			logs.join("\n"),
			/account outcome persistence failed: type=Error/,
		);
		assert.doesNotMatch(logs.join("\n"), /failure persistence secret/);
	});

	test("dispose releases a held upload lease once and rejects later acquisition", async () => {
		const cfg = baseGeminiClientConfig();
		const events: LifecycleEvent[] = [];
		const runtime = singleLeaseRuntime(
			lifecycleLease(accountConfig(cfg, "dispose"), events),
		);
		let uploadCalls = 0;
		const provider = createTestProvider(cfg, {
			accountRuntime: runtime,
			client: {},
			uploads: {
				async uploadTextFile(_activeCfg, _text, filename) {
					uploadCalls += 1;
					return { ref: "/held", name: String(filename) };
				},
			},
		});
		await provider.resolveModel("gemini-3.1-pro", "gemini-3.5-flash");
		await provider.uploadTextFile("body", "context.txt");
		assert.deepEqual(events, []);
		await provider.dispose();
		await provider.dispose();
		assert.deepEqual(events, [["release", "dispose"]]);
		const error = await captureError(() =>
			provider.uploadTextFile("again", "again.txt"),
		);
		assert.match(errorRecord(error).message, /provider is disposed/);
		assert.equal(uploadCalls, 1);
		assert.equal(runtime.records.acquire.length, 1);
	});
});
