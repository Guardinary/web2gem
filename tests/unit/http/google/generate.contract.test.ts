import { describe, test } from "vitest";
import type { ApplicationExecutionContext } from "../../../../src/app";
import type { AttachmentPlan } from "../../../../src/attachments/types";
import { EMPTY_UPSTREAM_MSG } from "../../../../src/completion/turn";
import type { FileRef } from "../../../../src/completion/types";
import { invalidGeminiCookieError } from "../../../../src/gemini/client/errors";
import worker from "../../../../src/index";
import { isRecord, type UnknownRecord } from "../../../../src/shared/types";
import {
	googleConfig,
	googleRoute,
	handleGoogle,
} from "./_support/fixtures.js";
import { withConsoleLog } from "../../_support/globals.js";
import { assert } from "../../assertions.js";
import { attachmentResult } from "../../attachments/_support/result.js";
import {
	noWorkProvider,
	streamError,
	strictProvider,
} from "../_support/provider.js";

const execution: ApplicationExecutionContext = { waitUntil() {} };

function responseRecord(value: unknown): UnknownRecord {
	if (!isRecord(value)) throw new Error("expected response object");
	return value;
}

function responseError(value: unknown): UnknownRecord {
	const error = responseRecord(value).error;
	if (!isRecord(error)) throw new Error("expected response error");
	return error;
}

function first<T>(values: readonly T[]): T {
	const value = values[0];
	if (value === undefined) throw new Error("expected recorded value");
	return value;
}

