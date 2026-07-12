import { assert } from "./assertions.js";
import {
	attachmentResult,
	fakeProvider,
	mod,
	withConsoleLog,
} from "./helpers.js";

export const suiteName = "context";
export const cases = [
	[
		"resolves default models and rejects empty or unknown explicit models",
		async () => {
			assert.equal(
				mod.resolveModel(undefined, "gemini-3.5-flash").name,
				"gemini-3.5-flash",
			);
			assert.equal(
				mod.resolveModel("", "gemini-3.5-flash").error,
				"model (empty) is not available",
			);
			assert.equal(
				mod.resolveModel("not-a-model", "gemini-3.5-flash").error,
				"model not-a-model is not available",
			);
		},
	],
	[
		"logs context-file metadata without leaking latest user text",
		async () => {
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
					const result = await mod.prepareOpenAIGeminiContext(
						cfg,
						provider,
						{},
						[{ role: "user", content: "short latest secret" }],
						[
							{
								type: "function",
								function: {
									name: "SecretSearchTool",
									parameters: { type: "object" },
								},
							},
						],
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
		},
	],
	[
		"builds oversized inline context failure metadata",
		async () => {
			const check = mod.contextFilePromptByteCheck(
				{
					current_input_file_enabled: true,
					current_input_file_min_bytes: 10,
					supports_authenticated_session: false,
				},
				"x".repeat(40),
			);
			const err = mod.oversizedInlineContextFailure(
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
		},
	],
	[
		"decides context-file eligibility without requiring uploads",
		async () => {
			const cfg = {
				current_input_file_enabled: true,
				current_input_file_min_bytes: 10,
				current_input_file_name: "history.txt",
				supports_authenticated_session: true,
			};
			const check = mod.contextFilePromptByteCheck(cfg, "x".repeat(40));
			assert.equal(
				mod.contextFileThreshold({ current_input_file_min_bytes: -1 }),
				0,
			);
			assert.equal(
				mod.contextFileThreshold({
					current_input_file_min_bytes: "not-a-number",
				}),
				95000,
			);
			assert.equal(
				mod.shouldConsiderContextFiles(
					{ ...cfg, current_input_file_enabled: false },
					"x".repeat(40),
				),
				false,
			);
			assert.equal(
				mod.shouldConsiderContextFiles(
					{ ...cfg, supports_authenticated_session: false },
					"x".repeat(40),
				),
				false,
			);
			assert.equal(mod.shouldConsiderContextFiles(cfg, "short"), false);
			assert.equal(
				mod.shouldConsiderContextFiles(cfg, "x".repeat(40), check),
				true,
			);
			assert.equal(
				mod.shouldUseContextFiles(
					cfg,
					"history",
					"latest",
					"x".repeat(40),
					check,
				),
				true,
			);
			assert.equal(
				mod.shouldUseContextFiles(cfg, "", "latest", "x".repeat(40), check),
				false,
			);
			assert.equal(
				mod.shouldUseContextFiles(cfg, "history", "   ", "x".repeat(40), check),
				false,
			);
		},
	],
	[
		"formats latest context-file prompt around the inline byte limit",
		async () => {
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
			assert.equal(mod.latestInputInlineLimit(smallCfg), 4000);
			assert.equal(mod.latestInputInlineLimit(largeCfg), 16000);
			assert.equal(
				mod.latestInputPromptForContextFile(smallCfg, "  short latest  "),
				"Latest user request:\nshort latest",
			);
			assert.equal(mod.latestInputPromptForContextFile(smallCfg, "   "), "");
			const longPrompt = mod.latestInputPromptForContextFile(
				smallCfg,
				"x".repeat(5000),
			);
			assert.match(
				longPrompt,
				/latest user request is at the end of `conversation\.txt`/,
			);
			assert.doesNotMatch(longPrompt, /x{100}/);
		},
	],
	[
		"adds file-ref attachment bytes to prepared prompt token usage",
		async () => {
			const cfg = {
				current_input_file_enabled: false,
				current_input_file_min_bytes: 1000000,
				current_input_file_name: "message.txt",
				current_tools_file_name: "tools.txt",
				cookie: "SID=ok",
				supports_authenticated_session: true,
				log_requests: false,
			};
			const messages = [
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
			];
			const prepareWithFileRefBytes = (fileRefBytes) =>
				mod.prepareOpenAIGeminiContext(
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
		},
	],
	[
		"returns upload failure metadata when large context has no uploader",
		async () => {
			const cfg = {
				current_input_file_enabled: true,
				current_input_file_min_bytes: 10,
				current_input_file_name: "message.txt",
				current_tools_file_name: "tools.txt",
				cookie: "SID=ok",
				supports_authenticated_session: true,
			};
			const check = mod.contextFilePromptByteCheck(cfg, "x".repeat(40));
			const result = await mod.prepareContextFiles(
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

			const direct = mod.contextFileUploadFailure(
				"tools",
				"short",
				"network down",
			);
			assert.equal(direct.code, "large_context_file_upload_failed");
			assert.equal(direct.promptBytes, 5);
			assert.equal(direct.promptBytesExact, true);
			assert.equal(direct.cause, "network down");
		},
	],
	[
		"refuses oversized inline fallback when history context upload fails",
		async () => {
			const cfg = {
				current_input_file_enabled: true,
				current_input_file_min_bytes: 10,
				current_input_file_name: "message.txt",
				current_tools_file_name: "tools.txt",
				cookie: "SID=ok",
				supports_authenticated_session: true,
				log_requests: false,
			};
			const result = await mod.prepareContextFilesWithUploader(
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
		},
	],
	[
		"refuses oversized inline fallback when tools context upload fails",
		async () => {
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
			const result = await mod.prepareContextFilesWithUploader(
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
		},
	],
	[
		"guards inline tool prompts without duplicating known metadata",
		async () => {
			const tools = [
				{
					name: "Read",
					description: "Read a file",
					parameters: { type: "object" },
				},
			];
			const instruction =
				'\n\nIMPORTANT: You MUST call the tool "Read". Do not call other tools.';
			const alreadyPrepared =
				"Available tools:\n[]\n\n<|DSML|tool_calls>\nuser prompt";
			assert.equal(
				mod.ensureInlineToolPrompt(alreadyPrepared, tools, instruction, null, {
					hasToolPrompt: true,
					hasToolInstructions: true,
				}),
				alreadyPrepared,
			);
			assert.equal(
				mod.ensureInlineToolPrompt(alreadyPrepared, tools, instruction),
				alreadyPrepared,
			);

			const guarded = mod.ensureInlineToolPrompt(
				"user prompt",
				tools,
				instruction,
			);
			assert.match(guarded, /Available tools/);
			assert.match(guarded, /"name": "Read"/);
			assert.match(guarded, /You MUST call the tool "Read"/);
			assert.match(guarded, /user prompt/);
			assert.doesNotMatch(guarded, /Gemini native hidden tool calls/);
		},
	],
	[
		"guards context-file prompts with instructions but without inline schemas",
		async () => {
			const tools = [
				{
					name: "Read",
					description: "Read a file",
					parameters: { type: "object" },
				},
			];
			const instruction =
				"\n\nIMPORTANT: You MUST call at least one tool. Do not respond with text only.";
			const guarded = mod.ensureInlineToolPrompt(
				"Continue from the latest state in the attached tools.txt context",
				tools,
				instruction,
				{ fileRefs: [] },
			);
			assert.doesNotMatch(guarded, /Available tools/);
			assert.match(guarded, /<\|DSML\|tool_calls>/);
			assert.match(guarded, /You MUST call at least one tool/);
			assert.match(guarded, /Continue from the latest state/);

			assert.equal(
				mod.ensureInlineToolPrompt(
					"Continue from the latest state",
					tools,
					instruction,
					{ fileRefs: [] },
					{
						hasToolInstructions: true,
					},
				),
				"Continue from the latest state",
			);
		},
	],
	[
		"adds missing tool-choice instruction once when no tools are declared",
		async () => {
			const instruction =
				"\n\nIMPORTANT: Do NOT call any tools. Respond with text only.";
			const guarded = mod.ensureInlineToolPrompt(
				"plain prompt",
				null,
				instruction,
			);
			assert.match(guarded, /^\s*IMPORTANT: Do NOT call any tools/);
			assert.match(guarded, /plain prompt$/);
			assert.equal(
				mod.ensureInlineToolPrompt(guarded, null, instruction, {
					fileRefs: [],
				}),
				guarded,
			);
		},
	],
	[
		"rejects configured JSON body limits before account or provider work",
		async () => {
			const paths = [
				"/v1/chat/completions",
				"/v1beta/models/gemini-3.5-flash:generateContent",
			];
			for (const path of paths) {
				let d1Reads = 0;
				const resp = await mod.default.fetch(
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
		},
	],
	[
		"cancels streamed JSON bodies at the configured application limit",
		async () => {
			let canceled = false;
			const result = await mod.readRouteJsonPost(
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
		},
	],
	[
		"rejects oversized chat body by Content-Length before JSON parsing",
		async () => {
			const bodyText = "x".repeat(40);
			const resp = await mod.default.fetch(
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
		},
	],
	[
		"rejects oversized streamed chat body before JSON parsing",
		async () => {
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
			const resp = await mod.default.fetch(
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
		},
	],
	[
		"parses image request bodies that exceed the inline prompt threshold",
		async () => {
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
			const result = await mod.readRouteJsonPost(
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
		},
	],
	[
		"rejects oversized parsed chat prompt without attachments",
		async () => {
			const resp = await mod.default.fetch(
				new Request("https://worker.example/v1/chat/completions", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						model: "gemini-3.5-flash",
						messages: [{ role: "user", content: "x".repeat(40) }],
					}),
				}),
				{
					API_KEYS: "",
					CURRENT_INPUT_FILE_ENABLED: "false",
					CURRENT_INPUT_FILE_MIN_BYTES: "10",
					GEMINI_DB: {
						prepare() {
							throw new Error("oversized inline rejection should not read D1");
						},
					},
					LOG_REQUESTS: "false",
				},
				{},
			);
			assert.equal(resp.status, 422);
			const body = await resp.json();
			assert.equal(body.error.code, "large_context_inline_unsupported");
			assert.match(body.error.message, /at least 40 UTF-8 bytes > 10/);
		},
	],
	[
		"formats OpenAI and Google response helper payloads",
		async () => {
			const chatChunk = mod.openAIChatChunk(
				"chatcmpl_test",
				"gemini-3.5-flash",
				{ content: "hi" },
				null,
			);
			assert.equal(chatChunk.object, "chat.completion.chunk");
			assert.equal(chatChunk.choices[0].delta.content, "hi");
			assert.deepEqual(mod.openAIChatUsageFromCompletionTokens(-1, "2"), {
				prompt_tokens: 0,
				completion_tokens: 2,
				total_tokens: 2,
			});

			const output = mod.buildResponsesOutput(
				"done",
				[
					{
						id: "call_1",
						function: { name: "Lookup", arguments: '{"id":"1"}' },
					},
				],
				"msg_1",
			);
			assert.equal(output[0].type, "function_call");
			assert.equal(output[1].type, "message");

			const google = mod.googleGenerateContentResponse({
				model: "gemini-3.5-flash",
				responseParts: [{ text: "done" }],
				promptTokens: 2,
				candidateTokens: 1,
				upstreamEmpty: true,
				warning: { code: "upstream_empty" },
			});
			assert.equal(google.promptFeedback.warning.code, "upstream_empty");
			assert.equal(
				mod.googleStreamDonePayload("gemini-3.5-flash", 2, 1).usageMetadata
					.totalTokenCount,
				3,
			);
		},
	],
];
