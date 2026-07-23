import { describe, test } from "vitest";
import type { AttachmentPlan } from "../../../src/attachments/types";
import { prepareOpenAIGeminiContext } from "../../../src/completion/context";
import type { CompletionProvider } from "../../../src/completion/ports";
import type {
	AttachmentResolutionResult,
	FileRef,
	GeminiContextPrepareResult,
	PreparedGeminiContext,
} from "../../../src/completion/types";
import { parseOpenAIMessages } from "../../../src/promptcompat/message-model";
import { assert } from "../assertions.js";
import { attachmentResult } from "../attachments/_support/result.js";
import { contextFileConfig } from "./_support/context-fixtures.js";

type ContextProviderCallbacks = {
	resolveAttachments: (
		plan: AttachmentPlan,
	) => AttachmentResolutionResult | Promise<AttachmentResolutionResult>;
};

function createContextProvider({
	resolveAttachments,
}: ContextProviderCallbacks) {
	if (typeof resolveAttachments !== "function") {
		throw new TypeError("resolveAttachments must be configured");
	}
	const provider: CompletionProvider = {
		supportsAuthenticatedSession: true,
		generateText() {
			throw new Error("unexpected context provider generateText call");
		},
		streamText() {
			throw new Error("unexpected context provider streamText call");
		},
		async resolveAttachments(plan) {
			return resolveAttachments(plan);
		},
		async uploadTextFile() {
			throw new Error("unexpected context provider uploadTextFile call");
		},
	};
	return provider;
}

function requirePreparedContext(
	result: GeminiContextPrepareResult,
): PreparedGeminiContext & { error?: undefined } {
	if ("error" in result) throw result.error;
	return result;
}

describe("completion context", () => {
	test("deduplicates merged completion file references through public prepare", async () => {
		const cfg = contextFileConfig({
			current_input_file_enabled: false,
			current_input_file_min_bytes: 1000000,
		});
		const messages = parseOpenAIMessages([
			{ role: "user", content: "review this" },
		]);
		const provider = createContextProvider({
			resolveAttachments() {
				return attachmentResult({
					fileRefs: [
						"file-a",
						{ ref: "file-b", name: "b" },
						{ fileRef: "file-b", name: "duplicate" },
						{ id: "file-c" },
					] as FileRef[],
					genericFileRefs: [
						"file-a",
						{ ref: "file-b", name: "b" },
						{ fileRef: "file-b", name: "duplicate" },
						{ id: "file-c" },
					] as FileRef[],
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
				});
			},
		});
		const result = requirePreparedContext(
			await prepareOpenAIGeminiContext(
				cfg,
				provider,
				{},
				messages,
				null,
				"auto",
				null,
				null,
			),
		);
		assert.deepEqual(result.fileRefs, [
			"file-a",
			{ ref: "file-b", name: "b" },
			{ id: "file-c" },
		]);

		const empty = requirePreparedContext(
			await prepareOpenAIGeminiContext(
				cfg,
				createContextProvider({
					resolveAttachments() {
						return attachmentResult({
							fileRefs: null,
							genericFileRefs: null,
						});
					},
				}),
				{},
				messages,
				null,
				"auto",
				null,
				null,
			),
		);
		assert.equal(empty.fileRefs, null);
	});
});
