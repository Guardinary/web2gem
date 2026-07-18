import { describe, test } from "vitest";
import { EMPTY_UPSTREAM_MSG } from "../../../../src/completion/turn";
import { invalidGeminiCookieError } from "../../../../src/gemini/client/errors";
import { handleGoogleGenerate } from "../../../../src/http/google/handlers";
import { parseGoogleGenerationPath } from "../../../../src/http/google/model-path";
import worker from "../../../../src/index";
import { assert } from "../../assertions.js";
import {
	attachmentResult,
	baseConfig,
	streamError,
	withConsoleLog,
} from "../../helpers.js";
import { noWorkProvider, strictProvider } from "../_support/provider.js";

describe("Google generate handler", () => {
	test("rejects invalid Google model before provider generation", async () => {
		const resp = await handleGoogleGenerate(
			{
				contents: [{ role: "user", parts: [{ text: "plain request" }] }],
			},
			{
				default_model: "gemini-3.5-flash",
				current_input_file_enabled: false,
				current_input_file_min_bytes: 1000000,
				current_input_file_name: "message.txt",
				current_tools_file_name: "tools.txt",
				cookie: "",
				log_requests: false,
			},
			noWorkProvider(),
			parseGoogleGenerationPath("/v1beta/models/not-a-model:generateContent"),
			false,
		);
		assert.equal(resp.status, 400);
		const body = await resp.json();
		assert.equal(body.error.code, "model_not_found");
	});
	test("hands inline Google tools to the provider without polluting plain requests", async () => {
		const toolPrompts = [];
		const toolResp = await handleGoogleGenerate(
			{
				contents: [{ role: "user", parts: [{ text: "read the file" }] }],
				tools: [
					{
						functionDeclarations: [
							{
								name: "Read",
								description: "Read a file",
								parameters: {
									type: "object",
									properties: { path: { type: "string" } },
								},
							},
						],
					},
				],
			},
			baseConfig(),
			strictProvider({
				async generateText(input) {
					toolPrompts.push(input.prompt);
					return "done";
				},
			}),
			parseGoogleGenerationPath(
				"/v1beta/models/gemini-3.5-flash:generateContent",
			),
			false,
		);
		assert.equal(toolResp.status, 200);
		assert.match(toolPrompts[0], /Available tools/);
		assert.match(toolPrompts[0], /<\|DSML\|tool_calls>/);
		assert.match(toolPrompts[0], /"name": "Read"/);
		assert.match(toolPrompts[0], /"path"/);

		const plainPrompts = [];
		const plainResp = await handleGoogleGenerate(
			{
				contents: [{ role: "user", parts: [{ text: "plain request" }] }],
			},
			baseConfig(),
			strictProvider({
				async generateText(input) {
					plainPrompts.push(input.prompt);
					return "done";
				},
			}),
			parseGoogleGenerationPath(
				"/v1beta/models/gemini-3.5-flash:generateContent",
			),
			false,
		);
		assert.equal(plainResp.status, 200);
		assert.doesNotMatch(
			plainPrompts[0],
			/Available tools|<\|DSML\|tool_calls>/,
		);
	});
	test("maps Google system image and function history into the provider prompt", async () => {
		const prompts = [];
		const plans = [];
		const resp = await handleGoogleGenerate(
			{
				systemInstruction: { parts: [{ text: "be concise" }] },
				contents: [
					{
						role: "user",
						parts: [
							{ text: "inspect image" },
							{ inlineData: { data: "AAAA", mimeType: "image/png" } },
						],
					},
					{
						role: "model",
						parts: [{ functionCall: { name: "Lookup", args: { id: "abc" } } }],
					},
					{
						role: "user",
						parts: [
							{
								functionResponse: {
									name: "Lookup",
									response: { ok: true },
								},
							},
						],
					},
				],
			},
			baseConfig(),
			strictProvider({
				async resolveAttachments(plan) {
					plans.push(plan);
					return attachmentResult();
				},
				async generateText(input) {
					prompts.push(input.prompt);
					return "done";
				},
			}),
			parseGoogleGenerationPath(
				"/v1beta/models/gemini-3.5-flash:generateContent",
			),
			false,
		);
		assert.equal(resp.status, 200);
		assert.equal(plans[0].candidates.length, 1);
		assert.match(prompts[0], /\[System instruction\]: be concise/);
		assert.match(prompts[0], /inspect image/);
		assert.match(prompts[0], /\[image input\]/);
		assert.match(
			prompts[0],
			/\[Assistant\]: \n<\|DSML\|tool_calls><\|DSML\|invoke name="Lookup">/,
		);
		assert.match(prompts[0], /\[Tool result for Lookup\]: \{"ok":true\}/);
	});
	test("passes Google image context and generic refs in protocol order", async () => {
		let seenFileRefs = null;
		const imageRef = { ref: "/uploaded/image", name: "image.png" };
		const genericRef = { ref: "/uploaded/file", name: "note.txt" };
		const resp = await handleGoogleGenerate(
			{
				contents: [
					{
						role: "user",
						parts: [
							{ text: `inspect ${"x".repeat(80)}` },
							{ inlineData: { data: "AAAA", mimeType: "image/png" } },
							{
								inlineData: {
									data: "bm90ZQ==",
									mimeType: "text/plain",
									displayName: "note.txt",
								},
							},
						],
					},
				],
			},
			{
				default_model: "gemini-3.5-flash",
				current_input_file_enabled: true,
				current_input_file_min_bytes: 10,
				current_input_file_name: "message.txt",
				current_tools_file_name: "tools.txt",
				cookie: "SID=ok",
				supports_authenticated_session: true,
				log_requests: false,
			},
			strictProvider({
				async resolveAttachments() {
					return attachmentResult({
						fileRefs: [imageRef, genericRef],
						imageFileRefs: [imageRef],
						genericFileRefs: [genericRef],
					});
				},
				async uploadTextFile(_text, filename) {
					return { ref: `/uploaded/${filename}`, name: filename };
				},
				async generateText(input) {
					seenFileRefs = input.fileRefs;
					return "done";
				},
			}),
			parseGoogleGenerationPath(
				"/v1beta/models/gemini-3.5-flash:generateContent",
			),
			false,
		);
		assert.equal(resp.status, 200);
		assert.deepEqual(seenFileRefs, [
			imageRef,
			{ ref: "/uploaded/message.txt", name: "message.txt" },
			{ ref: "/uploaded/tools.txt", name: "tools.txt" },
			genericRef,
		]);
	});
	test("rejects Google ANY tool choice when no tools are declared", async () => {
		const resp = await worker.fetch(
			new Request(
				"https://worker.example/v1beta/models/gemini-3.5-flash:generateContent",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						contents: [{ role: "user", parts: [{ text: "call a tool" }] }],
						toolConfig: { functionCallingConfig: { mode: "ANY" } },
					}),
				},
			),
			{
				API_KEYS: "",
				LOG_REQUESTS: "false",
				GEMINI_DB: {
					prepare() {
						throw new Error("invalid tool choice should not read D1");
					},
				},
			},
			{},
		);
		assert.equal(resp.status, 400);
		const body = await resp.json();
		assert.equal(body.error.code, "invalid_tool_choice");
		assert.match(body.error.message, /mode=ANY requires at least one tool/);
	});
	test("returns Google tool-choice errors for non-stream plain answers", async () => {
		const resp = await handleGoogleGenerate(
			{
				contents: [{ role: "user", parts: [{ text: "call a tool" }] }],
				tools: [
					{
						functionDeclarations: [
							{ name: "Read", parameters: { type: "object" } },
						],
					},
				],
				toolConfig: { functionCallingConfig: { mode: "ANY" } },
			},
			{
				default_model: "gemini-3.5-flash",
				current_input_file_enabled: false,
				current_input_file_min_bytes: 1000000,
				current_input_file_name: "message.txt",
				current_tools_file_name: "tools.txt",
				cookie: "",
				log_requests: false,
			},
			strictProvider({
				async generateText() {
					return "plain answer";
				},
			}),
			parseGoogleGenerationPath(
				"/v1beta/models/gemini-3.5-flash:generateContent",
			),
			false,
		);
		assert.equal(resp.status, 422);
		const body = await resp.json();
		assert.equal(body.error.code, "tool_choice_violation");
		assert.match(
			body.error.message,
			/mode=ANY requires at least one valid function call/,
		);
	});
	test("moves large Google tools into attached tools file", async () => {
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
		const resp = await handleGoogleGenerate(
			{
				contents: [
					{ role: "user", parts: [{ text: `lookup id ${"x".repeat(120)}` }] },
				],
				tools: [
					{
						functionDeclarations: [
							{
								name: "Lookup",
								description: "Lookup by id",
								parameters: {
									type: "object",
									properties: { id: { type: "string" } },
								},
							},
						],
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
			parseGoogleGenerationPath(
				"/v1beta/models/gemini-3.5-flash:generateContent",
			),
			false,
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
		assert.doesNotMatch(prompts[0], /"name": "Lookup"|"properties"/);
		assert.match(uploads[1].text, /Available tool descriptions/);
		assert.match(uploads[1].text, /Tool call format instructions/);
		assert.match(uploads[1].text, /<\|DSML\|tool_calls>/);
		assert.match(uploads[1].text, /Gemini native hidden tool calls/);
		assert.match(uploads[1].text, /"name": "Lookup"/);
		assert.match(uploads[1].text, /"id"/);
	});
	test("maps invalid Gemini cookie errors to Google auth responses", async () => {
		const err = invalidGeminiCookieError({ cookie: "SID=bad" }, 403, 10);
		const provider = strictProvider({
			async generateText() {
				throw err;
			},
		});
		const resp = await handleGoogleGenerate(
			{
				contents: [{ role: "user", parts: [{ text: "plain request" }] }],
			},
			{
				default_model: "gemini-3.5-flash",
				current_input_file_enabled: false,
				current_input_file_min_bytes: 1000000,
				current_input_file_name: "message.txt",
				current_tools_file_name: "tools.txt",
				cookie: "SID=bad",
				log_requests: false,
			},
			provider,
			parseGoogleGenerationPath(
				"/v1beta/models/gemini-3.5-flash:generateContent",
			),
			false,
		);
		assert.equal(resp.status, 401);
		const body = await resp.json();
		assert.equal(body.error.code, "invalid_gemini_cookie");
	});
	test("maps non-stream Google upstream errors to Google error envelopes", async () => {
		const err = streamError("google overloaded secret", "upstream_overloaded");
		err.status = 503;
		const logs = [];
		const resp = await withConsoleLog(
			(line) => logs.push(String(line)),
			() =>
				handleGoogleGenerate(
					{
						contents: [{ role: "user", parts: [{ text: "plain request" }] }],
					},
					{
						default_model: "gemini-3.5-flash",
						current_input_file_enabled: false,
						current_input_file_min_bytes: 1000000,
						current_input_file_name: "message.txt",
						current_tools_file_name: "tools.txt",
						cookie: "",
						log_requests: true,
					},
					strictProvider({
						async generateText() {
							throw err;
						},
					}),
					parseGoogleGenerationPath(
						"/v1beta/models/gemini-3.5-flash:generateContent",
					),
					false,
				),
		);
		assert.equal(resp.status, 503);
		const body = await resp.json();
		assert.equal(body.error.code, "upstream_overloaded");
		assert.match(
			body.error.message,
			/upstream error: google overloaded secret/,
		);
		const failureLog = logs.find((line) =>
			line.includes("google generate failed"),
		);
		assert.match(
			failureLog,
			/error=type=Error code=upstream_overloaded status=503/,
		);
		assert.doesNotMatch(failureLog, /google overloaded secret/);
	});
	test("returns Google upstream_empty error without fallback candidate", async () => {
		const resp = await handleGoogleGenerate(
			{
				contents: [{ role: "user", parts: [{ text: "plain request" }] }],
			},
			{
				default_model: "gemini-3.5-flash",
				current_input_file_enabled: false,
				current_input_file_min_bytes: 1000000,
				current_input_file_name: "message.txt",
				current_tools_file_name: "tools.txt",
				cookie: "",
				log_requests: false,
			},
			strictProvider({
				async generateText() {
					return "";
				},
			}),
			parseGoogleGenerationPath(
				"/v1beta/models/gemini-3.5-flash:generateContent",
			),
			false,
		);
		assert.equal(resp.status, 502);
		const body = await resp.json();
		assert.equal(body.error.code, "upstream_empty");
		assert.equal(body.error.message, EMPTY_UPSTREAM_MSG);
		assert.equal(body.candidates, undefined);
	});
});
