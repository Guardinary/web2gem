import { assert } from "./assertions.js";
import { mod } from "./helpers.js";

export const suiteName = "Gemini completion provider";
export const cases = [
	[
		"delegates text rich and stream calls with exact provider arguments",
		async () => {
			const calls = [];
			const logs = [];
			const dependencies = providerDependencies({ calls, logs });
			const cfg = providerConfig({ cookie: "session", log_requests: true });
			const provider =
				mod.createGeminiCompletionProviderWithDependenciesForTest(
					cfg,
					dependencies,
				);
			const extra = { 31: 2, 80: 3 };
			const modelHeaders = { "x-model-route": "pro" };
			const rm = {
				name: "gemini-3.1-pro-enhanced",
				modeId: 3,
				thinkMode: 4,
				extra,
				modelHeaders,
			};
			const fileRefs = [{ ref: "file-ref", name: "doc.txt" }];
			const input = { prompt: "provider prompt", rm, fileRefs };

			assert.equal(provider.supportsAuthenticatedSession, true);
			assert.equal(await provider.generateText(input), "text result");
			assert.deepEqual(await provider.generateRich(input), {
				text: "rich result",
				images: [],
			});
			const richOptions = { hydrateGeneratedImageBytes: true };
			await provider.generateRich(input, richOptions);
			const signal = new AbortController().signal;
			const deltas = [];
			for await (const delta of provider.streamText(input, { signal })) {
				deltas.push(delta);
			}

			assert.deepEqual(deltas, ["visible", "7"]);
			assert.deepEqual(calls[0], {
				kind: "text",
				args: [cfg, "provider prompt", 3, 4, extra, fileRefs, modelHeaders],
			});
			assert.deepEqual(calls[1], {
				kind: "rich",
				args: [cfg, "provider prompt", 3, 4, extra, fileRefs, modelHeaders, {}],
			});
			assert.deepEqual(calls[2], {
				kind: "rich",
				args: [
					cfg,
					"provider prompt",
					3,
					4,
					extra,
					fileRefs,
					modelHeaders,
					richOptions,
				],
			});
			assert.deepEqual(calls[3], {
				kind: "stream",
				args: [
					cfg,
					"provider prompt",
					3,
					4,
					extra,
					fileRefs,
					{ signal },
					modelHeaders,
				],
			});
			assert.deepEqual(
				logs.map((entry) => entry.metadata),
				[
					providerLogMetadata(false),
					providerLogMetadata(false),
					providerLogMetadata(false),
					providerLogMetadata(true),
				],
			);
		},
	],
	[
		"logs base routing metadata and rejects unresolved models explicitly",
		async () => {
			const logs = [];
			const cfg = providerConfig({ log_requests: true });
			const provider =
				mod.createGeminiCompletionProviderWithDependenciesForTest(
					cfg,
					providerDependencies({ logs }),
				);
			const rm = {
				name: "gemini-3.5-flash",
				modeId: 1,
				thinkMode: 0,
				extra: null,
			};

			assert.equal(provider.supportsAuthenticatedSession, false);
			await provider.generateText({ prompt: "base", rm, fileRefs: null });
			assert.deepEqual(logs[0].metadata, {
				model: "gemini-3.5-flash",
				modelFamily: 1,
				thinkingMode: 0,
				enhancedMode: undefined,
				enhancedRouting: undefined,
				webModelHeader: false,
				stream: false,
			});
			await assert.rejects(
				() =>
					provider.generateText({
						prompt: "bad",
						rm: { error: "model_not_found" },
						fileRefs: null,
					}),
				/model_not_found/,
			);
			await assert.rejects(
				() =>
					provider.generateRich({
						prompt: "bad",
						rm: {},
						fileRefs: null,
					}),
				/model is not resolved/,
			);
		},
	],
	[
		"delegates attachment resolution and text uploads without reshaping",
		async () => {
			const calls = [];
			const cfg = providerConfig();
			const provider =
				mod.createGeminiCompletionProviderWithDependenciesForTest(
					cfg,
					providerDependencies({ calls }),
				);
			const plan = mod.createAttachmentPlan();

			assert.deepEqual(await provider.resolveAttachments(plan), {
				fileRefs: [{ ref: "resolved", name: "resolved.txt" }],
			});
			assert.deepEqual(
				await provider.uploadTextFile("text body", "context.txt"),
				{ ref: "uploaded", name: "context.txt" },
			);
			assert.deepEqual(calls, [
				{ kind: "attachments", args: [cfg, plan] },
				{ kind: "upload", args: [cfg, "text body", "context.txt"] },
			]);
		},
	],
];

function providerDependencies({ calls = [], logs = [] } = {}) {
	return {
		async generate(...args) {
			calls.push({ kind: "text", args });
			return "text result";
		},
		async generateRich(...args) {
			calls.push({ kind: "rich", args });
			return { text: "rich result", images: [] };
		},
		async *generateStream(...args) {
			calls.push({ kind: "stream", args });
			yield "";
			yield undefined;
			yield "visible";
			yield 7;
		},
		async resolveAttachments(...args) {
			calls.push({ kind: "attachments", args });
			return { fileRefs: [{ ref: "resolved", name: "resolved.txt" }] };
		},
		async uploadTextFile(...args) {
			calls.push({ kind: "upload", args });
			return { ref: "uploaded", name: args[2] };
		},
		logStage(cfg, stage, metadata) {
			logs.push({ cfg, stage, metadata });
		},
	};
}

function providerConfig(overrides = {}) {
	return {
		cookie: "",
		log_requests: false,
		...overrides,
	};
}

function providerLogMetadata(stream) {
	return {
		model: "gemini-3.1-pro-enhanced",
		modelFamily: 3,
		thinkingMode: 4,
		enhancedMode: 2,
		enhancedRouting: 3,
		webModelHeader: true,
		stream,
	};
}
