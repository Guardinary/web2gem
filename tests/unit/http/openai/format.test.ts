import { describe, test } from "vitest";
import {
	openAIErrorResponse,
	openAIErrorType,
	openAIUpstreamErrorResponse,
} from "../../../../src/http/openai/errors";
import {
	buildResponsesOutput,
	openAIChatChunk,
	openAIChatUsageFromCompletionTokens,
	openAIResponsesUsage,
	writeOpenAIChatStreamError,
	writeOpenAIChatUsageTokenChunk,
} from "../../../../src/http/openai/format";
import { assert } from "../../assertions.js";
import type { SSEWrite } from "../../../../src/http/core/sse";
import type { UnknownRecord } from "../../../../src/shared/types";
import { streamError } from "../_support/provider.js";
import { collectSSEData } from "../_support/sse.js";
import { record } from "./_support/fixtures.js";

function firstRecord(value: unknown, label: string): UnknownRecord {
	if (!Array.isArray(value) || value.length === 0)
		throw new Error(`expected ${label}`);
	const item = value[0];
	return record(item, label);
}

describe("OpenAI response format", () => {
	test("formats OpenAI response helper payloads", () => {
		const chatChunk = openAIChatChunk(
			"chatcmpl_test",
			"gemini-3.5-flash",
			{ content: "hi" },
			null,
		);
		assert.equal(chatChunk.object, "chat.completion.chunk");
		assert.equal(chatChunk.choices[0]?.delta.content, "hi");
		assert.deepEqual(openAIChatUsageFromCompletionTokens(-1, "2"), {
			prompt_tokens: 0,
			completion_tokens: 2,
			total_tokens: 2,
		});

		const output = buildResponsesOutput(
			"done",
			[
				{
					id: "call_1",
					function: { name: "Lookup", arguments: '{"id":"1"}' },
				},
			],
			"msg_1",
		);
		assert.equal(output[0]?.type, "function_call");
		assert.equal(output[1]?.type, "message");
	});

	test("formats OpenAI error status types envelopes and upstream failures", async () => {
		assert.equal(openAIErrorType(400), "invalid_request_error");
		assert.equal(openAIErrorType(401), "authentication_error");
		assert.equal(openAIErrorType(403), "permission_error");
		assert.equal(openAIErrorType(429), "rate_limit_error");
		assert.equal(openAIErrorType(503), "service_unavailable_error");
		assert.equal(openAIErrorType(500), "api_error");
		assert.equal(openAIErrorType(418), "invalid_request_error");

		const forbidden = openAIErrorResponse("blocked", 403, "policy_blocked");
		assert.equal(forbidden.status, 403);
		assert.equal(forbidden.headers.get("content-type"), "application/json");
		assert.deepEqual(await forbidden.json(), {
			error: {
				message: "blocked",
				type: "permission_error",
				code: "policy_blocked",
				param: null,
			},
		});
		const defaultErr = record(
			await openAIErrorResponse("bad request").json(),
			"default error",
		);
		const defaultErrBody = record(defaultErr.error, "default error body");
		assert.equal(defaultErrBody.type, "invalid_request_error");
		assert.equal(defaultErrBody.code, null);

		const upstream = streamError("gateway down", "upstream_down");
		const upstreamResp = openAIUpstreamErrorResponse(upstream);
		assert.equal(upstreamResp.status, 502);
		const upstreamBody = record(await upstreamResp.json(), "upstream error");
		const upstreamError = record(upstreamBody.error, "upstream error body");
		assert.equal(upstreamError.type, "api_error");
		assert.equal(upstreamError.code, "upstream_down");
		assert.match(upstreamError.message, /upstream error: gateway down/);
	});

	test("formats OpenAI Chat usage and error stream frames", async () => {
		const usageWrites: string[] = [];
		const writeUsage: SSEWrite = async (chunk) => {
			usageWrites.push(chunk);
		};
		writeOpenAIChatUsageTokenChunk(writeUsage, "chatcmpl_usage", 0, -2, "3");
		const usageFrame = firstRecord(collectSSEData(usageWrites), "usage frame");
		assert.equal(usageFrame.id, "chatcmpl_usage");
		assert.deepEqual(usageFrame.choices, []);
		assert.deepEqual(usageFrame.usage, {
			prompt_tokens: 0,
			completion_tokens: 3,
			total_tokens: 3,
		});

		const upstream = streamError("gateway down", "upstream_down");
		const errorWrites: string[] = [];
		await writeOpenAIChatStreamError(
			async (chunk) => {
				errorWrites.push(chunk);
			},
			"chatcmpl_error",
			"gemini-3.5-flash",
			upstream,
		);
		const errorFrames = collectSSEData(errorWrites);
		const errorFrame = firstRecord(errorFrames, "error frame");
		const errorBody = record(errorFrame.error, "stream error");
		assert.equal(errorBody.code, "upstream_down");
		assert.equal(errorBody.message, "gateway down");
		assert.equal(errorFrame.choices, undefined);
		assert.equal(errorFrames[1], "[DONE]");
	});

	test("formats OpenAI Responses usage and filtered output fallbacks", () => {
		const responsesUsage = openAIResponsesUsage(-5, "abcd");
		assert.equal(responsesUsage.input_tokens, 0);
		assert.equal(responsesUsage.output_tokens > 0, true);
		assert.equal(responsesUsage.total_tokens, responsesUsage.output_tokens);

		const onlyValidTool = buildResponsesOutput(
			"",
			[
				"skip",
				{ id: "call_bad", function: { name: "MissingArguments" } },
				{
					id: "call_1",
					function: { name: "Lookup", arguments: '{"id":"1"}' },
				},
			],
			"msg_skip",
		);
		assert.equal(onlyValidTool.length, 1);
		assert.equal(onlyValidTool[0]?.type, "function_call");
		assert.equal(onlyValidTool[0]?.call_id, "call_1");

		const emptyArrayOutput = buildResponsesOutput("", [], "msg_empty");
		assert.equal(emptyArrayOutput[0]?.type, "message");
		const emptyContent = record(emptyArrayOutput[0], "empty output").content;
		assert.equal(
			record(
				Array.isArray(emptyContent) ? emptyContent[0] : null,
				"empty content",
			).text,
			"",
		);
		const nonArrayOutput = buildResponsesOutput("", null, "msg_null");
		assert.equal(nonArrayOutput[0]?.type, "message");
	});
});
