import { describe, test } from "vitest";
import { createAttachmentPlan } from "../../../src/attachments/plan";
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

function lifecycleLease(config, events, overrides = {}) {
	let released = false;
	const accountId = config.gemini_account.accountId;
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
		async maintainSessionIfStale(intervalMs) {
			events.push(["maintainSessionIfStale", accountId, intervalMs]);
		},
		release() {
			if (released) throw new Error(`lease ${accountId} released twice`);
			released = true;
			events.push(["release", accountId]);
		},
		...overrides,
	};
}

function singleLeaseRuntime(lease) {
	const records = { route: [], acquire: [] };
	let acquired = false;
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
				options: {
					...options,
					excludeAccountIds: [...(options.excludeAccountIds || [])],
				},
			});
			if (acquired) throw new Error("unexpected second account acquisition");
			acquired = true;
			return lease;
		},
	};
}

function createTestProvider(cfg, options) {
	return createGeminiCompletionProvider(cfg, {
		...options,
		client: failFastClient(options.client),
		uploads: failFastUploads(options.uploads),
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

function requestScopedError(message) {
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

describe("Gemini account lease lifecycle", () => {
	test("reuses one routed lease across attachment upload and text generation", async () => {
		const cfg = baseGeminiClientConfig();
		const events = [];
		const selectedCfg = accountConfig(cfg, "reuse");
		const runtime = singleLeaseRuntime(lifecycleLease(selectedCfg, events));
		const seenConfigs = [];
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
		assert.deepEqual(runtime.records.acquire[0].options.routeRequirement, {
			candidates: [basicRouteForFamily("pro")],
			fallbackRoute: basicRouteForFamily("pro"),
		});
		assert.deepEqual(
			events.map((event) => event[0]),
			["markSuccess", "release", "flushObservedCookies"],
		);
	});

	test("marks an upload failure with the original error and releases the lease", async () => {
		const cfg = baseGeminiClientConfig();
		const events = [];
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
		assert.equal(events[0][0], "markFailure");
		assert.equal(events[0][2], uploadError);
		assert.deepEqual(
			events.map((event) => event[0]),
			["markFailure", "release"],
		);
	});

	test("finalizes an account stream only after iterator completion", async () => {
		const cfg = baseGeminiClientConfig();
		const events = [];
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
			["markSuccess", "release", "flushObservedCookies"],
		);
	});

	test("marks a post-output stream failure and releases the selected lease", async () => {
		const cfg = baseGeminiClientConfig();
		const events = [];
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
		const output = [];
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
		assert.equal(events[0][2], streamError);
		assert.deepEqual(
			events.map((event) => event[0]),
			["markFailure", "release"],
		);
	});

	test("keeps a successful result when markSuccess persistence rejects", async () => {
		const cfg = baseGeminiClientConfig({ log_requests: true });
		const events = [];
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
					"stable result",
				);
			},
		);
		assert.deepEqual(
			events.map((event) => event[0]),
			["markSuccess", "release", "flushObservedCookies"],
		);
		assert.match(
			logs.join("\n"),
			/account outcome persistence failed: type=Error/,
		);
		assert.doesNotMatch(logs.join("\n"), /persistence secret/);
	});

	test("keeps a successful result when markSuccess throws synchronously", async () => {
		const cfg = baseGeminiClientConfig({ log_requests: true });
		const events = [];
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
					"stable result",
				);
			},
		);
		assert.deepEqual(
			events.map((event) => event[0]),
			["markSuccess", "release", "flushObservedCookies"],
		);
		assert.match(
			logs.join("\n"),
			/account outcome persistence failed: type=Error/,
		);
		assert.doesNotMatch(logs.join("\n"), /synchronous persistence secret/);
	});

	test("orders markSuccess release and scheduled session maintenance", async () => {
		let releasePersistence;
		const persistenceGate = new Promise((resolve) => {
			releasePersistence = resolve;
		});
		const pending = [];
		const cfg = baseGeminiClientConfig({
			gemini_account_refresh_interval_sec: 60,
			execution_ctx: {
				waitUntil(promise) {
					pending.push(promise);
				},
			},
		});
		const events = [];
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
		releasePersistence();
		await pending[0];
		assert.deepEqual(
			events.map((event) => event[0]),
			[
				"markSuccess",
				"release",
				"flushObservedCookies",
				"maintainSessionIfStale",
			],
		);
		assert.equal(events[3][2], 60_000);
	});

	test("isolates opportunistic session maintenance failures", async () => {
		const cfg = baseGeminiClientConfig({
			gemini_account_refresh_interval_sec: 60,
			log_requests: true,
		});
		const events = [];
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
		const events = [];
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
		const events = [];
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
		const logs = [];
		let error;
		await withConsoleLog(
			(line) => logs.push(String(line)),
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
		assert.equal(events[0][2], originalError);
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
		const events = [];
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
					return { ref: "/held", name: filename };
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
		assert.match(error.message, /provider is disposed/);
		assert.equal(uploadCalls, 1);
		assert.equal(runtime.records.acquire.length, 1);
	});
});
