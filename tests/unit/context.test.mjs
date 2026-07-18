import { beforeEach, describe, test } from "vitest";
import { prepareOpenAIGeminiContext } from "../../src/completion/context";
import {
	contextFilePromptByteCheck,
	contextFileThreshold,
	contextFileUploadFailure,
	latestInputInlineLimit,
	latestInputPromptForContextFile,
	oversizedInlineContextFailure,
	prepareContextFiles,
	prepareContextFilesWithUploader,
	shouldConsiderContextFiles,
	shouldUseContextFiles,
} from "../../src/completion/context-files";
import { ensureInlineToolPrompt } from "../../src/completion/tool-prompt-guard";
import { readRouteJsonPost } from "../../src/http/route-body";
import worker from "../../src/index";
import {
	geminiRouteKey,
	knownTierLabel,
	parseGeminiRouteKey,
} from "../../src/gemini/accounts/routes";
import { dynamicProviderModelCandidates, resolveModel } from "../../src/models";
import { parseOpenAIMessages } from "../../src/promptcompat/message-model";
import { createToolBundle } from "../../src/toolcall/tool-bundle";
import { assert } from "./assertions.js";
import {
	attachmentResult,
	fakeProvider,
	resetTestState,
	withConsoleLog,
} from "./helpers.js";

