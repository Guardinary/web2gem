import { describe, test } from "vitest";
import {
	googleConfig,
	googleRoute,
	handleGoogle,
} from "./_support/fixtures.js";
import {
	streamGooglePlain,
	streamGoogleTools,
} from "../../../../src/http/google/stream";
import { isRecord } from "../../../../src/shared/types";
import { parseGoogleToolChoicePolicy } from "../../../../src/toolcall/policy-google";
import { createToolBundle } from "../../../../src/toolcall/tool-bundle";
import { chunks } from "../../_support/async-stream.js";
import { withConsoleLog } from "../../_support/globals.js";
import { assert } from "../../assertions.js";
import {
	resolvedModel,
	streamError,
	streamProvider,
	strictProvider,
} from "../_support/provider.js";
import { collectSSEData } from "../_support/sse.js";

type PathSegment = string | number;

function pathValue(value: unknown, ...path: readonly PathSegment[]): unknown {
	let current = value;
	for (const segment of path) {
		if (typeof segment === "number") {
			if (!Array.isArray(current)) return undefined;
			current = current[segment];
			continue;
		}
		if (!isRecord(current)) return undefined;
		current = current[segment];
	}
	return current;
}

function pathNumber(value: unknown, ...path: readonly PathSegment[]): number {
	const result = pathValue(value, ...path);
	if (typeof result !== "number") throw new Error("expected numeric SSE field");
	return result;
}

function candidateText(value: unknown): string {
	const text = pathValue(value, "candidates", 0, "content", "parts", 0, "text");
	return typeof text === "string" ? text : "";
}

function requiredResponse(value: Response | null): Response {
	if (!value) throw new Error("expected response");
	return value;
}

