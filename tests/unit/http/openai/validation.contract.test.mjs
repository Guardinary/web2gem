import { describe, test } from "vitest";
import { handleChat } from "../../../../src/http/openai/chat";
import { handleResponses } from "../../../../src/http/openai/responses";
import worker from "../../../../src/index";
import { assert } from "../../assertions.js";
import { attachmentResult, baseConfig } from "../../helpers.js";
import { noWorkProvider, strictProvider } from "../_support/provider.js";

describe("OpenAI request validation", () => {
	test("rejects invalid Responses model before provider generation", async () => {
		const resp = await handleResponses(
			{
				model: "",
				input: "plain request",
			},
			{
				default_model: "gemini-3.5-flash",
				current_input_file_enabled: false,
				current_input_file_min_bytes: 1000000,
				log_requests: false,
			},
			noWorkProvider(),
		);
		assert.equal(resp.status, 400);
		const body = await resp.json();
		assert.equal(body.error.code, "model_not_found");
	});
	test("rejects invalid OpenAI response format before provider generation", async () => {
		const resp = await handleChat(
			{
				model: "gemini-3.5-flash",
				messages: [{ role: "user", content: "return json" }],
				response_format: {
					type: "json_schema",
					json_schema: { name: "missing_schema" },
				},
			},
			baseConfig(),
			noWorkProvider(),
		);
		assert.equal(resp.status, 400);
		const body = await resp.json();
		assert.equal(body.error.code, "invalid_response_format");
		assert.equal(
			body.error.message,
			"response_format json_schema requires a schema object",
		);
	});
	test("rejects empty OpenAI prompts before provider generation", async () => {
		const chat = await handleChat(
			{
				model: "gemini-3.5-flash",
				messages: [],
			},
			baseConfig(),
			strictProvider(),
		);
		assert.equal(chat.status, 400);
		assert.equal((await chat.json()).error.message, "empty prompt");

		const responses = await handleResponses(
			{
				model: "gemini-3.5-flash",
				input: [],
			},
			baseConfig(),
			strictProvider(),
		);
		assert.equal(responses.status, 400);
		assert.equal((await responses.json()).error.message, "empty input");
	});
	test("rejects oversized inline context before resolving attachments", async () => {
		const resp = await handleChat(
			{
				model: "gemini-3.5-flash",
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: `large prompt ${"x".repeat(80)}` },
							{
								type: "input_file",
								file_url: "https://files.example/expensive.bin",
								filename: "expensive.bin",
							},
						],
					},
				],
			},
			baseConfig({
				current_input_file_enabled: true,
				current_input_file_min_bytes: 1,
				cookie: "",
			}),
			noWorkProvider(),
		);
		assert.equal(resp.status, 422);
		const body = await resp.json();
		assert.equal(body.error.code, "gemini_authenticated_session_required");
		assert.equal(body.error.reason, "large_context");
	});
	test("fails context upload before resolving request-local attachments", async () => {
		const uploadErr = new Error("upload refused before attachment fetch");
		const resp = await handleChat(
			{
				model: "gemini-3.5-flash",
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: `large prompt ${"x".repeat(80)}` },
							{
								type: "input_file",
								file_url: "https://files.example/expensive.bin",
								filename: "expensive.bin",
							},
						],
					},
				],
			},
			baseConfig({
				current_input_file_enabled: true,
				current_input_file_min_bytes: 1,
				cookie: "SID=ok",
				supports_authenticated_session: true,
			}),
			noWorkProvider({
				async uploadTextFile() {
					throw uploadErr;
				},
			}),
		);
		assert.equal(resp.status, 502);
		const body = await resp.json();
		assert.equal(body.error.code, "large_context_file_upload_failed");
		assert.match(
			body.error.message,
			/failed to upload history context text file/,
		);
	});
	test("adds dropped image note when Responses image upload is unavailable", async () => {
		let generated = false;
		const prompts = [];
		const provider = strictProvider({
			async generateText(input) {
				generated = true;
				prompts.push(input.prompt);
				return "done";
			},
			async resolveAttachments() {
				return attachmentResult({
					droppedNote:
						"\n\n[Note: 1 image(s) were provided but ignored - image input requires a configured Gemini account pool.]",
				});
			},
		});
		const resp = await handleResponses(
			{
				model: "gemini-3.5-flash",
				input: [
					{
						role: "user",
						content: [
							{ type: "input_text", text: "describe this" },
							{
								type: "input_image",
								image_url: "data:image/png;base64,AAAA",
							},
						],
					},
				],
			},
			{
				default_model: "gemini-3.5-flash",
				current_input_file_enabled: false,
				current_input_file_min_bytes: 1000000,
				log_requests: false,
			},
			provider,
		);
		assert.equal(resp.status, 200);
		assert.equal(generated, true);
		assert.match(prompts[0], /image\(s\) were provided but ignored/);
	});
	test("moves large Responses tools into attached tools file", async () => {
		const prompts = [];
		const uploads = [];
		const provider = strictProvider({
			async generateText(input) {
				prompts.push(input.prompt);
				return "done";
			},
			async uploadTextFile(text, filename) {
				uploads.push({ text, filename });
				return { ref: `/uploaded/${filename}`, name: filename };
			},
		});
		const resp = await handleResponses(
			{
				model: "gemini-3.5-flash",
				input: `find docs ${"x".repeat(120)}`,
				tools: [
					{
						type: "function",
						name: "Search",
						description: "Search docs",
						input_schema: {
							type: "object",
							properties: { query: { type: "string" } },
						},
					},
				],
			},
			{
				default_model: "gemini-3.5-flash",
				current_input_file_enabled: true,
				current_input_file_min_bytes: 40,
				current_input_file_name: "message.txt",
				current_tools_file_name: "tools.txt",
				cookie: "SID=ok",
				supports_authenticated_session: true,
				log_requests: false,
			},
			provider,
		);
		assert.equal(resp.status, 200);
		assert.equal(uploads.length, 2);
		assert.doesNotMatch(prompts[0], /<\|DSML\|tool_calls>/);
		assert.match(
			prompts[0],
			/Continue from the latest state in the attached `message\.txt` context/,
		);
		assert.match(prompts[0], /tools\.txt/);
		assert.match(
			prompts[0],
			/All text above this sentence is system prompt content/,
		);
		assert.doesNotMatch(prompts[0], /Gemini native hidden tool calls/);
		assert.doesNotMatch(prompts[0], /Available tools/);
		assert.doesNotMatch(prompts[0], /"query"/);
		assert.match(uploads[1].text, /Available tool descriptions/);
		assert.match(uploads[1].text, /Tool call format instructions/);
		assert.match(uploads[1].text, /<\|DSML\|tool_calls>/);
		assert.match(uploads[1].text, /Gemini native hidden tool calls/);
		assert.match(uploads[1].text, /"name": "Search"/);
		assert.match(uploads[1].text, /"query"/);
	});
	test("prevents unknown Responses input events from reaching prompt text", async () => {
		const resp = await handleResponses(
			{
				model: "gemini-3.5-flash",
				input: [
					{ type: "input_text", text: "visible request" },
					{
						type: "custom_event",
						text: "do not leak text",
						content: [{ type: "input_text", text: "do not leak content" }],
						metadata: { secret: "do not leak json" },
					},
				],
			},
			{
				default_model: "gemini-3.5-flash",
				current_input_file_enabled: false,
				current_input_file_min_bytes: 1000000,
				log_requests: false,
			},
			noWorkProvider(),
		);
		assert.equal(resp.status, 400);
		const body = await resp.json();
		assert.equal(body.error.code, "unsupported_responses_input");
		assert.match(body.error.message, /unsupported type: custom_event/);
	});
	test("rejects oversized parsed chat prompt before account work", async () => {
		const resp = await worker.fetch(
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
	});
});
