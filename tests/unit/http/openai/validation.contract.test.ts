import { describe, test } from "vitest";
import type { ApplicationExecutionContext } from "../../../../src/app";
import {
	createRuntimeConfig,
	getConfig,
	type RuntimeConfig,
} from "../../../../src/config";
import { handleChat } from "../../../../src/http/openai/chat";
import { handleResponses } from "../../../../src/http/openai/responses";
import { isRecord, type UnknownRecord } from "../../../../src/shared/types";
import worker from "../../../../src/index";
import { assert } from "../../assertions.js";
import { attachmentResult } from "../../attachments/_support/result.js";
import { noWorkProvider, strictProvider } from "../_support/provider.js";

const execution: ApplicationExecutionContext = { waitUntil() {} };

function openAIConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
	return { ...createRuntimeConfig(getConfig()), ...overrides };
}

function record(value: unknown, label: string): UnknownRecord {
	if (!isRecord(value)) throw new Error(`expected ${label} object`);
	return value;
}

function responseError(value: unknown): UnknownRecord {
	return record(record(value, "response").error, "response error");
}

function first<T>(values: readonly T[], label: string): T {
	const value = values[0];
	if (value === undefined) throw new Error(`expected ${label}`);
	return value;
}

describe("OpenAI request validation", () => {
	test("rejects invalid Responses model before provider generation", async () => {
		const resp = await handleResponses(
			{
				model: "",
				input: "plain request",
			},
			openAIConfig({
				default_model: "gemini-3.5-flash",
				current_input_file_enabled: false,
				current_input_file_min_bytes: 1000000,
				log_requests: false,
			}),
			noWorkProvider(),
		);
		assert.equal(resp.status, 400);
		assert.equal(responseError(await resp.json()).code, "model_not_found");
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
			openAIConfig(),
			noWorkProvider(),
		);
		assert.equal(resp.status, 400);
		const body = responseError(await resp.json());
		assert.equal(body.code, "invalid_response_format");
		assert.equal(
			body.message,
			"response_format json_schema requires a schema object",
		);
	});
	test("rejects empty OpenAI prompts before provider generation", async () => {
		const chat = await handleChat(
			{
				model: "gemini-3.5-flash",
				messages: [],
			},
			openAIConfig(),
			strictProvider(),
		);
		assert.equal(chat.status, 400);
		assert.equal(responseError(await chat.json()).message, "empty prompt");

		const responses = await handleResponses(
			{
				model: "gemini-3.5-flash",
				input: [],
			},
			openAIConfig(),
			strictProvider(),
		);
		assert.equal(responses.status, 400);
		assert.equal(responseError(await responses.json()).message, "empty input");
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
			openAIConfig({
				current_input_file_enabled: true,
				current_input_file_min_bytes: 1,
				cookie: "",
			}),
			noWorkProvider(),
		);
		assert.equal(resp.status, 422);
		const body = responseError(await resp.json());
		assert.equal(body.code, "gemini_authenticated_session_required");
		assert.equal(body.reason, "large_context");
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
			openAIConfig({
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
		const body = responseError(await resp.json());
		assert.equal(body.code, "large_context_file_upload_failed");
		assert.match(body.message, /failed to upload history context text file/);
	});
	test("adds dropped image note when Responses image upload is unavailable", async () => {
		let generated = false;
		const prompts: string[] = [];
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
			openAIConfig({
				default_model: "gemini-3.5-flash",
				current_input_file_enabled: false,
				current_input_file_min_bytes: 1000000,
				log_requests: false,
			}),
			provider,
		);
		assert.equal(resp.status, 200);
		assert.equal(generated, true);
		assert.match(
			first(prompts, "image prompt"),
			/image\(s\) were provided but ignored/,
		);
	});
	test("moves large Responses tools into attached tools file", async () => {
		const prompts: string[] = [];
		const uploads: { text: string; filename: string }[] = [];
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
			openAIConfig({
				default_model: "gemini-3.5-flash",
				current_input_file_enabled: true,
				current_input_file_min_bytes: 40,
				current_input_file_name: "message.txt",
				current_tools_file_name: "tools.txt",
				cookie: "SID=ok",
				supports_authenticated_session: true,
				log_requests: false,
			}),
			provider,
		);
		assert.equal(resp.status, 200);
		assert.equal(uploads.length, 2);
		assert.doesNotMatch(
			first(prompts, "context prompt"),
			/<\|DSML\|tool_calls>/,
		);
		assert.match(
			first(prompts, "context prompt"),
			/Continue from the latest state in the attached `message\.txt` context/,
		);
		assert.match(first(prompts, "context prompt"), /tools\.txt/);
		assert.match(
			first(prompts, "context prompt"),
			/All text above this sentence is system prompt content/,
		);
		assert.doesNotMatch(
			first(prompts, "context prompt"),
			/Gemini native hidden tool calls/,
		);
		assert.doesNotMatch(first(prompts, "context prompt"), /Available tools/);
		assert.doesNotMatch(first(prompts, "context prompt"), /"query"/);
		const toolsUpload = uploads[1];
		if (!toolsUpload) throw new Error("expected tools upload");
		assert.match(toolsUpload.text, /Available tool descriptions/);
		assert.match(toolsUpload.text, /Tool call format instructions/);
		assert.match(toolsUpload.text, /<\|DSML\|tool_calls>/);
		assert.match(toolsUpload.text, /Gemini native hidden tool calls/);
		assert.match(toolsUpload.text, /"name": "Search"/);
		assert.match(toolsUpload.text, /"query"/);
	});
	test("ignores unknown Responses input events without leaking their payload", async () => {
		const prompts: string[] = [];
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
			openAIConfig({
				default_model: "gemini-3.5-flash",
				current_input_file_enabled: false,
				current_input_file_min_bytes: 1000000,
				log_requests: false,
			}),
			strictProvider({
				async generateText(input) {
					prompts.push(input.prompt);
					return "done";
				},
			}),
		);
		assert.equal(resp.status, 200);
		assert.equal(prompts.length, 1);
		const prompt = first(prompts, "visible prompt");
		assert.match(prompt, /visible request/);
		assert.doesNotMatch(prompt, /custom_event/);
		assert.doesNotMatch(prompt, /do not leak text/);
		assert.doesNotMatch(prompt, /do not leak content/);
		assert.doesNotMatch(prompt, /do not leak json/);
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
			execution,
		);
		assert.equal(resp.status, 422);
		const body = responseError(await resp.json());
		assert.equal(body.code, "large_context_inline_unsupported");
		assert.match(body.message, /at least 40 UTF-8 bytes > 10/);
	});
});
