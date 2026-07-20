import { describe, test } from "vitest";
import { createAttachmentPlan } from "../../../src/attachments/plan";
import type {
	AttachmentPlan,
	AttachmentUploadResult,
} from "../../../src/attachments/types";
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
import { assert } from "../assertions.js";
import { baseGeminiClientConfig } from "./_support/client-fixtures.js";
import { createRuntimeStore } from "./accounts/_support/runtime-fixtures.js";

type ClientOverrides = NonNullable<GeminiCompletionProviderOptions["client"]>;
type UploadOverrides = NonNullable<GeminiCompletionProviderOptions["uploads"]>;
type LifecycleEvent = [string, ...unknown[]];
type UploadCall =
	| [kind: "attachments", accountId: string, plan: AttachmentPlan]
	| [kind: "text", accountId: string, text: string, filename: string];
type GenerateCall = [accountId: string, refs: unknown[]];
type TestProvider = CompletionProvider &
	Required<Pick<CompletionProvider, "resolveModel">>;

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

function accountConfig(accountId: string): RuntimeConfig {
	return baseGeminiClientConfig({
		cookie: `__Secure-1PSID=psid-${accountId}`,
		gemini_account: {
			accountId,
			cookieHash: `hash-${accountId}`,
		},
	});
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

function replayLease(
	accountId: string,
	events: LifecycleEvent[],
): GeminiAccountLease {
	const config = accountConfig(accountId);
	let released = false;
	return {
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
};

function scriptedRuntime(leases: GeminiAccountLease[]): GeminiAccountRuntime & {
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
		if (!model.family) throw new Error("expected static model family");
		return [basicRouteForFamily(model.family)];
	};
	runtime.acquireLease = async (
		base: RuntimeConfig,
		options: GeminiAccountAcquireOptions = {},
	) => {
		records.acquire.push({
			base,
			excludeAccountIds: [...(options.excludeAccountIds || [])],
			routeRequirement: options.routeRequirement,
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
		uploads: failFastUploads(options.uploads),
	});
	const { resolveModel } = provider;
	if (!resolveModel) throw new Error("expected model resolver");
	return Object.assign(provider, { resolveModel });
}

function rateLimitError(accountId: string) {
	return Object.assign(new Error(`rate limited ${accountId}`), { status: 429 });
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

describe("Gemini upload replay failover", () => {
	test("replays attachment and text recipes in order and remaps refs", async () => {
		const cfg = baseGeminiClientConfig();
		const events: LifecycleEvent[] = [];
		const runtime = scriptedRuntime([
			replayLease("a", events),
			replayLease("b", events),
		]);
		const uploadCalls: UploadCall[] = [];
		const generateCalls: GenerateCall[] = [];
		const provider = createTestProvider(cfg, {
			accountRuntime: runtime,
			uploads: {
				async resolveAttachments(activeCfg, activePlan) {
					const accountId = requireAccount(activeCfg).accountId;
					uploadCalls.push(["attachments", accountId, activePlan]);
					return attachmentResult(`/attachment/${accountId}`);
				},
				async uploadTextFile(activeCfg, text, filename) {
					const accountId = requireAccount(activeCfg).accountId;
					uploadCalls.push(["text", accountId, String(text), String(filename)]);
					return { ref: `/text/${accountId}`, name: String(filename) };
				},
			},
			client: {
				async generate(activeCfg, _prompt, _model, _extended, refs) {
					const accountId = requireAccount(activeCfg).accountId;
					generateCalls.push([accountId, refs ?? []]);
					if (accountId === "a") throw rateLimitError(accountId);
					assert.deepEqual(refs, [
						{ ref: "/attachment/b", name: "file.txt" },
						{ ref: "/text/b", name: "context.txt" },
					]);
					return "replayed";
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
		const attachments = await provider.resolveAttachments(plan);
		const textRef = await provider.uploadTextFile(
			"context body",
			"context.txt",
		);
		assert.equal(
			await provider.generateText({
				prompt: "prompt",
				rm: model,
				fileRefs: [...(attachments.fileRefs ?? []), textRef],
			}),
			"replayed",
		);
		assert.deepEqual(uploadCalls, [
			["attachments", "a", plan],
			["text", "a", "context body", "context.txt"],
			["attachments", "b", plan],
			["text", "b", "context body", "context.txt"],
		]);
		assert.deepEqual(
			runtime.records.acquire.map((item) => item.excludeAccountIds),
			[[], ["a"]],
		);
		assert.deepEqual(
			generateCalls.map((item) => item[0]),
			["a", "b"],
		);
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

	test("classifies a replacement upload rate limit and replays on a third account", async () => {
		const cfg = baseGeminiClientConfig();
		const events: LifecycleEvent[] = [];
		const runtime = scriptedRuntime([
			replayLease("a", events),
			replayLease("b", events),
			replayLease("c", events),
		]);
		const generationError = rateLimitError("a generation");
		const replayError = rateLimitError("b replay");
		const uploadCalls: [string, AttachmentPlan][] = [];
		const generateCalls: GenerateCall[] = [];
		const provider = createTestProvider(cfg, {
			accountRuntime: runtime,
			uploads: {
				async resolveAttachments(activeCfg, activePlan) {
					const accountId = requireAccount(activeCfg).accountId;
					uploadCalls.push([accountId, activePlan]);
					if (accountId === "b") throw replayError;
					return attachmentResult(`/attachment/${accountId}`);
				},
			},
			client: {
				async generate(activeCfg, _prompt, _model, _extended, refs) {
					const accountId = requireAccount(activeCfg).accountId;
					generateCalls.push([accountId, refs ?? []]);
					if (accountId === "a") throw generationError;
					assert.equal(accountId, "c");
					assert.deepEqual(refs, [{ ref: "/attachment/c", name: "file.txt" }]);
					return "third account result";
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
				prompt: "prompt",
				rm: model,
				fileRefs: uploaded.fileRefs,
			}),
			"third account result",
		);
		assert.deepEqual(
			runtime.records.acquire.map((item) => item.excludeAccountIds),
			[[], ["a"], ["a", "b"]],
		);
		assert.deepEqual(uploadCalls, [
			["a", plan],
			["b", plan],
			["c", plan],
		]);
		assert.deepEqual(generateCalls, [
			["a", [{ ref: "/attachment/a", name: "file.txt" }]],
			["c", [{ ref: "/attachment/c", name: "file.txt" }]],
		]);
		assert.deepEqual(
			events.map((event) => event.slice(0, 2)),
			[
				["markFailure", "a"],
				["release", "a"],
				["markFailure", "b"],
				["release", "b"],
				["markSuccess", "c"],
				["release", "c"],
				["flushObservedCookies", "c"],
			],
		);
		assert.equal(requireItem(events)[2], generationError);
		assert.equal(requireItem(events, 2)[2], replayError);
	});

	test("does not move opaque external refs to another account", async () => {
		const cfg = baseGeminiClientConfig();
		const events: LifecycleEvent[] = [];
		const runtime = scriptedRuntime([replayLease("opaque", events)]);
		const upstreamError = rateLimitError("opaque");
		const provider = createTestProvider(cfg, {
			accountRuntime: runtime,
			client: {
				async generate() {
					throw upstreamError;
				},
			},
			uploads: {},
		});
		const error = await captureError(() =>
			provider.generateText({
				prompt: "prompt",
				rm: {
					name: "gemini-3.1-pro",
					family: "pro",
					extended: false,
					dynamicProviderId: null,
				},
				fileRefs: [{ ref: "/external/opaque", name: "opaque.txt" }],
			}),
		);
		assert.equal(error, upstreamError);
		assert.equal(runtime.records.acquire.length, 1);
		assert.equal(requireItem(events)[2], upstreamError);
		assert.deepEqual(
			events.map((event) => event[0]),
			["markFailure", "release"],
		);
	});

	test("stops immediately when replacement uploads lose refs", async () => {
		const cfg = baseGeminiClientConfig();
		const events: LifecycleEvent[] = [];
		const runtime = scriptedRuntime([
			replayLease("a", events),
			replayLease("b", events),
			replayLease("c", events),
		]);
		const generateAccounts: string[] = [];
		let attachmentCalls = 0;
		const provider = createTestProvider(cfg, {
			accountRuntime: runtime,
			uploads: {
				async resolveAttachments(activeCfg) {
					attachmentCalls += 1;
					const accountId = requireAccount(activeCfg).accountId;
					const result = attachmentResult(`/attachment/${accountId}`);
					if (accountId !== "a") result.fileRefs = [];
					return result;
				},
			},
			client: {
				async generate(activeCfg) {
					const accountId = requireAccount(activeCfg).accountId;
					generateAccounts.push(accountId);
					throw rateLimitError(accountId);
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
		const error = errorRecord(
			await captureError(() =>
				provider.generateText({
					prompt: "prompt",
					rm: model,
					fileRefs: uploaded.fileRefs,
				}),
			),
		);
		assert.equal(error.code, "gemini_upload_replay_failed");
		assert.equal(error.status, 502);
		assert.deepEqual(generateAccounts, ["a"]);
		assert.equal(attachmentCalls, 2);
		assert.equal(runtime.records.acquire.length, 2);
		assert.deepEqual(
			runtime.records.acquire.map((item) => item.excludeAccountIds),
			[[], ["a"]],
		);
		assert.deepEqual(
			events.map((event) => event.slice(0, 2)),
			[
				["markFailure", "a"],
				["release", "a"],
				["markFailure", "b"],
				["release", "b"],
			],
		);
		assert.equal(requireItem(events, 2)[2], error);
	});
});
