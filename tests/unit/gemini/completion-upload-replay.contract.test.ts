// @ts-nocheck
import { describe, test } from "vitest";
import { createAttachmentPlan } from "../../../src/attachments/plan";
import { basicRouteForFamily } from "../../../src/gemini/accounts/routes";
import { createGeminiCompletionProvider } from "../../../src/gemini/completion-provider";
import { assert } from "../assertions.js";
import { baseGeminiClientConfig } from "./_support/client-fixtures.js";

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

function attachmentResult(ref) {
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

function failFastUploads(overrides = {}) {
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

function replayLease(accountId, events) {
	const config = accountConfig(accountId);
	let released = false;
	return {
		accountId,
		rowId: config.gemini_account.rowId,
		selectedCookieHash: config.gemini_account.cookieHash,
		selectedRoute: basicRouteForFamily("pro"),
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
	};
}

function scriptedRuntime(leases) {
	const pending = [...leases];
	const records = { route: [], acquire: [] };
	return {
		records,
		async resolveModel() {
			throw new Error("unexpected runtime.resolveModel call");
		},
		async routeCandidatesForModel(model, freshAfterMs) {
			records.route.push([model, freshAfterMs]);
			return [basicRouteForFamily(model.family)];
		},
		async acquireLease(base, options) {
			records.acquire.push({
				base,
				excludeAccountIds: [...(options.excludeAccountIds || [])],
				routeRequirement: options.routeRequirement,
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
		uploads: failFastUploads(options.uploads),
	});
}

function rateLimitError(accountId) {
	return Object.assign(new Error(`rate limited ${accountId}`), { status: 429 });
}

async function captureError(run) {
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
		const events = [];
		const runtime = scriptedRuntime([
			replayLease("a", events),
			replayLease("b", events),
		]);
		const uploadCalls = [];
		const generateCalls = [];
		const provider = createTestProvider(cfg, {
			accountRuntime: runtime,
			uploads: {
				async resolveAttachments(activeCfg, activePlan) {
					const accountId = activeCfg.gemini_account.accountId;
					uploadCalls.push(["attachments", accountId, activePlan]);
					return attachmentResult(`/attachment/${accountId}`);
				},
				async uploadTextFile(activeCfg, text, filename) {
					const accountId = activeCfg.gemini_account.accountId;
					uploadCalls.push(["text", accountId, text, filename]);
					return { ref: `/text/${accountId}`, name: filename };
				},
			},
			client: {
				async generate(activeCfg, _prompt, _model, _extended, refs) {
					const accountId = activeCfg.gemini_account.accountId;
					generateCalls.push([accountId, refs]);
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
				fileRefs: [...attachments.fileRefs, textRef],
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
		const events = [];
		const runtime = scriptedRuntime([
			replayLease("a", events),
			replayLease("b", events),
			replayLease("c", events),
		]);
		const generationError = rateLimitError("a generation");
		const replayError = rateLimitError("b replay");
		const uploadCalls = [];
		const generateCalls = [];
		const provider = createTestProvider(cfg, {
			accountRuntime: runtime,
			uploads: {
				async resolveAttachments(activeCfg, activePlan) {
					const accountId = activeCfg.gemini_account.accountId;
					uploadCalls.push([accountId, activePlan]);
					if (accountId === "b") throw replayError;
					return attachmentResult(`/attachment/${accountId}`);
				},
			},
			client: {
				async generate(activeCfg, _prompt, _model, _extended, refs) {
					const accountId = activeCfg.gemini_account.accountId;
					generateCalls.push([accountId, refs]);
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
		assert.equal(events[0][2], generationError);
		assert.equal(events[2][2], replayError);
	});

	test("does not move opaque external refs to another account", async () => {
		const cfg = baseGeminiClientConfig();
		const events = [];
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
		assert.equal(events[0][2], upstreamError);
		assert.deepEqual(
			events.map((event) => event[0]),
			["markFailure", "release"],
		);
	});

	test("stops immediately when replacement uploads lose refs", async () => {
		const cfg = baseGeminiClientConfig();
		const events = [];
		const runtime = scriptedRuntime([
			replayLease("a", events),
			replayLease("b", events),
			replayLease("c", events),
		]);
		const generateAccounts = [];
		let attachmentCalls = 0;
		const provider = createTestProvider(cfg, {
			accountRuntime: runtime,
			uploads: {
				async resolveAttachments(activeCfg) {
					attachmentCalls += 1;
					const accountId = activeCfg.gemini_account.accountId;
					return accountId === "a"
						? attachmentResult("/attachment/a")
						: { fileRefs: [] };
				},
			},
			client: {
				async generate(activeCfg) {
					const accountId = activeCfg.gemini_account.accountId;
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
		const error = await captureError(() =>
			provider.generateText({
				prompt: "prompt",
				rm: model,
				fileRefs: uploaded.fileRefs,
			}),
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
		assert.equal(events[2][2], error);
	});
});
