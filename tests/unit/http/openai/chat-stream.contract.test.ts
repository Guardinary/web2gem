import {
	resolvedModel,
	streamError,
	strictProvider,
	streamProvider,
} from "../_support/provider.js";
import { describe, test } from "vitest";
import { EMPTY_UPSTREAM_MSG } from "../../../../src/completion/turn";
import { handleChat } from "../../../../src/http/openai/chat";
import {
	streamOpenAIChatPlain,
	streamOpenAIChatWithToolSieve,
} from "../../../../src/http/openai/chat-stream";
import { createToolBundle } from "../../../../src/toolcall/tool-bundle";
import { isRecord, type UnknownRecord } from "../../../../src/shared/types";
import { assert } from "../../assertions.js";
import { chunks } from "../../_support/async-stream.js";
import { withConsoleLog } from "../../_support/globals.js";
import { collectSSEData } from "../_support/sse.js";
import {
	frameObjects,
	openAIConfig,
	record,
	responseError,
	writeRecorder,
} from "./_support/fixtures.js";

const baseConfig = openAIConfig;

function firstObject(frames: readonly unknown[], label: string): UnknownRecord {
	const object = frameObjects(frames)[0];
	if (!object) throw new Error(`expected ${label}`);
	return object;
}

function optionalRecord(value: unknown): UnknownRecord | null {
	return isRecord(value) ? value : null;
}

function firstChoice(frame: UnknownRecord): UnknownRecord | null {
	if (!Array.isArray(frame.choices)) return null;
	return optionalRecord(frame.choices[0]);
}

function choiceDelta(frame: UnknownRecord): UnknownRecord | null {
	return optionalRecord(firstChoice(frame)?.delta);
}

function errorFrame(frames: readonly UnknownRecord[]): UnknownRecord {
	const frame = frames.find((item) => isRecord(item.error));
	if (!frame) throw new Error("expected stream error frame");
	return frame;
}

function streamErrorBody(frame: UnknownRecord): UnknownRecord {
	return record(frame.error, "stream error");
}

function toolFrame(frames: readonly UnknownRecord[]): UnknownRecord {
	const frame = frames.find((item) =>
		Array.isArray(choiceDelta(item)?.tool_calls),
	);
	if (!frame) throw new Error("expected tool-call frame");
	return frame;
}

function firstToolName(frame: UnknownRecord): unknown {
	const calls = choiceDelta(frame)?.tool_calls;
	if (!Array.isArray(calls)) throw new Error("expected tool calls");
	const call = record(calls[0], "tool call");
	return record(call.function, "tool function").name;
}

