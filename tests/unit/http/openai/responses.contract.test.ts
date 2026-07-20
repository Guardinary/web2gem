import { describe, test } from "vitest";
import type { AttachmentFileRef } from "../../../../src/attachments/types";
import { EMPTY_UPSTREAM_MSG } from "../../../../src/completion/turn";
import { handleResponses } from "../../../../src/http/openai/responses";
import { assert } from "../../assertions.js";
import { withConsoleLog } from "../../_support/globals.js";
import { attachmentResult } from "../../attachments/_support/result.js";
import { streamError } from "../_support/provider.js";
import { noWorkProvider, strictProvider } from "../_support/provider.js";
import { openAIConfig, record, responseError } from "./_support/fixtures.js";

function first<T>(values: readonly T[], label: string): T {
	const value = values[0];
	if (value === undefined) throw new Error(`expected ${label}`);
	return value;
}

describe("OpenAI Responses completion", () => {
	test("passes top-level Responses input_file uploads to provider", async () => {
		let seenFiles:
			| {
					b64: unknown;
					mime: string | undefined;
					filename: string | undefined;
			  }[]
			| null = null;
		let seenFileRefs: AttachmentFileRef[] | null | undefined = null;
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
			openAIConfig(),
			strictProvider({
				async resolveAttachments(plan) {
					seenFiles = plan.candidates.map((candidate) => ({
						b64:
							candidate.source.type === "base64"
								? candidate.source.data
								: candidate.source.bytes,
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
		const toolPrompts: string[] = [];
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
			openAIConfig(),
			strictProvider({
				async generateText(input) {
					toolPrompts.push(input.prompt);
					return "done";
				},
			}),
		);
		assert.equal(toolResp.status, 200);
		const toolPrompt = first(toolPrompts, "tool prompt");
		assert.match(toolPrompt, /Available tools/);
		assert.match(toolPrompt, /<\|DSML\|tool_calls>/);
		assert.match(toolPrompt, /"name": "Search"/);
		assert.match(toolPrompt, /"query"/);

		const plainPrompts: string[] = [];
		const plainResp = await handleResponses(
			{
				model: "gemini-3.5-flash",
				input: "plain request",
			},
			openAIConfig(),
			strictProvider({
				async generateText(input) {
					plainPrompts.push(input.prompt);
					return "done";
				},
			}),
		);
		assert.equal(plainResp.status, 200);
		assert.doesNotMatch(
			first(plainPrompts, "plain prompt"),
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
			openAIConfig({
				default_model: "gemini-3.5-flash",
				current_input_file_enabled: false,
				current_input_file_min_bytes: 1000000,
				log_requests: false,
			}),
			strictProvider({
				async generateText(input) {
					assert.match(input.prompt, /Schema name: strict_response/);
					return '{"ok":true,"extra":1}';
				},
			}),
		);
		assert.equal(resp.status, 502);
		const error = responseError(await resp.json());
		assert.equal(error.code, "structured_output_validation_failed");
		assert.match(error.message, /extra is not allowed/);
	});
	test("maps non-stream OpenAI Responses upstream errors to OpenAI error format", async () => {
		const err = streamError(
			"responses overloaded secret",
			"upstream_overloaded",
		);
		err.status = 503;
		const logs: string[] = [];
		const resp = await withConsoleLog(
			(line: unknown) => logs.push(String(line)),
			() =>
				handleResponses(
					{
						model: "gemini-3.5-flash",
						input: "try once",
					},
					openAIConfig({
						default_model: "gemini-3.5-flash",
						current_input_file_enabled: false,
						current_input_file_min_bytes: 1000000,
						log_requests: true,
					}),
					strictProvider({
						async generateText() {
							throw err;
						},
					}),
				),
		);
		assert.equal(resp.status, 503);
		const error = responseError(await resp.json());
		assert.equal(error.code, "upstream_overloaded");
		assert.equal(error.type, "service_unavailable_error");
		assert.match(error.message, /upstream error: responses overloaded secret/);
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
			openAIConfig(),
			noWorkProvider(),
		);
		assert.equal(resp.status, 400);
		assert.equal(
			responseError(await resp.json()).message,
			"request body must be a JSON object",
		);
	});
	test("returns OpenAI Responses upstream_empty error without model output", async () => {
		const resp = await handleResponses(
			{
				model: "gemini-3.5-flash",
				input: "say something",
			},
			openAIConfig(),
			strictProvider({
				async generateText() {
					return "";
				},
			}),
		);
		assert.equal(resp.status, 502);
		const body = record(await resp.json(), "empty response");
		const error = record(body.error, "empty response error");
		assert.equal(error.code, "upstream_empty");
		assert.equal(error.message, EMPTY_UPSTREAM_MSG);
		assert.equal(body.output, undefined);
	});
});
