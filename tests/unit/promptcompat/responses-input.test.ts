import { describe, test } from "vitest";
import {
	normalizeResponsesInputAsMessages,
	parseResponsesInput,
	type ResponsesInputParseResult,
} from "../../../src/promptcompat/responses-input";
import type {
	ImagePart,
	InternalMessage,
	InternalToolCall,
	MessagePart,
} from "../../../src/promptcompat/message-model";
import { isRecord, type UnknownRecord } from "../../../src/shared/types";
import { assert } from "../assertions.js";

function parsedMessages(result: ResponsesInputParseResult): InternalMessage[] {
	if (result.error !== undefined) throw new Error(result.error);
	return result.messages;
}

function itemAt<T>(items: readonly T[], index: number, label: string): T {
	const item = items[index];
	if (item === undefined) throw new Error(`${label} ${index} is required`);
	return item;
}

function messageAt(messages: readonly InternalMessage[], index: number) {
	return itemAt(messages, index, "message");
}

function partAt(message: InternalMessage, index: number): MessagePart {
	return itemAt(message.parts, index, "message part");
}

function textPartAt(message: InternalMessage, index: number) {
	const part = partAt(message, index);
	if (part.kind !== "text" && part.kind !== "reasoning") {
		throw new Error(`message part ${index} must contain text`);
	}
	return part;
}

function imagePartAt(message: InternalMessage, index: number): ImagePart {
	const part = partAt(message, index);
	if (part.kind !== "image")
		throw new Error(`message part ${index} must be image`);
	return part;
}

function toolCallAt(message: InternalMessage, index: number): InternalToolCall {
	return itemAt(message.toolCalls, index, "tool call");
}

function recordAt(items: readonly unknown[], index: number, label: string) {
	const item = itemAt(items, index, label);
	if (!isRecord(item)) throw new Error(`${label} ${index} must be a record`);
	return item;
}

function normalizedMessageAt(
	messages: readonly UnknownRecord[],
	index: number,
): UnknownRecord {
	return recordAt(messages, index, "normalized message");
}

function recordArray(value: unknown, label: string): UnknownRecord[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
	return value.map((item, index) => {
		if (!isRecord(item)) throw new Error(`${label} ${index} must be a record`);
		return item;
	});
}

function recordValue(value: unknown, label: string): UnknownRecord {
	if (!isRecord(value)) throw new Error(`${label} must be a record`);
	return value;
}

function normalizedToolCalls(message: UnknownRecord): UnknownRecord[] {
	return recordArray(message.tool_calls, "tool_calls");
}

function normalizedFunction(call: UnknownRecord): UnknownRecord {
	return recordValue(call.function, "tool call function");
}

