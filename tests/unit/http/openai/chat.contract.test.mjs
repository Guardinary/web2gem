import { describe, test } from "vitest";
import { EMPTY_UPSTREAM_MSG } from "../../../../src/completion/turn";
import { handleChat } from "../../../../src/http/openai/chat";
import { assert } from "../../assertions.js";
import {
	attachmentResult,
	baseConfig,
	streamError,
	withConsoleLog,
} from "../../helpers.js";
import { strictProvider } from "../_support/provider.js";

function simplifyAttachmentCandidate(candidate) {
	const out = {};
	if (candidate.source?.type === "base64") out.b64 = candidate.source.data;
	if (candidate.mime) out.mime = candidate.mime;
	if (candidate.filename) out.filename = candidate.filename;
	return out;
}

describe("OpenAI Chat completion", () => {
	test("returns OpenAI chat completions with text usage and stop finish", async () => {
		const resp = await handleChat(
			{
				model: "gemini-3.5-flash",
				messages: [{ role: "user", content: "say hi" }],
			},
			{
				default_model: "gemini-3.5-flash",
				current_input_file_enabled: false,
				current_input_file_min_bytes: 1000000,
				log_requests: false,
			},
			strictProvider({
				async generateText(input) {
					assert.match(input.prompt, /say hi/);
					return "hello";
				},
			}),
		);
		assert.equal(resp.status, 200);
		const body = await resp.json();
		assert.equal(body.object, "chat.completion");
		assert.equal(body.choices[0].message.content, "hello");
		assert.equal(body.choices[0].finish_reason, "stop");
		assert.equal(body.usage.total_tokens >= body.usage.prompt_tokens, true);
	});
	test("passes OpenAI file-id aliases to the provider in request order", async () => {
		let seenFileRefs = null;
		const resp = await handleChat(
			{
				model: "gemini-3.5-flash",
				ref_file_ids: ["file_top"],
				file_ids: ["file_alias"],
				messages: [
					{
						role: "user",
						content: [
							{
								type: "input_file",
								file_id: "file_message",
								filename: "message.txt",
							},
						],
					},
				],
			},
			baseConfig(),
			strictProvider({
				async generateText(input) {
					seenFileRefs = input.fileRefs;
					return "done";
				},
			}),
		);
		assert.equal(resp.status, 200);
		assert.deepEqual(seenFileRefs, [
			"file_top",
			"file_alias",
			{ id: "file_message", name: "message.txt" },
		]);
	});
	test("passes OpenAI inline input_file uploads to provider without treating bytes as file ids", async () => {
		let seenFiles = null;
		let seenFileRefs = null;
		const resp = await handleChat(
			{
				model: "gemini-3.5-flash",
				ref_file_ids: ["file_existing"],
				messages: [
					{
						role: "user",
						content: [
							{ type: "input_text", text: "review this code" },
							{
								type: "input_file",
								id: "part_1",
								filename: "../main.py",
								file_data: "data:text/x-python;base64,cHJpbnQoMSkK",
							},
						],
					},
				],
			},
			baseConfig(),
			strictProvider({
				async resolveAttachments(plan) {
					seenFiles = plan.candidates.map(simplifyAttachmentCandidate);
					return attachmentResult({
						fileRefs: [{ ref: "/uploaded/main-py", name: "main.py" }],
						genericFileRefs: [{ ref: "/uploaded/main-py", name: "main.py" }],
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
			{ b64: "cHJpbnQoMSkK", mime: "text/x-python", filename: "main.py" },
		]);
		assert.deepEqual(seenFileRefs, [
			"file_existing",
			{ ref: "/uploaded/main-py", name: "main.py" },
		]);
	});
	test("keeps nested inline and top-level OpenAI attachments distinct", async () => {
		let seenPlan = null;
		let seenFileRefs = null;
		const resolvedRefs = [
			{ id: "file_existing", name: "existing.txt" },
			{ ref: "/uploaded/top", name: "top.txt" },
			{ ref: "/uploaded/note", name: "note.txt" },
		];
		const resp = await handleChat(
			{
				model: "gemini-3.5-flash",
				messages: [
					{
						role: "user",
						content: [
							{ type: "input_text", text: "review attachments" },
							{
								type: "input_file",
								file: {
									id: "local_part",
									data: "aGVsbG8=",
									filename: "note.txt",
									mime_type: "text/plain",
								},
							},
						],
					},
				],
				attachments: [
					{
						type: "input_file",
						id: "local_top",
						filename: "../top.txt",
						file_data: "dG9w",
						mime_type: "text/plain",
					},
					{
						type: "file",
						file_id: "file_existing",
						filename: "existing.txt",
					},
				],
			},
			baseConfig(),
			strictProvider({
				async resolveAttachments(plan) {
					seenPlan = plan;
					return attachmentResult({
						fileRefs: resolvedRefs,
						genericFileRefs: resolvedRefs,
					});
				},
				async generateText(input) {
					seenFileRefs = input.fileRefs;
					return "done";
				},
			}),
		);
		assert.equal(resp.status, 200);
		assert.deepEqual(seenPlan.candidates.map(simplifyAttachmentCandidate), [
			{ b64: "dG9w", mime: "text/plain", filename: "top.txt" },
			{ b64: "aGVsbG8=", mime: "text/plain", filename: "note.txt" },
		]);
		assert.deepEqual(seenPlan.existingFileRefs, [
			{ id: "file_existing", name: "existing.txt" },
		]);
		assert.deepEqual(seenFileRefs, resolvedRefs);
	});
	test("adds dropped generic file note and continues OpenAI chat generation", async () => {
		let seenPrompt = "";
		let seenFileRefs = "unset";
		const resp = await handleChat(
			{
				model: "gemini-3.5-flash",
				messages: [
					{
						role: "user",
						content: [
							{ type: "input_file", data: "aGVsbG8=", filename: "note.txt" },
						],
					},
				],
			},
			baseConfig(),
			strictProvider({
				async resolveAttachments() {
					return attachmentResult({
						droppedNote:
							"\n\n[Note: 1 file(s) were provided but ignored - attachment upload failed.]",
					});
				},
				async generateText(input) {
					seenPrompt = input.prompt;
					seenFileRefs = input.fileRefs;
					return "continued";
				},
			}),
		);
		assert.equal(resp.status, 200);
		const body = await resp.json();
		assert.equal(body.choices[0].message.content, "continued");
		assert.match(
			seenPrompt,
			/\[Note: 1 file\(s\) were provided but ignored - attachment upload failed\.\]/,
		);
		assert.equal(seenFileRefs, null);
	});
	test("inlines anonymous generic file text and suppresses file refs before OpenAI chat generation", async () => {
		let seenPrompt = "";
		let seenFileRefs = "unset";
		const resp = await handleChat(
			{
				model: "gemini-3.5-flash",
				ref_file_ids: ["file_existing"],
				messages: [
					{
						role: "user",
						content: [
							{ type: "input_text", text: "summarize this" },
							{
								type: "input_file",
								data: "aGVsbG8=",
								filename: "note.txt",
								mime: "text/plain",
							},
						],
					},
				],
			},
			baseConfig(),
			strictProvider({
				async resolveAttachments() {
					return attachmentResult({
						promptText:
							"\n\n[File attachment: note.txt]\nhello\n[/File attachment]",
						supportsFileRefs: false,
					});
				},
				async generateText(input) {
					seenPrompt = input.prompt;
					seenFileRefs = input.fileRefs;
					return "continued";
				},
			}),
		);
		assert.equal(resp.status, 200);
		const body = await resp.json();
		assert.equal(body.choices[0].message.content, "continued");
		assert.match(seenPrompt, /summarize this/);
		assert.match(
			seenPrompt,
			/\[File attachment: note\.txt\]\nhello\n\[\/File attachment\]/,
		);
		assert.equal(seenFileRefs, null);
	});
	test("returns OpenAI chat upstream_empty error without model text", async () => {
		const resp = await handleChat(
			{
				model: "gemini-3.5-flash",
				messages: [{ role: "user", content: "say something" }],
			},
			{
				default_model: "gemini-3.5-flash",
				current_input_file_enabled: false,
				current_input_file_min_bytes: 1000000,
				log_requests: false,
			},
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
		assert.equal(body.choices, undefined);
	});
	test("canonicalizes successful non-stream OpenAI json_object output", async () => {
		const resp = await handleChat(
			{
				model: "gemini-3.5-flash",
				messages: [{ role: "user", content: "return json" }],
				response_format: { type: "json_object" },
			},
			baseConfig(),
			strictProvider({
				async generateText(input) {
					assert.match(input.prompt, /STRUCTURED OUTPUT REQUIREMENT/);
					return '```json\n{"ok":true}\n```';
				},
			}),
		);
		assert.equal(resp.status, 200);
		const body = await resp.json();
		assert.equal(body.choices[0].message.content, '{"ok":true}');
		assert.equal(body.choices[0].finish_reason, "stop");
	});
	test("rejects invalid non-stream structured OpenAI chat JSON schema output", async () => {
		const resp = await handleChat(
			{
				model: "gemini-3.5-flash",
				messages: [{ role: "user", content: "return strict json" }],
				response_format: {
					type: "json_schema",
					json_schema: {
						name: "strict_result",
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
					assert.match(input.prompt, /Schema name: strict_result/);
					return '{"ok":true,"extra":1}';
				},
			}),
		);
		assert.equal(resp.status, 502);
		const body = await resp.json();
		assert.equal(body.error.code, "structured_output_validation_failed");
		assert.match(body.error.message, /extra is not allowed/);
	});
	test("maps non-stream OpenAI Chat upstream errors to OpenAI error format", async () => {
		const err = streamError("chat overloaded secret", "chat_overloaded");
		err.status = 503;
		const logs = [];
		const resp = await withConsoleLog(
			(line) => logs.push(String(line)),
			() =>
				handleChat(
					{
						model: "gemini-3.5-flash",
						messages: [{ role: "user", content: "try once" }],
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
		assert.equal(body.error.code, "chat_overloaded");
		assert.equal(body.error.type, "service_unavailable_error");
		assert.match(body.error.message, /upstream error: chat overloaded secret/);
		const failureLog = logs.find((line) =>
			line.includes("openai chat generate failed"),
		);
		assert.match(
			failureLog,
			/error=type=Error code=chat_overloaded status=503/,
		);
		assert.doesNotMatch(failureLog, /chat overloaded secret/);
	});
	test("maps non-stream OpenAI Chat upstream empty errors instead of returning fallback 200", async () => {
		const err = streamError(
			"Gemini upstream HTTP 200 returned no parseable text (non-stream)",
			"upstream_empty_response",
		);
		err.status = 502;
		err.upstreamStatus = 200;
		err.rawLength = 31;
		const logs = [];
		const resp = await withConsoleLog(
			(line) => logs.push(String(line)),
			() =>
				handleChat(
					{
						model: "gemini-3.5-flash",
						messages: [{ role: "user", content: "try once" }],
					},
					baseConfig({ log_requests: true }),
					strictProvider({
						async generateText() {
							throw err;
						},
					}),
				),
		);
		assert.equal(resp.status, 502);
		const body = await resp.json();
		assert.equal(body.error.code, "upstream_empty_response");
		assert.equal(body.error.type, "api_error");
		assert.match(
			body.error.message,
			/upstream error: Gemini upstream HTTP 200 returned no parseable text/,
		);
		const failureLog = logs.find((line) =>
			line.includes("openai chat generate failed"),
		);
		assert.match(
			failureLog,
			/error=type=Error code=upstream_empty_response status=502 upstreamStatus=200 rawLength=31/,
		);
	});
});