describe("Google generate handler", () => {
	test("rejects invalid Google model before provider generation", async () => {
		const resp = await handleGoogle(
			{
				contents: [{ role: "user", parts: [{ text: "plain request" }] }],
			},
			{
				default_model: "gemini-3.5-flash",
				current_input_file_enabled: false,
				current_input_file_min_bytes: 1000000,
				cookie: "",
				log_requests: false,
			},
			noWorkProvider(),
			googleRoute("/v1beta/models/not-a-model:generateContent"),
		);
		assert.equal(resp.status, 400);
		assert.equal(responseError(await resp.json()).code, "model_not_found");
	});
	test("hands inline Google tools to the provider without polluting plain requests", async () => {
		const toolPrompts: string[] = [];
		const toolResp = await handleGoogle(
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
			googleConfig(),
			strictProvider({
				async generateText(input) {
					toolPrompts.push(input.prompt);
					return "done";
				},
			}),
			googleRoute("/v1beta/models/gemini-3.5-flash:generateContent"),
		);
		assert.equal(toolResp.status, 200);
		assert.match(first(toolPrompts), /Available tools/);
		assert.match(first(toolPrompts), /<\|DSML\|tool_calls>/);
		assert.match(first(toolPrompts), /"name": "Read"/);
		assert.match(first(toolPrompts), /"path"/);

		const plainPrompts: string[] = [];
		const plainResp = await handleGoogle(
			{
				contents: [{ role: "user", parts: [{ text: "plain request" }] }],
			},
			googleConfig(),
			strictProvider({
				async generateText(input) {
					plainPrompts.push(input.prompt);
					return "done";
				},
			}),
			googleRoute("/v1beta/models/gemini-3.5-flash:generateContent"),
		);
		assert.equal(plainResp.status, 200);
		assert.doesNotMatch(
			first(plainPrompts),
			/Available tools|<\|DSML\|tool_calls>/,
		);
	});
	test("maps Google system image and function history into the provider prompt", async () => {
		const prompts: string[] = [];
		const plans: AttachmentPlan[] = [];
		const resp = await handleGoogle(
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
			googleConfig(),
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
			googleRoute("/v1beta/models/gemini-3.5-flash:generateContent"),
		);
		assert.equal(resp.status, 200);
		assert.equal(first(plans).candidates.length, 1);
		assert.match(first(prompts), /\[System instruction\]: be concise/);
		assert.match(first(prompts), /inspect image/);
		assert.match(first(prompts), /\[image input\]/);
		assert.match(
			first(prompts),
			/\[Assistant\]: \n<\|DSML\|tool_calls><\|DSML\|invoke name="Lookup">/,
		);
		assert.match(first(prompts), /\[Tool result for Lookup\]: \{"ok":true\}/);
	});
	test("passes Google image context and generic refs in protocol order", async () => {
		let seenFileRefs: FileRef[] | null | undefined;
		const imageRef = { ref: "/uploaded/image", name: "image.png" };
		const genericRef = { ref: "/uploaded/file", name: "note.txt" };
		const resp = await handleGoogle(
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
			googleRoute("/v1beta/models/gemini-3.5-flash:generateContent"),
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
			execution,
		);
		assert.equal(resp.status, 400);
		const error = responseError(await resp.json());
		assert.equal(error.code, "invalid_tool_choice");
		assert.match(error.message, /mode=ANY requires at least one tool/);
	});
	test("returns Google tool-choice errors for non-stream plain answers", async () => {
		const resp = await handleGoogle(
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
				cookie: "",
				log_requests: false,
			},
			strictProvider({
				async generateText() {
					return "plain answer";
				},
			}),
			googleRoute("/v1beta/models/gemini-3.5-flash:generateContent"),
		);
		assert.equal(resp.status, 422);
		const error = responseError(await resp.json());
		assert.equal(error.code, "tool_choice_violation");
		assert.match(
			error.message,
			/mode=ANY requires at least one valid function call/,
		);
	});
	test("moves large Google tools into attached tools file", async () => {
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
		const resp = await handleGoogle(
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
				cookie: "SID=ok",
				supports_authenticated_session: true,
				log_requests: false,
			},
			provider,
			googleRoute("/v1beta/models/gemini-3.5-flash:generateContent"),
		);
		assert.equal(resp.status, 200);
		assert.equal(uploads.length, 2);
		assert.doesNotMatch(first(prompts), /<\|DSML\|tool_calls>/);
		assert.match(
			first(prompts),
			/Continue from the latest state in the attached `message\.txt` context/,
		);
		assert.match(first(prompts), /tools\.txt/);
		assert.match(
			first(prompts),
			/All text above this sentence is system prompt content/,
		);
		assert.doesNotMatch(first(prompts), /Gemini native hidden tool calls/);
		assert.doesNotMatch(first(prompts), /Available tools/);
		assert.doesNotMatch(first(prompts), /"name": "Lookup"|"properties"/);
		assert.match(first(uploads.slice(1)).text, /Available tool descriptions/);
		assert.match(first(uploads.slice(1)).text, /Tool call format instructions/);
		assert.match(first(uploads.slice(1)).text, /<\|DSML\|tool_calls>/);
		assert.match(
			first(uploads.slice(1)).text,
			/Gemini native hidden tool calls/,
		);
		assert.match(first(uploads.slice(1)).text, /"name": "Lookup"/);
		assert.match(first(uploads.slice(1)).text, /"id"/);
	});
	test("maps invalid Gemini cookie errors to Google auth responses", async () => {
		const err = invalidGeminiCookieError({ cookie: "SID=bad" }, 403, 10);
		const provider = strictProvider({
			async generateText() {
				throw err;
			},
		});
		const resp = await handleGoogle(
			{
				contents: [{ role: "user", parts: [{ text: "plain request" }] }],
			},
			{
				default_model: "gemini-3.5-flash",
				current_input_file_enabled: false,
				current_input_file_min_bytes: 1000000,
				cookie: "SID=bad",
				log_requests: false,
			},
			provider,
			googleRoute("/v1beta/models/gemini-3.5-flash:generateContent"),
		);
		assert.equal(resp.status, 401);
		assert.equal(
			responseError(await resp.json()).code,
			"invalid_gemini_cookie",
		);
	});
	test("maps non-stream Google upstream errors to Google error envelopes", async () => {
		const err = streamError("google overloaded secret", "upstream_overloaded");
		err.status = 503;
		const logs: string[] = [];
		const resp = await withConsoleLog(
			(line: unknown) => logs.push(String(line)),
			() =>
				handleGoogle(
					{
						contents: [{ role: "user", parts: [{ text: "plain request" }] }],
					},
					{
						default_model: "gemini-3.5-flash",
						current_input_file_enabled: false,
						current_input_file_min_bytes: 1000000,
						cookie: "",
						log_requests: true,
					},
					strictProvider({
						async generateText() {
							throw err;
						},
					}),
					googleRoute("/v1beta/models/gemini-3.5-flash:generateContent"),
				),
		);
		assert.equal(resp.status, 503);
		const error = responseError(await resp.json());
		assert.equal(error.code, "upstream_overloaded");
		assert.match(error.message, /upstream error: google overloaded secret/);
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
		const resp = await handleGoogle(
			{
				contents: [{ role: "user", parts: [{ text: "plain request" }] }],
			},
			{
				default_model: "gemini-3.5-flash",
				current_input_file_enabled: false,
				current_input_file_min_bytes: 1000000,
				cookie: "",
				log_requests: false,
			},
			strictProvider({
				async generateText() {
					return "";
				},
			}),
			googleRoute("/v1beta/models/gemini-3.5-flash:generateContent"),
		);
		assert.equal(resp.status, 502);
		const body = responseRecord(await resp.json());
		const error = responseError(body);
		assert.equal(error.code, "upstream_empty");
		assert.equal(error.message, EMPTY_UPSTREAM_MSG);
		assert.equal(body.candidates, undefined);
	});
});
