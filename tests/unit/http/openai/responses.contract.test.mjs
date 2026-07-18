import { describe, test } from "vitest";
import { EMPTY_UPSTREAM_MSG } from "../../../../src/completion/turn";
import { handleResponses } from "../../../../src/http/openai/responses";
import { assert } from "../../assertions.js";
import { withConsoleLog } from "../../_support/globals.js";
import { baseConfig } from "../../_support/runtime-config.js";
import { attachmentResult } from "../../attachments/_support/result.js";
import { streamError } from "../_support/provider.js";
import { noWorkProvider, strictProvider } from "../_support/provider.js";

describe("OpenAI Responses completion", () => {
	test("passes top-level Responses input_file uploads to provider", async () => {
		let seenFiles = null;
		let seenFileRefs = null;
		const resp = await handleResponses(
			{
				model: "gemini-3.5-flash",
				input: [
					{ type: "input_text", text: "review this note" },
					{
						type: "input_file",
						filename: "../note.txt",
						file_data: { data: "aGVsbG8=", mime_type: "text/plain" },
					},
				],
			},
			baseConfig(),
			strictProvider({
				async resolveAttachments(plan) {
					seenFiles = plan.candidates.map((candidate) => ({
						b64: candidate.source.data,
						mime: candidate.mime,
						filename: candidate.filename,
					}));
					return attachmentResult({
						fileRefs: [{ ref: "/uploaded/note", name: "note.txt" }],
						genericFileRefs: [{ ref: "/uploaded/note", name: "note.txt" }],
					});
				},
				async generateText(input) {
					seenFileRefs = input.fileRefs;
					return "done";
				},
			}),
		);
		assert.equal(resp.status, 200);
		assert.deepEqual(seenFiles, [
			{ b64: "aGVsbG8=", mime: "text/plain", filename: "note.txt" },
		]);
		assert.deepEqual(seenFileRefs, [
			{ ref: "/uploaded/note", name: "note.txt" },
		]);
	});
	test("hands inline Responses tools to the provider without polluting plain input", async () => {
		const toolPrompts = [];
		const toolResp = await handleResponses(
			{
				model: "gemini-3.5-flash",
				input: "find docs",
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
			baseConfig(),
			strictProvider({
				async generateText(input) {
					toolPrompts.push(input.prompt);
					return "done";
				},
			}),
		);
		assert.equal(toolResp.status, 200);
		assert.match(toolPrompts[0], /Available tools/);
		assert.match(toolPrompts[0], /<\|DSML\|tool_calls>/);
		assert.match(toolPrompts[0], /"name": "Search"/);
		assert.match(toolPrompts[0], /"query"/);

		const plainPrompts = [];
		const plainResp = await handleResponses(
			{
				model: "gemini-3.5-flash",
				input: "plain request",
			},
			baseConfig(),
			strictProvider({
				async generateText(input) {
					plainPrompts.push(input.prompt);
					return "done";
				},
			}),
		);
		assert.equal(plainResp.status, 200);
		assert.doesNotMatch(
			plainPrompts[0],
			/Available tools|<\|DSML\|tool_calls>/,
		);
	});
	test("rejects invalid non-stream structured OpenAI Responses JSON schema output", async () => {
		const resp = await handleResponses(
			{
				model: "gemini-3.5-flash",
				input: "return strict json",
				text: {
					format: {
						type: "json_schema",
						name: "strict_response",
						schema: {
							type: "object",
							required: ["ok"],
							additionalProperties: false,
							properties: { ok: { type: "boolean" } },
						},
					},
				},
			},
			{
				default_model: "gemini-3.5-flash",
				current_input_file_enabled: false,
				current_input_file_min_bytes: 1000000,
				log_requests: false,
			},
			strictProvider({
				async generateText(input) {
					assert.match(input.prompt, /Schema name: strict_response/);
					return '{"ok":true,"extra":1}';
				},
			}),
		);
		assert.equal(resp.status, 502);
		const body = await resp.json();
		assert.equal(body.error.code, "structured_output_validation_failed");
		assert.match(body.error.message, /extra is not allowed/);
	});
	test("maps non-stream OpenAI Responses upstream errors to OpenAI error format", async () => {
		const err = streamError(
			"responses overloaded secret",
			"upstream_overloaded",
		);
		err.status = 503;
		const logs = [];
		const resp = await withConsoleLog(
			(line) => logs.push(String(line)),
			() =>
				handleResponses(
					{
						model: "gemini-3.5-flash",
						input: "try once",
					},
					{
						default_model: "gemini-3.5-flash",
						current_input_file_enabled: false,
						current_input_file_min_bytes: 1000000,
						log_requests: true,
					},
					strictProvider({
						async generateText() {
							throw err;
						},
					}),
				),
		);
		assert.equal(resp.status, 503);
		const body = await resp.json();
		assert.equal(body.error.code, "upstream_overloaded");
		assert.equal(body.error.type, "service_unavailable_error");
		assert.match(
			body.error.message,
			/upstream error: responses overloaded secret/,
		);
		const failureLog = logs.find((line) =>
			line.includes("openai responses generate failed"),
		);
		assert.match(
			failureLog,
			/error=type=Error code=upstream_overloaded status=503/,
		);
		assert.doesNotMatch(failureLog, /responses overloaded secret/);
	});
	test("rejects missing OpenAI Responses request objects", async () => {
		const resp = await handleResponses(
			undefined,
			baseConfig(),
			noWorkProvider(),
		);
		assert.equal(resp.status, 400);
		const body = await resp.json();
		assert.equal(body.error.message, "request body must be a JSON object");
	});
	test("returns OpenAI Responses upstream_empty error without model output", async () => {
		const resp = await handleResponses(
			{
				model: "gemini-3.5-flash",
				input: "say something",
			},
			baseConfig(),
			strictProvider({
				async generateText() {
					return "";
				},
			}),
		);
		assert.equal(resp.status, 502);
		const body = await resp.json();
		assert.equal(body.error.code, "upstream_empty");
		assert.equal(body.error.message, EMPTY_UPSTREAM_MSG);
		assert.equal(body.output, undefined);
	});
});