describe("OpenAI Chat streaming", () => {
	test("rejects unsupported streaming structured OpenAI chat responses", async () => {
		let generated = false;
		const resp = await handleChat(
			{
				model: "gemini-3.5-flash",
				stream: true,
				messages: [{ role: "user", content: "json please" }],
				response_format: { type: "json_object" },
			},
			baseConfig({
				default_model: "gemini-3.5-flash",
				current_input_file_enabled: false,
				current_input_file_min_bytes: 1000000,
				log_requests: false,
			}),
			strictProvider({
				async generateText() {
					generated = true;
					return "{}";
				},
			}),
		);
		assert.equal(resp.status, 400);
		assert.equal(
			responseError(await resp.json()).code,
			"unsupported_response_format_stream",
		);
		assert.equal(generated, false);
	});
	test("streams OpenAI chat tool-choice none violations through handler path", async () => {
		const resp = await handleChat(
			{
				model: "gemini-3.5-flash",
				stream: true,
				messages: [{ role: "user", content: "do not call tools" }],
				tools: [
					{
						type: "function",
						function: { name: "Read", parameters: { type: "object" } },
					},
				],
				tool_choice: "none",
			},
			baseConfig({
				default_model: "gemini-3.5-flash",
				current_input_file_enabled: false,
				current_input_file_min_bytes: 1000000,
				log_requests: false,
			}),
			streamProvider([
				'<tool_calls><invoke name="Read"><parameter name="path">README.md</parameter></invoke></tool_calls>',
			]),
		);
		assert.equal(resp.status, 200);
		const body = await resp.text();
		assert.match(body, /tool_choice does not allow tool\(s\): Read/);
		assert.match(body, /data: \[DONE\]/);
	});
	test("streams OpenAI chat warning usage and DONE after partial output", async () => {
		const { writes, write } = writeRecorder();
		const logs: string[] = [];
		await withConsoleLog(
			(line: unknown) => logs.push(String(line)),
			() =>
				streamOpenAIChatPlain(write, baseConfig({ log_requests: true }), {
					provider: strictProvider({
						streamText() {
							return chunks(["hello"], 0);
						},
					}),
					id: "chatcmpl_test",
					model: "gemini-3.5-flash",
					prompt: "say hello",
					rm: resolvedModel(),
					fileRefs: null,
					includeUsage: true,
					promptTokens: 3,
					signal: new AbortController().signal,
				}),
		);
		const frames = collectSSEData(writes);
		const objects = frameObjects(frames);
		assert.equal(
			choiceDelta(firstObject(objects, "role frame"))?.role,
			"assistant",
		);
		assert.equal(
			objects.some(
				(frame) => optionalRecord(frame.warning)?.code === "stream_interrupted",
			),
			true,
		);
		assert.equal(
			objects.some(
				(frame) =>
					choiceDelta(frame) !== null &&
					String(choiceDelta(frame)?.content || "").includes(
						"stream interrupted after partial output",
					),
			),
			false,
		);
		assert.equal(
			objects.some(
				(frame) =>
					Array.isArray(frame.choices) &&
					frame.choices.length === 0 &&
					Number(optionalRecord(frame.usage)?.total_tokens) >= 3,
			),
			true,
		);
		assert.equal(frames[frames.length - 1], "[DONE]");
		const warningLog = logs.find((line) =>
			line.includes("openai chat stream interrupted after partial output"),
		);
		assert.match(warningLog, /error=type=Error/);
		assert.doesNotMatch(warningLog, /stream broke/);
	});
	test("streams OpenAI chat protocol error before any output", async () => {
		const { writes, write } = writeRecorder();
		const logs: string[] = [];
		await withConsoleLog(
			(line: unknown) => logs.push(String(line)),
			() =>
				streamOpenAIChatPlain(write, baseConfig({ log_requests: true }), {
					provider: strictProvider({
						streamText() {
							throw streamError("upstream down secret", "upstream_down");
						},
					}),
					id: "chatcmpl_error",
					model: "gemini-3.5-flash",
					prompt: "fail",
					rm: resolvedModel(),
					fileRefs: null,
					includeUsage: false,
					promptTokens: 1,
					signal: new AbortController().signal,
				}),
		);
		const frames = collectSSEData(writes);
		const frame = errorFrame(frameObjects(frames));
		const errorBody = streamErrorBody(frame);
		assert.equal(errorBody.code, "upstream_down");
		assert.equal(errorBody.message, "upstream down secret");
		assert.equal(frame.choices, undefined);
		assert.equal(frames[frames.length - 1], "[DONE]");
		const failureLog = logs.find((line) =>
			line.includes("openai chat stream failed before output"),
		);
		assert.match(failureLog, /error=type=Error code=upstream_down/);
		assert.doesNotMatch(failureLog, /upstream down secret/);
	});
	test("streams OpenAI chat plain output through handler path with usage", async () => {
		const resp = await handleChat(
			{
				model: "gemini-3.5-flash",
				stream: true,
				stream_options: { include_usage: true },
				messages: [{ role: "user", content: "say hello" }],
			},
			baseConfig(),
			streamProvider(["he", "llo"]),
		);
		assert.equal(resp.status, 200);
		const frames = collectSSEData([await resp.text()]);
		const objects = frameObjects(frames);
		assert.equal(
			choiceDelta(firstObject(objects, "role frame"))?.role,
			"assistant",
		);
		const text = frames
			.filter((frame): frame is UnknownRecord => isRecord(frame))
			.map((frame) => choiceDelta(frame)?.content)
			.filter((content): content is string => typeof content === "string")
			.join("");
		assert.equal(text, "hello");
		assert.equal(
			objects.some(
				(frame) =>
					Array.isArray(frame.choices) &&
					frame.choices.length === 0 &&
					Number(optionalRecord(frame.usage)?.total_tokens) >=
						Number(optionalRecord(frame.usage)?.prompt_tokens),
			),
			true,
		);
		assert.equal(frames[frames.length - 1], "[DONE]");
	});
	test("streams OpenAI chat upstream_empty protocol error through handler path", async () => {
		const resp = await handleChat(
			{
				model: "gemini-3.5-flash",
				stream: true,
				messages: [{ role: "user", content: "say something" }],
			},
			baseConfig(),
			streamProvider([]),
		);
		assert.equal(resp.status, 200);
		const frames = collectSSEData([await resp.text()]);
		const errorBody = streamErrorBody(errorFrame(frameObjects(frames)));
		assert.equal(errorBody.code, "upstream_empty");
		assert.equal(errorBody.message, EMPTY_UPSTREAM_MSG);
		assert.equal(frames[frames.length - 1], "[DONE]");
	});
	test("streams OpenAI chat protocol errors through handler path", async () => {
		const resp = await handleChat(
			{
				model: "gemini-3.5-flash",
				stream: true,
				messages: [{ role: "user", content: "fail stream" }],
			},
			baseConfig(),
			strictProvider({
				streamText() {
					throw streamError("handler upstream down", "handler_down");
				},
			}),
		);
		assert.equal(resp.status, 200);
		const frames = collectSSEData([await resp.text()]);
		const errorBody = streamErrorBody(errorFrame(frameObjects(frames)));
		assert.equal(errorBody.code, "handler_down");
		assert.equal(errorBody.message, "handler upstream down");
		assert.equal(frames[frames.length - 1], "[DONE]");
	});
	test("streams OpenAI chat tool call deltas and usage", async () => {
		const { writes, write } = writeRecorder();
		await streamOpenAIChatWithToolSieve(write, baseConfig(), {
			provider: streamProvider([
				'<tool_calls><invoke name="Read"><parameter name="path">README.md</parameter></invoke></tool_calls>',
			]),
			id: "chatcmpl_tool",
			model: "gemini-3.5-flash",
			prompt: "read",
			rm: resolvedModel(),
			fileRefs: null,
			tools: createToolBundle([
				{
					type: "function",
					function: { name: "Read", parameters: { type: "object" } },
				},
			]),
			toolPolicy: null,
			includeUsage: true,
			promptTokens: 2,
			signal: new AbortController().signal,
		});
		const frames = collectSSEData(writes);
		const objects = frameObjects(frames);
		const toolCallFrame = toolFrame(objects);
		assert.equal(firstChoice(toolCallFrame)?.finish_reason, "tool_calls");
		assert.equal(firstToolName(toolCallFrame), "Read");
		assert.equal(
			objects.some(
				(frame) =>
					Array.isArray(frame.choices) &&
					frame.choices.length === 0 &&
					Number(optionalRecord(frame.usage)?.total_tokens) >= 2,
			),
			true,
		);
		assert.equal(frames[frames.length - 1], "[DONE]");
	});
	test("streams OpenAI chat warning when tool call stream interrupts after a parsed call", async () => {
		const { writes, write } = writeRecorder();
		await streamOpenAIChatWithToolSieve(write, baseConfig(), {
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
			id: "chatcmpl_tool_warning",
			model: "gemini-3.5-flash",
			prompt: "read",
			rm: resolvedModel(),
			fileRefs: null,
			tools: createToolBundle([
				{
					type: "function",
					function: { name: "Read", parameters: { type: "object" } },
				},
			]),
			toolPolicy: null,
			includeUsage: false,
			promptTokens: 2,
			signal: new AbortController().signal,
		});
		const frames = collectSSEData(writes);
		const objects = frameObjects(frames);
		assert.equal(
			objects.some(
				(frame) => optionalRecord(frame.warning)?.code === "stream_interrupted",
			),
			true,
		);
		const toolCallFrame = toolFrame(objects);
		assert.equal(firstChoice(toolCallFrame)?.finish_reason, "tool_calls");
		assert.equal(firstToolName(toolCallFrame), "Read");
		assert.equal(frames[frames.length - 1], "[DONE]");
	});
	test("streams OpenAI chat upstream_empty error when tool sieve has no output", async () => {
		const { writes, write } = writeRecorder();
		await streamOpenAIChatWithToolSieve(write, baseConfig(), {
			provider: streamProvider([]),
			id: "chatcmpl_tool_empty",
			model: "gemini-3.5-flash",
			prompt: "read",
			rm: resolvedModel(),
			fileRefs: null,
			tools: createToolBundle([
				{
					type: "function",
					function: { name: "Read", parameters: { type: "object" } },
				},
			]),
			toolPolicy: null,
			includeUsage: false,
			promptTokens: 2,
			signal: new AbortController().signal,
		});
		const frames = collectSSEData(writes);
		const errorBody = streamErrorBody(errorFrame(frameObjects(frames)));
		assert.equal(errorBody.code, "upstream_empty");
		assert.equal(errorBody.message, EMPTY_UPSTREAM_MSG);
		assert.equal(frames[frames.length - 1], "[DONE]");
	});
	test("streams OpenAI chat warning when tool sieve text stream interrupts", async () => {
		const { writes, write } = writeRecorder();
		const logs: string[] = [];
		await withConsoleLog(
			(line: unknown) => logs.push(String(line)),
			() =>
				streamOpenAIChatWithToolSieve(
					write,
					baseConfig({ log_requests: true }),
					{
						provider: strictProvider({
							streamText() {
								return chunks(["partial answer"], 0);
							},
						}),
						id: "chatcmpl_tool_partial",
						model: "gemini-3.5-flash",
						prompt: "answer",
						rm: resolvedModel(),
						fileRefs: null,
						tools: createToolBundle([
							{
								type: "function",
								function: { name: "Read", parameters: { type: "object" } },
							},
						]),
						toolPolicy: null,
						includeUsage: false,
						promptTokens: 2,
						signal: new AbortController().signal,
					},
				),
		);
		const frames = collectSSEData(writes);
		const objects = frameObjects(frames);
		assert.equal(
			objects.some(
				(frame) => optionalRecord(frame.warning)?.code === "stream_interrupted",
			),
			true,
		);
		assert.equal(
			objects.some(
				(frame) =>
					firstChoice(frame) !== null &&
					String(choiceDelta(frame)?.content || "").includes(
						"stream interrupted after partial output",
					),
			),
			false,
		);
		assert.equal(
			objects.some((frame) => firstChoice(frame)?.finish_reason === "stop"),
			true,
		);
		assert.equal(frames[frames.length - 1], "[DONE]");
		const warningLog = logs.find((line) =>
			line.includes("openai chat stream interrupted after partial output"),
		);
		assert.match(warningLog, /error=type=Error/);
		assert.doesNotMatch(warningLog, /stream broke/);
	});
});
