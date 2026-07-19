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
import { createToolBundle } from "../../../src/toolcall/tool-bundle";
import { assert } from "../assertions.js";
import { withConsoleLog } from "../_support/globals.js";
import { attachmentResult } from "../attachments/_support/result.js";
import { baseGeminiClientConfig } from "../gemini/_support/client-fixtures.js";

type ContextProviderCallbacks = {
	resolveAttachments: (
		plan: AttachmentPlan,
	) => AttachmentResolutionResult | Promise<AttachmentResolutionResult>;
	uploadTextFile?: (
		text: string,
		filename: string,
	) => FileRef | Promise<FileRef>;
};

type RecordedUpload = { text: string; filename: string };

function createContextProvider({
	resolveAttachments,
	uploadTextFile,
}: ContextProviderCallbacks) {
	if (typeof resolveAttachments !== "function") {
		throw new TypeError("resolveAttachments must be configured");
	}
	const calls: {
		resolveAttachments: AttachmentPlan[];
		uploadTextFile: RecordedUpload[];
	} = {
		resolveAttachments: [],
		uploadTextFile: [],
	};
	const provider: CompletionProvider = {
		supportsAuthenticatedSession: true,
		generateText() {
			throw new Error("unexpected context provider generateText call");
		},
		streamText() {
			throw new Error("unexpected context provider streamText call");
		},
		async resolveAttachments(plan) {
			calls.resolveAttachments.push(plan);
			return resolveAttachments(plan);
		},
		async uploadTextFile(text, filename) {
			calls.uploadTextFile.push({ text, filename });
			if (typeof uploadTextFile !== "function") {
				throw new Error("unexpected context provider uploadTextFile call");
			}
			return uploadTextFile(text, filename);
		},
	};
	return { calls, provider };
}

function requirePreparedContext(
	result: GeminiContextPrepareResult,
): PreparedGeminiContext & { error?: undefined } {
	if ("error" in result) throw result.error;
	return result;
}

function requireRecordedUpload(
	uploads: readonly RecordedUpload[],
	index: number,
): RecordedUpload {
	const upload = uploads[index];
	if (!upload) throw new Error(`expected upload at index ${index}`);
	return upload;
}

describe.sequential("OpenAI context preparation contract", () => {
	test("logs context-file metadata without leaking latest user text", async () => {
		const cfg = baseGeminiClientConfig({
			current_input_file_enabled: true,
			current_input_file_min_bytes: 40,
			current_input_file_name: "message.txt",
			current_tools_file_name: "tools.txt",
			cookie: "SID=ok",
			supports_authenticated_session: true,
			log_requests: true,
		});
		const logs: string[] = [];
		await withConsoleLog(
			(line: unknown) => logs.push(String(line)),
			async () => {
				const { calls, provider } = createContextProvider({
					resolveAttachments(plan) {
						assert.equal(plan.candidates.length, 0);
						return attachmentResult();
					},
					uploadTextFile(_text, filename) {
						return { ref: `/uploaded/${filename}`, name: filename };
					},
				});
				const result = requirePreparedContext(
					await prepareOpenAIGeminiContext(
						cfg,
						provider,
						{},
						parseOpenAIMessages([
							{ role: "user", content: "short latest secret" },
						]),
						createToolBundle([
							{
								type: "function",
								function: {
									name: "SecretSearchTool",
									parameters: { type: "object" },
								},
							},
						]),
						"auto",
						null,
						null,
					),
				);
				assert.equal(result.error, undefined);
				assert.equal(!!result.contextFiles, true);
				assert.equal(calls.resolveAttachments.length, 1);
				assert.equal(calls.uploadTextFile.length, 2);
				assert.match(
					result.prompt,
					/Continue from the latest state in the attached `message\.txt` context/,
				);
				assert.match(result.prompt, /tools\.txt/);
				assert.match(
					result.prompt,
					/All text above this sentence is system prompt content/,
				);
				assert.doesNotMatch(result.prompt, /Gemini native hidden tool calls/);
				assert.equal(
					requireRecordedUpload(calls.uploadTextFile, 1).filename,
					"tools.txt",
				);
				assert.match(
					requireRecordedUpload(calls.uploadTextFile, 1).text,
					/Gemini native hidden tool calls/,
				);
			},
		);
		const logText = logs.join("\n");
		assert.match(logText, /stage=context_file_upload/);
		assert.match(logText, /stage=context_prepare/);
		assert.doesNotMatch(logText, /short latest secret/);
		assert.doesNotMatch(logText, /SecretSearchTool/);
	});
	test("adds file-ref attachment bytes to prepared prompt token usage", async () => {
		const cfg = baseGeminiClientConfig({
			current_input_file_enabled: false,
			current_input_file_min_bytes: 1000000,
			current_input_file_name: "message.txt",
			current_tools_file_name: "tools.txt",
			cookie: "SID=ok",
			supports_authenticated_session: true,
			log_requests: false,
		});
		const messages = parseOpenAIMessages([
			{
				role: "user",
				content: [
					{ type: "input_text", text: "review this" },
					{
						type: "input_file",
						data: "YWJjZGVmZ2hp",
						filename: "nine.txt",
						mime_type: "text/plain",
					},
				],
			},
		]);
		const prepareWithFileRefBytes = async (
			fileRefBytes: number,
		): Promise<PreparedGeminiContext & { error?: undefined }> => {
			const { calls, provider } = createContextProvider({
				resolveAttachments(plan) {
					assert.equal(plan.candidates.length, 1);
					return attachmentResult({
						fileRefs: [{ ref: "/uploaded/nine", name: "nine.txt" }],
						genericFileRefs: [{ ref: "/uploaded/nine", name: "nine.txt" }],
						usage: {
							uploadedFiles: 1,
							dedupedFiles: 0,
							uploadedBytes: 9,
							fileRefBytes,
							inlinedFiles: 0,
							inlinedBytes: 0,
							droppedFiles: 0,
							multipartUploads: 1,
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
			assert.equal(calls.resolveAttachments.length, 1);
			assert.equal(calls.uploadTextFile.length, 0);
			return result;
		};
		const base = await prepareWithFileRefBytes(0);
		const withBytes = await prepareWithFileRefBytes(9);
		assert.equal(base.error, undefined);
		assert.equal(withBytes.error, undefined);
		assert.equal(withBytes.promptTokens, base.promptTokens + 3);
	});
});
