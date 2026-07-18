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
import { assert } from "../../assertions.js";
import { chunks } from "../../_support/async-stream.js";
import { withConsoleLog } from "../../_support/globals.js";
import { baseConfig } from "../../_support/runtime-config.js";
import { collectSSEData } from "../_support/sse.js";

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
			{
				default_model: "gemini-3.5-flash",
				current_input_file_enabled: false,
				current_input_file_min_bytes: 1000000,
				log_requests: false,
			},
			strictProvider({
				async generateText() {
					generated = true;
					return "{}";
				},
			}),
		);
		assert.equal(resp.status, 400);
		const body = await resp.json();
		assert.equal(body.error.code, "unsupported_response_format_stream");
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
			{
				default_model: "gemini-3.5-flash",
				current_input_file_enabled: false,
				current_input_file_min_bytes: 1000000,
				log_requests: false,
			},
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
		const writes = [];
		const logs = [];
		await withConsoleLog(
			(line) => logs.push(String(line)),
			() =>
				streamOpenAIChatPlain(
					(chunk) => writes.push(chunk),
					baseConfig({ log_requests: true }),
					{
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
					},
				),
		);
		const frames = collectSSEData(writes);
		assert.equal(frames[0].choices[0].delta.role, "assistant");
		assert.equal(
			frames.some(
				(frame) => frame.warning && frame.warning.code === "stream_interrupted",
			),
			true,
		);
		assert.equal(
			frames.some(
				(frame) =>
					frame.choices?.[0]?.delta &&
					String(frame.choices[0].delta.content || "").includes(
						"stream interrupted after partial output",
					),
			),
			false,
		);
		assert.equal(
			frames.some(
				(frame) =>
					Array.isArray(frame.choices) &&
					frame.choices.length === 0 &&
					frame.usage.total_tokens >= 3,
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
		const writes = [];
		const logs = [];
		await withConsoleLog(
			(line) => logs.push(String(line)),
			() =>
				streamOpenAIChatPlain(
					(chunk) => writes.push(chunk),
					baseConfig({ log_requests: true }),
					{
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
					},
				),
		);
		const frames = collectSSEData(writes);
		const errorFrame = frames.find((frame) => frame.error);
		assert.equal(errorFrame.error.code, "upstream_down");
		assert.equal(errorFrame.error.message, "upstream down secret");
		assert.equal(errorFrame.choices, undefined);
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
		assert.equal(frames[0].choices[0].delta.role, "assistant");
		const text = frames
			.filter((frame) => frame.choices?.[0]?.delta?.content)
			.map((frame) => frame.choices[0].delta.content)
			.join("");
		assert.equal(text, "hello");
		assert.equal(
			frames.some(
				(frame) =>
					Array.isArray(frame.choices) &&
					frame.choices.length === 0 &&
					frame.usage.total_tokens >= frame.usage.prompt_tokens,
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
		const errorFrame = frames.find((frame) => frame.error);
		assert.equal(errorFrame.error.code, "upstream_empty");
		assert.equal(errorFrame.error.message, EMPTY_UPSTREAM_MSG);
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
		const errorFrame = frames.find((frame) => frame.error);
		assert.equal(errorFrame.error.code, "handler_down");
		assert.equal(errorFrame.error.message, "handler upstream down");
		assert.equal(frames[frames.length - 1], "[DONE]");
	});
	test("streams OpenAI chat tool call deltas and usage", async () => {
		const writes = [];
		await streamOpenAIChatWithToolSieve(
			(chunk) => writes.push(chunk),
			baseConfig(),
			{
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
			},
		);
		const frames = collectSSEData(writes);
		const toolFrame = frames.find(
			(frame) => frame.choices?.[0].delta.tool_calls,
		);
		assert.equal(toolFrame.choices[0].finish_reason, "tool_calls");
		assert.equal(
			toolFrame.choices[0].delta.tool_calls[0].function.name,
			"Read",
		);
		assert.equal(
			frames.some(
				(frame) =>
					Array.isArray(frame.choices) &&
					frame.choices.length === 0 &&
					frame.usage.total_tokens >= 2,
			),
			true,
		);
		assert.equal(frames[frames.length - 1], "[DONE]");
	});
	test("streams OpenAI chat warning when tool call stream interrupts after a parsed call", async () => {
		const writes = [];
		await streamOpenAIChatWithToolSieve(
			(chunk) => writes.push(chunk),
			baseConfig(),
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
			},
		);
		const frames = collectSSEData(writes);
		assert.equal(
			frames.some(
				(frame) => frame.warning && frame.warning.code === "stream_interrupted",
			),
			true,
		);
		const toolFrame = frames.find(
			(frame) => frame.choices?.[0].delta.tool_calls,
		);
		assert.equal(toolFrame.choices[0].finish_reason, "tool_calls");
		assert.equal(
			toolFrame.choices[0].delta.tool_calls[0].function.name,
			"Read",
		);
		assert.equal(frames[frames.length - 1], "[DONE]");
	});
	test("streams OpenAI chat upstream_empty error when tool sieve has no output", async () => {
		const writes = [];
		await streamOpenAIChatWithToolSieve(
			(chunk) => writes.push(chunk),
			baseConfig(),
			{
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
			},
		);
		const frames = collectSSEData(writes);
		const errorFrame = frames.find((frame) => frame.error);
		assert.equal(errorFrame.error.code, "upstream_empty");
		assert.equal(errorFrame.error.message, EMPTY_UPSTREAM_MSG);
		assert.equal(frames[frames.length - 1], "[DONE]");
	});
	test("streams OpenAI chat warning when tool sieve text stream interrupts", async () => {
		const writes = [];
		const logs = [];
		await withConsoleLog(
			(line) => logs.push(String(line)),
			() =>
				streamOpenAIChatWithToolSieve(
					(chunk) => writes.push(chunk),
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
		assert.equal(
			frames.some(
				(frame) => frame.warning && frame.warning.code === "stream_interrupted",
			),
			true,
		);
		assert.equal(
			frames.some(
				(frame) =>
					frame.choices &&
					String(frame.choices[0].delta.content || "").includes(
						"stream interrupted after partial output",
					),
			),
			false,
		);
		assert.equal(
			frames.some(
				(frame) => frame.choices && frame.choices[0].finish_reason === "stop",
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
});
