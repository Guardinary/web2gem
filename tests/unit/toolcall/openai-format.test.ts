import { describe, test } from "vitest";
import {
	formatOpenAIStreamToolCalls,
	formatOpenAIToolCalls,
} from "../../../src/toolcall/openai-format";
import { createToolBundle } from "../../../src/toolcall/tool-bundle";
import { assert } from "../assertions.js";
import { required } from "./_support/assertions.js";

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
		// Reusing the same store must keep stream tool-call IDs stable.
		const again = formatOpenAIStreamToolCalls(calls, ids, bundle);
		assert.equal(required(again[0]).id, required(streamCalls[0]).id);
		assert.equal(required(again[1]).id, required(streamCalls[1]).id);
		// A fresh store (or null) allocates a new ID each time.
		const fallback = formatOpenAIStreamToolCalls(calls, null, bundle);
		assert.match(required(fallback[0]).id, /^call_[0-9a-f]{32}$/);
		assert.equal(
			required(fallback[0]).id === required(streamCalls[0]).id,
			false,
		);
	});
});
