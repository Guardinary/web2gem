import {
	resolvedModel,
	streamError,
	strictProvider,
	streamProvider,
} from "../_support/provider.js";
import { describe, test } from "vitest";
import { EMPTY_UPSTREAM_MSG } from "../../../../src/completion/turn";
import { handleResponses } from "../../../../src/http/openai/responses";
import { streamResponsesWithToolSieve } from "../../../../src/http/openai/responses-stream";
import { createToolBundle } from "../../../../src/toolcall/tool-bundle";
import { assert } from "../../assertions.js";
import { chunks } from "../../_support/async-stream.js";
import { withConsoleLog } from "../../_support/globals.js";
import { baseConfig } from "../../_support/runtime-config.js";
import { collectSSEData } from "../_support/sse.js";

describe("OpenAI Responses streaming", () => {
	test("rejects unsupported streaming structured OpenAI Responses", async () => {
		let generated = false;
		const resp = await handleResponses(
			{
				model: "gemini-3.5-flash",
				stream: true,
				input: "json please",
				text: { format: { type: "json_object" } },
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
	test("streams OpenAI Responses plain output through handler path", async () => {
		const logs = [];
		let resp;
		let body = "";
		await withConsoleLog(
			(line) => logs.push(String(line)),
			async () => {
				resp = await handleResponses(
					{
						model: "gemini-3.5-flash",
						stream: true,
						input: "say hello",
					},
					baseConfig({ log_requests: true }),
					streamProvider(["he", "llo"]),
				);
				body = await resp.text();
			},
		);
		assert.equal(resp.status, 200);
		const frames = collectSSEData([body]);
		assert.equal(frames[0].type, "response.created");
		assert.equal(
			frames
				.filter((frame) => frame.type === "response.output_text.delta")
				.map((frame) => frame.delta)
				.join(""),
			"hello",
		);
		const completed = frames.find(
			(frame) => frame.type === "response.completed",
		);
		assert.equal(completed.response.output[0].content[0].text, "hello");
		assert.equal(completed.response.status, "completed");
		assert.equal(
			logs.some((line) => line.includes("stage=openai_responses_prepare")),
			true,
		);
		assert.equal(
			logs.some((line) =>
				line.includes("stage=openai_responses_stream_generate"),
			),
			true,
		);
	});
	test("streams OpenAI Responses tool-choice none violations through handler path", async () => {
		const resp = await handleResponses(
			{
				model: "gemini-3.5-flash",
				stream: true,
				input: "do not call tools",
				tools: [
					{
						type: "function",
						function: { name: "Read", parameters: { type: "object" } },
					},
				],
				tool_choice: "none",
			},
			baseConfig(),
			streamProvider([
				'<tool_calls><invoke name="Read"><parameter name="path">README.md</parameter></invoke></tool_calls>',
			]),
		);
		assert.equal(resp.status, 200);
		const frames = collectSSEData([await resp.text()]);
		const failed = frames.find((frame) => frame.type === "response.failed");
		assert.equal(failed.response.status, "failed");
		assert.equal(failed.response.error.code, "tool_choice_violation");
		assert.match(
			failed.response.error.message,
			/does not allow tool\(s\): Read/,
		);
	});
	test("streams Responses failure for missing required tool call", async () => {
		const writes = [];
		await streamResponsesWithToolSieve(
			(chunk) => writes.push(chunk),
			baseConfig(),
			{
				provider: streamProvider(["plain answer"]),
				rid: "resp_test",
				rm: resolvedModel(),
				prompt: "must call a tool",
				fileRefs: null,
				tools: createToolBundle([
					{
						type: "function",
						function: { name: "Read", parameters: { type: "object" } },
					},
				]),
				toolPolicy: {
					mode: "required",
					forcedName: "",
					allowed: null,
					hasAllowed: false,
					declared: ["Read"],
					error: "",
				},
				promptTokens: 1,
				signal: new AbortController().signal,
			},
		);
		const frames = collectSSEData(writes);
		const failed = frames.find((frame) => frame.type === "response.failed");
		assert.equal(failed.response.error.code, "tool_choice_violation");
		assert.match(
			failed.response.error.message,
			/tool_choice requires at least one valid tool call/,
		);
	});
	test("streams Responses warning after partial plain output", async () => {
		const writes = [];
		const logs = [];
		await withConsoleLog(
			(line) => logs.push(String(line)),
			() =>
				streamResponsesWithToolSieve(
					(chunk) => writes.push(chunk),
					baseConfig({ log_requests: true }),
					{
						provider: strictProvider({
							streamText() {
								return chunks(["partial"], 0);
							},
						}),
						rid: "resp_partial",
						rm: resolvedModel(),
						prompt: "partial",
						fileRefs: null,
						tools: null,
						toolPolicy: null,
						promptTokens: 3,
						signal: new AbortController().signal,
					},
				),
		);
		const frames = collectSSEData(writes);
		assert.equal(
			frames.some(
				(frame) =>
					frame.type === "response.warning" &&
					frame.warning.code === "stream_interrupted",
			),
			true,
		);
		assert.equal(
			frames.some(
				(frame) =>
					frame.type === "response.output_text.delta" &&
					String(frame.delta || "").includes(
						"stream interrupted after partial output",
					),
			),
			false,
		);
		const completed = frames.find(
			(frame) => frame.type === "response.completed",
		);
		assert.equal(completed.response.status, "completed");
		assert.equal(completed.response.usage.input_tokens, 3);
		const warningLog = logs.find((line) =>
			line.includes("openai responses stream interrupted after partial output"),
		);
		assert.match(warningLog, /error=type=Error/);
		assert.doesNotMatch(warningLog, /stream broke/);
	});
	test("streams Responses function call output without message text", async () => {
		const writes = [];
		await streamResponsesWithToolSieve(
			(chunk) => writes.push(chunk),
			baseConfig(),
			{
				provider: streamProvider([
					'<tool_calls><invoke name="Read"><parameter name="path">README.md</parameter></invoke></tool_calls>',
				]),
				rid: "resp_tool",
				rm: resolvedModel(),
				prompt: "read",
				fileRefs: null,
				tools: createToolBundle([
					{
						type: "function",
						function: { name: "Read", parameters: { type: "object" } },
					},
				]),
				toolPolicy: null,
				promptTokens: 2,
				signal: new AbortController().signal,
			},
		);
		const frames = collectSSEData(writes);
		const added = frames.find(
			(frame) =>
				frame.type === "response.output_item.added" &&
				frame.item.type === "function_call",
		);
		assert.equal(added.item.name, "Read");
		const argsDone = frames.find(
			(frame) => frame.type === "response.function_call_arguments.done",
		);
		assert.equal(argsDone.name, "Read");
		assert.match(argsDone.arguments, /README\.md/);
		const completed = frames.find(
			(frame) => frame.type === "response.completed",
		);
		assert.equal(
			completed.response.output.some(
				(item) => item.type === "function_call" && item.name === "Read",
			),
			true,
		);
	});
	test("streams Responses failure when tool stream errors before output", async () => {
		const writes = [];
		const logs = [];
		await withConsoleLog(
			(line) => logs.push(String(line)),
			() =>
				streamResponsesWithToolSieve(
					(chunk) => writes.push(chunk),
					baseConfig({ log_requests: true }),
					{
						provider: strictProvider({
							streamText() {
								throw streamError("upstream down secret", "upstream_down");
							},
						}),
						rid: "resp_tool_error",
						rm: resolvedModel(),
						prompt: "read",
						fileRefs: null,
						tools: createToolBundle([
							{
								type: "function",
								function: { name: "Read", parameters: { type: "object" } },
							},
						]),
						toolPolicy: null,
						promptTokens: 2,
						signal: new AbortController().signal,
					},
				),
		);
		const frames = collectSSEData(writes);
		const failed = frames.find((frame) => frame.type === "response.failed");
		assert.equal(failed.response.status, "failed");
		assert.equal(failed.response.error.code, "upstream_down");
		assert.match(
			failed.response.error.message,
			/upstream error: upstream down secret/,
		);
		const failureLog = logs.find((line) =>
			line.includes("openai responses stream failed before output"),
		);
		assert.match(failureLog, /error=type=Error code=upstream_down/);
		assert.doesNotMatch(failureLog, /upstream down secret/);
	});
	test("streams Responses warning when tool stream errors after a parsed call", async () => {
		const writes = [];
		const logs = [];
		await withConsoleLog(
			(line) => logs.push(String(line)),
			() =>
				streamResponsesWithToolSieve(
					(chunk) => writes.push(chunk),
					baseConfig({ log_requests: true }),
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
						rid: "resp_tool_warning",
						rm: resolvedModel(),
						prompt: "read",
						fileRefs: null,
						tools: createToolBundle([
							{
								type: "function",
								function: { name: "Read", parameters: { type: "object" } },
							},
						]),
						toolPolicy: null,
						promptTokens: 2,
						signal: new AbortController().signal,
					},
				),
		);
		const frames = collectSSEData(writes);
		assert.equal(
			frames.some(
				(frame) =>
					frame.type === "response.warning" &&
					frame.warning.code === "stream_interrupted",
			),
			true,
		);
		assert.equal(
			frames.some(
				(frame) =>
					frame.type === "response.output_text.delta" &&
					String(frame.delta || "").includes(
						"stream interrupted after partial output",
					),
			),
			false,
		);
		assert.equal(
			frames.some(
				(frame) =>
					frame.type === "response.function_call_arguments.done" &&
					frame.name === "Read",
			),
			true,
		);
		const warningLog = logs.find((line) =>
			line.includes("openai responses stream interrupted after partial output"),
		);
		assert.match(warningLog, /error=type=Error/);
		assert.doesNotMatch(warningLog, /stream broke/);
	});
	test("streams Responses upstream_empty failure without output text", async () => {
		const writes = [];
		await streamResponsesWithToolSieve(
			(chunk) => writes.push(chunk),
			baseConfig(),
			{
				provider: streamProvider([]),
				rid: "resp_empty",
				rm: resolvedModel(),
				prompt: "empty",
				fileRefs: null,
				tools: null,
				toolPolicy: null,
				promptTokens: 1,
				signal: new AbortController().signal,
			},
		);
		const frames = collectSSEData(writes);
		const failed = frames.find((frame) => frame.type === "response.failed");
		assert.equal(failed.response.error.code, "upstream_empty");
		assert.equal(failed.response.error.message, EMPTY_UPSTREAM_MSG);
		assert.deepEqual(failed.response.output, []);
	});
});