describe("context", () => {
	beforeEach(resetTestState);
	test("resolves default models and rejects empty or unknown explicit models", async () => {
		assert.equal(
			resolveModel(undefined, "gemini-3.5-flash").name,
			"gemini-3.5-flash",
		);
		assert.equal(
			resolveModel("", "gemini-3.5-flash").error,
			"model (empty) is not available",
		);
		assert.equal(
			resolveModel("not-a-model", "gemini-3.5-flash").error,
			"model not-a-model is not available",
		);
	});
	test("round-trips exact Gemini routes and preserves dynamic suffix ambiguity", async () => {
		const route = {
			providerModelId: "future-model-extended",
			capacity: 3,
			capacityField: 13,
			modelNumber: 7,
		};
		assert.deepEqual(parseGeminiRouteKey(geminiRouteKey(route)), route);
		assert.deepEqual(dynamicProviderModelCandidates("future-model-extended"), [
			{ providerModelId: "future-model-extended", extended: false },
			{ providerModelId: "future-model", extended: true },
		]);
		assert.equal(
			knownTierLabel({
				providerModelId: "56fdd199312815e2",
				capacity: 4,
				capacityField: 12,
			}),
			"Plus",
		);
	});
	test("logs context-file metadata without leaking latest user text", async () => {
		const cfg = {
			current_input_file_enabled: true,
			current_input_file_min_bytes: 40,
			current_input_file_name: "message.txt",
			current_tools_file_name: "tools.txt",
			cookie: "SID=ok",
			supports_authenticated_session: true,
			log_requests: true,
		};
		const logs = [];
		await withConsoleLog(
			(line) => logs.push(String(line)),
			async () => {
				const uploads = [];
				const provider = fakeProvider({
					async generateText() {
						return "";
					},
					async uploadTextFile(text, filename) {
						uploads.push({ text, filename });
						return { ref: `/uploaded/${filename}`, name: filename };
					},
				});
				const result = await prepareOpenAIGeminiContext(
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
				);
				assert.equal(result.error, undefined);
				assert.equal(!!result.contextFiles, true);
				assert.equal(uploads.length, 2);
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
				assert.equal(uploads[1].filename, "tools.txt");
				assert.match(uploads[1].text, /Gemini native hidden tool calls/);
			},
		);
		const logText = logs.join("\n");
		assert.match(logText, /stage=context_file_upload/);
		assert.match(logText, /stage=context_prepare/);
		assert.doesNotMatch(logText, /short latest secret/);
		assert.doesNotMatch(logText, /SecretSearchTool/);
	});
	test("builds oversized inline context failure metadata", async () => {
		const check = contextFilePromptByteCheck(
			{
				current_input_file_enabled: true,
				current_input_file_min_bytes: 10,
				supports_authenticated_session: false,
			},
			"x".repeat(40),
		);
		const err = oversizedInlineContextFailure(
			{
				current_input_file_enabled: true,
				current_input_file_min_bytes: 10,
				supports_authenticated_session: false,
			},
			"x".repeat(40),
			check,
		);
		assert.equal(err.code, "gemini_authenticated_session_required");
		assert.equal(err.status, 422);
		assert.equal(err.reason, "large_context");
		assert.equal(err.promptBytes, 11);
		assert.equal(err.promptBytesExact, false);
		assert.match(err.message, /at least 11 UTF-8 bytes > 10/);
	});
	test("decides context-file eligibility without requiring uploads", async () => {
		const cfg = {
			current_input_file_enabled: true,
			current_input_file_min_bytes: 10,
			current_input_file_name: "history.txt",
			supports_authenticated_session: true,
		};
		const check = contextFilePromptByteCheck(cfg, "x".repeat(40));
		assert.equal(contextFileThreshold({ current_input_file_min_bytes: -1 }), 0);
		assert.equal(
			contextFileThreshold({
				current_input_file_min_bytes: "not-a-number",
			}),
			95000,
		);
		assert.equal(
			shouldConsiderContextFiles(
				{ ...cfg, current_input_file_enabled: false },
				"x".repeat(40),
			),
			false,
		);
		assert.equal(
			shouldConsiderContextFiles(
				{ ...cfg, supports_authenticated_session: false },
				"x".repeat(40),
			),
			false,
		);
		assert.equal(shouldConsiderContextFiles(cfg, "short"), false);
		assert.equal(shouldConsiderContextFiles(cfg, "x".repeat(40), check), true);
		assert.equal(
			shouldUseContextFiles(cfg, "history", "latest", "x".repeat(40), check),
			true,
		);
		assert.equal(
			shouldUseContextFiles(cfg, "", "latest", "x".repeat(40), check),
			false,
		);
		assert.equal(
			shouldUseContextFiles(cfg, "history", "   ", "x".repeat(40), check),
			false,
		);
	});
	test("formats latest context-file prompt around the inline byte limit", async () => {
		const smallCfg = {
			current_input_file_enabled: true,
			current_input_file_min_bytes: 12,
			current_input_file_name: "conversation.txt",
			cookie: "SID=ok",
		};
		const largeCfg = {
			current_input_file_enabled: true,
			current_input_file_min_bytes: 120000,
			current_input_file_name: "conversation.txt",
			cookie: "SID=ok",
		};
		assert.equal(latestInputInlineLimit(smallCfg), 4000);
		assert.equal(latestInputInlineLimit(largeCfg), 16000);
		assert.equal(
			latestInputPromptForContextFile(smallCfg, "  short latest  "),
			"Latest user request:\nshort latest",
		);
		assert.equal(latestInputPromptForContextFile(smallCfg, "   "), "");
		const longPrompt = latestInputPromptForContextFile(
			smallCfg,
			"x".repeat(5000),
		);
		assert.match(
			longPrompt,
			/latest user request is at the end of `conversation\.txt`/,
		);
		assert.doesNotMatch(longPrompt, /x{100}/);
	});
	test("adds file-ref attachment bytes to prepared prompt token usage", async () => {
		const cfg = {
			current_input_file_enabled: false,
			current_input_file_min_bytes: 1000000,
			current_input_file_name: "message.txt",
			current_tools_file_name: "tools.txt",
			cookie: "SID=ok",
			supports_authenticated_session: true,
			log_requests: false,
		};
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
		const prepareWithFileRefBytes = (fileRefBytes) =>
			prepareOpenAIGeminiContext(
				cfg,
				fakeProvider({
					async resolveAttachments(plan) {
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
				}),
				{},
				messages,
				null,
				"auto",
				null,
				null,
			);
		const base = await prepareWithFileRefBytes(0);
		const withBytes = await prepareWithFileRefBytes(9);
		assert.equal(base.error, undefined);
		assert.equal(withBytes.error, undefined);
		assert.equal(withBytes.promptTokens, base.promptTokens + 3);
	});
	test("returns upload failure metadata when large context has no uploader", async () => {
		const cfg = {
			current_input_file_enabled: true,
			current_input_file_min_bytes: 10,
			current_input_file_name: "message.txt",
			current_tools_file_name: "tools.txt",
			cookie: "SID=ok",
			supports_authenticated_session: true,
		};
		const check = contextFilePromptByteCheck(cfg, "x".repeat(40));
		const result = await prepareContextFiles(
			cfg,
			"prior conversation",
			null,
			"",
			"latest request",
			"x".repeat(40),
			undefined,
			check,
		);
		assert.equal(result.error.code, "large_context_file_upload_failed");
		assert.equal(result.error.promptBytes, 11);
		assert.equal(result.error.promptBytesExact, false);
		assert.equal(result.error.thresholdBytes, 10);
		assert.match(
			result.error.cause.message,
			/text file uploader is not configured/,
		);

		const direct = contextFileUploadFailure("tools", "short", "network down");
		assert.equal(direct.code, "large_context_file_upload_failed");
		assert.equal(direct.promptBytes, 5);
		assert.equal(direct.promptBytesExact, true);
		assert.equal(direct.cause, "network down");
	});
	test("refuses oversized inline fallback when history context upload fails", async () => {
		const cfg = {
			current_input_file_enabled: true,
			current_input_file_min_bytes: 10,
			current_input_file_name: "message.txt",
			current_tools_file_name: "tools.txt",
			cookie: "SID=ok",
			supports_authenticated_session: true,
			log_requests: false,
		};
		const result = await prepareContextFilesWithUploader(
			cfg,
			"prior conversation",
			null,
			"",
			"latest request",
			"x".repeat(40),
			async () => {
				throw new Error("history upload broke");
			},
		);
		assert.equal(result.error.code, "large_context_file_upload_failed");
		assert.match(
			result.error.message,
			/failed to upload history context text file/,
		);
		assert.match(result.error.cause.message, /history upload broke/);
	});
	test("refuses oversized inline fallback when tools context upload fails", async () => {
		const cfg = {
			current_input_file_enabled: true,
			current_input_file_min_bytes: 10,
			current_input_file_name: "message.txt",
			current_tools_file_name: "tools.txt",
			cookie: "SID=ok",
			supports_authenticated_session: true,
			log_requests: false,
		};
		const uploads = [];
		const result = await prepareContextFilesWithUploader(
			cfg,
			"prior conversation",
			[
				{
					name: "Read",
					description: "Read a file",
					parameters: { type: "object" },
				},
			],
			"must call Read",
			"latest request",
			"x".repeat(40),
			async (text, filename) => {
				uploads.push({ text, filename });
				if (filename === "tools.txt") throw new Error("tools upload broke");
				return { ref: `/uploaded/${filename}`, name: filename };
			},
		);
		assert.equal(uploads.length, 2);
		assert.equal(result.error.code, "large_context_file_upload_failed");
		assert.match(
			result.error.message,
			/failed to upload tools context text file/,
		);
		assert.match(result.error.cause.message, /tools upload broke/);
	});
	test("guards inline tool prompts without duplicating known metadata", async () => {
		const tools = createToolBundle([
			{
				name: "Read",
				description: "Read a file",
				parameters: { type: "object" },
			},
		]);
		const instruction =
			'\n\nIMPORTANT: You MUST call the tool "Read". Do not call other tools.';
		const alreadyPrepared =
			"Available tools:\n[]\n\n<|DSML|tool_calls>\nuser prompt";
		assert.equal(
			ensureInlineToolPrompt(alreadyPrepared, tools, instruction, null, {
				hasToolPrompt: true,
				hasToolInstructions: true,
			}),
			alreadyPrepared,
		);
		assert.equal(
			ensureInlineToolPrompt(alreadyPrepared, tools, instruction, null, {
				hasToolPrompt: true,
				hasToolInstructions: true,
			}),
			alreadyPrepared,
		);

		const guarded = ensureInlineToolPrompt(
			"user prompt",
			tools,
			instruction,
			null,
			{
				hasToolPrompt: false,
				hasToolInstructions: false,
			},
		);
		assert.match(guarded, /Available tools/);
		assert.match(guarded, /"name": "Read"/);
		assert.match(guarded, /You MUST call the tool "Read"/);
		assert.match(guarded, /user prompt/);
		assert.doesNotMatch(guarded, /Gemini native hidden tool calls/);
	});
	test("guards context-file prompts with instructions but without inline schemas", async () => {
		const tools = createToolBundle([
			{
				name: "Read",
				description: "Read a file",
				parameters: { type: "object" },
			},
		]);
		const instruction =
			"\n\nIMPORTANT: You MUST call at least one tool. Do not respond with text only.";
		const guarded = ensureInlineToolPrompt(
			"Continue from the latest state in the attached tools.txt context",
			tools,
			instruction,
			{ fileRefs: [] },
			{ hasToolPrompt: false, hasToolInstructions: false },
		);
		assert.doesNotMatch(guarded, /Available tools/);
		assert.match(guarded, /<\|DSML\|tool_calls>/);
		assert.match(guarded, /You MUST call at least one tool/);
		assert.match(guarded, /Continue from the latest state/);

		assert.equal(
			ensureInlineToolPrompt(
				"Continue from the latest state",
				tools,
				instruction,
				{ fileRefs: [] },
				{
					hasToolPrompt: false,
					hasToolInstructions: true,
				},
			),
			"Continue from the latest state",
		);
	});
	test("adds missing tool-choice instruction once when no tools are declared", async () => {
		const instruction =
			"\n\nIMPORTANT: Do NOT call any tools. Respond with text only.";
		const guarded = ensureInlineToolPrompt(
			"plain prompt",
			null,
			instruction,
			null,
			{
				hasToolPrompt: false,
				hasToolInstructions: false,
			},
		);
		assert.match(guarded, /^\s*IMPORTANT: Do NOT call any tools/);
		assert.match(guarded, /plain prompt$/);
		assert.equal(
			ensureInlineToolPrompt(
				guarded,
				null,
				instruction,
				{
					fileRefs: [],
				},
				{ hasToolPrompt: false, hasToolInstructions: false },
			),
			guarded,
		);
	});
	test("rejects configured JSON body limits before account or provider work", async () => {
		const paths = [
			"/v1/chat/completions",
			"/v1beta/models/gemini-3.5-flash:generateContent",
		];
		for (const path of paths) {
			let d1Reads = 0;
			const resp = await worker.fetch(
				new Request(`https://worker.example${path}`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"Content-Length": "11",
					},
					body: "12345678901",
				}),
				{
					API_KEYS: "",
					REQUEST_BODY_MAX_BYTES: "10",
					GEMINI_DB: {
						prepare() {
							d1Reads += 1;
							throw new Error("oversized JSON should not read D1");
						},
					},
				},
				{},
			);
			assert.equal(resp.status, 413);
			const body = await resp.json();
			assert.equal(body.error.code, "request_body_too_large");
			assert.equal(d1Reads, 0);
		}
	});
	test("cancels streamed JSON bodies at the configured application limit", async () => {
		let canceled = false;
		const result = await readRouteJsonPost(
			new Request("https://worker.example/v1/responses", {
				method: "POST",
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('{"x":"12345"'));
					},
					cancel() {
						canceled = true;
					},
				}),
				duplex: "half",
			}),
			{
				current_input_file_enabled: true,
				request_body_max_bytes: 10,
				supports_authenticated_session: true,
			},
			"/v1/responses",
		);
		assert.equal(result.status, 413);
		assert.equal(result.code, "request_body_too_large");
		assert.equal(canceled, true);
	});
	test("rejects oversized chat body by Content-Length before JSON parsing", async () => {
		const bodyText = "x".repeat(40);
		const resp = await worker.fetch(
			new Request("https://worker.example/v1/chat/completions", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Content-Length": String(bodyText.length),
				},
				body: bodyText,
			}),
			{
				API_KEYS: "",
				CURRENT_INPUT_FILE_ENABLED: "true",
				CURRENT_INPUT_FILE_MIN_BYTES: "10",
				GENERIC_FILE_UPLOAD_MAX_BYTES: "0",
				LOG_REQUESTS: "false",
			},
			{},
		);
		assert.equal(resp.status, 422);
		const body = await resp.json();
		assert.equal(body.error.code, "gemini_authenticated_session_required");
		assert.equal(body.error.reason, "large_context");
		assert.match(body.error.message, /40 bytes > inline read limit 10/);
	});
	test("rejects oversized streamed chat body before JSON parsing", async () => {
		const encoder = new TextEncoder();
		const bodyStream = new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode('{"messages":['));
				controller.enqueue(
					encoder.encode("not valid json but already too large"),
				);
				controller.close();
			},
		});
		const resp = await worker.fetch(
			new Request("https://worker.example/v1/chat/completions", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: bodyStream,
				duplex: "half",
			}),
			{
				API_KEYS: "",
				CURRENT_INPUT_FILE_ENABLED: "true",
				CURRENT_INPUT_FILE_MIN_BYTES: "10",
				GENERIC_FILE_UPLOAD_MAX_BYTES: "0",
				LOG_REQUESTS: "false",
			},
			{},
		);
		assert.equal(resp.status, 422);
		const body = await resp.json();
		assert.equal(body.error.code, "gemini_authenticated_session_required");
		assert.match(body.error.message, /exceeds inline read limit 10/);
	});
	test("parses image request bodies that exceed the inline prompt threshold", async () => {
		const body = JSON.stringify({
			model: "gemini-3.5-flash",
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "describe this" },
						{
							type: "image_url",
							image_url: { url: `data:image/png;base64,${"A".repeat(80)}` },
						},
					],
				},
			],
		});
		assert.equal(body.length > 40, true);
		const result = await readRouteJsonPost(
			new Request("https://worker.example/v1/chat/completions", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Content-Length": String(body.length),
				},
				body,
			}),
			{
				current_input_file_enabled: true,
				current_input_file_min_bytes: 40,
				generic_file_upload_max_bytes: 1024,
				cookie: "",
				log_requests: false,
			},
			"/v1/chat/completions",
		);
		assert.equal(result.error, undefined);
		assert.equal(result.value.messages[0].content[0].text, "describe this");
	});
});