function stringValue(
	record: UnknownRecord,
	key: string,
	label: string,
): string {
	const value = record[key];
	if (typeof value !== "string")
		throw new Error(`${label}.${key} must be string`);
	return value;
}

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
		const messages = parsedMessages(result);
		const system = messageAt(messages, 0);
		const assistant = messageAt(messages, 1);
		const tool = messageAt(messages, 2);
		const followUp = messageAt(messages, 3);
		assert.equal(system.role, "system");
		assert.equal(textPartAt(system, 0).text, "be brief");
		assert.equal(assistant.role, "assistant");
		assert.equal(assistant.reasoningText, "first thought\nsecond thought");
		assert.equal(assistant.toolCalls.length, 2);
		assert.equal(toolCallAt(assistant, 0).args, objectArgs);
		assert.deepEqual(toolCallAt(assistant, 1).args, {
			path: "README.md",
		});
		assert.deepEqual(
			{
				role: tool.role,
				toolCallId: tool.toolCallId,
				toolName: tool.toolName,
				text: textPartAt(tool, 0).text,
			},
			{
				role: "tool",
				toolCallId: "call_1",
				toolName: "Lookup",
				text: '{"ok":true}',
			},
		);
		assert.equal(textPartAt(followUp, 0).text, "follow\nup");
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
		const imageMessage = messageAt(parsedMessages(image), 0);
		assert.equal(imagePartAt(imageMessage, 0).kind, "image");
		assert.equal(imagePartAt(imageMessage, 0).b64, "QUJD");

		const mixed = parseResponsesInput({
			input: [
				{ type: "custom_event", text: "hidden" },
				{ type: "input_text", text: "visible" },
			],
		});
		const mixedMessages = parsedMessages(mixed);
		assert.equal(mixedMessages.length, 1);
		assert.equal(textPartAt(messageAt(mixedMessages, 0), 0).text, "visible");
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
		const assistantMessage = messageAt(parsedMessages(assistant), 0);
		assert.equal(partAt(assistantMessage, 0).kind, "reasoning");
		assert.equal(textPartAt(assistantMessage, 1).text, "visible");
		assert.deepEqual(
			assistantMessage.toolCalls.map((call) => call.name),
			["Existing", "Search"],
		);

		const reasoning = parseResponsesInput({
			input: {
				role: "assistant",
				content: [{ type: "reasoning", text: "only" }],
			},
		});
		assert.equal(messageAt(parsedMessages(reasoning), 0).reasoningText, "only");
		const tool = parseResponsesInput({
			input: { role: "tool", call_id: "call_9", name: "Lookup", output: 0 },
		});
		const toolMessage = messageAt(parsedMessages(tool), 0);
		assert.equal(textPartAt(toolMessage, 0).text, "0");
		assert.equal(toolMessage.toolCallId, "call_9");

		const invalidInputs: readonly (readonly [unknown, RegExp])[] = [
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
		for (const [input, pattern] of invalidInputs) {
			const invalid = parseResponsesInput({ input });
			assert.match(invalid.error, pattern);
		}
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
		const reasoningMessage = normalizedMessageAt(messages, 0);
		const reasoningCalls = normalizedToolCalls(reasoningMessage);
		assert.equal(reasoningMessage.role, "assistant");
		assert.match(
			stringValue(reasoningMessage, "reasoning_content", "message"),
			/checked cache/,
		);
		assert.equal(reasoningCalls.length, 2);
		assert.equal(
			stringValue(
				normalizedFunction(itemAt(reasoningCalls, 0, "tool call")),
				"name",
				"function",
			),
			"Lookup",
		);
		assert.equal(
			stringValue(
				normalizedFunction(itemAt(reasoningCalls, 1, "tool call")),
				"name",
				"function",
			),
			"Read",
		);
		const toolMessage = normalizedMessageAt(messages, 1);
		assert.equal(toolMessage.role, "tool");
		assert.equal(toolMessage.name, "Lookup");
		assert.deepEqual(normalizedMessageAt(messages, 2), {
			role: "user",
			content: "follow up\n42",
		});
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
		assert.deepEqual(normalizedMessageAt(messages, 0), {
			role: "system",
			content: "be brief",
		});
		const assistantMessage = normalizedMessageAt(messages, 1);
		assert.equal(assistantMessage.role, "assistant");
		assert.equal(assistantMessage.content, "visible answer");
		assert.equal(assistantMessage.reasoning_content, "internal chain");
		const searchCall = itemAt(
			normalizedToolCalls(assistantMessage),
			0,
			"tool call",
		);
		assert.equal(
			stringValue(normalizedFunction(searchCall), "name", "function"),
			"Search",
		);
	});
	test("stringifies unrepresentable Responses tool arguments as empty object", async () => {
		const cyclic: UnknownRecord = {};
		cyclic.self = cyclic;
		const messages = normalizeResponsesInputAsMessages({
			input: [cyclic, "raw", null].map((argumentsValue, index) => ({
				type: "function_call",
				call_id: `call_${index}`,
				name: "Lookup",
				arguments: argumentsValue,
			})),
		});
		const calls = normalizedToolCalls(normalizedMessageAt(messages, 0));
		assert.deepEqual(
			calls.map((call) =>
				stringValue(normalizedFunction(call), "arguments", "function"),
			),
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

		const firstAssistant = normalizedMessageAt(messages, 0);
		const secondAssistant = normalizedMessageAt(messages, 1);
		const assistantCalls = normalizedToolCalls(secondAssistant);
		const existingCall = itemAt(assistantCalls, 0, "tool call");
		const nestedCall = itemAt(assistantCalls, 1, "tool call");
		const nestedFunction = normalizedFunction(nestedCall);
		assert.equal(firstAssistant.role, "assistant");
		assert.equal(firstAssistant.content, "assistant text");
		assert.equal(
			stringValue(normalizedFunction(existingCall), "name", "function"),
			"Existing",
		);
		assert.equal(nestedCall.id, "call_nested");
		assert.equal(stringValue(nestedFunction, "name", "function"), "Nested");
		assert.deepEqual(
			JSON.parse(stringValue(nestedFunction, "arguments", "function")),
			{
				query: "docs",
			},
		);
		assert.deepEqual(normalizedMessageAt(messages, 2), {
			role: "tool",
			tool_call_id: "call_nested",
			name: "Nested",
			content: "nested result",
		});
		assert.deepEqual(normalizedMessageAt(messages, 3), {
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
		const assistant = normalizedMessageAt(messages, 0);
		const tool = normalizedMessageAt(messages, 1);
		const lookupCall = itemAt(normalizedToolCalls(assistant), 0, "tool call");
		assert.equal(assistant.role, "assistant");
		assert.match(
			stringValue(assistant, "reasoning_content", "message"),
			/first thought/,
		);
		assert.match(
			stringValue(assistant, "reasoning_content", "message"),
			/second thought/,
		);
		assert.equal(
			stringValue(normalizedFunction(lookupCall), "name", "function"),
			"Lookup",
		);
		assert.equal(tool.role, "tool");
		assert.equal(tool.name, "Lookup");
	});
});