describe("Google streaming", () => {
	test("streams Google tool text warnings through generate handler", async () => {
		const resp = await handleGoogle(
			{
				contents: [{ role: "user", parts: [{ text: "read a file" }] }],
				tools: [
					{
						functionDeclarations: [
							{ name: "Read", parameters: { type: "object" } },
						],
					},
				],
			},
			{
				default_model: "gemini-3.5-flash",
				current_input_file_enabled: false,
				current_input_file_min_bytes: 1000000,
				cookie: "",
				log_requests: false,
			},
			strictProvider({
				streamText() {
					return chunks(["partial answer"], 0);
				},
			}),
			googleRoute("/v1beta/models/gemini-3.5-flash:streamGenerateContent"),
		);
		assert.equal(resp.status, 200);
		const events = collectSSEData([await resp.text()]);
		assert.equal(
			events.some((event) => candidateText(event) === "partial answer"),
			true,
		);
		const warning = events.find(
			(event) => pathValue(event, "warning") !== undefined,
		);
		assert.equal(pathValue(warning, "warning", "code"), "stream_interrupted");
		assert.equal(
			events.some((event) =>
				candidateText(event).includes(
					"stream interrupted after partial output",
				),
			),
			false,
		);
		assert.equal(
			pathNumber(events.at(-1), "usageMetadata", "totalTokenCount") >= 0,
			true,
		);
	});
	test("streams safe Google tool-compatible plain deltas before done", async () => {
		const text = "x".repeat(80);
		const resp = await handleGoogle(
			{
				contents: [{ role: "user", parts: [{ text: "summarize" }] }],
				tools: [
					{
						functionDeclarations: [
							{ name: "Read", parameters: { type: "object" } },
						],
					},
				],
			},
			googleConfig(),
			streamProvider([text]),
			googleRoute("/v1beta/models/gemini-3.5-flash:streamGenerateContent"),
		);
		assert.equal(resp.status, 200);
		const events = collectSSEData([await resp.text()]);
		assert.equal(events.map(candidateText).join(""), text);
		const done = events.at(-1);
		assert.equal(
			pathNumber(done, "usageMetadata", "totalTokenCount"),
			pathNumber(done, "usageMetadata", "promptTokenCount") +
				pathNumber(done, "usageMetadata", "candidatesTokenCount"),
		);
	});
	test("streams Google upstream_empty for an empty tool-compatible stream", async () => {
		const resp = await handleGoogle(
			{
				contents: [{ role: "user", parts: [{ text: "read" }] }],
				tools: [
					{
						functionDeclarations: [
							{ name: "Read", parameters: { type: "object" } },
						],
					},
				],
			},
			googleConfig(),
			streamProvider([]),
			googleRoute("/v1beta/models/gemini-3.5-flash:streamGenerateContent"),
		);
		assert.equal(resp.status, 200);
		const events = collectSSEData([await resp.text()]);
		assert.equal(events.length, 1);
		assert.equal(pathValue(events[0], "error", "code"), "upstream_empty");
		assert.equal(pathValue(events[0], "modelVersion"), "gemini-3.5-flash");
	});
	test("streams Google plain responses through generate handler", async () => {
		const logs: string[] = [];
		let resp: Response | null = null;
		let body = "";
		await withConsoleLog(
			(line: unknown) => logs.push(String(line)),
			async () => {
				resp = await handleGoogle(
					{
						contents: [{ role: "user", parts: [{ text: "say hi" }] }],
					},
					{
						default_model: "gemini-3.5-flash",
						current_input_file_enabled: false,
						current_input_file_min_bytes: 1000000,
						cookie: "",
						log_requests: true,
					},
					streamProvider(["he", "llo"]),
					googleRoute("/v1beta/models/gemini-3.5-flash:streamGenerateContent"),
				);
				body = await requiredResponse(resp).text();
			},
		);
		assert.equal(requiredResponse(resp).status, 200);
		assert.match(body, /"text":"he"/);
		assert.match(body, /"text":"llo"/);
		assert.match(body, /"finishReason":"STOP"/);
		const done = collectSSEData([body]).at(-1);
		assert.equal(
			pathNumber(done, "usageMetadata", "promptTokenCount") >= 0,
			true,
		);
		assert.equal(
			pathNumber(done, "usageMetadata", "candidatesTokenCount") >= 0,
			true,
		);
		assert.equal(
			pathNumber(done, "usageMetadata", "totalTokenCount"),
			pathNumber(done, "usageMetadata", "promptTokenCount") +
				pathNumber(done, "usageMetadata", "candidatesTokenCount"),
		);
		assert.equal(
			logs.some((line) => line.includes("stage=google_prepare")),
			true,
		);
		assert.equal(
			logs.some((line) => line.includes("stage=google_stream_generate")),
			true,
		);
	});
	test("streams Google upstream errors through generate handler", async () => {
		const resp = await handleGoogle(
			{
				contents: [{ role: "user", parts: [{ text: "fail stream" }] }],
			},
			{
				default_model: "gemini-3.5-flash",
				current_input_file_enabled: false,
				current_input_file_min_bytes: 1000000,
				cookie: "",
				log_requests: false,
			},
			strictProvider({
				streamText() {
					throw streamError("handler upstream down", "handler_down");
				},
			}),
			googleRoute("/v1beta/models/gemini-3.5-flash:streamGenerateContent"),
		);
		assert.equal(resp.status, 200);
		const frames = collectSSEData([await resp.text()]);
		assert.equal(frames.length, 1);
		assert.equal(pathValue(frames[0], "error", "code"), "handler_down");
		assert.equal(
			pathValue(frames[0], "error", "message"),
			"handler upstream down",
		);
		assert.equal(pathValue(frames[0], "modelVersion"), "gemini-3.5-flash");
	});
	test("streams Google tool upstream errors through generate handler", async () => {
		const resp = await handleGoogle(
			{
				contents: [{ role: "user", parts: [{ text: "fail tool stream" }] }],
				tools: [
					{
						functionDeclarations: [
							{ name: "Read", parameters: { type: "object" } },
						],
					},
				],
			},
			googleConfig(),
			strictProvider({
				streamText() {
					throw streamError("tool handler upstream down", "tool_handler_down");
				},
			}),
			googleRoute("/v1beta/models/gemini-3.5-flash:streamGenerateContent"),
		);
		assert.equal(resp.status, 200);
		const frames = collectSSEData([await resp.text()]);
		assert.equal(frames.length, 1);
		assert.equal(pathValue(frames[0], "error", "code"), "tool_handler_down");
		assert.equal(
			pathValue(frames[0], "error", "message"),
			"tool handler upstream down",
		);
		assert.equal(pathValue(frames[0], "modelVersion"), "gemini-3.5-flash");
	});
	test("streams Google tool calls through generate handler", async () => {
		const logs: string[] = [];
		let resp: Response | null = null;
		let body = "";
		await withConsoleLog(
			(line: unknown) => logs.push(String(line)),
			async () => {
				resp = await handleGoogle(
					{
						contents: [{ role: "user", parts: [{ text: "read file" }] }],
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
						log_requests: true,
					},
					streamProvider([
						'<tool_calls><invoke name="Read"><parameter name="path">README.md</parameter></invoke></tool_calls>',
					]),
					googleRoute("/v1beta/models/gemini-3.5-flash:streamGenerateContent"),
				);
				body = await requiredResponse(resp).text();
			},
		);
		assert.equal(requiredResponse(resp).status, 200);
		assert.match(
			body,
			/"functionCall":\{"name":"Read","args":\{"path":"README.md"\}\}/,
		);
		assert.match(body, /"finishReason":"STOP"/);
		const done = collectSSEData([body]).at(-1);
		assert.equal(
			pathNumber(done, "usageMetadata", "promptTokenCount") >= 0,
			true,
		);
		assert.equal(
			pathNumber(done, "usageMetadata", "candidatesTokenCount") >= 0,
			true,
		);
		assert.equal(
			pathNumber(done, "usageMetadata", "totalTokenCount"),
			pathNumber(done, "usageMetadata", "promptTokenCount") +
				pathNumber(done, "usageMetadata", "candidatesTokenCount"),
		);
		assert.equal(
			logs.some((line) => line.includes("stage=google_stream_generate")),
			true,
		);
		assert.equal(
			logs.some((line) => line.includes("tools=1")),
			true,
		);
	});
	test("streams Google warning and final done after partial output", async () => {
		const writes: string[] = [];
		const logs: string[] = [];
		await withConsoleLog(
			(line: unknown) => logs.push(String(line)),
			() =>
				streamGooglePlain(
					async (chunk) => {
						writes.push(chunk);
					},
					googleConfig({ log_requests: true }),
					{
						provider: strictProvider({
							streamText() {
								return chunks(["partial"], 0);
							},
						}),
						prompt: "partial",
						rm: resolvedModel(),
						fileRefs: null,
						promptTokens: 4,
						signal: new AbortController().signal,
					},
				),
		);
		const frames = collectSSEData(writes);
		assert.equal(
			frames.some((frame) => candidateText(frame) === "partial"),
			true,
		);
		assert.equal(
			frames.some(
				(frame) => pathValue(frame, "warning", "code") === "stream_interrupted",
			),
			true,
		);
		assert.equal(
			frames.some(
				(frame) =>
					pathValue(frame, "promptFeedback", "warning", "code") ===
					"stream_interrupted",
			),
			true,
		);
		assert.equal(
			pathNumber(frames.at(-1), "usageMetadata", "promptTokenCount"),
			4,
		);
		const warningLog = logs.find((line) =>
			line.includes("google stream interrupted after partial output"),
		);
		assert.match(warningLog, /error=type=Error/);
		assert.doesNotMatch(warningLog, /stream broke/);
	});
	test("streams Google tool warning when stream interrupts after parsed call", async () => {
		const writes: string[] = [];
		const logs: string[] = [];
		const tools = [
			{
				functionDeclarations: [
					{ name: "Read", parameters: { type: "object" } },
				],
			},
		];
		await withConsoleLog(
			(line: unknown) => logs.push(String(line)),
			() =>
				streamGoogleTools(
					async (chunk) => {
						writes.push(chunk);
					},
					googleConfig({ log_requests: true }),
					{
						provider: strictProvider({
							streamText() {
								return chunks(
									[
										'<tool_calls><invoke name="Read"><parameter name="path">README.md</parameter></invoke></tool_calls>',
									],
									0,
								);
							},
						}),
						prompt: "read",
						rm: resolvedModel(),
						fileRefs: null,
						tools: createToolBundle(tools),
						toolPolicy: parseGoogleToolChoicePolicy(
							{
								tools,
								toolConfig: { functionCallingConfig: { mode: "ANY" } },
							},
							createToolBundle(tools),
						),
						promptTokens: 5,
						signal: new AbortController().signal,
					},
				),
		);
		const frames = collectSSEData(writes);
		assert.equal(
			frames.some(
				(frame) => pathValue(frame, "warning", "code") === "stream_interrupted",
			),
			true,
		);
		const callFrame = frames.find(
			(frame) => pathValue(frame, "candidates", 0, "content") !== undefined,
		);
		const warningIndex = frames.findIndex(
			(frame) => pathValue(frame, "warning") !== undefined,
		);
		const callIndex = frames.findIndex(
			(frame) => pathValue(frame, "candidates", 0, "content") !== undefined,
		);
		assert.equal(warningIndex >= 0, true);
		assert.equal(warningIndex < callIndex, true);
		assert.equal(
			pathValue(
				callFrame,
				"candidates",
				0,
				"content",
				"parts",
				0,
				"functionCall",
				"name",
			),
			"Read",
		);
		assert.equal(
			pathNumber(frames.at(-1), "usageMetadata", "promptTokenCount"),
			5,
		);
		const warningLog = logs.find((line) =>
			line.includes("google tool stream interrupted after partial output"),
		);
		assert.match(warningLog, /error=type=Error/);
		assert.doesNotMatch(warningLog, /stream broke/);
	});
	test("streams Google tool policy violations as error frames", async () => {
		const writes: string[] = [];
		const tools = [
			{
				functionDeclarations: [
					{ name: "Read", parameters: { type: "object" } },
				],
			},
		];
		await streamGoogleTools(
			async (chunk) => {
				writes.push(chunk);
			},
			googleConfig(),
			{
				provider: streamProvider([
					'<tool_calls><invoke name="Read"><parameter name="path">README.md</parameter></invoke></tool_calls>',
				]),
				prompt: "do not call tools",
				rm: resolvedModel(),
				fileRefs: null,
				tools: createToolBundle(tools),
				toolPolicy: parseGoogleToolChoicePolicy(
					{
						tools,
						toolConfig: { functionCallingConfig: { mode: "NONE" } },
					},
					createToolBundle(tools),
				),
				promptTokens: 5,
				signal: new AbortController().signal,
			},
		);
		const frames = collectSSEData(writes);
		assert.equal(frames.length, 1);
		assert.equal(
			pathValue(frames[0], "error", "code"),
			"tool_choice_violation",
		);
		assert.match(
			pathValue(frames[0], "error", "message"),
			/does not allow function\(s\): Read/,
		);
		assert.equal(pathValue(frames[0], "modelVersion"), "gemini-3.5-flash");
	});
});
