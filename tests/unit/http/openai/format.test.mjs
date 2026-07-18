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
import { streamError } from "../_support/provider.js";
import { collectSSEData } from "../_support/sse.js";

describe("OpenAI response format", () => {
	test("formats OpenAI response helper payloads", () => {
		const chatChunk = openAIChatChunk(
			"chatcmpl_test",
			"gemini-3.5-flash",
			{ content: "hi" },
			null,
		);
		assert.equal(chatChunk.object, "chat.completion.chunk");
		assert.equal(chatChunk.choices[0].delta.content, "hi");
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
		assert.equal(output[0].type, "function_call");
		assert.equal(output[1].type, "message");
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
		const defaultErr = await openAIErrorResponse("bad request").json();
		assert.equal(defaultErr.error.type, "invalid_request_error");
		assert.equal(defaultErr.error.code, null);

		const upstream = streamError("gateway down", "upstream_down");
		const upstreamResp = openAIUpstreamErrorResponse(upstream);
		assert.equal(upstreamResp.status, 502);
		const upstreamBody = await upstreamResp.json();
		assert.equal(upstreamBody.error.type, "api_error");
		assert.equal(upstreamBody.error.code, "upstream_down");
		assert.match(upstreamBody.error.message, /upstream error: gateway down/);
	});

	test("formats OpenAI Chat usage and error stream frames", async () => {
		const usageWrites = [];
		writeOpenAIChatUsageTokenChunk(
			(chunk) => usageWrites.push(chunk),
			"chatcmpl_usage",
			0,
			-2,
			"3",
		);
		const usageFrame = collectSSEData(usageWrites)[0];
		assert.equal(usageFrame.id, "chatcmpl_usage");
		assert.deepEqual(usageFrame.choices, []);
		assert.deepEqual(usageFrame.usage, {
			prompt_tokens: 0,
			completion_tokens: 3,
			total_tokens: 3,
		});

		const upstream = streamError("gateway down", "upstream_down");
		const errorWrites = [];
		await writeOpenAIChatStreamError(
			(chunk) => {
				errorWrites.push(chunk);
			},
			"chatcmpl_error",
			"gemini-3.5-flash",
			upstream,
		);
		const errorFrames = collectSSEData(errorWrites);
		assert.equal(errorFrames[0].error.code, "upstream_down");
		assert.equal(errorFrames[0].error.message, "gateway down");
		assert.equal(errorFrames[0].choices, undefined);
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
		assert.equal(onlyValidTool[0].type, "function_call");
		assert.equal(onlyValidTool[0].call_id, "call_1");

		const emptyArrayOutput = buildResponsesOutput("", [], "msg_empty");
		assert.equal(emptyArrayOutput[0].type, "message");
		assert.equal(emptyArrayOutput[0].content[0].text, "");
		const nonArrayOutput = buildResponsesOutput("", null, "msg_null");
		assert.equal(nonArrayOutput[0].type, "message");
	});
});
