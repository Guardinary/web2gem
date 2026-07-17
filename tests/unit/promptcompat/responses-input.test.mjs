import { describe, test } from "vitest";
import {
	normalizeResponsesInputAsMessages,
	normalizeResponsesInputAsMessagesStrict,
	normalizeResponsesInputValueAsMessages,
	responsesMessagesFromRequest,
	stringifyToolCallArguments,
} from "../../../src/promptcompat/responses-input";
import { assert } from "../assertions.js";

describe("prompt compatibility", () => {
	test("normalizes Responses reasoning tool calls and outputs in order", async () => {
		const messages = normalizeResponsesInputValueAsMessages([
			{
				type: "reasoning",
				summary: [{ type: "summary_text", text: "checked cache" }],
			},
			{
				type: "function_call",
				call_id: "call_1",
				name: "Lookup",
				arguments: { id: 7 },
			},
			{
				type: "function_call",
				call_id: "call_2",
				name: "Read",
				input: { path: "README.md" },
			},
			{
				type: "function_call_output",
				call_id: "call_1",
				output: { ok: true },
			},
			"follow up",
			42,
		]);
		assert.equal(messages[0].role, "assistant");
		assert.match(messages[0].reasoning_content, /checked cache/);
		assert.equal(messages[0].tool_calls.length, 2);
		assert.equal(messages[0].tool_calls[0].function.name, "Lookup");
		assert.equal(messages[0].tool_calls[1].function.name, "Read");
		assert.equal(messages[1].role, "tool");
		assert.equal(messages[1].name, "Lookup");
		assert.deepEqual(messages[2], { role: "user", content: "follow up\n42" });
	});
	test("normalizes Responses assistant content parts and instructions", async () => {
		const messages = responsesMessagesFromRequest({
			instructions: "be brief",
			input: [
				{
					type: "message",
					role: "assistant",
					content: [
						{ type: "reasoning", summary: "internal chain" },
						{ type: "output_text", text: "visible answer" },
						{
							type: "function_call",
							call_id: "call_3",
							name: "Search",
							input: { query: "docs" },
						},
					],
				},
			],
		});
		assert.deepEqual(messages[0], { role: "system", content: "be brief" });
		assert.equal(messages[1].role, "assistant");
		assert.equal(messages[1].content, "visible answer");
		assert.equal(messages[1].reasoning_content, "internal chain");
		assert.equal(messages[1].tool_calls[0].function.name, "Search");
	});
	test("stringifies unrepresentable Responses tool arguments as empty object", async () => {
		const cyclic = {};
		cyclic.self = cyclic;
		assert.equal(stringifyToolCallArguments(cyclic), "{}");
		assert.equal(stringifyToolCallArguments("raw"), "raw");
		assert.equal(stringifyToolCallArguments(null), "{}");
	});
	test("normalizes Responses messages instructions and sparse items", async () => {
		assert.deepEqual(
			responsesMessagesFromRequest({
				instructions: "  stay factual  ",
				messages: [{ role: "user", text: "hello" }],
			}),
			[
				{ role: "system", content: "stay factual" },
				{ role: "user", text: "hello" },
			],
		);
		assert.equal(normalizeResponsesInputValueAsMessages(null), null);
		assert.equal(normalizeResponsesInputValueAsMessages("   "), null);
		assert.equal(
			normalizeResponsesInputValueAsMessages({ type: "function_call" }),
			null,
		);
		assert.deepEqual(
			normalizeResponsesInputValueAsMessages({
				type: "input_message",
				text: "fallback text",
			}),
			[{ role: "user", content: "fallback text" }],
		);
		assert.deepEqual(
			normalizeResponsesInputValueAsMessages({
				role: "function",
				call_id: "call_7",
				name: "Lookup",
				content: "ok",
			}),
			[
				{
					role: "tool",
					content: "ok",
					tool_call_id: "call_7",
					name: "Lookup",
				},
			],
		);
	});
	test("normalizes additional Responses item shapes without accepting unknown objects", async () => {
		const messages = normalizeResponsesInputValueAsMessages([
			{ type: "message", role: "assistant", text: "assistant text" },
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "call_existing",
						type: "function",
						function: { name: "Existing", arguments: '{"ok":true}' },
					},
				],
			},
			{
				type: "function_call",
				id: "call_nested",
				function: { name: "Nested", arguments: { query: "docs" } },
			},
			{ type: "tool_result", id: "call_nested", content: "nested result" },
			{ type: "output_text", text: "visible output" },
			{
				type: "custom_event",
				text: "ignored text",
				content: [{ type: "input_text", text: "ignored nested content" }],
				metadata: { secret: "ignored metadata" },
			},
			{ text: "ignored bare text" },
		]);

		assert.equal(messages[0].role, "assistant");
		assert.equal(messages[0].content, "assistant text");
		assert.equal(messages[1].tool_calls[0].function.name, "Existing");
		assert.equal(messages[1].tool_calls[1].id, "call_nested");
		assert.equal(messages[1].tool_calls[1].function.name, "Nested");
		assert.deepEqual(JSON.parse(messages[1].tool_calls[1].function.arguments), {
			query: "docs",
		});
		assert.deepEqual(messages[2], {
			role: "tool",
			tool_call_id: "call_nested",
			name: "Nested",
			content: "nested result",
		});
		assert.deepEqual(messages[3], {
			role: "user",
			content: "visible output",
		});
		assert.equal(messages.length, 4);
		assert.deepEqual(
			normalizeResponsesInputAsMessages({
				input: { type: "custom_event", text: "ignored root text" },
			}),
			[],
		);
	});
	test("validates Responses input strictly before normalization", async () => {
		assert.deepEqual(normalizeResponsesInputAsMessagesStrict("bad"), {
			error: "request body must be a JSON object",
		});
		assert.deepEqual(
			normalizeResponsesInputAsMessagesStrict({ input: "hello" }),
			{ messages: [{ role: "user", content: "hello" }] },
		);
		assert.deepEqual(
			normalizeResponsesInputAsMessagesStrict({
				input: { role: "user", text: "hello" },
			}),
			{ messages: [{ role: "user", content: "hello" }] },
		);
		assert.deepEqual(
			normalizeResponsesInputAsMessagesStrict({
				input: { role: "bogus", content: "x" },
			}),
			{ messages: [{ role: "bogus", content: "x" }] },
		);

		const invalidInputs = [
			[{ input: [""] }, /item 0 is empty/],
			[{ input: [42] }, /item 0 must be a supported object or string/],
			[{ input: [{ role: "tool" }] }, /tool message requires content/],
			[{ input: [{ role: "user" }] }, /message requires content/],
			[
				{ input: [{ role: "assistant" }] },
				/assistant message requires content or tool calls/,
			],
			[{ input: [{ type: "message" }] }, /message requires content/],
			[{ input: [{ type: "tool_result" }] }, /tool result requires output/],
			[{ input: [{ type: "function_call" }] }, /function call requires name/],
			[{ input: [{ type: "reasoning" }] }, /reasoning item requires text/],
			[
				{ input: [{ type: "input_text", text: "" }] },
				/text item requires text/,
			],
			[
				{ input: [{ type: "custom_event", text: "ignored" }] },
				/unsupported type: custom_event/,
			],
			[{ input: true }, /must be a string, object, or array/],
		];
		for (const [req, pattern] of invalidInputs) {
			const result = normalizeResponsesInputAsMessagesStrict(req);
			assert.match(result.error, pattern);
		}
	});
	test("merges Responses reasoning-only items into following assistant tool calls", async () => {
		const messages = normalizeResponsesInputValueAsMessages([
			{ type: "reasoning", text: "first thought" },
			{
				type: "thinking",
				content: [{ type: "summary_text", text: "second thought" }],
			},
			{
				type: "function_call",
				call_id: "call_1",
				name: "Lookup",
				arguments: { id: "1" },
			},
			{ type: "tool_result", call_id: "call_1", output: "done" },
		]);
		assert.equal(messages[0].role, "assistant");
		assert.match(messages[0].reasoning_content, /first thought/);
		assert.match(messages[0].reasoning_content, /second thought/);
		assert.equal(messages[0].tool_calls[0].function.name, "Lookup");
		assert.equal(messages[1].role, "tool");
		assert.equal(messages[1].name, "Lookup");
	});
});
