import { describe, test } from "vitest";
import type {
	AttachmentCandidate,
	AttachmentFileRef,
	AttachmentPlan,
} from "../../../../src/attachments/types";
import { EMPTY_UPSTREAM_MSG } from "../../../../src/completion/turn";
import { handleChat } from "../../../../src/http/openai/chat";
import type { UnknownRecord } from "../../../../src/shared/types";
import { assert } from "../../assertions.js";
import { withConsoleLog } from "../../_support/globals.js";
import { attachmentResult } from "../../attachments/_support/result.js";
import { streamError } from "../_support/provider.js";
import { strictProvider } from "../_support/provider.js";
import { openAIConfig, record, required } from "./_support/fixtures.js";

function recordAt(value: unknown, index: number, label: string): UnknownRecord {
	if (!Array.isArray(value)) throw new Error(`expected ${label} array`);
	return record(value[index], `${label} ${index}`);
}

function chatChoice(body: UnknownRecord): UnknownRecord {
	return recordAt(body.choices, 0, "chat choices");
}

function chatMessage(choice: UnknownRecord): UnknownRecord {
	return record(choice.message, "chat message");
}

function responseError(body: UnknownRecord): UnknownRecord {
	return record(body.error, "response error");
}

function simplifyAttachmentCandidate(
	candidate: AttachmentCandidate,
): UnknownRecord {
	const out: UnknownRecord = {};
	if (candidate.source.type === "base64") out.b64 = candidate.source.data;
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
			openAIConfig({
				default_model: "gemini-3.5-flash",
				current_input_file_enabled: false,
				current_input_file_min_bytes: 1000000,
				log_requests: false,
			}),
			strictProvider({
				async generateText(input) {
					assert.match(input.prompt, /say hi/);
					return "hello";
				},
			}),
		);
		assert.equal(resp.status, 200);
		const body = record(await resp.json(), "chat response");
		const choice = chatChoice(body);
		assert.equal(body.object, "chat.completion");
		assert.equal(chatMessage(choice).content, "hello");
		assert.equal(choice.finish_reason, "stop");
		const usage = record(body.usage, "chat usage");
		if (
			typeof usage.total_tokens !== "number" ||
			typeof usage.prompt_tokens !== "number"
		)
			throw new Error("expected numeric chat usage");
		assert.equal(usage.total_tokens >= usage.prompt_tokens, true);
	});
	test("passes OpenAI file-id aliases to the provider in request order", async () => {
		let seenFileRefs: AttachmentFileRef[] | null | undefined = null;
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
			openAIConfig(),
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
		let seenFiles: UnknownRecord[] | null = null;
		let seenFileRefs: AttachmentFileRef[] | null | undefined = null;
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
			openAIConfig(),
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
		let seenPlan: AttachmentPlan | null = null;
		let seenFileRefs: AttachmentFileRef[] | null | undefined = null;
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
			openAIConfig(),
			strictProvider({
				async resolveAttachments(attachmentPlan) {
					seenPlan = attachmentPlan;
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
		const plan = required<AttachmentPlan>(seenPlan, "attachment plan");
		assert.deepEqual(plan.candidates.map(simplifyAttachmentCandidate), [
			{ b64: "dG9w", mime: "text/plain", filename: "top.txt" },
			{ b64: "aGVsbG8=", mime: "text/plain", filename: "note.txt" },
		]);
		assert.deepEqual(plan.existingFileRefs, [
			{ id: "file_existing", name: "existing.txt" },
		]);
		assert.deepEqual(seenFileRefs, resolvedRefs);
	});
	test("adds dropped generic file note and continues OpenAI chat generation", async () => {
		let seenPrompt = "";
		let seenFileRefs: AttachmentFileRef[] | null | "unset" | undefined =
			"unset";
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
			openAIConfig(),
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
		const body = record(await resp.json(), "dropped-file chat response");
		assert.equal(chatMessage(chatChoice(body)).content, "continued");
		assert.match(
			seenPrompt,
			/\[Note: 1 file\(s\) were provided but ignored - attachment upload failed\.\]/,
		);
		assert.equal(seenFileRefs, null);
	});
	test("inlines anonymous generic file text and suppresses file refs before OpenAI chat generation", async () => {
		let seenPrompt = "";
		let seenFileRefs: AttachmentFileRef[] | null | "unset" | undefined =
			"unset";
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
			openAIConfig(),
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
		const body = record(await resp.json(), "inlined-file chat response");
		assert.equal(chatMessage(chatChoice(body)).content, "continued");
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
			openAIConfig({
				default_model: "gemini-3.5-flash",
				current_input_file_enabled: false,
				current_input_file_min_bytes: 1000000,
				log_requests: false,
			}),
			strictProvider({
				async generateText() {
					return "";
				},
			}),
		);
		assert.equal(resp.status, 502);
		const body = record(await resp.json(), "empty chat response");
		const error = responseError(body);
		assert.equal(error.code, "upstream_empty");
		assert.equal(error.message, EMPTY_UPSTREAM_MSG);
		assert.equal(body.choices, undefined);
	});
	test("canonicalizes successful non-stream OpenAI json_object output", async () => {
		const resp = await handleChat(
			{
				model: "gemini-3.5-flash",
				messages: [{ role: "user", content: "return json" }],
				response_format: { type: "json_object" },
			},
			openAIConfig(),
			strictProvider({
				async generateText(input) {
					assert.match(input.prompt, /STRUCTURED OUTPUT REQUIREMENT/);
					return '```json\n{"ok":true}\n```';
				},
			}),
		);
		assert.equal(resp.status, 200);
		const body = record(await resp.json(), "JSON chat response");
		const choice = chatChoice(body);
		assert.equal(chatMessage(choice).content, '{"ok":true}');
		assert.equal(choice.finish_reason, "stop");
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
			openAIConfig({
				default_model: "gemini-3.5-flash",
				current_input_file_enabled: false,
				current_input_file_min_bytes: 1000000,
				log_requests: false,
			}),
			strictProvider({
				async generateText(input) {
					assert.match(input.prompt, /Schema name: strict_result/);
					return '{"ok":true,"extra":1}';
				},
			}),
		);
		assert.equal(resp.status, 502);
		const error = responseError(
			record(await resp.json(), "schema error response"),
		);
		assert.equal(error.code, "structured_output_validation_failed");
		assert.match(error.message, /extra is not allowed/);
	});
	test("maps non-stream OpenAI Chat upstream errors to OpenAI error format", async () => {
		const err = streamError("chat overloaded secret", "chat_overloaded");
		err.status = 503;
		const logs: string[] = [];
		const resp = await withConsoleLog(
			(line: unknown) => logs.push(String(line)),
			() =>
				handleChat(
					{
						model: "gemini-3.5-flash",
						messages: [{ role: "user", content: "try once" }],
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
		const error = responseError(
			record(await resp.json(), "upstream chat response"),
		);
		assert.equal(error.code, "chat_overloaded");
		assert.equal(error.type, "service_unavailable_error");
		assert.match(error.message, /upstream error: chat overloaded secret/);
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
		const logs: string[] = [];
		const resp = await withConsoleLog(
			(line: unknown) => logs.push(String(line)),
			() =>
				handleChat(
					{
						model: "gemini-3.5-flash",
						messages: [{ role: "user", content: "try once" }],
					},
					openAIConfig({ log_requests: true }),
					strictProvider({
						async generateText() {
							throw err;
						},
					}),
				),
		);
		assert.equal(resp.status, 502);
		const error = responseError(
			record(await resp.json(), "empty upstream response"),
		);
		assert.equal(error.code, "upstream_empty_response");
		assert.equal(error.type, "api_error");
		assert.match(
			error.message,
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
