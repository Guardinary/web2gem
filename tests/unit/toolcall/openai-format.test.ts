import { describe, test } from "vitest";
import {
	ensureStreamToolCallID,
	formatOpenAIStreamToolCalls,
	formatOpenAIToolCalls,
} from "../../../src/toolcall/openai-format";
import { createToolBundle } from "../../../src/toolcall/tool-bundle";
import { assert } from "../assertions.js";

function required<T>(value: T | null | undefined): T {
	if (value == null) throw new Error("expected a value");
	return value;
}

describe("toolcall", () => {
	test("formats OpenAI tool call payloads and stable stream IDs", async () => {
		assert.deepEqual(formatOpenAIToolCalls(null, null), []);
		assert.deepEqual(formatOpenAIStreamToolCalls([], new Map(), null), []);

		const tools = [
			{
				type: "function",
				function: {
					name: "Lookup",
					parameters: {
						type: "object",
						properties: {
							query: { type: "string" },
							count: { type: "integer" },
						},
					},
				},
			},
		];
		const bundle = createToolBundle(tools);
		const calls = [
			{ name: "Lookup", input: { query: { term: "docs" }, count: "3" } },
			{ name: "NoInput" },
		];
		const formatted = formatOpenAIToolCalls(calls, bundle);
		assert.equal(formatted.length, 2);
		assert.match(required(formatted[0]).id, /^call_[0-9a-f]{8}$/);
		assert.equal(required(formatted[0]).type, "function");
		assert.deepEqual(JSON.parse(required(formatted[0]).function.arguments), {
			query: '{"term":"docs"}',
			count: "3",
		});
		assert.deepEqual(JSON.parse(required(formatted[1]).function.arguments), {});
		assert.equal("index" in required(formatted[0]), false);

		const ids = new Map();
		const streamCalls = formatOpenAIStreamToolCalls(calls, ids, bundle);
		assert.equal(required(streamCalls[0]).index, 0);
		assert.match(required(streamCalls[0]).id, /^call_[0-9a-f]{32}$/);
		assert.equal(ensureStreamToolCallID(ids, 0), required(streamCalls[0]).id);
		const fallbackId = ensureStreamToolCallID(null, 0);
		assert.match(fallbackId, /^call_[0-9a-f]{32}$/);
		const nonIntegerId = ensureStreamToolCallID(ids, "not-an-index");
		assert.equal(nonIntegerId, required(streamCalls[0]).id);
	});
});
