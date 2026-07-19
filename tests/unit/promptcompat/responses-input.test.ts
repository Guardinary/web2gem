// @ts-nocheck
import { describe, test } from "vitest";
import {
	normalizeResponsesInputAsMessages,
	parseResponsesInput,
} from "../../../src/promptcompat/responses-input";
import { assert } from "../assertions.js";

describe("prompt compatibility", () => {
	test("parses Responses items directly into typed messages in order", async () => {
		const objectArgs = { id: 7 };
		const result = parseResponsesInput({
			instructions: "be brief",
			input: [
				{ type: "reasoning", text: "first thought" },
				{
					type: "thinking",
					content: [{ type: "summary_text", text: "second thought" }],
				},
				{
					type: "function_call",
					call_id: "call_1",
					name: "Lookup",
					arguments: objectArgs,
				},
				{
					type: "function_call",
					call_id: "call_2",
					function: { name: "Read", arguments: '{"path":"README.md"}' },
				},
				{
					type: "function_call_output",
					call_id: "call_1",
					output: { ok: true },
				},
				"follow",
				"up",
			],
		});

		assert.equal(result.error, undefined);
		assert.equal(result.messages[0].role, "system");
		assert.equal(result.messages[0].parts[0].text, "be brief");
		assert.equal(result.messages[1].role, "assistant");
		assert.equal(
			result.messages[1].reasoningText,
			"first thought\nsecond thought",
		);
		assert.equal(result.messages[1].toolCalls.length, 2);
		assert.equal(result.messages[1].toolCalls[0].args, objectArgs);
		assert.deepEqual(result.messages[1].toolCalls[1].args, {
			path: "README.md",
		});
		assert.deepEqual(
			{
				role: result.messages[2].role,
				toolCallId: result.messages[2].toolCallId,
				toolName: result.messages[2].toolName,
				text: result.messages[2].parts[0].text,
			},
			{
				role: "tool",
				toolCallId: "call_1",
				toolName: "Lookup",
				text: '{"ok":true}',
			},
		);
		assert.equal(result.messages[3].parts[0].text, "follow\nup");
	});

	test("uses explicit Responses modes and ignores unknown top-level items", async () => {
		const imageInput = {
			type: "input_image",
			image_url: "data:image/png;base64,QUJD",
		};
		assert.match(
			parseResponsesInput({ input: [imageInput] }, "completion").error,
			/unsupported type: input_image/,
		);
		const image = parseResponsesInput(
			{ input: [imageInput] },
			"image-generation",
		);
		assert.equal(image.messages[0].parts[0].kind, "image");
		assert.equal(image.messages[0].parts[0].b64, "QUJD");

		const mixed = parseResponsesInput({
			input: [
				{ type: "custom_event", text: "hidden" },
				{ type: "input_text", text: "visible" },
			],
		});
		assert.equal(mixed.messages.length, 1);
		assert.equal(mixed.messages[0].parts[0].text, "visible");
		assert.deepEqual(
			parseResponsesInput({ input: { type: "custom_event", text: "hidden" } }),
			{ messages: [] },
		);
		assert.deepEqual(parseResponsesInput({ input: null }), { messages: [] });
		assert.deepEqual(parseResponsesInput({ input: "   " }), { messages: [] });
		assert.match(parseResponsesInput({ input: true }).error, /string, object/);
	});

	test("preserves typed role messages and rejects malformed recognized items", async () => {
		const assistant = parseResponsesInput({
			input: {
				role: "assistant",
				content: [
					{ type: "reasoning", summary: "checked" },
					{ type: "output_text", text: "visible" },
					{ type: "function_call", name: "Search", input: { q: "docs" } },
				],
				tool_calls: [
					null,
					{
						id: "call_existing",
						function: { name: "Existing", arguments: "{}" },
					},
				],
			},
		});
		assert.equal(assistant.messages[0].parts[0].kind, "reasoning");
		assert.equal(assistant.messages[0].parts[1].text, "visible");
		assert.deepEqual(
			assistant.messages[0].toolCalls.map((call) => call.name),
			["Existing", "Search"],
		);

		const reasoning = parseResponsesInput({
			input: {
				role: "assistant",
				content: [{ type: "reasoning", text: "only" }],
			},
		});
		assert.equal(reasoning.messages[0].reasoningText, "only");
		const tool = parseResponsesInput({
			input: { role: "tool", call_id: "call_9", name: "Lookup", output: 0 },
		});
		assert.equal(tool.messages[0].parts[0].text, "0");
		assert.equal(tool.messages[0].toolCallId, "call_9");

		const invalidInputs = [
			[[""], /item 0 is empty/],
			[[42], /item 0 must be a supported object or string/],
			[[{ type: "tool_result" }], /tool result requires output/],
			[[{ type: "function_call" }], /function call requires name/],
			[[{ type: "reasoning" }], /reasoning item requires text/],
			[[{ type: "input_text", text: "" }], /text item requires text/],
			[{ role: "user" }, /message requires content/],
			[
				{ role: "assistant" },
				/assistant message requires content or tool calls/,
			],
		];
		for (const [input, pattern] of invalidInputs)
			assert.match(parseResponsesInput({ input }).error, pattern);
	});

	test("normalizes Responses reasoning tool calls and outputs in order", async () => {
		const messages = normalizeResponsesInputAsMessages({
			input: [
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
			],
		});
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
		const messages = normalizeResponsesInputAsMessages({
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
		const messages = normalizeResponsesInputAsMessages({
			input: [cyclic, "raw", null].map((argumentsValue, index) => ({
				type: "function_call",
				call_id: `call_${index}`,
				name: "Lookup",
				arguments: argumentsValue,
			})),
		});
		assert.deepEqual(
			messages[0].tool_calls.map((call) => call.function.arguments),
			["{}", "raw", "{}"],
		);
	});
	test("normalizes Responses messages instructions and sparse items", async () => {
		assert.deepEqual(
			normalizeResponsesInputAsMessages({
				instructions: "  stay factual  ",
				messages: [{ role: "user", text: "hello" }],
			}),
			[
				{ role: "system", content: "stay factual" },
				{ role: "user", text: "hello" },
			],
		);
		assert.deepEqual(normalizeResponsesInputAsMessages({ input: null }), []);
		assert.deepEqual(normalizeResponsesInputAsMessages({ input: "   " }), []);
		assert.deepEqual(
			normalizeResponsesInputAsMessages({
				input: { type: "function_call" },
			}),
			[],
		);
		assert.deepEqual(
			normalizeResponsesInputAsMessages({
				input: { type: "input_message", text: "fallback text" },
			}),
			[{ role: "user", content: "fallback text" }],
		);
		assert.deepEqual(
			normalizeResponsesInputAsMessages({
				input: {
					role: "function",
					call_id: "call_7",
					name: "Lookup",
					content: "ok",
				},
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
		const messages = normalizeResponsesInputAsMessages({
			input: [
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
			],
		});

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
	test("merges Responses reasoning-only items into following assistant tool calls", async () => {
		const messages = normalizeResponsesInputAsMessages({
			input: [
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
			],
		});
		assert.equal(messages[0].role, "assistant");
		assert.match(messages[0].reasoning_content, /first thought/);
		assert.match(messages[0].reasoning_content, /second thought/);
		assert.equal(messages[0].tool_calls[0].function.name, "Lookup");
		assert.equal(messages[1].role, "tool");
		assert.equal(messages[1].name, "Lookup");
	});
});
