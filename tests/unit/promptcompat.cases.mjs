import { assert } from "./assertions.js";
import { mod } from "./helpers.js";

export const suiteName = "prompt compatibility";
export const cases = [
	[
		"normalizes Responses reasoning tool calls and outputs in order",
		async () => {
			const messages = mod.normalizeResponsesInputValueAsMessages([
				{
					type: "reasoning",
					summary: [{ type: "summary_text", text: "checked cache" }],
				},
				{
					type: "function_call",
					call_id: "call_1",
					name: "Lookup",
					arguments: { id: 7 },
				},
				{
					type: "function_call",
					call_id: "call_2",
					name: "Read",
					input: { path: "README.md" },
				},
				{
					type: "function_call_output",
					call_id: "call_1",
					output: { ok: true },
				},
				"follow up",
				42,
			]);
			assert.equal(messages[0].role, "assistant");
			assert.match(messages[0].reasoning_content, /checked cache/);
			assert.equal(messages[0].tool_calls.length, 2);
			assert.equal(messages[0].tool_calls[0].function.name, "Lookup");
			assert.equal(messages[0].tool_calls[1].function.name, "Read");
			assert.equal(messages[1].role, "tool");
			assert.equal(messages[1].name, "Lookup");
			assert.deepEqual(messages[2], { role: "user", content: "follow up\n42" });
		},
	],
	[
		"normalizes Responses assistant content parts and instructions",
		async () => {
			const messages = mod.responsesMessagesFromRequest({
				instructions: "be brief",
				input: [
					{
						type: "message",
						role: "assistant",
						content: [
							{ type: "reasoning", summary: "internal chain" },
							{ type: "output_text", text: "visible answer" },
							{
								type: "function_call",
								call_id: "call_3",
								name: "Search",
								input: { query: "docs" },
							},
						],
					},
				],
			});
			assert.deepEqual(messages[0], { role: "system", content: "be brief" });
			assert.equal(messages[1].role, "assistant");
			assert.equal(messages[1].content, "visible answer");
			assert.equal(messages[1].reasoning_content, "internal chain");
			assert.equal(messages[1].tool_calls[0].function.name, "Search");
		},
	],
	[
		"stringifies unrepresentable Responses tool arguments as empty object",
		async () => {
			const cyclic = {};
			cyclic.self = cyclic;
			assert.equal(mod.stringifyToolCallArguments(cyclic), "{}");
			assert.equal(mod.stringifyToolCallArguments("raw"), "raw");
			assert.equal(mod.stringifyToolCallArguments(null), "{}");
		},
	],
	[
		"normalizes Responses messages instructions and sparse items",
		async () => {
			assert.deepEqual(
				mod.responsesMessagesFromRequest({
					instructions: "  stay factual  ",
					messages: [{ role: "user", text: "hello" }],
				}),
				[
					{ role: "system", content: "stay factual" },
					{ role: "user", text: "hello" },
				],
			);
			assert.equal(mod.normalizeResponsesInputValueAsMessages(null), null);
			assert.equal(mod.normalizeResponsesInputValueAsMessages("   "), null);
			assert.equal(
				mod.normalizeResponsesInputValueAsMessages({ type: "function_call" }),
				null,
			);
			assert.deepEqual(
				mod.normalizeResponsesInputValueAsMessages({
					type: "input_message",
					text: "fallback text",
				}),
				[{ role: "user", content: "fallback text" }],
			);
			assert.deepEqual(
				mod.normalizeResponsesInputValueAsMessages({
					role: "function",
					call_id: "call_7",
					name: "Lookup",
					content: "ok",
				}),
				[
					{
						role: "tool",
						content: "ok",
						tool_call_id: "call_7",
						name: "Lookup",
					},
				],
			);
		},
	],
	[
		"normalizes additional Responses item shapes without accepting unknown objects",
		async () => {
			const messages = mod.normalizeResponsesInputValueAsMessages([
				{ type: "message", role: "assistant", text: "assistant text" },
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call_existing",
							type: "function",
							function: { name: "Existing", arguments: '{"ok":true}' },
						},
					],
				},
				{
					type: "function_call",
					id: "call_nested",
					function: { name: "Nested", arguments: { query: "docs" } },
				},
				{ type: "tool_result", id: "call_nested", content: "nested result" },
				{ type: "output_text", text: "visible output" },
				{ type: "custom_event", text: "ignored text" },
				{ text: "ignored bare text" },
			]);

			assert.equal(messages[0].role, "assistant");
			assert.equal(messages[0].content, "assistant text");
			assert.equal(messages[1].tool_calls[0].function.name, "Existing");
			assert.equal(messages[1].tool_calls[1].id, "call_nested");
			assert.equal(messages[1].tool_calls[1].function.name, "Nested");
			assert.deepEqual(
				JSON.parse(messages[1].tool_calls[1].function.arguments),
				{ query: "docs" },
			);
			assert.deepEqual(messages[2], {
				role: "tool",
				tool_call_id: "call_nested",
				name: "Nested",
				content: "nested result",
			});
			assert.deepEqual(messages[3], {
				role: "user",
				content: "visible output",
			});
			assert.equal(messages.length, 4);
		},
	],
	[
		"validates Responses input strictly before normalization",
		async () => {
			assert.deepEqual(mod.normalizeResponsesInputAsMessagesStrict("bad"), {
				error: "request body must be a JSON object",
			});
			assert.deepEqual(
				mod.normalizeResponsesInputAsMessagesStrict({ input: "hello" }),
				{ messages: [{ role: "user", content: "hello" }] },
			);
			assert.deepEqual(
				mod.normalizeResponsesInputAsMessagesStrict({
					input: { role: "user", text: "hello" },
				}),
				{ messages: [{ role: "user", content: "hello" }] },
			);
			assert.deepEqual(
				mod.normalizeResponsesInputAsMessagesStrict({
					input: { role: "bogus", content: "x" },
				}),
				{ messages: [{ role: "bogus", content: "x" }] },
			);

			const invalidInputs = [
				[{ input: [""] }, /item 0 is empty/],
				[{ input: [42] }, /item 0 must be a supported object or string/],
				[{ input: [{ role: "tool" }] }, /tool message requires content/],
				[{ input: [{ role: "user" }] }, /message requires content/],
				[
					{ input: [{ role: "assistant" }] },
					/assistant message requires content or tool calls/,
				],
				[{ input: [{ type: "message" }] }, /message requires content/],
				[{ input: [{ type: "tool_result" }] }, /tool result requires output/],
				[{ input: [{ type: "function_call" }] }, /function call requires name/],
				[{ input: [{ type: "reasoning" }] }, /reasoning item requires text/],
				[
					{ input: [{ type: "input_text", text: "" }] },
					/text item requires text/,
				],
				[
					{ input: [{ type: "custom_event", text: "ignored" }] },
					/unsupported type: custom_event/,
				],
				[{ input: true }, /must be a string, object, or array/],
			];
			for (const [req, pattern] of invalidInputs) {
				const result = mod.normalizeResponsesInputAsMessagesStrict(req);
				assert.match(result.error, pattern);
			}
		},
	],
	[
		"preserves top-level Responses input_file items for upload collection",
		async () => {
			const messages = mod.normalizeResponsesInputValueAsMessages([
				{ type: "input_text", text: "review this" },
				{
					type: "input_file",
					filename: "../note.txt",
					data: "aGVsbG8=",
					mime_type: "text/plain",
				},
			]);
			assert.deepEqual(messages, [
				{ role: "user", content: "review this" },
				{
					role: "user",
					content: [
						{
							type: "input_file",
							filename: "../note.txt",
							data: "aGVsbG8=",
							mime_type: "text/plain",
						},
					],
				},
			]);

			const result = mod.messagesToPrompt(
				messages,
				null,
				"auto",
				[],
				"",
				1000000,
			);
			assert.match(result[0], /\[file input note\.txt\]/);
			assert.deepEqual(result.files, [
				{ b64: "aGVsbG8=", mime: "text/plain", filename: "note.txt" },
			]);
		},
	],
	[
		"merges Responses reasoning-only items into following assistant tool calls",
		async () => {
			const messages = mod.normalizeResponsesInputValueAsMessages([
				{ type: "reasoning", text: "first thought" },
				{
					type: "thinking",
					content: [{ type: "summary_text", text: "second thought" }],
				},
				{
					type: "function_call",
					call_id: "call_1",
					name: "Lookup",
					arguments: { id: "1" },
				},
				{ type: "tool_result", call_id: "call_1", output: "done" },
			]);
			assert.equal(messages[0].role, "assistant");
			assert.match(messages[0].reasoning_content, /first thought/);
			assert.match(messages[0].reasoning_content, /second thought/);
			assert.equal(messages[0].tool_calls[0].function.name, "Lookup");
			assert.equal(messages[1].role, "tool");
			assert.equal(messages[1].name, "Lookup");
		},
	],
	[
		"builds OpenAI history transcript with reasoning tool call and tool metadata",
		async () => {
			const transcript = mod.buildOpenAIHistoryTranscript(
				[
					{ role: "system", content: "system guide" },
					{
						role: "user",
						content: [
							{ type: "text", text: "hello" },
							{ type: "input_image", image_url: "data:image/png;base64,AAAA" },
						],
					},
					{
						role: "assistant",
						content: "I will read it",
						reasoning_content: "need file",
						tool_calls: [
							{
								function: {
									name: "Read",
									arguments: '{"file_path":"README.md"}',
								},
							},
						],
					},
					{
						role: "tool",
						name: "Read",
						tool_call_id: "call_1",
						content: { ok: true },
					},
				],
				"history.txt",
			);
			assert.match(transcript, /# history\.txt/);
			assert.match(transcript, /=== 1\. SYSTEM ===/);
			assert.match(transcript, /\[reasoning_content\]\nneed file/);
			assert.match(
				transcript,
				/<\|DSML\|tool_calls><\|DSML\|invoke name="Read">/,
			);
			assert.match(transcript, /\[name=Read tool_call_id=call_1\]/);
			assert.match(transcript, /\{"ok":true\}/);
		},
	],
	[
		"returns empty history transcripts for invalid or contentless inputs",
		async () => {
			assert.equal(mod.buildOpenAIHistoryTranscript(null, "empty.txt"), "");
			assert.equal(
				mod.buildOpenAIHistoryTranscript(
					[{ role: "assistant", content: "" }],
					"empty.txt",
				),
				"",
			);
			assert.equal(mod.latestOpenAIUserInputText(null), "");
			assert.equal(
				mod.latestOpenAIUserInputText([
					{ role: "assistant", content: "answer" },
				]),
				"",
			);
		},
	],
	[
		"builds Google history transcript and latest user text from rich parts",
		async () => {
			const req = {
				systemInstruction: {
					parts: [{ text: "be concise" }, { ignored: true }],
				},
				contents: [
					{
						role: "user",
						parts: [{ text: "inspect" }, { inlineData: { data: "AAAA" } }],
					},
					{
						role: "model",
						parts: [{ functionCall: { name: "Lookup", args: { id: "1" } } }],
					},
					{
						role: "user",
						parts: [
							{ functionResponse: { name: "Lookup", response: { ok: true } } },
						],
					},
					{
						role: "user",
						parts: [
							{ fileData: { fileUri: "gemini://file/1" } },
							{ text: "latest" },
						],
					},
				],
			};
			const transcript = mod.buildGoogleHistoryTranscript(req, "google.txt");
			assert.match(transcript, /be concise/);
			assert.match(transcript, /\[image input\]/);
			assert.match(
				transcript,
				/<\|DSML\|tool_calls><\|DSML\|invoke name="Lookup">/,
			);
			assert.match(transcript, /\[name=Lookup\]\n\{"ok":true\}/);
			assert.match(transcript, /\[file input gemini:\/\/file\/1\]\nlatest/);
			assert.equal(
				mod.latestGoogleUserInputText(req),
				"[file input gemini://file/1]\nlatest",
			);
		},
	],
	[
		"extracts latest Google user text from image and file-only turns",
		async () => {
			assert.equal(
				mod.latestGoogleUserInputText({
					contents: [
						{ role: "model", parts: [{ text: "assistant" }] },
						{ role: "user", parts: [{ inlineData: { data: "AAAA" } }] },
					],
				}),
				"[image input]",
			);
			assert.equal(
				mod.latestGoogleUserInputText({
					contents: [{ role: "user", parts: [{ fileData: {} }] }],
				}),
				"[file input]",
			);
			assert.equal(
				mod.latestGoogleUserInputText({
					contents: [{ role: "model", parts: [{ text: "assistant only" }] }],
				}),
				"",
			);
		},
	],
	[
		"converts Google native contents with tools images and function responses",
		async () => {
			const tools = [
				{
					functionDeclarations: [
						{
							name: "Search",
							description: "Search docs",
							parameters: { type: "object" },
						},
					],
				},
			];
			const req = {
				systemInstruction: {
					parts: [
						{ text: "be concise" },
						{ text: "cite sources" },
						{ ignored: true },
					],
				},
				tools,
				toolConfig: {
					functionCallingConfig: {
						mode: "ANY",
						allowedFunctionNames: ["Search"],
					},
				},
				contents: [
					{
						role: "user",
						parts: [
							{ text: "look up docs" },
							{
								inline_data: {
									data: "BBBB",
									mime_type: "image/jpeg",
									display_name: "diagram.jpg",
								},
							},
							{ fileData: { fileUri: "gemini://file/2" } },
						],
					},
					{
						role: "model",
						parts: [
							{ text: "I will search" },
							{ functionCall: { name: "Search", args: { query: "docs" } } },
						],
					},
					{
						role: "user",
						parts: [
							{ text: "tool output follows" },
							{ functionResponse: { name: "Search", response: { ok: true } } },
						],
					},
				],
			};

			assert.match(
				mod.googleToolChoiceInstruction(req),
				/MUST call one of these tools: "Search"/,
			);
			const fallbackPrompt = mod.buildGoogleToolPrompt(
				[{ name: "Fallback", parameters: {} }],
				req,
				tools,
			);
			assert.match(fallbackPrompt, /"name": "Fallback"/);
			assert.match(fallbackPrompt, /MUST call one of these tools: "Search"/);

			const promptResult = mod.googleContentsToPrompt(req, null, 1000000);
			const prompt = promptResult[0];
			assert.match(prompt, /Available tools/);
			assert.match(prompt, /\[System instruction\]: be concise cite sources/);
			assert.match(prompt, /look up docs/);
			assert.match(prompt, /\[image input\]/);
			assert.match(prompt, /\[Assistant\]: I will search/);
			assert.match(
				prompt,
				/<\|DSML\|tool_calls><\|DSML\|invoke name="Search">/,
			);
			assert.match(
				prompt,
				/<\|DSML\|parameter name="query"><!\[CDATA\[docs\]\]><\/\|DSML\|parameter>/,
			);
			assert.match(prompt, /tool output follows/);
			assert.match(prompt, /\[Tool result for Search\]: \{"ok":true\}/);
			assert.equal(promptResult.latestInputText, "tool output follows");
			assert.equal(promptResult.hasToolPrompt, true);
			assert.equal(promptResult.hasToolInstructions, true);
			assert.doesNotMatch(prompt, /Gemini native hidden tool calls/);
			assert.deepEqual(promptResult[1], [
				{ b64: "BBBB", mime: "image/jpeg", filename: "diagram.jpg" },
			]);

			const noTools = mod.googleContentsToPrompt(
				{
					tools,
					toolConfig: { functionCallingConfig: { mode: "NONE" } },
					contents: [{ role: "user", parts: [{ text: "answer directly" }] }],
				},
				null,
				1000000,
			);
			assert.doesNotMatch(noTools[0], /Available tools/);
			assert.equal(noTools.hasToolPrompt, undefined);
			assert.match(
				mod.googleToolChoiceInstruction({
					toolConfig: { functionCallingConfig: { mode: "NONE" } },
				}),
				/Do NOT call any tools/,
			);
			const noOverrideTools = mod.googleContentsToPrompt(
				{
					tools: [
						{
							functionDeclarations: [
								{ name: "Search", parameters: { type: "object" } },
							],
						},
					],
					contents: [{ role: "user", parts: [{ text: "look up docs" }] }],
				},
				[],
				1000000,
			);
			assert.doesNotMatch(noOverrideTools[0], /Available tools/);
			assert.equal(noOverrideTools.hasToolPrompt, undefined);
			assert.equal(noOverrideTools.hasToolInstructions, undefined);

			const assistantTextOnly = mod.googleContentsToPrompt(
				{
					contents: [{ role: "model", parts: [{ text: "previous answer" }] }],
				},
				null,
				1000000,
			);
			assert.match(assistantTextOnly[0], /\[Assistant\]: previous answer/);
			assert.doesNotMatch(assistantTextOnly[0], /<tool_calls>/);

			const messages = mod.googleContentsToOpenAIMessages(req);
			assert.deepEqual(messages[0], {
				role: "system",
				content: "be concise cite sources",
			});
			assert.equal(messages[1].role, "user");
			assert.equal(messages[1].content[0].text, "look up docs");
			assert.equal(messages[1].content[1].source.media_type, "image/jpeg");
			assert.equal(messages[2].role, "assistant");
			assert.equal(messages[2].tool_calls[0].function.name, "Search");
			assert.equal(
				messages[2].tool_calls[0].function.arguments,
				'{"query":"docs"}',
			);
			assert.equal(messages[3].role, "user");
			assert.deepEqual(messages[3].content, [
				{ type: "text", text: "tool output follows" },
			]);
			assert.deepEqual(messages[4], {
				role: "tool",
				name: "Search",
				content: '{"ok":true}',
			});
		},
	],
	[
		"extracts latest OpenAI user text while ignoring empty and assistant messages",
		async () => {
			assert.equal(
				mod.latestOpenAIUserInputText([
					{ role: "user", content: "first" },
					{ role: "assistant", content: "answer" },
					{ role: "user", content: [{ type: "input_text", text: "" }] },
					{ role: "user", content: [{ type: "text", text: "latest" }] },
				]),
				"latest",
			);
		},
	],
	[
		"converts mixed Responses content parts to prompt text and image refs",
		async () => {
			const images = [];
			const text = mod.messageContentToPrompt(
				[
					"plain",
					{ type: "input_text", text: "hello" },
					{
						type: "reasoning",
						summary: [{ type: "summary_text", text: "checked" }],
					},
					{
						type: "image_url",
						image_url: {
							url: "https://cdn.example.com/folder/photo%201.png?x=1",
							filename: "../remote.jpg",
						},
					},
					{
						type: "input_image",
						source: {
							data: "AAAA",
							media_type: "image/jpeg",
							file_name: "nested.jpg",
						},
					},
					{
						type: "input_image",
						image_url: "data:image/webp;base64,BBBB",
						name: "data.webp",
					},
					{ type: "input_file", file_id: "file_1" },
					{
						type: "custom",
						output: [{ type: "output_text", text: "custom output" }],
					},
				],
				images,
			);
			assert.match(text, /plain\nhello/);
			assert.match(
				text,
				/\[reasoning_content\]\nchecked\n\[\/reasoning_content\]/,
			);
			assert.equal((text.match(/\[image input\]/g) || []).length, 3);
			assert.match(text, /\[file input file_1\]/);
			assert.match(text, /custom output/);
			assert.deepEqual(images[0], {
				b64: "AAAA",
				mime: "image/jpeg",
				filename: "nested.jpg",
			});
			assert.deepEqual(images[1], {
				b64: "BBBB",
				mime: "image/webp",
				filename: "data.webp",
			});
		},
	],
	[
		"collects inline input_file parts and treats remote file URLs as missing payloads",
		async () => {
			const images = [];
			const files = [];
			const text = mod.messageContentToPrompt(
				[
					{ type: "input_text", text: "inspect code" },
					{
						type: "input_file",
						filename: "../main.py",
						file_data: "data:text/x-python;base64,cHJpbnQoMSkK",
					},
					{
						type: "input_file",
						filename: "note.txt",
						file_data: { data: "aGVsbG8=", mime_type: "text/plain" },
					},
					{
						type: "input_file",
						filename: "empty.txt",
						file_data: "",
						mime_type: "text/plain",
					},
					{
						type: "file",
						file_url: "https://files.example/archive/app.ts?sig=secret",
						filename: "app.ts",
					},
					{ type: "input_file", filename: "missing.txt" },
					{
						type: "input_file",
						file_id: "file_existing",
						filename: "existing.txt",
					},
				],
				images,
				files,
			);
			assert.match(text, /inspect code/);
			assert.match(text, /\[file input main\.py\]/);
			assert.match(text, /\[file input note\.txt\]/);
			assert.match(text, /\[file input empty\.txt\]/);
			assert.match(text, /\[file input app\.ts\]/);
			assert.match(text, /\[file input missing\.txt\]/);
			assert.match(text, /\[file input file_existing\]/);
			assert.deepEqual(images, []);
			assert.deepEqual(files, [
				{ b64: "cHJpbnQoMSkK", mime: "text/x-python", filename: "main.py" },
				{ b64: "aGVsbG8=", mime: "text/plain", filename: "note.txt" },
				{ b64: "", mime: "text/plain", filename: "empty.txt" },
				{
					invalidReason: "missing generic file upload data",
					mime: "text/typescript",
					filename: "app.ts",
				},
				{
					invalidReason: "missing generic file upload data",
					mime: "text/plain",
					filename: "missing.txt",
				},
			]);

			const result = mod.messagesToPrompt(
				[
					{
						role: "user",
						content: [
							{ type: "input_file", data: "aGVsbG8=", filename: "note.txt" },
						],
					},
				],
				null,
				"auto",
				[],
				"",
				1000000,
			);
			assert.deepEqual(result.files, [
				{ b64: "aGVsbG8=", mime: "text/plain", filename: "note.txt" },
			]);
		},
	],
	[
		"uses explicit image_url MIME metadata when a data URL omits MIME",
		async () => {
			const images = [];
			const text = mod.messageContentToPrompt(
				[
					{
						type: "image_url",
						image_url: { url: "data:;base64,AAAA", mime_type: "image/jpeg" },
						filename: "photo.jpg",
					},
				],
				images,
				[],
			);
			assert.equal(text, "[image input]");
			assert.deepEqual(images, [
				{ b64: "AAAA", mime: "image/jpeg", filename: "photo.jpg" },
			]);
		},
	],
	[
		"uses top-level image_url data URL when image_url object is omitted",
		async () => {
			const images = [];
			const text = mod.messageContentToPrompt(
				[
					{
						type: "image_url",
						url: "data:image/gif;base64,R0lGODlh",
						filename: "direct.gif",
					},
				],
				images,
				[],
			);
			assert.equal(text, "[image input]");
			assert.deepEqual(images, [
				{ b64: "R0lGODlh", mime: "image/gif", filename: "direct.gif" },
			]);
		},
	],
	[
		"preserves Google fileData fileUri and collects inline non-image parts",
		async () => {
			const req = {
				contents: [
					{
						role: "user",
						parts: [
							{
								fileData: {
									fileUri: "https://files.example/main.py",
									mimeType: "text/x-python",
									displayName: "main.py",
								},
							},
							{
								inlineData: {
									data: "Y29uc29sZS5sb2coMSk=",
									mimeType: "text/javascript",
									displayName: "inline.js",
								},
							},
						],
					},
				],
			};
			const result = mod.googleContentsToPrompt(req, [], 1000000);
			assert.deepEqual(result[1], []);
			assert.deepEqual(result.files, [
				{
					b64: "Y29uc29sZS5sb2coMSk=",
					mime: "text/javascript",
					filename: "inline.js",
				},
			]);
			assert.match(result[0], /\[file input main\.py\]/);
			assert.match(result[0], /\[file input inline\.js\]/);

			const messages = mod.googleContentsToOpenAIMessages(req);
			assert.equal(messages[0].role, "user");
			assert.equal(messages[0].content[0].type, "file");
			assert.deepEqual(messages[0].content[0].fileData, {
				fileUri: "https://files.example/main.py",
				mimeType: "text/x-python",
				displayName: "main.py",
			});
			assert.equal(messages[0].content[0].filename, "main.py");
			assert.equal(messages[0].content[1].type, "file");
			assert.deepEqual(messages[0].content[1].source, {
				data: "Y29uc29sZS5sb2coMSk=",
				media_type: "text/javascript",
			});
			assert.equal(messages[0].content[1].filename, "inline.js");

			const transcript = mod.buildGoogleHistoryTranscript(
				req,
				"google-files.txt",
			);
			assert.match(transcript, /\[file input main\.py\]/);
			assert.match(transcript, /\[file input inline\.js\]/);
			assert.doesNotMatch(transcript, /\[image input\]/);
			assert.equal(
				mod.latestGoogleUserInputText(req),
				"[file input main.py]\n[file input inline.js]",
			);
		},
	],
	[
		"uses normalized Google file parts in history for snake case fields",
		async () => {
			const req = {
				contents: [
					{
						role: "user",
						parts: [
							{
								file_data: {
									file_uri: "gemini://file/3",
									mime_type: "text/plain",
									display_name: "notes.txt",
								},
							},
							{
								inline_data: {
									data: "IyBUaXRsZQ==",
									mime_type: "text/markdown",
									display_name: "readme.md",
								},
							},
						],
					},
				],
			};
			const transcript = mod.buildGoogleHistoryTranscript(
				req,
				"snake-google-files.txt",
			);
			assert.match(transcript, /\[file input notes\.txt\]/);
			assert.match(transcript, /\[file input readme\.md\]/);
			assert.doesNotMatch(transcript, /\[image input\]/);
			assert.equal(
				mod.latestGoogleUserInputText(req),
				"[file input notes.txt]\n[file input readme.md]",
			);
		},
	],
	[
		"handles content text fallbacks and file ref de-duplication",
		async () => {
			const cyclic = {};
			cyclic.self = cyclic;
			assert.equal(mod.contentTextForHistory(cyclic), "[object Object]");
			assert.equal(
				mod.responsesContentToText([
					{ type: "text", text: "a" },
					2,
					true,
					{ type: "input_file", file_id: "f1" },
				]),
				"a 2 true [file input f1]",
			);
			assert.deepEqual(
				mod.mergeFileRefs(
					["file-a", { ref: "file-b", name: "b" }],
					[{ fileRef: "file-b", name: "duplicate" }, { id: "file-c" }, null],
				),
				["file-a", { ref: "file-b", name: "b" }, { id: "file-c" }],
			);
			assert.equal(mod.mergeFileRefs(null, [], [null]), null);
		},
	],
	[
		"handles object content fallbacks for Responses-compatible prompts",
		async () => {
			assert.equal(
				mod.reasoningTextForHistory({
					content: [
						{ type: "reasoning", text: "checked plan" },
						{ type: "thinking", text: "picked tool" },
						{ type: "text", text: "visible" },
					],
				}),
				"checked plan\npicked tool",
			);
			assert.equal(
				mod.responsesContentToText({
					text: [{ type: "summary_text", text: "nested summary" }],
				}),
				"nested summary",
			);
			assert.equal(
				mod.responsesContentToText({
					output: { type: "output_text", text: "nested output" },
				}),
				"nested output",
			);

			let images = [];
			assert.equal(
				mod.messageContentToPrompt(
					{
						type: "input_image",
						source: {
							data: "CCCC",
							mime_type: "image/gif",
							file_name: "inline.gif",
						},
					},
					images,
				),
				"[image input]",
			);
			assert.deepEqual(images, [
				{ b64: "CCCC", mime: "image/gif", filename: "inline.gif" },
			]);

			images = [];
			assert.equal(
				mod.messageContentToPrompt(
					{
						type: "image_url",
						image_url: { url: "https://cdn.example.com/assets/raw.png" },
					},
					images,
				),
				"[image input]",
			);
			assert.deepEqual(images, []);
			assert.equal(
				mod.messageContentToPrompt({ type: "file" }, []),
				"[file input]",
			);
			assert.equal(
				mod.messageContentToPrompt(
					{ text: { type: "output_text", text: "fallback output" } },
					[],
				),
				"fallback output",
			);

			const cyclic = {};
			cyclic.self = cyclic;
			assert.equal(mod.messageContentToPrompt(cyclic, []), "[object Object]");
		},
	],
	[
		"sanitizes media filenames and maps image mime extensions",
		async () => {
			assert.deepEqual(
				mod.parseImageUrl("data:IMAGE/PNG;charset=utf-8;base64,AAAA"),
				{ b64: "AAAA", mime: "image/png" },
			);
			assert.equal(mod.parseImageUrl("https://example.com/a.png"), null);
			assert.equal(mod.parseImageUrl("ftp://example.com/a.png"), null);
			assert.equal(
				mod.sanitizeUploadFilename("../bad\u0000\r\nname.png"),
				"bad  name.png",
			);
			assert.equal(mod.sanitizeUploadFilename(".."), "");
			assert.equal(mod.sanitizeUploadFilename("x".repeat(220)).length, 180);
			assert.equal(
				mod.filenameFromUrl("https://example.com/a%20b.png?x=1"),
				"a b.png",
			);
			assert.equal(
				mod.filenameFromUrl("https://example.com/%E0%A4%A"),
				"%E0%A4%A",
			);
			assert.equal(mod.firstNonEmptyString(null, "  ", " ok "), "ok");
			assert.equal(
				mod.imageFilenameFromObject({
					inline_data: { display_name: " inline.gif " },
				}),
				"inline.gif",
			);
			assert.equal(mod.imageFilenameFromMime("image/jpeg", 1), "image.jpg");
			assert.equal(mod.imageFilenameFromMime("image/webp", 2), "image-2.webp");
			assert.equal(mod.imageFilenameFromMime("image/gif", 3), "image-3.gif");
			assert.equal(mod.imageFilenameFromMime("image/bmp", 4), "image-4.bmp");
			assert.equal(mod.imageFilenameFromMime("image/heic", 5), "image-5.heic");
			assert.equal(mod.imageFilenameFromMime("image/heif", 6), "image-6.heif");
			assert.equal(
				mod.imageFilenameFromMime("application/octet-stream", 7),
				"image-7.png",
			);
			assert.equal(
				mod.genericFilenameFromMime("application/octet-stream", 7),
				"file-7.bin",
			);
			assert.equal(
				mod.genericFilenameFromMime("text/x-python", 2),
				"file-2.py",
			);
			assert.equal(mod.mimeFromFilename("main.py"), "text/x-python");
			assert.deepEqual(mod.parseUploadUrl("data:text/plain;base64,QQ=="), {
				b64: "QQ==",
				mime: "text/plain",
			});
			assert.deepEqual(
				mod.normalizeUploadFileInput({
					type: "input_file",
					filename: "document.txt",
					file_data: "data:application/pdf;base64,JVBERi0=",
				}),
				{ b64: "JVBERi0=", mime: "application/pdf", filename: "document.txt" },
			);
			assert.deepEqual(
				mod.normalizeUploadFileInput({
					type: "input_file",
					filename: "../nested.py",
					file_data: { data: "cHJpbnQoMikK", mime_type: "text/x-python" },
					data: "dG9wLWxldmVs",
				}),
				{ b64: "cHJpbnQoMikK", mime: "text/x-python", filename: "nested.py" },
			);
		},
	],
	[
		"omits OpenAI tool prompt when tool choice is none",
		async () => {
			const result = mod.messagesToPrompt(
				[{ role: "user", content: "answer without tools" }],
				[
					{
						type: "function",
						function: { name: "Read", parameters: { type: "object" } },
					},
				],
				"none",
				null,
				"",
				1000000,
			);
			assert.equal(result[0], "answer without tools");
			assert.equal(result.hasToolPrompt, undefined);
			assert.equal(result.hasToolInstructions, undefined);
		},
	],
	[
		"keeps OpenAI tool prompt metadata aligned with provided tool defs",
		async () => {
			const tools = [
				{
					type: "function",
					function: { name: "Read", parameters: { type: "object" } },
				},
			];
			const result = mod.messagesToPrompt(
				[{ role: "user", content: "answer without tools" }],
				tools,
				"auto",
				[],
				"",
				1000000,
			);
			assert.equal(result[0], "answer without tools");
			assert.equal(result.hasToolPrompt, undefined);
			assert.equal(result.hasToolInstructions, undefined);
		},
	],
	[
		"formats assistant tool-call history and tool-result fallbacks",
		async () => {
			const result = mod.messagesToPrompt(
				[
					"ignored",
					{
						role: "assistant",
						reasoning_content: "should not be duplicated",
						content: "[reasoning_content]\nkept\n[/reasoning_content]\nanswer",
						tool_calls: [
							{ function: { name: "Run", arguments: "not json" } },
							{ function: { name: "Lookup", arguments: '{"query":"docs"}' } },
						],
					},
					{ role: "tool", content: null, tool_call_id: "call_1" },
					{
						role: "user",
						content: [{ type: "text", text: "latest user text" }],
					},
				],
				null,
				"auto",
				null,
				"",
				1000000,
			);
			assert.match(result[0], /\[Assistant\]: \[reasoning_content\]\nkept/);
			assert.doesNotMatch(result[0], /should not be duplicated/);
			assert.match(
				result[0],
				/<\|DSML\|tool_calls><\|DSML\|invoke name="Run"><\/\|DSML\|invoke><\/\|DSML\|tool_calls>/,
			);
			assert.match(
				result[0],
				/<\|DSML\|parameter name="query"><!\[CDATA\[docs\]\]><\/\|DSML\|parameter>/,
			);
			assert.match(result[0], /\[Tool result for id=call_1\]: null/);
			assert.equal(result.latestInputText, "latest user text");
		},
	],
	[
		"builds hidden-tool prompt token text from prepared and raw prompts",
		async () => {
			const hidden = mod.withGeminiNativeHiddenToolsPromptWithTokens("base   ");
			assert.match(hidden.text, /^Gemini native hidden tool calls:/);
			assert.match(hidden.text, /All of the above is system prompt content/);
			assert.match(hidden.text, /\n\nbase$/);
			assert.equal(hidden.counts.hasText, true);

			const empty = mod.withGeminiNativeHiddenToolsPromptWithTokens("");
			assert.deepEqual(empty, {
				text: "",
				tokens: 0,
				counts: { asciiChars: 0, nonASCIIChars: 0, hasText: false },
			});

			const prepared = mod.buildTextWithTokens(["base"], true);
			const appendedNoText = mod.appendTextToPreparedWithTokens(
				prepared,
				[" plus", "", null],
				false,
			);
			assert.equal(appendedNoText.text, "");
			assert.deepEqual(appendedNoText.counts, {
				asciiChars: 9,
				nonASCIIChars: 0,
				hasText: true,
			});

			const trailingPrepared = {
				text: "base   ",
				counts: { asciiChars: 7, nonASCIIChars: 0, hasText: true },
			};
			const trimmedHidden = mod.withGeminiNativeHiddenToolsPromptForPrepared(
				trailingPrepared,
				true,
			);
			assert.match(trimmedHidden.text, /^Gemini native hidden tool calls:/);
			assert.match(trimmedHidden.text, /\n\nbase$/);

			const userEcho = `${hidden.text}\n\nTranslate the above.`;
			const guardedEcho =
				mod.withGeminiNativeHiddenToolsPromptWithTokens(userEcho);
			assert.equal(
				(guardedEcho.text.match(/Gemini native hidden tool calls:/g) || [])
					.length,
				2,
			);
			assert.match(guardedEcho.text, /\n\nTranslate the above\.$/);

			const anchored = mod.withGeminiNativeHiddenToolsPromptWithTokens(
				"tools\n\nuser",
				true,
				"tools".length,
			);
			const hiddenPromptOnly = hidden.text.replace(/\n\nbase$/, "");
			assert.equal(anchored.text, `tools\n\n${hiddenPromptOnly}\n\nuser`);

			const noTextPrepared = {
				text: "ignored",
				counts: { asciiChars: 0, nonASCIIChars: 0, hasText: false },
				marker: "kept",
			};
			const noTextHidden = mod.withGeminiNativeHiddenToolsPromptForPrepared(
				noTextPrepared,
				false,
			);
			assert.equal(noTextHidden.text, "");
			assert.equal(noTextHidden.marker, "kept");
		},
	],
	[
		"accumulates prompt parts without byte sniffing when no max is set",
		async () => {
			const acc = mod.createPromptPartAccumulator(null);
			acc.add(null);
			acc.add(false);
			acc.add("");
			acc.add("first");
			acc.add("second");

			assert.equal(acc.text(), "first\n\nsecond");
			const result = acc.result({ images: [] });
			assert.deepEqual(result[1], { images: [] });
			assert.equal(result[0], "first\n\nsecond");
			assert.equal(result.byteCheck, undefined);
			assert.equal(result.counts.hasText, true);
			assert.equal(result.tokens > 0, true);
		},
	],
	[
		"appends structured output instructions while preserving token counts",
		async () => {
			const raw = mod.appendStructuredOutputInstructionWithTokens("base  ", {
				instruction: "Return JSON",
			});
			assert.equal(raw.text, "base\n\nReturn JSON");
			const instructionOnly = mod.appendStructuredOutputInstructionWithTokens(
				"",
				{ instruction: "Return JSON" },
			);
			assert.equal(instructionOnly.text, "Return JSON");
			const malformed = mod.appendStructuredOutputInstructionWithTokens(
				"base",
				{ instruction: 123 },
			);
			assert.equal(malformed.text, "base");

			const prepared = mod.buildTextWithTokens(["base"], true);
			const appended = mod.appendStructuredOutputInstructionToPrepared(
				prepared,
				{ instruction: "Return JSON" },
				false,
			);
			assert.equal(appended.text, "");
			assert.equal(appended.counts.asciiChars, "base\n\nReturn JSON".length);
			assert.equal(appended.counts.hasText, true);

			const unchanged = mod.appendStructuredOutputInstructionToPrepared(
				{
					text: "keep",
					counts: { asciiChars: 4, nonASCIIChars: 0, hasText: true },
					marker: "kept",
				},
				null,
				false,
			);
			assert.equal(unchanged.text, "");
			assert.equal(unchanged.marker, "kept");
		},
	],
];
