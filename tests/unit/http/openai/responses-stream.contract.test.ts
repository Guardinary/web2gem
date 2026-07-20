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
import type { UnknownRecord } from "../../../../src/shared/types";
import { assert } from "../../assertions.js";
import { chunks } from "../../_support/async-stream.js";
import { withConsoleLog } from "../../_support/globals.js";
import { collectSSEData } from "../_support/sse.js";
import {
	frameObjects,
	openAIConfig,
	record,
	records,
	responseError,
	writeRecorder,
} from "./_support/fixtures.js";

const baseConfig = openAIConfig;

function eventFrame(
	frames: readonly UnknownRecord[],
	type: string,
): UnknownRecord {
	const frame = frames.find((item) => item.type === type);
	if (!frame) throw new Error(`expected ${type} frame`);
	return frame;
}

function eventResponse(frame: UnknownRecord): UnknownRecord {
	return record(frame.response, "event response");
}

function eventError(frame: UnknownRecord): UnknownRecord {
	return record(eventResponse(frame).error, "event error");
}

function firstRecord(value: unknown, label: string): UnknownRecord {
	const item = records(value, label)[0];
	if (!item) throw new Error(`expected ${label} item`);
	return item;
}

function completedText(frame: UnknownRecord): unknown {
	const output = firstRecord(eventResponse(frame).output, "response output");
	return firstRecord(output.content, "response content").text;
}

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
	test("streams OpenAI Responses plain output through handler path", async () => {
		const logs: string[] = [];
		let status = 0;
		let body = "";
		await withConsoleLog(
			(line: unknown) => logs.push(String(line)),
			async () => {
				const resp = await handleResponses(
					{
						model: "gemini-3.5-flash",
						stream: true,
						input: "say hello",
					},
					baseConfig({ log_requests: true }),
					streamProvider(["he", "llo"]),
				);
				status = resp.status;
				body = await resp.text();
			},
		);
		assert.equal(status, 200);
		const frames = frameObjects(collectSSEData([body]));
		assert.equal(frames[0]?.type, "response.created");
		assert.equal(
			frames
				.filter((frame) => frame.type === "response.output_text.delta")
				.map((frame) => frame.delta)
				.join(""),
			"hello",
		);
		const completed = eventFrame(frames, "response.completed");
		assert.equal(completedText(completed), "hello");
		assert.equal(eventResponse(completed).status, "completed");
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
		const frames = frameObjects(collectSSEData([await resp.text()]));
		const failed = eventFrame(frames, "response.failed");
		assert.equal(eventResponse(failed).status, "failed");
		assert.equal(eventError(failed).code, "tool_choice_violation");
		assert.match(eventError(failed).message, /does not allow tool\(s\): Read/);
	});
	test("streams Responses failure for missing required tool call", async () => {
		const { writes, write } = writeRecorder();
		await streamResponsesWithToolSieve(write, baseConfig(), {
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
		});
		const frames = frameObjects(collectSSEData(writes));
		const failed = eventFrame(frames, "response.failed");
		assert.equal(eventError(failed).code, "tool_choice_violation");
		assert.match(
			eventError(failed).message,
			/tool_choice requires at least one valid tool call/,
		);
	});
	test("streams Responses warning after partial plain output", async () => {
		const { writes, write } = writeRecorder();
		const logs: string[] = [];
		await withConsoleLog(
			(line: unknown) => logs.push(String(line)),
			() =>
				streamResponsesWithToolSieve(
					write,
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
		const frames = frameObjects(collectSSEData(writes));
		assert.equal(
			frames.some(
				(frame) =>
					frame.type === "response.warning" &&
					record(frame.warning, "warning").code === "stream_interrupted",
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
		const completed = eventFrame(frames, "response.completed");
		const completedResponse = eventResponse(completed);
		assert.equal(completedResponse.status, "completed");
		assert.equal(
			record(completedResponse.usage, "response usage").input_tokens,
			3,
		);
		const warningLog = logs.find((line) =>
			line.includes("openai responses stream interrupted after partial output"),
		);
		assert.match(warningLog, /error=type=Error/);
		assert.doesNotMatch(warningLog, /stream broke/);
	});
	test("streams Responses function call output without message text", async () => {
		const { writes, write } = writeRecorder();
		await streamResponsesWithToolSieve(write, baseConfig(), {
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
		});
		const frames = frameObjects(collectSSEData(writes));
		const added = eventFrame(frames, "response.output_item.added");
		assert.equal(record(added.item, "added item").name, "Read");
		const argsDone = eventFrame(
			frames,
			"response.function_call_arguments.done",
		);
		assert.equal(argsDone.name, "Read");
		assert.match(argsDone.arguments, /README\.md/);
		const completed = eventFrame(frames, "response.completed");
		const completedOutput = records(
			eventResponse(completed).output,
			"response output",
		);
		assert.equal(
			completedOutput.some(
				(item) => item.type === "function_call" && item.name === "Read",
			),
			true,
		);
	});
	test("streams Responses failure when tool stream errors before output", async () => {
		const { writes, write } = writeRecorder();
		const logs: string[] = [];
		await withConsoleLog(
			(line: unknown) => logs.push(String(line)),
			() =>
				streamResponsesWithToolSieve(
					write,
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
		const frames = frameObjects(collectSSEData(writes));
		const failed = eventFrame(frames, "response.failed");
		assert.equal(eventResponse(failed).status, "failed");
		assert.equal(eventError(failed).code, "upstream_down");
		assert.match(
			eventError(failed).message,
			/upstream error: upstream down secret/,
		);
		const failureLog = logs.find((line) =>
			line.includes("openai responses stream failed before output"),
		);
		assert.match(failureLog, /error=type=Error code=upstream_down/);
		assert.doesNotMatch(failureLog, /upstream down secret/);
	});
	test("streams Responses warning when tool stream errors after a parsed call", async () => {
		const { writes, write } = writeRecorder();
		const logs: string[] = [];
		await withConsoleLog(
			(line: unknown) => logs.push(String(line)),
			() =>
				streamResponsesWithToolSieve(
					write,
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
		const frames = frameObjects(collectSSEData(writes));
		assert.equal(
			frames.some(
				(frame) =>
					frame.type === "response.warning" &&
					record(frame.warning, "warning").code === "stream_interrupted",
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
		const { writes, write } = writeRecorder();
		await streamResponsesWithToolSieve(write, baseConfig(), {
			provider: streamProvider([]),
			rid: "resp_empty",
			rm: resolvedModel(),
			prompt: "empty",
			fileRefs: null,
			tools: null,
			toolPolicy: null,
			promptTokens: 1,
			signal: new AbortController().signal,
		});
		const frames = frameObjects(collectSSEData(writes));
		const failed = eventFrame(frames, "response.failed");
		assert.equal(eventError(failed).code, "upstream_empty");
		assert.equal(eventError(failed).message, EMPTY_UPSTREAM_MSG);
		assert.deepEqual(eventResponse(failed).output, []);
	});
});
